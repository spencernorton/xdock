// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Gio,
    GLib,
} from './dependencies/gi.js';

import {
    AppDisplay,
    Main,
} from './dependencies/shell/ui.js';

import {
    isUserDrawer,
    resolveDrawerApps,
} from './appLauncherModel.js';

import {Docking} from './imports.js';

const FOLDERS_SCHEMA = 'org.gnome.desktop.app-folders';
const FOLDER_SCHEMA = 'org.gnome.desktop.app-folders.folder';
const FOLDER_PATH = '/org/gnome/desktop/app-folders/folders/';

function gridAppDisplay() {
    return Main.overview.isDummy
        ? null : Docking.DockManager.getDefault().overviewControls.appDisplay;
}

/**
 * @param {string} id folder id
 * @returns {object|null} the Shell app grid's icon for the folder, if the grid
 *   has one
 */
function gridFolderIcon(id) {
    return gridAppDisplay()?.getAllItems().find(item =>
        item instanceof AppDisplay.FolderIcon && item.id === id) ?? null;
}

/**
 * Read/write access to the launcher's drawers.
 *
 * Drawers are GNOME app-folders, not a private store: a drawer created here is
 * an ordinary folder in the Shell's own app grid, and folders the user already
 * made there show up here. That interop is the whole reason for the choice, and
 * it is also why every mutation below is conservative -- this settings subtree
 * is shared with the rest of the desktop.
 *
 * Only folders that pass isUserDrawer() are ever listed or mutated, so
 * distribution-shipped folders (System, Utilities, YaST, Pardus) and
 * category-driven folders are invisible here and cannot be renamed, refilled or
 * deleted by this code. That is a distro/user boundary, NOT an ownership one:
 * folders the user created in the Shell's app grid before this extension
 * existed are listed and mutable, by design.
 */
export class DrawerStore {
    constructor() {
        this._settings = new Gio.Settings({schema_id: FOLDERS_SCHEMA});
        this._folderSettingsCache = new Map();
    }

    destroy() {
        this._folderSettingsCache.clear();
        this._settings = null;
    }

    get settings() {
        return this._settings;
    }

    _folderSettings(id) {
        let folder = this._folderSettingsCache.get(id);
        if (!folder) {
            folder = new Gio.Settings({
                schema_id: FOLDER_SCHEMA,
                path: `${FOLDER_PATH}${id}/`,
            });
            this._folderSettingsCache.set(id, folder);
        }
        return folder;
    }

    _snapshot(id) {
        const folder = this._folderSettings(id);
        return {
            id,
            name: folder.get_string('name'),
            translate: folder.get_boolean('translate'),
            categories: folder.get_strv('categories'),
            apps: folder.get_strv('apps'),
            excludedApps: folder.get_strv('excluded-apps'),
        };
    }

    /**
     * @returns {object[]} user-created drawers, in folder-children order
     */
    list() {
        const drawers = [];
        for (const id of this._settings.get_strv('folder-children')) {
            let snapshot;
            try {
                snapshot = this._snapshot(id);
            } catch (error) {
                // A folder-children entry with no backing settings path is
                // stale; skip it rather than failing the whole sidebar.
                logError(error, `Skipping unreadable app folder ${id}`);
                continue;
            }

            if (isUserDrawer(snapshot))
                drawers.push(snapshot);
        }
        return drawers;
    }

    /**
     * @param {string} id drawer id
     * @returns {string[]} desktop ids filed in the drawer
     */
    appIds(id) {
        return resolveDrawerApps(this._snapshot(id));
    }

    // NOT an ownership check. It answers "is this a drawer the sidebar shows",
    // which is deliberately every user-created folder -- including ones made in
    // the Shell's app grid before this extension existed, because those are
    // exactly the drawers the user expects to manage here. What it does
    // guarantee is that distribution folders (translate=true) and
    // category-driven folders are never touched.
    _isManageableDrawer(id) {
        try {
            return isUserDrawer(this._snapshot(id));
        } catch {
            return false;
        }
    }

    /**
     * Create a drawer. The folder's own keys are written before it joins
     * folder-children, so a failure part-way cannot leave a child pointing at
     * an empty settings path.
     *
     * @param {string} name validated drawer name
     * @returns {string} the new drawer's id
     */
    create(name) {
        const id = GLib.uuid_string_random();
        const folder = this._folderSettings(id);
        folder.set_string('name', name);
        // Marks the folder as user-created; see isUserDrawer().
        folder.set_boolean('translate', false);
        folder.set_strv('apps', []);
        folder.set_strv('categories', []);
        folder.set_strv('excluded-apps', []);
        Gio.Settings.sync();

        const children = this._settings.get_strv('folder-children');
        children.push(id);
        this._settings.set_strv('folder-children', children);
        return id;
    }

