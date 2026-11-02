// Import and call run() from a private headless Shell's test harness. The
// harness must set GNOME_SHELL_DEV_HARNESS=1; never run on a live desktop.
// Writes its own launcher into the harness's private XDG_DATA_HOME: a small
// GTK window, so the app can be RUNNING when its launcher changes.
//
// GNOME Shell swaps an app's desktop entry in place when its launcher file
// changes, without notify::icon (shell-app.c _shell_app_set_app_info, 50.1).
// A pinned app whose Icon= changes under the same desktop ID -- a package that
// redraws its icon, or an icon override applied or removed -- must still show
// the new picture on the dock without a logout.
/* eslint-disable no-await-in-loop -- waits on the app system in order */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ID = 'dev.xdock.IconRefreshTest.desktop';
const WINDOW = `imports.gi.versions.Gtk = '4.0';
const {Gtk} = imports.gi;
const app = new Gtk.Application({application_id: 'dev.xdock.IconRefreshTest'});
app.connect('activate', () => new Gtk.ApplicationWindow({application: app, title: 'Icon refresh'}).present());
app.run([]);`;
const wait = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

function shownIcon(dash) {
    const icon = dash.getAppIcons().find(appIcon => appIcon.app?.get_id() === ID);
    return icon?.icon?.icon?.gicon?.to_string() ?? null;
}

export async function run() {
    if (GLib.getenv('GNOME_SHELL_DEV_HARNESS') !== '1')
        throw new Error('private test session required');
    const extension = Main.extensionManager.lookup('xdock@spencercnorton.github.io');
    const {DockManager} = await import(`file://${extension.path}/docking.js`);
    const appSystem = Shell.AppSystem.get_default();
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
    const script = GLib.build_filenamev([GLib.get_user_data_dir(), 'icon-refresh-window.js']);
    GLib.file_set_contents(script, WINDOW);
    GLib.mkdir_with_parents(dir, 0o755);
    const path = GLib.build_filenamev([dir, ID]);
    const launcher = icon => '[Desktop Entry]\nType=Application\nName=Icon Refresh Test\n' +
        `Exec=gjs ${script}\nIcon=${icon}\nStartupWMClass=dev.xdock.IconRefreshTest\n`;
    let installed = false;
    let handler = appSystem.connect('installed-changed', () => (installed = true));
    GLib.file_set_contents(path, launcher('applications-utilities-symbolic'));
    for (let i = 0; i < 100 && !(installed && appSystem.lookup_app(ID)); i++)
        await wait(100);
    appSystem.disconnect(handler);
    const previous = global.settings.get_strv('favorite-apps');
    global.settings.set_strv('favorite-apps', [ID]);
    try {
        let dash = null;
        for (let i = 0; i < 50 && !shownIcon(dash ?? {getAppIcons: () => []}); i++) {
            dash = DockManager.getDefault()?.mainDock?.dash ?? null;
            await wait(100);
        }
        const before = dash && shownIcon(dash);
        if (!before)
            throw new Error('the pinned test app never reached the dock');
        // Running is the case that matters: Shell keeps a running app's
        // object and only swaps its desktop entry, where a stopped app is
        // looked up afresh (and so redraws by itself).
        const app = appSystem.lookup_app(ID);
        app.activate();
        for (let i = 0; i < 100 && app.state !== Shell.AppState.RUNNING; i++)
            await wait(100);
        if (app.state !== Shell.AppState.RUNNING)
            throw new Error('the test window never started');
        await wait(500);

        installed = false;
        handler = appSystem.connect('installed-changed', () => (installed = true));
        Gio.File.new_for_path(path).replace_contents(
            new TextEncoder().encode(launcher('media-playback-start-symbolic')),
            null, false, Gio.FileCreateFlags.NONE, null);
        for (let i = 0; i < 100 && !installed; i++)
            await wait(100);
        appSystem.disconnect(handler);
        if (!installed)
            throw new Error('the app system never reported the launcher change');
        let after = shownIcon(dash);
        for (let i = 0; i < 30 && after === before; i++) {
            await wait(100);
            after = shownIcon(dash);
        }
        const running = app.state === Shell.AppState.RUNNING;
        return {
            before,
            after,
            running,
            refreshed: running && /media-playback-start/.test(after ?? ''),
        };
    } finally {
        appSystem.lookup_app(ID)?.get_windows().forEach(w => w.delete(global.get_current_time()));
        global.settings.set_strv('favorite-apps', previous);
    }
}
