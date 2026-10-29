// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    AccountsService,
    Atk,
    Clutter,
    Gio,
    GLib,
    GObject,
    Meta,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    AppDisplay,
    AppFavorites,
    Dialog,
    DND,
    Main,
    ModalDialog,
    PopupMenu,
    UserWidget,
} from './dependencies/shell/ui.js';

import {
    ParentalControlsManager,
    SystemActions,
} from './dependencies/shell/misc.js';

import {
    MAX_VISIBLE_RESULTS,
    QUICK_ACCESS_COUNT,
    SIDEBAR_WIDTH,
    FOOTER_HEIGHT,
    computeGridLayout,
    computeHeaderHeight,
    fillQuickAccess,
    filterCatalog,
    getGridPosition,
    moveSelection,
    normalizeSearchText,
    planAdjacentDrawerReorder,
    trailingCellCount,
    validateDrawerName,
} from './appLauncherModel.js';

import {DeferredTask} from './lifecycle.js';
import {WholeSurfaceRedraw} from './dockBlur.js';

import * as PopupMenuUtils from './popupMenuUtils.js';

import {
    AppDrawers,
    AppIcons,
    Utils,
} from './imports.js';

import {Extension} from './dependencies/shell/extensions/extension.js';

const {gettext: __} = Extension;

const MAX_CACHED_BUTTONS = MAX_VISIBLE_RESULTS * 2;

// The All Apps row's id. A Symbol rather than a string on purpose: drawer ids
// are folder names in app-folders, and every path that touches one --
// _canFileApp, DrawerStore.addApp, _drawers.appIds -- would happily treat a
// string sentinel as a real folder and CREATE it. A Symbol cannot be written
// to settings, so those paths fail loudly instead of silently making a folder.
const ALL_APPS = Symbol('all-apps');

const DEFAULT_GRID_COLUMNS = 6;
const DEFAULT_ICON_SIZE = 48;

// Hover label: named after the dock's own tooltip timing so the two feel alike.
const HOVER_LABEL_SHOW_TIME = 150;
const HOVER_LABEL_HIDE_TIME = 100;
const HOVER_LABEL_GAP = 8;

// Drag feel. EASE_OUT_BACK overshoots slightly, which is what reads as "spring".
const DRAG_PICKUP_FROM_SCALE = 0.85;
const DRAG_PICKUP_TO_SCALE = 1.15;
const DRAG_PICKUP_DURATION = 190;
const DRAG_SETTLE_DURATION = 250;
const DRAG_SOURCE_GHOST_SCALE = 0.92;
const DRAG_SOURCE_GHOST_OPACITY = 60;
const DRAWER_REORDER_MODIFIERS = Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK;

// Clutter.Actor.ease() already applies Shell's slow-down factor. Only zero the
// base duration here for reduced motion; calling adjustAnimationTime() first
// would apply the slow-down factor twice when ease() sets its easing duration.
function launcherAnimationDuration(duration) {
    return St.Settings.get().enable_animations ? duration : 0;
}

/**
 * A launcher grid result.
 *
 * This derives from Shell's own AppIcon rather than from this extension's
 * DockAppIcon for two independently sufficient reasons:
 *
 * 1. Dash.getAppFromSource() resolves a drag source with
 *    `source instanceof AppDisplay.AppIcon ? source.app : null`, so only a real
 *    AppIcon can ever be accepted by the dock's drop target. A plain St.Button
 *    always resolves to null and can never be dropped.
 * 2. DockAppIcon.activate() dispatches on settings.clickAction (MINIMIZE,
 *    CYCLE_WINDOWS, FOCUS_OR_PREVIEWS...). That is correct for a dock icon and
 *    wrong for a launcher, where a click must always launch.
 *
 * AppIcon already supplies the draggable, the right-click and long-press
 * gestures, the keyboard popup-menu signal, and its own PopupMenuManager. Only
 * the menu implementation and the post-activation behaviour are overridden.
 */