    /**
     * Move a drawer so it sits directly before another one.
     *
     * The sidebar's order IS `folder-children` order, so reordering is a
     * rewrite of that one key. Distribution folders are in the same list and
     * are NOT shown in the sidebar, so their relative order has to survive:
     * the moved id is spliced among the children the list already has rather
     * than the list being rebuilt from what the sidebar displays.
     *
     * @param {string} id drawer to move
     * @param {string|null} beforeId drawer to insert it in front of, or null
     *   to move it to the end
     * @returns {boolean} whether anything changed
     */
    reorder(id, beforeId) {
        if (id === beforeId || !this._isManageableDrawer(id))
            return false;

        const children = this._settings.get_strv('folder-children');
        const from = children.indexOf(id);
        if (from === -1)
            return false;

        const without = children.filter(item => item !== id);
        let target = without.length;
        if (beforeId !== null) {
            target = without.indexOf(beforeId);
            if (target === -1)
                return false;
        }

        without.splice(target, 0, id);
        if (without.every((item, index) => item === children[index]))
            return false;

        this._settings.set_strv('folder-children', without);
        return true;
    }

    /**
     * @param {string} id drawer id
     * @param {string} appId desktop id to file
     * @returns {boolean} whether anything changed
     */
    addApp(id, appId) {
        if (!appId || !this._isManageableDrawer(id))
            return false;

        const folder = this._folderSettings(id);
        const apps = folder.get_strv('apps');
        const excluded = folder.get_strv('excluded-apps');
        const isFiled = apps.includes(appId);
        const isExcluded = excluded.includes(appId);

        // An id can be in BOTH lists -- the Shell's own app grid leaves that
        // state when an app is removed from a folder it also lists. Returning
        // early on `apps.includes()` alone left the exclusion in place, so
        // resolveDrawerApps() kept hiding the app and the drop did nothing
        // visible. Both lists have to be considered before deciding.
        if (isFiled && !isExcluded)
            return false;

        if (!isFiled) {
            apps.push(appId);
            folder.set_strv('apps', apps);
        }
        if (isExcluded)
            folder.set_strv('excluded-apps', excluded.filter(item => item !== appId));

        // The Shell's app grid keeps no icon for an empty folder, so nothing
        // there hears the folder's own keys change: a drawer's first app went
        // unseen in the grid until the next login. Queue the rebuild the grid
        // runs for a change to folder-children. (Writing that key back
        // unchanged does not do it: an unchanged write notifies nobody.)
        const appDisplay = gridAppDisplay();
        if (appDisplay && !gridFolderIcon(id))
            Main.queueDeferredWork(appDisplay._redisplayWorkId);

        return true;
    }

    /**
     * @param {string} id drawer id
     * @param {string} appId desktop id to unfile
     * @returns {boolean} whether anything changed
     */
    removeApp(id, appId) {
        if (!appId || !this._isManageableDrawer(id))
            return false;

        const folder = this._folderSettings(id);
        const apps = folder.get_strv('apps');
        if (!apps.includes(appId))
            return false;

        folder.set_strv('apps', apps.filter(item => item !== appId));

        // With no app left to show in a folder, the Shell's app grid hides the
        // folder's icon, and its next rebuild then destroys that hidden icon
        // while still holding it, and throws. So an icon that has just hidden
        // leaves the grid the way a deleted folder's does: the folder is out
        // of folder-children for one rebuild, and then back where it was.
        const icon = gridFolderIcon(id);
        if (icon && !icon.visible) {
            const children = this._settings.get_strv('folder-children');
            this._settings.set_strv('folder-children', children.filter(item => item !== id));
            gridAppDisplay()._redisplay();
            this._settings.set_strv('folder-children', children);
        }
        return true;
    }

    /**
     * Delete a drawer.
     *
     * This resets shared desktop state: the folder disappears from the Shell's
     * app grid too. It refuses distribution and category-driven folders, but it
     * does NOT distinguish a drawer created here from one the user made in the
     * app grid -- both are the user's own folders and both are listed in the
     * sidebar, so both are theirs to delete. The launcher asks first, because
     * the action is not undoable.
     *
     * The order is the Shell's own (FolderView.removeApp): the folder's keys
     * are reset while its app-grid icon is told to ignore them, and only then
     * does the folder leave folder-children. Without the flag the icon answers
     * the first reset by rebuilding the grid from inside its own change
     * handler, and that rebuild destroys the icon halfway through the handler.
     * The flag is never cleared: once the folder has left folder-children the
     * icon is only waiting for the grid to drop it, and nothing may wake it.
     *
     * @param {string} id drawer id
     * @returns {boolean} whether anything changed
     */
    delete(id) {
        if (!this._isManageableDrawer(id))
            return false;

        const children = this._settings.get_strv('folder-children');
        if (!children.includes(id))
            return false;

        const icon = gridFolderIcon(id);
        if (icon)
            icon.view._deletingFolder = true;

        const folder = this._folderSettings(id);
        for (const key of folder.settings_schema.list_keys())
            folder.reset(key);

        this._settings.set_strv('folder-children', children.filter(item => item !== id));
        return true;
    }
}
