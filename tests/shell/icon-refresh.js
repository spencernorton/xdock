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
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ID = 'dev.xdock.IconRefreshTest.desktop';
const SIGTERM = 15;
const WINDOW = `imports.gi.versions.Gtk = '4.0';
const {Gtk, GLib, GLibUnix} = imports.gi;
const app = new Gtk.Application({application_id: 'dev.xdock.IconRefreshTest'});
app.connect('activate', () => new Gtk.ApplicationWindow({application: app, title: 'Icon refresh'}).present());
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, ${SIGTERM}, () => {
    app.quit();
    return GLib.SOURCE_REMOVE;
});
app.run([]);`;
const wait = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

async function stopWindowProcess(process) {
    // Window removal alone does not prove that the Wayland connection closed.
    // A stock headless Shell 51 can fail on shutdown with a live client.
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        timeoutId = 0;
        process.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        process.send_signal(SIGTERM);
        await new Promise((resolve, reject) => {
            process.wait_check_async(null, (source, result) => {
                try {
                    source.wait_check_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
    }
}

function shownIcon(dash) {
    const icon = dash.getAppIcons().find(appIcon => appIcon.app?.get_id() === ID);
    return icon?.icon?.icon?.gicon?.to_string() ?? null;
}

async function waitFor(condition, message) {
    for (let i = 0; i < 100; i++) {
        if (condition())
            return;
        await wait(50);
    }
    throw new Error(message);
}

async function checkStationaryMagnification(manager, settings, app, script) {
    const favoriteIds = Array.from({length: 6}, (_unused, index) =>
        `xdock-popup-test-0${index}.desktop`);
    const previousFavorites = global.settings.get_strv('favorite-apps');
    const previousAnimations = global.force_animations;
    const dockSettings = {
        'dock-fixed': new GLib.Variant('b', true),
        manualhide: new GLib.Variant('b', false),
        'icon-size-fixed': new GLib.Variant('b', false),
        'show-favorites': new GLib.Variant('b', true),
        'show-running': new GLib.Variant('b', true),
        'magnify-icons': new GLib.Variant('b', true),
        'magnify-max-scale': new GLib.Variant('d', 1.6),
        'magnify-duration': new GLib.Variant('i', 125),
    };
    const previousSettings = Object.keys(dockSettings).map(key => [key, settings.get_value(key)]);
    const previousPosition = settings.get_enum('dock-position');
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    const icons = () => manager.mainDock.dash.getAppIcons();
    const containsApp = () => icons().some(icon => icon.app.get_id() === ID);
    const center = actor => {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        return [x + width / 2, y + height / 2];
    };
    let child = null;
    const stop = async () => {
        const process = child;
        child = null;
        if (process)
            await stopWindowProcess(process);
    };

    try {
        for (const [key, value] of Object.entries(dockSettings))
            settings.set_value(key, value);
        settings.set_enum('dock-position', St.Side.BOTTOM);
        global.force_animations = true;
        global.settings.set_strv('favorite-apps', favoriteIds);
        Main.overview.hide();
        move(100, 100);
        await wait(700);
        await waitFor(() => favoriteIds.every(id => icons().some(icon => icon.app.get_id() === id)),
            'the fixed dock never showed its magnification fixtures');
        if (containsApp())
            throw new Error('the unpinned Wayland app must be absent before launch');
        const hovered = icons().find(icon => icon.app.get_id() === favoriteIds[2]);
        const [x, y] = center(hovered);
        const reach = hovered.width * 1.5;
        const scale = icon => icon._floatLayer?.visible ? icon._floatClone.scale_x : 1;
        const nearbyPeak = () => Math.max(1, ...icons().filter(icon =>
            Math.abs(center(icon)[0] - x) <= reach).map(scale));
        move(x, y);
        await waitFor(() => scale(hovered) > 1.45, 'the starting hover did not magnify');
        const [stationaryX, stationaryY] = global.get_pointer();

        const checkMutation = async (name, present, mutate) => {
            let minimum = Infinity;
            let frames = 0;
            let maxFrameStep = 0;
            let sampledSteps = 0;
            const scales = () => new Map(icons().filter(icon =>
                favoriteIds.includes(icon.app.get_id())).map(icon => [icon, scale(icon)]));
            let previousScales = scales();
            let previousTime = GLib.get_monotonic_time();
            const paintId = global.stage.connect('after-paint', () => {
                const time = GLib.get_monotonic_time();
                const currentScales = scales();
                // A stalled compositor can legitimately cover more of the
                // easing curve in one frame. Check the steps while painting
                // at a normal cadence and compare only surviving actors.
                if (time - previousTime <= 40_000) {
                    for (const [icon, current] of currentScales) {
                        const previous = previousScales.get(icon);
                        if (previous !== undefined) {
                            maxFrameStep = Math.max(maxFrameStep, Math.abs(current - previous));
                            sampledSteps++;
                        }
                    }
                }
                previousTime = time;
                previousScales = currentScales;
                minimum = Math.min(minimum, nearbyPeak());
                frames++;
            });
            try {
                await mutate();
                const state = present ? Shell.AppState.RUNNING : Shell.AppState.STOPPED;
                await waitFor(() => containsApp() === present && app.state === state,
                    `the Wayland app icon did not ${name}`);
                await wait(650);
                const [nextX, nextY] = global.get_pointer();
                if (nextX !== stationaryX || nextY !== stationaryY)
                    throw new Error(`the pointer moved during app icon ${name}`);
                const settled = nearbyPeak();
                if (settled <= 1.2)
                    throw new Error(`stationary pointer lost magnification after app icon ${name} (scale ${settled})`);
                if (!frames)
                    throw new Error(`app icon ${name} did not paint any frames`);
                if (maxFrameStep > 0.45)
                    throw new Error(`app icon ${name} caused a one-frame scale jump of ${maxFrameStep}`);
                return {settled, minimum, frames, maxFrameStep, sampledSteps};
            } finally {
                global.stage.disconnect(paintId);
            }
        };

        const added = await checkMutation('appear', true, () => {
            child = Gio.Subprocess.new(['gjs', script], Gio.SubprocessFlags.NONE);
        });
        const removed = await checkMutation('leave', false, stop);
        // A repeated work-area notification without geometry changes should
        // not reset the still-active hover or start a shrink and grow cycle.
        const beforeWorkarea = nearbyPeak();
        let workareaMinimum = beforeWorkarea;
        const workareaPaintId = global.stage.connect('after-paint', () => {
            workareaMinimum = Math.min(workareaMinimum, nearbyPeak());
        });
        try {
            global.display.emit('workareas-changed');
            await wait(350);
        } finally {
            global.stage.disconnect(workareaPaintId);
        }
        if (Math.min(workareaMinimum, nearbyPeak()) < beforeWorkarea - 0.1)
            throw new Error('an unchanged work area disturbed stationary magnification');
        return {added, removed, unchangedWorkarea: 'pass'};
    } finally {
        try {
            await stop();
        } finally {
            move(100, 100);
            global.settings.set_strv('favorite-apps', previousFavorites);
            for (const [key, value] of previousSettings)
                settings.set_value(key, value);
            settings.set_enum('dock-position', previousPosition);
            global.force_animations = previousAnimations;
            await wait(700);
        }
    }
}

async function overview(show) {
    if (show)
        Main.overview.show();
    else
        Main.overview.hide();
    for (let i = 0; i < 30; i++) {
        if (Main.overview.visible === show && !Main.overview.animationInProgress)
            return;
        await wait(100);
    }
    throw new Error('the overview did not finish its transition');
}

// Reuse the live Wayland window from this fixture. It must be followed
// exactly once in intelligent hide mode and left alone in fixed mode.
async function checkIntellihide(settings, intellihide, actor) {
    const keys = ['dock-fixed', 'manualhide', 'intellihide'];
    const previous = keys.map(key => settings.get_boolean(key));
    const expectInactive = mode => {
        if (intellihide._isEnabled || intellihide._trackedWindows.size ||
            intellihide._checkOverlapTimeoutId)
            throw new Error(`window overlap tracking was active in ${mode}`);
    };
    try {
        settings.set_boolean('manualhide', false);
        settings.set_boolean('dock-fixed', true);
        settings.set_boolean('intellihide', true);
        await overview(true);
        await overview(false);
        expectInactive('fixed dock mode after overview');

        settings.set_boolean('dock-fixed', false);
        const tracked = intellihide._trackedWindows.get(actor);
        if (!tracked)
            throw new Error('intelligent hide did not follow the existing window');
        intellihide.enable();
        if (intellihide._trackedWindows.get(actor) !== tracked)
            throw new Error('repeated enable replaced live window signal handlers');

        await overview(true);
        settings.set_boolean('intellihide', false);
        settings.set_boolean('intellihide', true);
        expectInactive('overview after changing the setting');
        await overview(false);
        if (!intellihide._isEnabled || !intellihide._trackedWindows.has(actor))
            throw new Error('intelligent hide did not resume after overview');

        settings.set_boolean('intellihide', false);
        expectInactive('intelligent hide disabled');
    } finally {
        Main.overview.hide();
        keys.forEach((key, index) => settings.set_boolean(key, previous[index]));
    }
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
    const app = appSystem.lookup_app(ID);
    if (!app)
        throw new Error('the private Wayland application was not registered');
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const stationaryMagnify = await checkStationaryMagnification(DockManager.getDefault(), settings, app, script);
    let windowProcess = null;
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
        windowProcess = Gio.Subprocess.new(['gjs', script], Gio.SubprocessFlags.NONE);
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
        const window = app.get_windows()[0];
        if (!window)
            throw new Error('no Wayland window available for the overlap check');
        await checkIntellihide(settings, DockManager.getDefault().mainDock._intellihide,
            window.get_compositor_private());
        return {
            before,
            after,
            running,
            refreshed: running && /media-playback-start/.test(after ?? ''),
            intellihide: 'tracking paused and resumed correctly',
            stationaryMagnify,
        };
    } finally {
        global.settings.set_strv('favorite-apps', previous);
        if (windowProcess)
            await stopWindowProcess(windowProcess);
    }
}