export const LauncherAppIcon = GObject.registerClass(
class LauncherAppIcon extends AppDisplay.AppIcon {
    _init(app, launcher) {
        super._init(app, {
            isDraggable: true,
            popupMenuSide: Utils.getPosition(),
            // No caption under the icon. At grid density a title is ellipsised
            // to the point of being unreadable, so the name is shown as a
            // floating label on hover instead (see AppGridLauncher._showHoverLabel).
            showLabel: false,
            // Moot without a label, but AppViewItem's hover handler re-wraps an
            // ellipsised title between single- and multi-line, which changes the
            // item's height. Shell's app grid absorbs that because IconGrid sizes
            // items fixedly; this launcher uses a homogeneous Clutter.GridLayout
            // where it relayouts every row on every hover and visibly flickers.
            expandTitleOnHover: false,
        });

        this._launcher = launcher;
        // The launcher's selection and pool bookkeeping keys off _app.
        this._app = app;
        this.add_style_class_name('xdock-app-grid-launcher-item');

        this._draggable?.connect('drag-begin', () => this._launcher?.onDragBegin(this));
        this._draggable?.connect('drag-end', () => this._launcher?.onDragEnd(this));
        this._draggable?.connect('drag-cancelled', () => this._launcher?.onDragEnd(this));
    }

    setIconSize(size) {
        this.icon.setIconSize(size);
    }

    // DockAppIconMenu reads this surface off its source actor. It is defined on
    // DockAbstractAppIcon, which this class deliberately does not derive from
    // (see above), so the menu's contract is satisfied explicitly here.

    // Opts this icon into the menu's favourite and app-details actions, which
    // are what make "Pin to Dock" available on a launcher result.
    get canManageFavorites() {
        return true;
    }

    getWindows() {
        return this.app.get_windows();
    }

    getInterestingWindows() {
        return AppIcons.getInterestingWindows(this.getWindows(),
            Main.layoutManager.findIndexForActor(this));
    }

    get windowsCount() {
        return this.getInterestingWindows().length;
    }

    // Snap/Flatpak update state is tracked by the dock's own icons, which watch
    // the remote model. A transient launcher result never enters that state.
    get updating() {
        return false;
    }

    getSnapName() {
        return this.app.appInfo?.get_string('X-SnapInstanceName');
    }

    closeAllWindows() {
        const time = global.get_current_time();
        this.getInterestingWindows().forEach(window => window.delete(time));
    }

    // Launcher semantics: always launch. Ctrl/middle-click still opens a new
    // window, which is AppIcon's own behaviour.
    activate(button) {
        super.activate(button);
        this._launcher?.close();
    }

    popupMenu() {
        this.fake_release();
        this._draggable?.fakeRelease?.();

        if (!this._menu) {
            this._menu = new AppIcons.DockAppIconMenu(this);
            this._menu.connect('activate-window', (menu, window) => {
                if (window)
                    Main.activateWindow(window);
            });
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                this._launcher?.onIconMenuStateChanged(this, isPoppedUp);
                if (!isPoppedUp)
                    this.set_hover(false);
            });
            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);
        this.set_hover(true);
        this._menu.popup();
        // DockAppIconMenu._rebuildMenu() runs inside popup() and discards every
        // item, so the launcher's own entry has to be appended afterwards.
        this._launcher?.appendDrawerMenuItem(this._menu, this);
        // Removed in GNOME 50.
        this._menuManager.ignoreRelease?.();

        return false;
    }

    // The dock's icons own a floating label each; the launcher shares a single
    // one owned by AppGridLauncher, so this inherited hook stays inert.
    showLabel() {}

    // Mac-style pickup. AppIcon's default hands DND a plain icon texture at the
    // dock's icon size, which pops to a different size the instant a drag
    // starts. Match the grid's size instead and scale up slightly from under
    // the cursor so the icon reads as lifting off the surface.
    getDragActor() {
        const size = this._launcher?.iconSize ?? DEFAULT_ICON_SIZE;
        const actor = this.app.create_icon_texture(size);
        actor.add_style_class_name('xdock-app-grid-launcher-drag-actor');
        actor.set_pivot_point(0.5, 0.5);
        actor.set_scale(DRAG_PICKUP_FROM_SCALE, DRAG_PICKUP_FROM_SCALE);
        actor.ease({
            scale_x: DRAG_PICKUP_TO_SCALE,
            scale_y: DRAG_PICKUP_TO_SCALE,
            duration: launcherAnimationDuration(DRAG_PICKUP_DURATION),
            // motion-exception: overshoot is deliberate here. The token spec
            // (motion_easing.enter = easeOutCubic) governs reveals; direct
            // manipulation gets EASE_OUT_BACK so the icon reads as picked up
            // rather than merely faded in. See the note above.
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        return actor;
    }

    // AppViewItem's default collapses the source to half size and full
    // transparency, which on a grid reads as the icon being deleted. Leave a
    // faint depression in its place, the way a lifted dock icon does.
    scaleAndFade() {
        this.reactive = false;
        this.ease({
            scale_x: DRAG_SOURCE_GHOST_SCALE,
            scale_y: DRAG_SOURCE_GHOST_SCALE,
            opacity: DRAG_SOURCE_GHOST_OPACITY,
            duration: launcherAnimationDuration(DRAG_PICKUP_DURATION),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // Settle back with a slight overshoot so a cancelled drag springs into
    // place rather than snapping.
    undoScaleAndFade() {
        this.reactive = true;
        this.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            opacity: 255,
            duration: launcherAnimationDuration(DRAG_SETTLE_DURATION),
            // motion-exception: the settle overshoot, same reasoning as the
            // pickup above -- a cancelled drag should spring back, not glide.
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }
});

/**
 * A bounded, searchable app-grid popup anchored to the dash's Show
 * Applications button. Enumeration, parental-control checks and sorting are
 * cached until their source signals change. Query updates only filter cached
 * strings and reparent a capped set of reusable actors.
 */
export class AppGridLauncher {
    constructor() {
        this._destroyed = false;
        this._menu = null;
        this._menuManager = null;
        this._sourceButton = null;
        this._arrowSide = null;
        this._entry = null;
        this._box = null;
        this._grid = null;
        this._gridFillers = [];
        this._scrollView = null;
        this._touchPanGesture = null;
        this._statusLabel = null;
        this._hoverLabel = null;
        this._hoverLabelIcon = null;
        this._header = null;
        this._footer = null;
        this._sidebar = null;
        this._drawerList = null;
        this._drawerRows = new Map();
        this._activeDrawerId = null;
        this._draggingRow = null;
        this._drawerNameEntry = null;
        this._drawerMenu = null;
        this._drawerMenuManager = null;
        this._drawerMenuOpen = false;
        this._powerMenu = null;
        this._powerMenuManager = null;
        this._powerMenuOpen = false;
        this._drawerCreationOrigin = null;
        this._drawerFocusRequest = null;
        this._dropHighlightRow = null;
        this._deferredDrawerRender = false;
        this._dragMonitor = null;
        this._closingForDrag = false;
        this._dragCloseId = 0;
        this._drawers = null;

        this._iconMenuOpen = false;
        this._activeIconMenuIcon = null;
        this._closeRequestedWhileIconMenuOpen = null;
        this._draggingIcon = null;
        this._deferredCatalogRender = false;
        this._styledSelectionIndex = -1;

        this._catalog = [];
        this._catalogDirty = true;
        this._buttonsById = new Map();
        this._visibleButtons = [];
        this._buttonUseSerial = 0;
        this._selectedIndex = -1;
        this._columns = DEFAULT_GRID_COLUMNS;
        this._iconSize = DEFAULT_ICON_SIZE;
        this._layoutDirty = true;
        this._rtl = null;
        this._suppressEntryChange = false;
        this._restoreFocusOnClose = false;
        this._idleSources = new Set();
        this._layoutTask = new DeferredTask(
            callback => Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, callback),
            id => Utils.laterRemove(id));

        this._appSystem = null;
        this._appFavorites = null;
        this._parentalControls = null;
        this._interfaceSettings = null;
        this._signalsHandler = null;
        this._menuSignalsHandler = null;

        let signalsHandler = null;
        let menuSignalsHandler = null;
        try {
            const appSystem = Shell.AppSystem.get_default();
            const appFavorites = AppFavorites.getAppFavorites();
            const parentalControls = ParentalControlsManager.getDefault();
            const interfaceSettings = new Gio.Settings({
                schema_id: 'org.gnome.desktop.interface',
            });
            const drawers = new AppDrawers.DrawerStore();
            signalsHandler = new Utils.GlobalSignalsHandler();
            menuSignalsHandler = new Utils.GlobalSignalsHandler();

            // Commit the acquired resources only after every constructor above
            // succeeded. The catch path can therefore dispose a partial setup
            // without leaving global signal connections behind.
            this._appSystem = appSystem;
            this._appFavorites = appFavorites;
            this._parentalControls = parentalControls;
            this._interfaceSettings = interfaceSettings;
            this._drawers = drawers;
            this._signalsHandler = signalsHandler;
            this._menuSignalsHandler = menuSignalsHandler;

            this._signalsHandler.add([
                this._appSystem,
                'installed-changed',
                () => this._invalidateCatalog(),
            ], [
                this._appFavorites,
                'changed',
                () => this._invalidateCatalog(),
            ], [
                this._parentalControls,
                'app-filter-changed',
                () => this._invalidateCatalog(),
            ], [
                this._drawers.settings,
                'changed::folder-children',
                () => this._invalidateDrawers(),
            ], [
                this._interfaceSettings,
                'changed::text-scaling-factor',
                () => this._onLayoutChanged(),
            ], [
                Main.layoutManager,
                'monitors-changed',
                () => this._onLayoutChanged(),
            ], [
                global.display,
                'workareas-changed',
                () => this._onLayoutChanged(),
            ]);
        } catch (error) {
            this._tryCleanup('catalog signal handler', () => signalsHandler?.destroy());
            this._tryCleanup('menu signal handler', () => menuSignalsHandler?.destroy());
            this._signalsHandler = null;
            this._menuSignalsHandler = null;
            this._appSystem = null;
            this._appFavorites = null;
            this._parentalControls = null;
            this._interfaceSettings = null;
            this._destroyed = true;
            throw error;
        }
    }

    get isOpen() {
        return !!this._menu?.isOpen;
    }

    toggle(sourceButton) {
        if (this._destroyed)
            return;

        if (this.isOpen && this._sourceButton === sourceButton)
            this.close();
        else
            this.open(sourceButton);
    }

    open(sourceButton) {
        if (this._destroyed || !sourceButton?.mapped)
            return false;

        try {
            // The source actor and arrow side are fixed at construction time. A
            // different monitor's button therefore needs a new anchored menu.
            const arrowSide = Utils.getPosition();
            if (!this._menu || this._sourceButton !== sourceButton ||
                this._arrowSide !== arrowSide)
                this._rebuild(sourceButton, arrowSide);

            if (!this._applyResponsiveLayout()) {
                this._destroyMenu();
                return false;
            }

            // Closing the popup does not destroy its actors, so an abandoned
            // rename would otherwise still be showing its entry -- and its
            // stale text -- the next time the launcher opens.
            this._endDrawerCreation();
            // Every open starts on the quick-access view. Selection used to
            // persist, which would have meant that picking All Apps once made
            // it the landing view forever after.
            this._activeDrawerId = null;
            this._renderDrawers();
            this._setEntryText('');
            this._renderResults('');
            if (this._scrollView.vadjustment)
                this._scrollView.vadjustment.value = 0;
            PopupMenuUtils.open(this._menu);
            this._entry.grab_key_focus();
            return true;
        } catch (error) {
            this._destroyMenu();
            logError(error, 'Unable to open the XDock application launcher');
            return false;
        }
    }

    close({restoreFocus = false, animate = true} = {}) {
        if (this._destroyed || !this._menu)
            return;

        // These live in uiGroup, not in the popup, so they do not go away with
        // it. Left open they would float over a closed launcher.
        this._closeDrawerMenu();
        this._closePowerMenu();

        // A result's context menu pushes its own modal grab on top of this one,
        // so a programmatic close must dismiss the inner menu too rather than
        // leaving it orphaned over a closed launcher. Verified headlessly: no
        // grab and no active menu survives this path. Note the
        // open-state-changed signals actually fire launcher-then-menu -- the
        // launcher's own PopupMenuManager reacts to the focus change when the
        // inner boxpointer hides -- which is harmless because each manager
        // pops only the grab it pushed.
        if (this._iconMenuOpen) {
            this._closeRequestedWhileIconMenuOpen = {restoreFocus, animate};
            this._activeIconMenuIcon?._menu?.close();
            return;
        }

        if (!this.isOpen) {
            if (restoreFocus && this._sourceButton?.mapped)
                this._sourceButton.grab_key_focus();
            return;
        }

        this._restoreFocusOnClose ||= restoreFocus;
        this._hideHoverLabel({animate: false});
        PopupMenuUtils.close(this._menu, {animate});
    }

    /**
     * A result's context menu opened or closed. While one is open the launcher
     * must stay open (see close()) and must not rebuild its actors, because
     * DockAppIconMenu chains its own lifetime to the source icon's destroy.
     *
     * @param {LauncherAppIcon} icon the menu's source icon
     * @param {boolean} isOpen whether the menu is now popped up
     */
    onIconMenuStateChanged(icon, isOpen) {
        if (this._destroyed)
            return;

        this._iconMenuOpen = isOpen;
        this._activeIconMenuIcon = isOpen ? icon : null;
        if (isOpen) {
            // The menu covers the icon; a tooltip on top of it reads as a glitch.
            this._hideHoverLabel({animate: false});
            return;
        }

        const pending = this._closeRequestedWhileIconMenuOpen;
        this._closeRequestedWhileIconMenuOpen = null;
        if (pending) {
            this.close(pending);
            return;
        }

        this._flushDeferredDrawers();
        if (this._flushDeferredCatalog())
            return;

        if (this.isOpen && icon?.mapped)
            icon.grab_key_focus();
    }

    /**
     * A result is being dragged out, normally onto the dock to pin it. Close
     * the launcher so its modal grab stops swallowing the drag, but keep the
     * actor tree alive: close() only calls PopupMenuUtils.close(), while
     * AppViewItem._onDestroy() would call Main.overview.endItemDrag() and
     * corrupt the drag if the source were destroyed mid-flight.
     *
     * @param {LauncherAppIcon} icon the icon being dragged
     */
    onDragBegin(icon) {
        if (this._destroyed)
            return;

        this._cancelDragClose();
        this._draggingIcon = icon;
        this._hideHoverLabel({animate: false});
        this._iconMenuOpen = false;
        this._activeIconMenuIcon = null;

        // The launcher deliberately stays open: the drawer rows are inside the
        // popup and a drop onto one has to reach them. DND takes its own modal
        // grab (dnd.js Main.pushModal(_getEventHandlerActor())) and picks
        // targets with get_actor_at_pos() before walking _delegate.acceptDrop,
        // so this popup's grab was never what made the dock drop work -- the
        // close was. The close is therefore deferred until the pointer leaves.
        this._installDragMonitor();
    }

    _installDragMonitor() {
        if (this._dragMonitor)
            return;

        this._dragMonitor = {
            dragMotion: event => {
                this._onDragMotion(event);
                // MUST be CONTINUE. dnd.js returns early from
                // _updateDragHover() on any other result, which would stop
                // handleDragOver ever reaching the row under the pointer.
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _removeDragMonitor() {
        if (!this._dragMonitor)
            return;

        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    /**
     * Hit-test an actor in stage coordinates.
     *
     * Graphene.Rect exposes origin/size as fields in GJS; get_origin() and
     * get_size() do not exist and throw.
     *
     * @param {Clutter.Actor} actor actor to test
     * @param {number} x stage x
     * @param {number} y stage y
     * @returns {boolean|null} whether the point is inside, or null if the actor
     *   has no allocation to test against
     */
    _containsPoint(actor, x, y) {
        const extents = actor?.get_transformed_extents();
        const origin = extents?.origin;
        const size = extents?.size;
        if (!origin || !size)
            return null;

        return x >= origin.x && x <= origin.x + size.width &&
            y >= origin.y && y <= origin.y + size.height;
    }

    _onDragMotion(event) {
        if (this._destroyed || !this.isOpen || this._closingForDrag)
            return;

        const inside = this._containsPoint(this._menu?.actor, event.x, event.y);
        if (inside === null)
            return;

        // handleDragOver only ever fires for the row under the pointer, so the
        // last row lit stays lit once the drag moves off the sidebar into the
        // grid. This monitor sees every motion event, which makes it the one
        // place that can put the highlight out.
        if (this._containsPoint(this._sidebar, event.x, event.y) !== true)
            this._setDropHighlight(null);

        if (inside)
            return;

        // Drawer reordering stays inside the launcher; only an application
        // drag can hand off to the dock.
        if (!this._draggingIcon)
            return;

        // The drag has left for the dock. Release the popup so the drop lands,
        // but not from inside this callback: dnd.js has a destroy handler
        // connected to the picked target for the duration of the monitor loop,
        // and closing synchronously tears actors down underneath it.
        this._closingForDrag = true;
        this._removeDragMonitor();
        this._clearDropHighlights();
        const icon = this._draggingIcon;
        const menu = this._menu;
        this._dragCloseId = this._queueIdle('drag close', () => {
            this._dragCloseId = 0;
            this._closingForDrag = false;
            if (this._destroyed || this._draggingIcon !== icon || this._menu !== menu)
                return;

            this.close({animate: false});
            // Closing changes the actor under a stationary pointer. Ask
            // Shell to pick again so the dock's insertion placeholder appears
            // without requiring another mouse movement.
            icon._draggable?._queueUpdateDragHover?.();
        });
    }

    _cancelDragClose() {
        if (this._dragCloseId) {
            if (this._idleSources.has(this._dragCloseId))
                GLib.source_remove(this._dragCloseId);
            this._idleSources.delete(this._dragCloseId);
            this._dragCloseId = 0;
        }
        this._closingForDrag = false;
    }

    /**
     * @param {LauncherAppIcon} icon the icon that was dragged
     */
    onDragEnd(icon) {
        if (this._destroyed || this._draggingIcon !== icon)
            return;

        this._cancelDragClose();
        this._removeDragMonitor();
        this._draggingIcon = null;
        this._clearDropHighlights();
        this._flushDeferredDrawers();
        this._flushDeferredCatalog();
    }

    get iconSize() {
        return this._iconSize;
    }

    /**
     * Rebuild the drawer sidebar from the app-folders store.
     *
     * @param {boolean} preserveSelection keep the active drawer if it survives
     */
    _renderDrawers(preserveSelection = true) {
        if (!this._drawerList)
            return;

        // The rows about to be destroyed are what the drawer menu is anchored
        // to and what focus is owed to; neither reference survives this.
        this._closeDrawerMenu();
        this._drawerCreationOrigin = null;
        this._dropHighlightRow = null;
        // A reorder IS a folder change, so the settings watch rebuilds the
        // sidebar while the drag is still finishing. The dragged row is one of
        // the actors about to be destroyed.
        this._draggingRow = null;
        this._drawerList.destroy_all_children();
        this._drawerRows = new Map();

        const drawers = this._drawers.list();
        // All Apps is not in the folder list, so it must be exempted here or
        // selecting it and then creating a drawer would bounce the view back
        // to quick access.
        if (preserveSelection && this._activeDrawerId &&
            this._activeDrawerId !== ALL_APPS &&
            !drawers.some(drawer => drawer.id === this._activeDrawerId))
            this._activeDrawerId = null;
        else if (!preserveSelection)
            this._activeDrawerId = null;

        for (const drawer of drawers)
            this._drawerList.add_child(this._createDrawerRow(drawer.id, drawer.name));
        // Last, under the drawers: All Apps is the fallback you reach for, not
        // the starting point. The starting point is now the quick-access view,
        // which is what an _activeDrawerId of null selects.
        this._drawerList.add_child(this._createDrawerRow(ALL_APPS, __('All Apps')));

        this._updateDrawerSelection();
    }

    _createDrawerRow(id, text) {
        const row = new St.Button({
            style_class: 'xdock-app-grid-launcher-drawer',
            label: text,
            accessible_name: text,
            accessible_role: Atk.Role.LIST_ITEM,
            can_focus: true,
            x_expand: true,
        });
        row._drawerId = id;
        // Secondary click is how a drawer is created now, so the row has to be
        // told to report button three at all -- St.Button masks it by default.
        row.set_button_mask(St.ButtonMask.ONE | St.ButtonMask.THREE);
        row.connect('key-press-event', (actor, event) =>
            this._onDrawerRowKeyPress(row, event));
        row.connect('clicked', (actor, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                this._openDrawerMenu(row);
            else
                this._selectDrawer(id);
        });
        this._drawerRows.set(id, row);

        // Only real drawers can be picked up and reordered. All Apps is a view
        // pinned to the bottom, so it stays put.
        if (typeof id === 'string' && id)
            this._makeDrawerRowDraggable(row);

        // Drop target for TWO kinds of source: an app being filed into the
        // drawer, and another drawer row being reordered. DND resolves the
        // delegate off the picked actor, so the row itself carries the
        // protocol rather than the sidebar.
        row._delegate = {
            // Drag a PROXY, not the row. Without this dnd.js reparents the row
            // itself into the drag layer, it leaves the sidebar box, every row
            // below it shifts up by a row height, and the drop lands one row
            // past whatever the pointer was aimed at -- measured: dropping on
            // row 2 moved the drawer to the end of the list.
            getDragActor: () => {
                const proxy = new St.Label({
                    style_class: 'xdock-app-grid-launcher-drawer dragging',
                    text: row.label,
                });
                proxy.set_width(row.get_width());
                return proxy;
            },
            // Lets a cancelled drag snap back to the row it came from.
            getDragActorSource: () => row,
            handleDragOver: source => {
                if (this._isDrawerRowDrag(source))
                    return this._handleRowReorderOver(row, source);
                if (!this._canFileApp(id, source))
                    return DND.DragMotionResult.NO_DROP;
                this._setDropHighlight(row);
                return DND.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: source => {
                if (this._isDrawerRowDrag(source))
                    return this._acceptRowReorder(row, source);
                this._setDropHighlight(null);
                if (!this._canFileApp(id, source))
                    return false;
                return this._fileAppInDrawer(id, source.app.get_id());
            },
        };
        return row;
    }

    /**
     * Let a drawer row be picked up and dropped on another to reorder it.
     *
     * The draggable is created lazily on first press rather than at row
     * construction: _renderDrawers() destroys and rebuilds every row on any
     * folder change, and a reorder IS a folder change, so building a draggable
     * per row per rebuild would churn one for every row on every drop.
     *
     * @param {St.Button} row the drawer row
     */
    _makeDrawerRowDraggable(row) {
        const draggable = DND.makeDraggable(row, {restoreOnSuccess: false});
        row._draggable = draggable;
        draggable.connect('drag-begin', () => {
            this._draggingRow = row;
            this._closeDrawerMenu();
            this._hideHoverLabel({animate: false});
            // The row stays in place so the list does not reflow; dimming it is
            // what shows which one is in flight.
            row.add_style_class_name('dragging-source');
        });
        const end = () => {
            // Order matters: drop the in-flight reference and un-dim the row
            // while it is still alive, THEN let the deferred rebuild run. The
            // rebuild is what destroys this row.
            this._draggingRow = null;
            row.remove_style_class_name('dragging-source');
            this._clearDropHighlights();
            this._flushDeferredDrawers();
        };
        draggable.connect('drag-end', end);
        draggable.connect('drag-cancelled', end);
    }

    /**
     * @param {object} source drag source
     * @returns {boolean} whether this is a drawer row being reordered
     */
    _isDrawerRowDrag(source) {
        return !!this._draggingRow &&
            (source === this._draggingRow || source === this._draggingRow._delegate);
    }

    /**
     * Reordering feedback. Uses the same one-lit-row highlight as filing, so a
     * drag across the sidebar cannot leave a trail either way.
     *
     * @param {St.Button} row the row under the pointer
     * @returns {number} a DND.DragMotionResult
     */
    _handleRowReorderOver(row) {
        if (row === this._draggingRow || typeof row._drawerId !== 'string') {
            this._setDropHighlight(null);
            return DND.DragMotionResult.NO_DROP;
        }

        this._setDropHighlight(row);
        return DND.DragMotionResult.MOVE_DROP;
    }

    /**
     * Drop a dragged drawer onto another one.
     *
     * Dropping ON a row means "take its place": the dragged drawer is inserted
     * before the target when moving up the list, and after it when moving down,
     * which is what makes a drag downwards actually move past the target rather
     * than stopping short of it.
     *
     * @param {St.Button} row the row dropped on
     * @returns {boolean} whether the drop was taken
     */
    _acceptRowReorder(row) {
        const dragged = this._draggingRow;
        this._setDropHighlight(null);
        if (!dragged || row === dragged || typeof row._drawerId !== 'string')
            return false;

        const order = this._drawers.list().map(drawer => drawer.id);
        const from = order.indexOf(dragged._drawerId);
        const to = order.indexOf(row._drawerId);
        if (from === -1 || to === -1)
            return false;

        // Moving down: land after the target, so use whatever follows it as the
        // insertion point. Moving up: land on the target itself.
        const beforeId = from < to ? order[to + 1] ?? null : row._drawerId;
        return this._drawers.reorder(dragged._drawerId, beforeId);
    }

    // "All Apps" is a view, not a folder, so nothing can be filed into it. Both
    // halves of the drop protocol ask, so the row cannot light up as a valid
    // target and then refuse the drop -- which is what it did while only
    // acceptDrop knew about the null id.
    // Only a real drawer can hold an app. `typeof id === 'string'` rejects both
    // sentinels at once -- null (quick access) and the ALL_APPS Symbol -- which
    // matters because DrawerStore would otherwise create a folder named after
    // whatever it was handed.
    _canFileApp(id, source) {
        return typeof id === 'string' && !!id && !!source?.app &&
            source instanceof AppDisplay.AppIcon;
    }

    _fileAppInDrawer(id, appId) {
        if (!id)
            return false;

        const changed = this._drawers.addApp(id, appId);
        // The store writes app-folders, whose change signal re-renders the
        // sidebar; nothing more is needed on success.
        return changed;
    }

    /**
     * Add "Remove from <drawer>" to a result's context menu.
     *
     * Only while a drawer is the active filter: an app can belong to several
     * drawers, and outside that context there is no unambiguous target. This
     * is the other half of drag-to-file -- without it apps can be put into a
     * drawer here but only taken out from the Shell's app grid.
     *
     * @param {PopupMenu.PopupMenu} menu the result's freshly rebuilt menu
     * @param {LauncherAppIcon} icon the result the menu belongs to
     */
    appendDrawerMenuItem(menu, icon) {
        const id = this._activeDrawerId;
        // Same string test _canFileApp uses: quick access (null) and All Apps
        // (a Symbol) are views, not folders, so nothing can be removed FROM
        // them either.
        if (!menu || !icon || typeof id !== 'string' || !id)
            return;

        const drawer = this._drawers.list().find(entry => entry.id === id);
        if (!drawer)
            return;

        const appId = icon._app?.get_id();
        if (!appId || !this._drawers.appIds(id).includes(appId))
            return;

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const item = new PopupMenu.PopupMenuItem(
            __('Remove from %s').format(drawer.name));
        item.connect('activate', () => this._removeAppFromDrawer(id, appId));
        menu.addMenuItem(item);
    }

    _removeAppFromDrawer(id, appId) {
        if (!this._drawers.removeApp(id, appId))
            return;

        // Only folder-children is watched, so a membership change does not
        // re-render by itself. The removed result must leave the grid now, or
        // it sits there until the drawer is reselected.
        this._renderResults(this._entry?.get_text() ?? '');
    }

    /**
     * Light exactly one drawer row, or none.
     *
     * dnd.js has no drag-leave callback: it only ever calls handleDragOver on
     * the row currently under the pointer, so a row that lit up stayed lit
     * after the pointer moved on and a drag across the sidebar left a trail of
     * highlighted drawers behind it. Tracking the lit row here is what makes
     * the highlight follow the pointer instead of accumulating.
     *
     * @param {St.Button|null} row the row under the pointer, or null
     */
    _setDropHighlight(row) {
        if (this._dropHighlightRow === row)
            return;

        this._dropHighlightRow?.remove_style_class_name('drop-target');
        this._dropHighlightRow = row ?? null;
        row?.add_style_class_name('drop-target');
    }

    _clearDropHighlights() {
        this._dropHighlightRow = null;
        for (const row of this._drawerRows?.values() ?? [])
            row.remove_style_class_name('drop-target');
    }

    _selectDrawer(id) {
        if (this._activeDrawerId === id)
            return;

        this._activeDrawerId = id;
        this._updateDrawerSelection();
        this._setEntryText('');
        this._renderResults('');
    }

    _updateDrawerSelection() {
        for (const [id, row] of this._drawerRows?.entries() ?? []) {
            if (id === this._activeDrawerId) {
                row.add_style_class_name('selected');
                row.add_accessible_state(Atk.StateType.SELECTED);
            } else {
                row.remove_style_class_name('selected');
                row.remove_accessible_state(Atk.StateType.SELECTED);
            }
        }

        const request = this._drawerFocusRequest;
        this._drawerFocusRequest = null;
        const focusedRow = request ? this._drawerRows?.get(request.id) : null;
        if (focusedRow?.mapped) {
            focusedRow.grab_key_focus();
            this._updateStatusText(request.message);
        }
    }

    /**
     * @param {string} iconName symbolic icon name
     * @param {string} label accessible name and tooltip text
     * @param {Function} onClick activation handler
     * @returns {St.Button} a footer action button
     */
    _createFooterButton(iconName, label, onClick) {
        const button = new St.Button({
            style_class: 'xdock-app-grid-launcher-footer-button',
            accessible_name: label,
            can_focus: true,
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
            }),
        });
        button.connect('clicked', () => onClick());
        button.connect('key-press-event', (actor, event) =>
            this._onFooterKeyPress(button, event));
        return button;
    }

    /**
     * Open GNOME Settings.
     *
     * Resolved through AppSystem rather than spawned, so it reuses a running
     * window instead of starting a second copy. The id is org.gnome.Settings
     * on this Shell; gnome-control-center.desktop does not resolve.
     *
     * The launcher is closed FIRST and deliberately: it holds a modal grab, and
     * activating an app underneath one is the same mistake that made the drawer
     * context menu unusable.
     */
    _openSettings() {
        const app = Shell.AppSystem.get_default()
            .lookup_app('org.gnome.Settings.desktop');
        if (!app) {
            this._updateStatusText(__('Settings is not available'));
            return;
        }

        this.close();
        app.activate();
    }

    /**
     * Log out, restart or power off, from the footer's power button.
     *
     * Every item is gated on the matching SystemActions `can*` property, which
     * is not defensive politeness: activatePowerOff() and friends THROW when
     * the action is unavailable. The properties are also live -- they change
     * with inhibitors and with who else is logged in -- so the menu is built at
     * open time rather than once.
     *
     * No confirmation is added here. All three go through
     * org.gnome.SessionManager, which puts up its own confirmation dialog.
     *
     * @param {St.Button} button the power button, which the menu anchors to
     */
    _openPowerMenu(button) {
        if (!this._menu || !button?.mapped)
            return;

        this._closeDrawerMenu();

        if (!this._powerMenu) {
            this._powerMenuManager = new PopupMenu.PopupMenuManager(button);
            this._powerMenu = new PopupMenu.PopupMenu(button, 0.5,
                Utils.getPosition());
            // Must not return a value: PopupMenu uses the GJS Signals mixin,
            // whose emit() stops on the first handler returning true, which
            // would skip the manager's own handler and its Main.pushModal.
            this._powerMenu.connect('open-state-changed', (menu, isOpen) => {
                this._powerMenuOpen = isOpen;
            });
            Utils.addActor(Main.uiGroup, this._powerMenu.actor);
            this._powerMenu.actor.hide();
            this._powerMenuManager.addMenu(this._powerMenu);
        }

        const actions = SystemActions.getDefault();
        const entries = [
            [__('Log Out…'), actions.canLogout, () => actions.activateLogout()],
            [__('Restart…'), actions.canRestart, () => actions.activateRestart()],
            [__('Power Off…'), actions.canPowerOff, () => actions.activatePowerOff()],
        ];

        this._powerMenu.removeAll();
        for (const [label, available, activate] of entries) {
            const item = new PopupMenu.PopupMenuItem(label);
            if (!available)
                item.setSensitive(false);
            else
                item.connect('activate', () => this._runSystemAction(activate));
            this._powerMenu.addMenuItem(item);
        }

        PopupMenuUtils.open(this._powerMenu);
    }

    // The session dialog needs the grab this popup is holding, so the launcher
    // goes away first. Deferred past the current dispatch for the same reason
    // _beginDrawerCreation defers its focus grab: this runs from the menu
    // item's activate handler, while that menu still holds its own grab.
    _runSystemAction(activate) {
        this.close();
        this._queueIdle('system action', () => {
            try {
                activate();
            } catch (error) {
                logError(error, 'Unable to run the requested system action');
            }
        });
    }

    _closePowerMenu() {
        if (this._powerMenuOpen && this._powerMenu)
            PopupMenuUtils.close(this._powerMenu, {animate: false});
    }

    /**
     * Drawer row context menu: the only way to create a drawer.
     *
     * It replaces a permanent "New Drawer…" row at the foot of the sidebar,
     * which read as one more drawer rather than as an action. It also carries
     * Delete for every row that is a real drawer.
     *
     * One menu is re-anchored per row rather than one menu per drawer.
     * Verified on GNOME 50: PopupMenu does NOT connect to its source actor's
     * destroy, so a per-row menu would outlive the row and leak into uiGroup
     * every time the sidebar rebuilt. Re-anchoring leaves a dangling
     * sourceActor between a rebuild and the next open, which is safe only
     * because _renderDrawers() closes the menu before destroying the rows.
     *
     * @param {St.Button} row the drawer row the menu belongs to
     */
    _openDrawerMenu(row) {
        if (!this._menu || !row?.mapped)
            return;

        // Only one of the popup's own menus at a time. The grab would normally
        // dismiss the other for us, but the keyboard openers (Menu, Shift+F10)
        // reach here without a button press, so nothing else would.
        this._closeDrawerMenu();
        this._closePowerMenu();

        if (!this._drawerMenu) {
            // Its own manager, not the launcher's: a PopupMenuManager closes
            // its siblings, so sharing one would close the launcher underneath
            // this menu. Same two-manager model the result icons already use.
            this._drawerMenuManager = new PopupMenu.PopupMenuManager(this._sidebar);
            this._drawerMenu = new PopupMenu.PopupMenu(row, 0.5, Utils.getPosition());
            this._drawerMenu.actor.add_style_class_name(
                'xdock-app-grid-launcher-drawer-menu');
            // MUST NOT return a value. PopupMenu uses the GJS Signals mixin,
            // whose emit() stops calling handlers as soon as one returns true
            // -- so the concise `(menu, isOpen) => (this._drawerMenuOpen =
            // isOpen)` form swallowed the emission on open and the manager's
            // own _onMenuOpenState, connected after this one by addMenu(),
            // never ran. That is what skipped Main.pushModal: the menu opened
            // with no grab of its own, the launcher's grab stayed on top and
            // kept capturing, and the first click on a menu item reached
            // PopupMenuManager._onCapturedEvent as a press outside the
            // launcher -- which closed the launcher and ate the click.
            this._drawerMenu.connect('open-state-changed', (menu, isOpen) => {
                this._drawerMenuOpen = isOpen;
            });
            Utils.addActor(Main.uiGroup, this._drawerMenu.actor);
            this._drawerMenu.actor.hide();
            this._drawerMenuManager.addMenu(this._drawerMenu);
        }

        // Rebuilt on every open, not once: Delete names the drawer it acts on,
        // "All Apps" has no drawer to delete, and an item built once would keep
        // acting on whichever row the menu happened to be created for -- a row
        // the next folder change destroys.
        this._drawerMenu.removeAll();
        const create = new PopupMenu.PopupMenuItem(__('New Drawer…'));
        create.connect('activate', () => this._beginDrawerCreation(row));
        this._drawerMenu.addMenuItem(create);

        // "All Apps" is a view over the whole catalog rather than a folder, so
        // there is nothing there to delete. The test is on the TYPE, not on
        // truthiness: All Apps carries a Symbol id, and a Symbol is truthy, so
        // `if (id)` offered Delete "All Apps" -- which would have handed a
        // Symbol to DrawerStore.delete() and thrown building the settings path.
        const id = row._drawerId;
        if (typeof id === 'string' && id) {
            // Separated from New Drawer so the destructive item is not the
            // neighbour of the one people reach for most.
            this._drawerMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const remove = new PopupMenu.PopupMenuItem(
                __('Delete “%s”…').format(row.label));
            remove.connect('activate', () => this._confirmDrawerDeletion(id, row.label));
            this._drawerMenu.addMenuItem(remove);
        }

        // PopupMenu.open() re-runs BoxPointer.setPosition(this.sourceActor),
        // so re-anchoring is just this assignment.
        this._drawerMenu.sourceActor = row;
        this._drawerCreationOrigin = row;
        PopupMenuUtils.open(this._drawerMenu);
    }

    /**
     * Ask before deleting a drawer. No app is lost either way -- All Apps is
     * the unfiltered catalog, so a drawer is a filter over apps rather than a
     * place that holds them -- but the folder goes from the Shell's app grid
     * too, and there is no undo. Cancel is the first button, so it is what
     * has the focus.
     *
     * A system-modal dialog closes every open popup menu, this one included
     * (PopupMenu closes itself on 'system-modal-opened'), so the launcher
     * steps aside first and opens again once the question is answered. The
     * dialog waits for the current dispatch to finish for the same reason
     * _runSystemAction() does: this runs from the drawer menu's item, while
     * that menu still holds its grab.
     *
     * @param {string} id drawer id
     * @param {string} name drawer name, for the question
     */
    _confirmDrawerDeletion(id, name) {
        const source = this._sourceButton;
        this.close();
        this._queueIdle('drawer deletion question', () => {
            this._deleteDialog?.close();

            const dialog = new ModalDialog.ModalDialog();
            dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
                title: __('Delete “%s”?').format(name),
                description: __('The drawer goes from the app grid too. ' +
                    'Its apps stay installed, in All Apps.'),
            }));
            dialog.setButtons([{
                label: _('Cancel'),
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
            }, {
                label: __('Delete'),
                action: () => {
                    this._deleteDrawer(id);
                    dialog.close();
                },
            }]);
            dialog.connect('closed', () => {
                if (this._deleteDialog !== dialog)
                    return;

                this._deleteDialog = null;
                this._queueIdle('reopening after the drawer question', () => this.open(source));
            });
            this._deleteDialog = dialog;
            dialog.open();
        });
    }

    /**
     * Delete a drawer, returning its apps to All Apps.
     *
     * Nothing is re-rendered here: delete() writes folder-children, and the
     * watch on that key runs _renderDrawers(), which drops the selection when
     * the active drawer is the one that just went away -- that is what returns
     * the grid to All Apps -- and then re-renders the results.
     *
     * @param {string} id drawer id
     */
    _deleteDrawer(id) {
        if (this._destroyed)
            return;

        if (!this._drawers.delete(id))
            this._updateStatusText(__('That drawer could not be deleted'));
    }

    // Both halves of the guard matter. The flag says a menu was opened; the
    // reference says it still exists. _destroyMenu() clears both together, but
    // close() runs on paths that can interleave with a teardown, and passing a
    // null menu into PopupMenuUtils.close() throws before the launcher closes.
    _closeDrawerMenu() {
        if (this._drawerMenuOpen && this._drawerMenu)
            PopupMenuUtils.close(this._drawerMenu, {animate: false});
    }

    // Show the name entry at the foot of the sidebar. It is a permanent child,
    // so this costs one visibility toggle rather than the destroy-and-rebuild
    // the actor swap used to need.
    //
    // @param {St.Button} [origin] row to hand focus back to when creation ends
    _beginDrawerCreation(origin = null) {
        const entry = this._drawerNameEntry;
        if (!entry || entry.visible)
            return;

        this._drawerCreationOrigin = origin ?? this._drawerCreationOrigin;
        entry.set_text('');
        entry.remove_style_class_name('error');
        entry.show();
        // Focus cannot be taken here. This runs from the context menu item's
        // activate handler, while the menu still holds its modal grab, and
        // popping that grab restores key focus to whatever held it before --
        // the search entry. Grabbing now is silently undone a moment later,
        // which left the name entry visible but not typeable. Deferring past
        // the current dispatch is what makes it actually receive the name.
        this._queueIdle('drawer name focus', () => {
            if (this._drawerNameEntry === entry && entry.visible)
                entry.grab_key_focus();
        });
    }

    _endDrawerCreation() {
        const entry = this._drawerNameEntry;
        if (!entry?.visible)
            return;

        entry.hide();
        // Back to the row the menu was opened from. Handing focus to the search
        // entry instead threw it across the popup on every cancel.
        const origin = this._drawerCreationOrigin;
        this._drawerCreationOrigin = null;
        if (origin?.mapped)
            origin.grab_key_focus();
        else
            this._entry?.grab_key_focus();
    }

    _commitDrawerCreation() {
        const entry = this._drawerNameEntry;
        if (!entry?.visible)
            return;

        // Enter on an empty field means "never mind", as in every other
        // new-folder field. It used to raise a validation error instead, which
        // left no way out of the entry except Escape.
        if (!entry.get_text().trim()) {
            this._endDrawerCreation();
            return;
        }

        const existing = this._drawers.list().map(drawer => drawer.name);
        const result = validateDrawerName(entry.get_text(), existing);
        if (!result.ok) {
            // Keep the entry focused so the name can be corrected rather than
            // silently dropping what was typed.
            entry.add_style_class_name('error');
            this._updateStatusText(result.reason === 'duplicate'
                ? __('A drawer with that name already exists')
                : __('That drawer name is too long'));
            return;
        }

        this._endDrawerCreation();
        // The store writes folder-children, and the watch on that key performs
        // the one sidebar rebuild. Committing used to render the sidebar three
        // times over (cancel, explicit, settings signal) and the grid twice,
        // which is what made creating a drawer stutter.
        //
        // The new drawer is deliberately NOT selected: it is empty by
        // definition, so selecting it would swap the apps the user is about to
        // drag into it for a blank grid.
        this._drawers.create(result.name);
    }

    /**
     * Show the hovered result's name as a floating label above it.
     *
     * One label is shared by the whole grid rather than one per result: the
     * pool holds up to 144 actors, and a caption under every icon is what made
     * the names unreadable in the first place. It lives in Main.uiGroup so the
     * ScrollView cannot clip it.
     *
     * @param {LauncherAppIcon} icon the hovered result
     */
    _showHoverLabel(icon) {
        if (!this._hoverLabel || !icon?.mapped || !this.isOpen)
            return;

        // A result's own context menu covers the icon; a tooltip over it reads
        // as a glitch.
        if (this._iconMenuOpen || this._draggingIcon)
            return;

        this._hoverLabelIcon = icon;
        this._hoverLabel.set_text(icon._app.get_name());
        this._hoverLabel.show();
        // Opening a popup menu raises it to the top of uiGroup, so the label,
        // added after the launcher's popup, still ends up underneath it --
        // and the popup is exactly what it has to float over.
        Main.uiGroup.set_child_above_sibling(this._hoverLabel, null);

        const [iconX, iconY] = icon.get_transformed_position();
        const [iconWidth] = icon.get_transformed_size();
        // Allocation can still hold the previous app's caption here. Measure
        // the new text so crossing between short and long names stays centred.
        const [, , labelWidth, labelHeight] = this._hoverLabel.get_preferred_size();

        let x = Math.round(iconX + (iconWidth - labelWidth) / 2);
        const y = Math.round(iconY - labelHeight - HOVER_LABEL_GAP);

        // Keep it on-screen for results in the leftmost and rightmost columns.
        const monitor = Main.layoutManager.findMonitorForActor(icon);
        if (monitor) {
            const min = monitor.x + HOVER_LABEL_GAP;
            const max = monitor.x + monitor.width - labelWidth - HOVER_LABEL_GAP;
            x = Math.max(min, Math.min(max, x));
        }

        this._hoverLabel.set_position(x, y);
        this._hoverLabel.remove_all_transitions();
        this._hoverLabel.ease({
            opacity: 255,
            duration: launcherAnimationDuration(HOVER_LABEL_SHOW_TIME),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _hideHoverLabel({animate = true, source = null} = {}) {
        if (source && source !== this._hoverLabelIcon)
            return;
        this._hoverLabelIcon = null;
        if (!this._hoverLabel)
            return;

        this._hoverLabel.remove_all_transitions();
        if (!animate) {
            this._hoverLabel.opacity = 0;
            this._hoverLabel.hide();
            return;
        }

        this._hoverLabel.ease({
            opacity: 0,
            duration: launcherAnimationDuration(HOVER_LABEL_HIDE_TIME),
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => this._hoverLabel?.hide(),
        });
    }

    _flushDeferredCatalog() {
        if (!this._deferredCatalogRender)
            return false;

        this._deferredCatalogRender = false;
        if (this.isOpen && this._entry)
            this._renderResults(this._entry.get_text());
        return true;
    }

    /**
     * Schedule one launcher-owned idle and retain its source until dispatch.
     * Destroy cancels every pending source before releasing actor references,
     * so no callback can wake up against a torn-down launcher.
     *
     * @param {string} operation description used if the callback throws
     * @param {Function} callback one-shot work
     * @returns {number} GLib source id, or 0 after destruction
     */
    _queueIdle(operation, callback) {
        if (this._destroyed)
            return 0;

        let sourceId = 0;
        sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleSources.delete(sourceId);
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;

            try {
                callback();
            } catch (error) {
                logError(error, `Unable to complete launcher ${operation}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._idleSources.add(sourceId);
        return sourceId;
    }

    _cancelIdleSources() {
        const errors = [];
        for (const sourceId of this._idleSources) {
            try {
                GLib.source_remove(sourceId);
                this._idleSources.delete(sourceId);
            } catch (error) {
                errors.push(error);
            }
        }

        if (errors.length === 1)
            throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, 'Failed to cancel launcher idle sources');
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this._tryCleanup('drawer deletion dialog', () => this._deleteDialog?.close());
        this._tryCleanup('layout callback', () => this._layoutTask?.deactivate());
        this._tryCleanup('idle sources', () => this._cancelIdleSources());
        this._tryCleanup('drag monitor', () => this._removeDragMonitor());
        const signalsHandler = this._signalsHandler;
        this._signalsHandler = null;
        this._tryCleanup('catalog signal handler', () => signalsHandler?.destroy());
        this._destroyMenu();
        const menuSignalsHandler = this._menuSignalsHandler;
        this._menuSignalsHandler = null;
        this._tryCleanup('menu signal handler', () => menuSignalsHandler?.destroy());
        this._catalog = [];
        this._tryCleanup('drawer store', () => this._drawers?.destroy());
        this._drawers = null;
        this._appSystem = null;
        this._appFavorites = null;
        this._parentalControls = null;
        this._interfaceSettings = null;
        this._layoutTask = null;
    }

    _tryCleanup(resource, callback) {
        try {
            callback();
        } catch (error) {
            logError(error, `Failed to clean up application launcher ${resource}`);
        }
    }

    _rebuild(sourceButton, arrowSide) {
        this._destroyMenu();

        let menu = null;
        let menuManager = null;
        let hoverLabel = null;
        let sidebar = null;
        let drawerList = null;
        let drawerNameEntry = null;
        let footer = null;
        let powerButton = null;
        try {
            menu = new PopupMenu.PopupMenu(sourceButton, 0.5, arrowSide);
            menu.actor.add_style_class_name('xdock-app-grid-launcher');

            const entry = new St.Entry({
                style_class: 'xdock-app-grid-launcher-entry search-entry',
                hint_text: __('Search apps'),
                accessible_name: __('Search applications'),
                can_focus: true,
                x_expand: true,
            });
            entry.clutter_text.connect('text-changed', () => {
                if (!this._suppressEntryChange)
                    this._renderResults(entry.get_text());
            });
            entry.clutter_text.connect('key-press-event',
                (actor, event) => this._onEntryKeyPress(event));

            // St.ScrollView only accepts an StScrollable child. St.Viewport
            // supplies that contract while still allowing an explicit grid
            // layout for the bounded result actors on GNOME Shell 50 and 51.
            const grid = new St.Viewport({
                style_class: 'xdock-app-grid-launcher-grid',
                accessible_name: __('Application results'),
                accessible_role: Atk.Role.GROUPING,
                // START, not the default FILL. The ScrollView has a fixed
                // height, so a filling grid was allocated all 680px of it and
                // row_homogeneous then split that between however few rows
                // existed: a drawer holding three apps got one 680px-tall row,
                // and the tiles stretched down the whole popup. Taking natural
                // height instead keeps a row the height of an icon and leaves
                // the leftover space empty, which is what makes a tile the same
                // size no matter how many apps are showing. The grid still
                // grows past the viewport and scrolls when there are enough
                // results; it is only the shrinking case that changes.
                y_align: Clutter.ActorAlign.START,
                layout_manager: new Clutter.GridLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    column_homogeneous: true,
                    row_homogeneous: true,
                }),
            });

            const scrollView = new Utils.DockScrollView({
                style_class: 'xdock-app-grid-launcher-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                // An overlay scrollbar preserves the homogeneous column widths.
                overlay_scrollbars: true,
                enable_mouse_scrolling: true,
                x_expand: true,
                y_expand: true,
                child: grid,
            });
            // A floating label is outside the viewport. Hide it as soon as
            // scrolling moves its source, including wheel, keyboard and touch
            // adjustment changes; the next hover/focus displays a fresh label.
            this._menuSignalsHandler.add(scrollView.vadjustment, 'notify::value',
                () => this._hideHoverLabel({animate: false}));

            let touchPanGesture = null;
            if (scrollView.set_touch_scrolling instanceof Function) {
                // GNOME Shell 51 gained native St.ScrollView touch scrolling.
                scrollView.set_touch_scrolling(true);
            } else {
                // GNOME Shell 50 uses the same PanGesture fallback as its
                // built-in search results view.
                touchPanGesture = new Clutter.PanGesture();
                touchPanGesture.connect('pan-update',
                    gesture => this._onPanUpdate(gesture));
                scrollView.add_action(touchPanGesture);
            }

            const statusLabel = new St.Label({
                style_class: 'xdock-app-grid-launcher-status',
                accessible_role: Atk.Role.STATUSBAR,
                x_align: Clutter.ActorAlign.END,
            });

            const box = new St.BoxLayout({
                style_class: 'xdock-app-grid-launcher-box',
                accessible_name: __('Application launcher'),
                accessible_role: Atk.Role.PANEL,
                vertical: true,
            });
            box.add_child(entry);
            box.add_child(scrollView);
            box.add_child(statusLabel);

            // Drawer sidebar. Rows are drop targets, so this is a sibling of
            // the grid rather than part of it: a drop onto a row must not be
            // confused with a drop onto a result.
            sidebar = new St.BoxLayout({
                style_class: 'xdock-app-grid-launcher-sidebar',
                accessible_name: __('Drawers'),
                accessible_role: Atk.Role.LIST,
                vertical: true,
            });
            sidebar.set_style(`width: ${SIDEBAR_WIDTH}px;`);

            // Only the drawer rows are rebuilt when the folder list changes.
            // The name entry below lives outside that subtree so creating a
            // drawer never destroys the control being used to create it.
            drawerList = new St.BoxLayout({
                style_class: 'xdock-app-grid-launcher-drawer-list',
                vertical: true,
            });

            // Shown at the foot of the sidebar while a name is being typed,
            // after "New Drawer…" is picked from a drawer row's context menu.
            // Toggling visibility rather than swapping actors is what keeps the
            // sidebar from flickering through a full rebuild on every begin,
            // cancel and commit.
            drawerNameEntry = new St.Entry({
                style_class: 'xdock-app-grid-launcher-drawer-entry',
                hint_text: __('Drawer name'),
                accessible_name: __('New drawer name'),
                can_focus: true,
                x_expand: true,
            });
            drawerNameEntry.hide();
            drawerNameEntry.clutter_text.connect('activate',
                () => this._commitDrawerCreation());
            // Clear a rejected name's styling as soon as it is being corrected.
            drawerNameEntry.clutter_text.connect('text-changed',
                () => drawerNameEntry.remove_style_class_name('error'));
            drawerNameEntry.clutter_text.connect('key-press-event', (actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this._endDrawerCreation();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            sidebar.add_child(drawerList);
            sidebar.add_child(drawerNameEntry);

            const content = new St.BoxLayout({
                style_class: 'xdock-app-grid-launcher-content',
                vertical: false,
            });
            content.add_child(sidebar);
            content.add_child(box);

            // Who is logged in. Shell's own UserWidget rather than an avatar
            // assembled here: it already resolves the AccountsService icon
            // file, falls back to a generic avatar when there is no picture
            // set, and re-renders itself on notify::is-loaded, which matters
            // because the user object is not populated synchronously.
            const header = new St.BoxLayout({
                style_class: 'xdock-app-grid-launcher-header',
                accessible_role: Atk.Role.PANEL,
                vertical: false,
            });
            // Contained: the header is decoration, and decoration must never be
            // able to stop the launcher opening. A throw here would otherwise
            // propagate out of _rebuild(), destroy the partial menu and leave
            // the Show Applications button doing nothing at all -- AccountsService
            // is a D-Bus service and can be unavailable.
            try {
                const user = AccountsService.UserManager.get_default()
                    .get_user(GLib.get_user_name());
                const userWidget = new UserWidget.UserWidget(user,
                    Clutter.Orientation.HORIZONTAL);
                userWidget.x_align = Clutter.ActorAlign.START;
                userWidget.y_align = Clutter.ActorAlign.CENTER;
                header.add_child(userWidget);
            } catch (error) {
                logError(error, 'Unable to show the launcher user header');
            }

            // Footer: system actions, bottom left.
            footer = new St.BoxLayout({
                style_class: 'xdock-app-grid-launcher-footer',
                accessible_role: Atk.Role.PANEL,
                vertical: false,
            });
            // Adwaita's standard gear rather than org.gnome.Settings-symbolic,
            // which only exists in Yaru: both render a gear here, but the
            // standard name survives an icon-theme change.
            footer.add_child(this._createFooterButton(
                'preferences-system-symbolic', __('Settings'),
                () => this._openSettings()));

            // Match Shell's own quick-settings lock action. The live binding
            // hides the control when session policy forbids locking, while
            // _runSystemAction() releases this popup's modal grab before the
            // screen shield takes over. Unlike the power actions, locking is
            // deliberately immediate and has no confirmation step.
            const systemActions = SystemActions.getDefault();
            const lockButton = this._createFooterButton(
                'system-lock-screen-symbolic', C_('action', 'Lock Screen'),
                () => this._runSystemAction(() => systemActions.activateLockScreen()));
            systemActions.bind_property(
                'can-lock-screen', lockButton, 'visible',
                GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE);
            footer.add_child(lockButton);

            powerButton = this._createFooterButton(
                'system-shutdown-symbolic', __('Power'),
                () => this._openPowerMenu(powerButton));
            footer.add_child(powerButton);

            const root = new St.BoxLayout({
                style_class: 'xdock-app-grid-launcher-root',
                vertical: true,
            });
            root.add_child(header);
            root.add_child(content);
            root.add_child(footer);

            const menuItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            // This is a content container rather than an ornamented menu item.
            if (menuItem._ornamentIcon)
                menuItem.remove_child(menuItem._ornamentIcon);
            menuItem.add_child(root);
            menu.addMenuItem(menuItem);

            // Popup blur is a sibling behind the menu in uiGroup. Expanding
            // content damage to the whole menu keeps it from sampling pixels
            // left over from the previous blurred frame on hover or scroll.
            // The zero-size clone observes only content, never itself or the
            // blur actor, and is destroyed with the menu.
            menu.box.add_child(new WholeSurfaceRedraw({source: root}));

            menuManager = new PopupMenu.PopupMenuManager(sourceButton);
            Utils.addActor(Main.uiGroup, menu.actor);
            menu.actor.hide();

            // Shared hover label. In uiGroup, not the menu, so the ScrollView
            // never clips it and it can sit above the popup's top edge.
            hoverLabel = new St.Label({
                style_class: 'dash-label xdock-app-grid-launcher-hover-label',
                opacity: 0,
            });
            hoverLabel.hide();
            Utils.deferActorDestroy(hoverLabel);
            Utils.addActor(Main.uiGroup, hoverLabel);

            // Commit only the complete actor graph. A failure above leaves all
            // state local and the catch block destroys the partial menu tree.
            this._sourceButton = sourceButton;
            this._arrowSide = arrowSide;
            this._menu = menu;
            this._menuManager = menuManager;
            this._hoverLabel = hoverLabel;
            this._header = header;
            this._footer = footer;
            this._sidebar = sidebar;
            this._drawerList = drawerList;
            this._drawerNameEntry = drawerNameEntry;
            this._entry = entry;
            this._box = box;
            this._grid = grid;
            this._scrollView = scrollView;
            this._touchPanGesture = touchPanGesture;
            this._statusLabel = statusLabel;

            // PopupMenuManager consumes Escape during event capture before a
            // focused entry/button sees it. Observe it first so the subsequent
            // close restores focus to the dock source rather than nowhere.
            this._menuSignalsHandler.add(
                menu.actor,
                'captured-event',
                (actor, event) => {
                    // While a result's context menu is up, Escape belongs to
                    // that menu: it closes the innermost grab only and the
                    // launcher stays open, so focus must not be handed back to
                    // the dock button.
                    if (event.type() === Clutter.EventType.KEY_PRESS &&
                        event.get_key_symbol() === Clutter.KEY_Escape &&
                        !this._iconMenuOpen && !this._drawerMenuOpen &&
                        !this._powerMenuOpen)
                        this._restoreFocusOnClose = true;
                    return Clutter.EVENT_PROPAGATE;
                });
            menuManager.addMenu(menu);
            this._menuSignalsHandler.add([
                menu,
                'open-state-changed',
                (openedMenu, isOpen) => this._onOpenStateChanged(isOpen),
            ], [
                sourceButton,
                'destroy',
                () => this._destroyMenu(),
            ]);
        } catch (error) {
            if (this._menu === menu) {
                this._destroyMenu();
            } else {
                this._tryCleanup('partial menu manager', () =>
                    menuManager?.removeMenu(menu));
                this._tryCleanup('partial menu', () => menu?.destroy());
            }
            throw error;
        }
    }

    _destroyMenu() {
        this._cancelDragClose();
        this._hoverLabelIcon = null;
        this._tryCleanup('pending layout callback', () => this._layoutTask?.cancel());
        const menu = this._menu;
        const menuManager = this._menuManager;
        const hoverLabel = this._hoverLabel;
        const drawerMenu = this._drawerMenu;
        const drawerMenuManager = this._drawerMenuManager;
        const powerMenu = this._powerMenu;
        const powerMenuManager = this._powerMenuManager;
        this._menu = null;
        this._header = null;
        this._footer = null;
        this._sidebar = null;
        this._drawerList = null;
        this._drawerRows = new Map();
        this._drawerNameEntry = null;
        this._drawerMenu = null;
        this._drawerMenuManager = null;
        this._drawerMenuOpen = false;
        // The power menu is torn down below like the drawer menu, so its three
        // fields have to be cleared here for the same reason: they outlive the
        // popup otherwise. _onLayoutChanged() calls this on a monitor change,
        // which can happen with the menu open, and a stale _powerMenu would
        // then be a destroyed object that _openPowerMenu() happily reuses.
        this._powerMenu = null;
        this._powerMenuManager = null;
        this._powerMenuOpen = false;
        this._drawerCreationOrigin = null;
        this._drawerFocusRequest = null;
        this._dropHighlightRow = null;
        this._draggingRow = null;
        this._menuManager = null;
        this._hoverLabel = null;
        this._sourceButton = null;
        this._arrowSide = null;
        this._entry = null;
        this._box = null;
        this._grid = null;
        this._gridFillers = [];
        this._scrollView = null;
        this._touchPanGesture = null;
        this._statusLabel = null;
        this._selectedIndex = -1;
        this._styledSelectionIndex = -1;
        this._rtl = null;
        this._layoutDirty = true;
        this._restoreFocusOnClose = false;
        this._iconMenuOpen = false;
        this._activeIconMenuIcon = null;
        this._closeRequestedWhileIconMenuOpen = null;
        this._draggingIcon = null;
        this._deferredCatalogRender = false;

        this._tryCleanup('menu signals', () => this._menuSignalsHandler?.clear());
        this._clearButtonPool();
        this._tryCleanup('menu manager', () => menuManager?.removeMenu(menu));
        this._tryCleanup('drawer menu manager', () =>
            drawerMenuManager?.removeMenu(drawerMenu));
        // Destroyed before the sidebar it anchors to: the menu actor lives in
        // uiGroup, not in the popup, so nothing else takes it with the tree.
        this._tryCleanup('drawer menu', () => drawerMenu?.destroy());
        this._tryCleanup('power menu manager', () =>
            powerMenuManager?.removeMenu(powerMenu));
        this._tryCleanup('power menu', () => powerMenu?.destroy());
        this._tryCleanup('hover label', () => hoverLabel?.destroy());
        this._tryCleanup('menu actor tree', () => menu?.destroy());
    }

    _onOpenStateChanged(isOpen) {
        if (isOpen)
            return;

        this._hideHoverLabel({animate: false});
        this._cancelDragClose();
        if (this._restoreFocusOnClose && this._sourceButton?.mapped)
            this._sourceButton.grab_key_focus();
        this._restoreFocusOnClose = false;
    }

    _onLayoutChanged() {
        if (this._destroyed || !this.isOpen)
            return;

        // Text scale, workarea and monitor signals commonly arrive as a burst
        // for one compositor transaction. Own one BEFORE_REDRAW callback so
        // the popup measures, restyles and re-renders once against the final
        // monitor snapshot instead of doing a full pass for every signal.
        this._layoutTask.schedule(() => this._applyLayoutChange());
    }

    _applyLayoutChange() {
        if (this._destroyed || !this.isOpen)
            return;

        if (!this._sourceButton?.mapped || !this._applyResponsiveLayout()) {
            this._destroyMenu();
            return;
        }

        this._renderResults(this._entry.get_text());
    }

    _applyResponsiveLayout() {
        if (!this._box || !this._scrollView)
            return false;

        const workArea = this._getSourceWorkArea();
        if (!workArea)
            return false;

        const textScale = this._interfaceSettings.get_double('text-scaling-factor');
        // One number, used twice: set on the header actor and subtracted from
        // the popup's height budget. Recomputed here rather than at build time
        // so a scale change moves both together.
        const headerHeight = computeHeaderHeight(Main.defaultIconSize);
        const layout = computeGridLayout({
            workAreaWidth: workArea.width,
            workAreaHeight: workArea.height,
            textScale,
            sidebarWidth: SIDEBAR_WIDTH,
            chromeHeight: headerHeight + FOOTER_HEIGHT,
        });

        const iconSizeChanged = this._iconSize !== layout.iconSize;
        this._layoutDirty ||= this._columns !== layout.columns;
        this._columns = layout.columns;
        this._iconSize = layout.iconSize;
        this._header?.set_style(`height: ${headerHeight}px;`);
        this._footer?.set_style(`height: ${FOOTER_HEIGHT}px;`);
        this._sidebar?.set_style(`width: ${layout.sidebarWidth}px;`);
        this._box.set_style(`width: ${layout.width}px;`);
        // height, not max-height: the popup is one size on a given monitor no
        // matter how many results are showing. Result actors carry y_expand
        // false so the homogeneous rows keep their natural height instead of
        // stretching to fill this box when only a few apps match.
        this._scrollView.set_style(`height: ${layout.gridHeight}px;`);

        if (iconSizeChanged) {
            this._clearButtonPool();
            this._layoutDirty = true;
        }

        return true;
    }

    _getSourceWorkArea() {
        const {layoutManager} = Main;
        const monitorCount = layoutManager.monitors?.length ?? 0;
        if (monitorCount <= 0)
            return null;

        try {
            let monitorIndex = layoutManager.findIndexForActor(this._sourceButton);
            if (!Number.isInteger(monitorIndex) || monitorIndex < 0 ||
                monitorIndex >= monitorCount)
                monitorIndex = layoutManager.primaryIndex;
            if (!Number.isInteger(monitorIndex) || monitorIndex < 0 ||
                monitorIndex >= monitorCount)
                monitorIndex = 0;

            const workArea = layoutManager.getWorkAreaForMonitor(monitorIndex);
            if (!workArea || !Number.isFinite(workArea.width) ||
                !Number.isFinite(workArea.height) || workArea.width <= 0 ||
                workArea.height <= 0)
                return null;
            return workArea;
        } catch {
            // Monitor state is briefly inconsistent during Wayland hotplug.
            return null;
        }
    }

    _onPanUpdate(gesture) {
        const adjustment = this._scrollView?.vadjustment;
        const height = this._scrollView?.height ?? 0;
        if (!adjustment || height <= 0)
            return;

        const delta = gesture.get_delta();
        adjustment.value -= (delta.get_y() / height) * adjustment.page_size;
    }

    _setEntryText(text) {
        this._suppressEntryChange = true;
        try {
            this._entry.set_text(text);
        } finally {
            this._suppressEntryChange = false;
        }
    }

    _onEntryKeyPress(event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close({restoreFocus: true});
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._activateButton(this._visibleButtons[this._selectedIndex]);
            return Clutter.EVENT_STOP;
        }

        // With no results there is no grid to move into, and the grid is how
        // the sidebar and then the footer are normally reached. Bailing out
        // here left every control below the entry unreachable from the keyboard
        // for as long as a query matched nothing -- including the gear and the
        // power button, which have no other keyboard path at all. Fall through
        // to the sidebar instead, which always has at least "All Apps".
        if (symbol === Clutter.KEY_Down) {
            if (this._visibleButtons.length)
                this._focusResult(Math.max(0, this._selectedIndex));
            else if (!this._focusFirstDrawerRow())
                this._focusFooter(0);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Up) {
            if (this._visibleButtons.length)
                this._focusResult(this._visibleButtons.length - 1);
            else if (!this._focusFooter(0))
                this._focusFirstDrawerRow();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onButtonKeyPress(button, event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close({restoreFocus: true});
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
            symbol === Clutter.KEY_space) {
            this._activateButton(button);
            return Clutter.EVENT_STOP;
        }

        let direction;
        if (symbol === Clutter.KEY_Left)
            direction = 'left';
        else if (symbol === Clutter.KEY_Right)
            direction = 'right';
        else if (symbol === Clutter.KEY_Up)
            direction = 'up';
        else if (symbol === Clutter.KEY_Down)
            direction = 'down';
        else if (symbol === Clutter.KEY_Home)
            direction = 'home';
        else if (symbol === Clutter.KEY_End)
            direction = 'end';
        else
            return Clutter.EVENT_PROPAGATE;

        const next = moveSelection(this._selectedIndex, this._visibleButtons.length,
            this._columns, direction, this._rtl);
        if (next < 0) {
            this._entry.grab_key_focus();
            return Clutter.EVENT_STOP;
        }

        // moveSelection clamps to the row, so an unchanged index means the
        // selection is already at that visual edge. The key would otherwise do
        // nothing, which makes it the natural way into the sidebar -- the rows
        // are focusable but were reachable only by Tab.
        //
        // The sidebar is the content box's first child, so it renders on the
        // left under LTR and on the RIGHT under RTL (measured: x=25 vs x=771).
        // The key that moves toward it therefore has to mirror too.
        if (direction === this._towardSidebarDirection() &&
            next === this._selectedIndex && this._focusDrawerRow())
            return Clutter.EVENT_STOP;

        this._focusResult(next);
        return Clutter.EVENT_STOP;
    }

    // Physical direction of the sidebar relative to the grid.
    _towardSidebarDirection() {
        return this._rtl ? 'right' : 'left';
    }

    // ...and the key that goes back the other way.
    _backToGridKey() {
        return this._rtl ? Clutter.KEY_Left : Clutter.KEY_Right;
    }

    /**
     * Move focus to the sidebar row for the active drawer.
     *
     * @returns {boolean} whether a row took focus
     */
    _focusDrawerRow() {
        // Quick access is the state of having selected nothing, so it has no
        // row of its own and the lookup misses. Falling back to the first row
        // is what keeps Left-from-the-grid working on the default view; before
        // this it silently did nothing there.
        const row = this._drawerRows?.get(this._activeDrawerId) ??
            this._drawerList?.get_children()
                .find(child => child?.visible && child.can_focus);
        if (!row?.mapped)
            return false;

        this._hideHoverLabel();
        row.grab_key_focus();
        return true;
    }

    _onDrawerRowKeyPress(row, event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close({restoreFocus: true});
            return Clutter.EVENT_STOP;
        }

        // Ctrl+Shift+Up/Down is the keyboard equivalent of dragging a drawer
        // row. Defer the settings write past this key event: its change signal
        // rebuilds the sidebar and destroys the row currently dispatching.
        const modifiers = event.get_state?.() ?? 0;
        if (typeof row._drawerId === 'string' &&
            (modifiers & DRAWER_REORDER_MODIFIERS) === DRAWER_REORDER_MODIFIERS &&
            (symbol === Clutter.KEY_Up || symbol === Clutter.KEY_Down)) {
            const id = row._drawerId;
            const direction = symbol === Clutter.KEY_Up ? -1 : 1;
            this._queueIdle('keyboard drawer reorder', () =>
                this._reorderDrawerFromKeyboard(id, direction));
            return Clutter.EVENT_STOP;
        }

        // The context menu is the only way to create a drawer since the "New
        // Drawer…" row was removed, so it needs the same keyboard openers the
        // Shell gives every other context menu.
        if (symbol === Clutter.KEY_Menu ||
            (symbol === Clutter.KEY_F10 &&
             (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0)) {
            this._openDrawerMenu(row);
            return Clutter.EVENT_STOP;
        }

        // Back to the results, mirrored for RTL where the grid is on the left.
        // Enter/Space stay with St.Button's own handling.
        if (symbol === this._backToGridKey()) {
            this._focusResult(Math.max(0, this._selectedIndex));
            return Clutter.EVENT_STOP;
        }

        if (symbol !== Clutter.KEY_Up && symbol !== Clutter.KEY_Down)
            return Clutter.EVENT_PROPAGATE;

        // The drawer rows live in their own subtree, with the name entry as a
        // sibling of it. Up/Down still walk the sidebar top to bottom, and pick
        // the entry up only while a drawer is being named.
        const rows = [
            ...this._drawerList?.get_children() ?? [],
            this._drawerNameEntry,
        ].filter(child => child?.visible && child.can_focus);
        const current = rows.indexOf(row);
        if (current < 0)
            return Clutter.EVENT_PROPAGATE;

        const delta = symbol === Clutter.KEY_Down ? 1 : -1;
        const target = rows[current + delta];
        if (!target) {
            // Past the last row is the footer, which sits under this column.
            // Without this the gear and the power button are pointer-only:
            // Tab does not reach them, because this popup navigates by arrows
            // and PopupMenu's focus group does not include the footer.
            if (symbol === Clutter.KEY_Down)
                this._focusFooter(0);
            return Clutter.EVENT_STOP;
        }

        target.grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    _reorderDrawerFromKeyboard(id, direction) {
        const drawers = this._drawers.list();
        const order = drawers.map(drawer => drawer.id);
        const drawer = drawers.find(item => item.id === id);
        if (!drawer)
            return;

        const plan = planAdjacentDrawerReorder(order, id, direction);
        if (!plan) {
            this._updateStatusText(direction < 0
                ? __('“%s” is already first').format(drawer.name)
                : __('“%s” is already last').format(drawer.name));
            return;
        }

        const message = direction < 0
            ? __('Moved “%s” up').format(drawer.name)
            : __('Moved “%s” down').format(drawer.name);
        this._drawerFocusRequest = {id, message};

        let changed = false;
        try {
            changed = this._drawers.reorder(id, plan.beforeId);
        } catch (error) {
            logError(error, `Unable to reorder drawer ${id}`);
        }

        if (!changed) {
            this._drawerFocusRequest = null;
            this._updateStatusText(__('That drawer could not be moved'));
            return;
        }

        // The settings notification normally rebuilds synchronously. Announce
        // here as well so a backend that delivers it on the next turn cannot
        // leave keyboard users without immediate feedback.
        this._updateStatusText(message);
    }

    /**
     * @returns {boolean} whether a drawer row took focus
     */
    _focusFirstDrawerRow() {
        const row = (this._drawerList?.get_children() ?? [])
            .find(child => child?.visible && child.can_focus);
        row?.grab_key_focus();
        return !!row;
    }

    _footerButtons() {
        return (this._footer?.get_children() ?? [])
            .filter(child => child?.visible && child.can_focus);
    }

    /**
     * @param {number} index footer button to focus
     * @returns {boolean} whether a button took focus
     */
    _focusFooter(index) {
        const buttons = this._footerButtons();
        const button = buttons[Math.min(Math.max(index, 0), buttons.length - 1)];
        button?.grab_key_focus();
        return !!button;
    }

    /**
     * Footer navigation: Left/Right between the buttons, Up back into the
     * sidebar. Deliberately mirrors the sidebar's own arrow scheme rather than
     * relying on Tab, which does not reach here.
     *
     * @param {St.Button} button the focused footer button
     * @param {Clutter.Event} event key event
     * @returns {boolean} whether the key was consumed
     */
    _onFooterKeyPress(button, event) {
        const symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close({restoreFocus: true});
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Up) {
            // Back to the sidebar row nearest the footer, or the search entry
            // when there are no rows to return to.
            const rows = (this._drawerList?.get_children() ?? [])
                .filter(child => child?.visible && child.can_focus);
            const last = rows[rows.length - 1];
            if (last)
                last.grab_key_focus();
            else
                this._entry?.grab_key_focus();
            return Clutter.EVENT_STOP;
        }

        if (symbol !== Clutter.KEY_Left && symbol !== Clutter.KEY_Right)
            return Clutter.EVENT_PROPAGATE;

        const buttons = this._footerButtons();
        const current = buttons.indexOf(button);
        if (current < 0)
            return Clutter.EVENT_PROPAGATE;

        // Visual movement, so RTL mirrors it -- the same rule _backToGridKey()
        // applies to the sidebar.
        const visualDelta = symbol === Clutter.KEY_Right ? 1 : -1;
        const next = buttons[current + (this._rtl ? -visualDelta : visualDelta)];
        next?.grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    _invalidateCatalog() {
        this._catalogDirty = true;
        if (!this.isOpen)
            return;

        // "Pin to Dock" fires AppFavorites::changed synchronously from the open
        // context menu. Re-rendering here would run _clearButtonPool() and
        // destroy the very icon the menu is anchored to (and, mid-drag, the
        // drag source). Defer until the menu closes or the drag ends.
        if (this._iconMenuOpen || this._draggingIcon) {
            this._deferredCatalogRender = true;
            return;
        }

        this._renderResults(this._entry.get_text());
    }

    _refreshCatalog() {
        if (!this._catalogDirty)
            return;

        const favorites = this._appFavorites.getFavoriteMap();
        const catalog = [];

        for (const appInfo of this._appSystem.get_installed()) {
            try {
                if (!appInfo.should_show() || !this._parentalControls.shouldShowApp(appInfo))
                    continue;

                const id = appInfo.get_id();
                const app = this._appSystem.lookup_app(id);
                if (!app)
                    continue;

                const name = app.get_name();
                const keywords = appInfo.get_keywords?.() ?? [];
                catalog.push({
                    id,
                    app,
                    name,
                    favorite: id in favorites,
                    searchText: normalizeSearchText([
                        name,
                        appInfo.get_display_name?.(),
                        appInfo.get_description?.(),
                        appInfo.get_executable?.(),
                        ...keywords,
                    ]),
                });
            } catch {
                // Invalid desktop-file encoding or policy data: mirror Shell's
                // app grid by omitting the broken entry rather than failing open.
            }
        }

        catalog.sort((a, b) => {
            if (a.favorite !== b.favorite)
                return a.favorite ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        // installed-changed may retain the desktop ID while replacing its
        // name, icon, or backing Shell.App. Recreate cached actors on every
        // source refresh so same-ID desktop metadata cannot remain visible.
        this._clearButtonPool();
        this._catalog = catalog;
        this._catalogDirty = false;
    }

    _renderResults(query) {
        if (!this._grid)
            return;

        const previousButton = this._visibleButtons[this._selectedIndex];
        const previousId = previousButton?._app?.get_id();
        const restoreResultFocus = previousButton?.has_key_focus() ?? false;
        const rtl = this._grid.get_text_direction() === Clutter.TextDirection.RTL;
        this._layoutDirty ||= this._rtl !== rtl;
        this._rtl = rtl;
        this._refreshCatalog();
        // Quick access is the empty-query state of "no drawer selected" only.
        // Typing has to search everything, or the six apps on screen would be
        // the only ones findable from the default view.
        const searching = normalizeSearchText(query).length > 0;
        const source = !this._activeDrawerId && !searching
            ? this._quickAccessApps()
            : this._catalogForActiveDrawer();
        const {items, total, truncated} = filterCatalog(source, query);
        const nextIds = items.map(entry => entry.id);
        const visibleIds = this._visibleButtons.map(button => button._app.get_id());
        const sameResults = nextIds.length === visibleIds.length &&
            nextIds.every((id, index) => id === visibleIds[index]);

        if (!sameResults || this._layoutDirty) {
            for (const button of this._visibleButtons) {
                if (button.get_parent() === this._grid)
                    this._grid.remove_child(button);
            }
            this._gridFillers.forEach(filler => filler.destroy());
            this._gridFillers = [];

            this._visibleButtons = items.map((entry, index) => {
                const button = this._getAppButton(entry);
                const {column, row} = getGridPosition(index, this._columns, rtl);
                this._grid.layout_manager.attach(button, column, row, 1, 1);
                return button;
            });
            // Finish the last row with empty cells. Without them the
            // homogeneous grid has only as many columns as there are results,
            // so a drawer holding one app was given a single row-wide column
            // and its tile -- selection highlight and all -- stretched across
            // the whole popup. See trailingCellCount().
            const fillerCount = trailingCellCount(items.length, this._columns);
            for (let index = items.length; index < items.length + fillerCount; index++) {
                const filler = new Clutter.Actor({x_expand: true});
                const {column, row} = getGridPosition(index, this._columns, rtl);
                this._grid.layout_manager.attach(filler, column, row, 1, 1);
                this._gridFillers.push(filler);
            }
            // Buttons come from the pool and may carry a stale selection class
            // from an earlier result set, so the cached index is invalid here.
            // Pooled buttons are re-attached here, so a label anchored to one
            // that just left the grid would hang in mid-air.
            this._hideHoverLabel({animate: false});
            this._visibleButtons.forEach(button =>
                button.remove_style_class_name('selected'));
            this._styledSelectionIndex = -1;
            this._layoutDirty = false;
            this._trimButtonPool(new Set(nextIds));
        }

        const preservedIndex = previousId
            ? this._visibleButtons.findIndex(button => button._app.get_id() === previousId)
            : -1;
        if (preservedIndex >= 0)
            this._selectedIndex = preservedIndex;
        else
            this._selectedIndex = this._visibleButtons.length ? 0 : -1;
        this._updateSelection();
        if (restoreResultFocus) {
            if (preservedIndex >= 0)
                this._visibleButtons[this._selectedIndex].grab_key_focus();
            else
                this._entry.grab_key_focus();
        }
        this._updateStatus(total, items.length, truncated);
    }

    // Membership is read fresh rather than cached: the store is shared with
    // the Shell's app grid, so a folder can change under an open popup.
    /**
     * The default view: a short row of the apps actually reached for most.
     *
     * Ranked by Shell's own AppUsage rather than by favourites, which are
     * already one click away on the dock, and resolved THROUGH the catalog so
     * that parental controls and should_show() filtering are applied -- the
     * usage list knows nothing about either. Usage order is preserved, so this
     * deliberately does not follow the catalog's favourites-then-name sort.
     *
     * Falls back to the head of the catalog when there is no usage history
     * yet, which is what a fresh account looks like; an empty launcher would
     * read as broken.
     *
     * @returns {object[]} catalog entries for the quick-access row
     */
    _quickAccessApps() {
        const byId = new Map(this._catalog.map(entry => [entry.id, entry]));
        const picked = [];

        try {
            for (const app of Shell.AppUsage.get_default().get_most_used()) {
                const entry = byId.get(app.get_id());
                if (!entry)
                    continue;
                picked.push(entry);
                if (picked.length === QUICK_ACCESS_COUNT)
                    break;
            }
        } catch (error) {
            logError(error, 'Unable to read application usage');
        }

        // Top up from the catalog. AppUsage is usage state, not an app list, so
        // it can return anything from nothing on a fresh account to a handful
        // on a lightly used one. The catalog head is favourites-first, making
        // it a useful fallback while preserving the usage-ranked entries first.
        return fillQuickAccess(this._catalog, picked, QUICK_ACCESS_COUNT);
    }

    _catalogForActiveDrawer() {
        if (!this._activeDrawerId || this._activeDrawerId === ALL_APPS)
            return this._catalog;

        let members;
        try {
            members = new Set(this._drawers.appIds(this._activeDrawerId));
        } catch (error) {
            logError(error, `Unable to read drawer ${this._activeDrawerId}`);
            return this._catalog;
        }

        return this._catalog.filter(entry => members.has(entry.id));
    }

    /**
     * A drawer was added or removed somewhere in the session. Rebuild the
     * sidebar, deferring while a context menu or drag is in flight for the same
     * reason _invalidateCatalog does: rebuilding destroys the actors those
     * interactions are anchored to.
     */
    _invalidateDrawers() {
        if (!this.isOpen || !this._sidebar)
            return;

        // _draggingRow belongs here for a sharper reason than the other two: a
        // REORDER is itself a folder change, so this fires from inside
        // acceptDrop while DND is still completing the drop. Rebuilding there
        // destroys the row DND is holding as its drag source, and the drag-end
        // handler then touches a destroyed actor. Defer, and let the drag's own
        // end handler flush it.
        if (this._iconMenuOpen || this._draggingIcon || this._draggingRow) {
            this._deferredDrawerRender = true;
            return;
        }

        this._renderDrawers();
        this._renderResults(this._entry?.get_text() ?? '');
    }

    _flushDeferredDrawers() {
        if (!this._deferredDrawerRender)
            return false;

        this._deferredDrawerRender = false;
        if (this.isOpen && this._sidebar) {
            this._renderDrawers();
            this._renderResults(this._entry?.get_text() ?? '');
        }
        return true;
    }

    // Status line text that is not a result count (validation messages).
    _updateStatusText(text) {
        if (!this._statusLabel)
            return;
        this._statusLabel.text = text;
        this._statusLabel.accessible_name = text;
    }

    _getAppButton(entry) {
        let button = this._buttonsById.get(entry.id);
        if (!button) {
            button = this._createAppButton(entry);
            this._buttonsById.set(entry.id, button);
        } else {
            button._app = entry.app;
        }

        button._launcherLastUsed = ++this._buttonUseSerial;
        return button;
    }

    _trimButtonPool(visibleIds) {
        if (this._buttonsById.size <= MAX_CACHED_BUTTONS)
            return;

        const removable = [...this._buttonsById.entries()]
            .filter(([id, button]) => !visibleIds.has(id) && !this._isButtonBusy(button))
            .sort((a, b) => a[1]._launcherLastUsed - b[1]._launcherLastUsed);
        while (this._buttonsById.size > MAX_CACHED_BUTTONS && removable.length) {
            const [id, button] = removable.shift();
            this._buttonsById.delete(id);
            this._tryCleanup(`cached button ${id}`, () => button.destroy());
        }
    }

    // An icon holding an open context menu, or acting as a live drag source,
    // must outlive a pool sweep: DockAppIconMenu destroys itself with its
    // source, and AppViewItem._onDestroy() ends an in-flight drag.
    _isButtonBusy(button) {
        return button === this._activeIconMenuIcon || button === this._draggingIcon;
    }

    _clearButtonPool() {
        const retained = [];
        const buttons = [...this._buttonsById.entries()].filter(([id, button]) => {
            if (!this._isButtonBusy(button))
                return true;
            retained.push([id, button]);
            return false;
        });
        this._buttonsById.clear();
        retained.forEach(([id, button]) => this._buttonsById.set(id, button));
        this._visibleButtons = [];
        buttons.forEach(([id, button]) =>
            this._tryCleanup(`cached button ${id}`, () => button.destroy()));
    }

    /**
     * The status line is deliberately blank for an ordinary result set: a
     * running count of the apps you are already looking at is noise.
     *
     * The label itself stays, and is not merely decoration. It is the only
     * surface the popup has for three things that are NOT the count:
     *
     * - validation failures from drawer creation and deletion, via
     *   _updateStatusText();
     * - the empty state, so a query that matches nothing reads as "no matches"
     *   rather than as a broken popup;
     * - the truncation notice. filterCatalog() renders at most
     *   MAX_VISIBLE_RESULTS, and without this line a capped list gives no
     *   indication at all that there are more apps than are on screen.
     *
     * @param {number} total apps matching the query
     * @param {number} visible apps actually rendered
     * @param {boolean} truncated whether the render was capped
     */
    _updateStatus(total, visible, truncated) {
        let status = '';
        if (total === 0)
            status = __('No applications found');
        else if (truncated)
            status = __('Showing %d of %d applications').format(visible, total);

        this._statusLabel.text = status;
        // Updating the accessible name on a STATUSBAR actor emits the ATK name
        // change screen readers announce. An empty string is correct here: it
        // stops the reader announcing a count on every keystroke.
        this._statusLabel.accessible_name = status;
    }

    _focusResult(index) {
        this._selectedIndex = Math.min(Math.max(index, 0), this._visibleButtons.length - 1);
        this._updateSelection();
        this._visibleButtons[this._selectedIndex]?.grab_key_focus();
        this._ensureSelectionVisible();
    }

    // Hover moves the selection, so this runs on every pointer crossing. Touch
    // only the two actors that changed: restyling the whole grid each time
    // forces a full style cascade over every result.
    _updateSelection() {
        if (this._styledSelectionIndex === this._selectedIndex)
            return;

        this._visibleButtons[this._styledSelectionIndex]
            ?.remove_style_class_name('selected');
        this._visibleButtons[this._selectedIndex]
            ?.add_style_class_name('selected');
        this._styledSelectionIndex = this._selectedIndex;
    }

    _ensureSelectionVisible() {
        const selected = this._visibleButtons[this._selectedIndex];
        const adjustment = this._scrollView?.vadjustment;
        if (!selected || !adjustment)
            return;

        const {y1, y2} = selected.get_allocation_box();
        if (y1 < adjustment.value) {
            adjustment.value = Math.max(0, y1);
        } else if (y2 > adjustment.value + adjustment.page_size) {
            adjustment.value = Math.max(0,
                Math.min(adjustment.upper - adjustment.page_size, y2 - adjustment.page_size));
        }
    }

    _activateButton(button) {
        if (!button?._app)
            return;

        // Route keyboard activation through the icon so it takes the same path
        // as a click (launch animation, Ctrl/middle-click new window, close).
        button.activate(Clutter.BUTTON_PRIMARY);
    }

    _createAppButton(entry) {
        const button = new LauncherAppIcon(entry.app, this);
        button.setIconSize(this._iconSize);
        button.accessible_name = entry.name;
        button.x_expand = true;
        // Deliberately NOT y_expand. Clutter.GridLayout hands leftover vertical
        // space to rows containing an expanding child, and the ScrollView now
        // has a fixed height, so one row of results would have stretched to
        // 600px tall.
        button.y_expand = false;
        button.connect('key-press-event',
            (actor, event) => this._onButtonKeyPress(button, event));
        button.connect('key-focus-in', () => {
            const index = this._visibleButtons.indexOf(button);
            if (index >= 0) {
                this._selectedIndex = index;
                this._updateSelection();
                this._ensureSelectionVisible();
            }
            // Keyboard users get the name too, not just pointer users.
            this._showHoverLabel(button);
        });
        button.connect('key-focus-out', () => {
            if (!button.hover)
                this._hideHoverLabel({source: button});
        });
        button.connect('notify::hover', () => {
            const index = this._visibleButtons.indexOf(button);
            if (button.hover && index >= 0) {
                this._selectedIndex = index;
                this._updateSelection();
                this._showHoverLabel(button);
            } else if (!button.hover && !button.has_key_focus()) {
                this._hideHoverLabel({source: button});
            }
        });

        return button;
    }
}
