// Import and call run() from a private headless Shell's test harness. The
// harness must set GNOME_SHELL_DEV_HARNESS=1; never run on a live desktop.
// Supply the same xdock-popup-test-*.desktop fixtures as popup-interactions.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const wait = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});
const check = (condition, message) => {
    if (!condition)
        throw new Error(message);
};

export async function run() {
    check(GLib.getenv('GNOME_SHELL_DEV_HARNESS') === '1', 'private test session required');
    const extension = Main.extensionManager.lookup('xdock@spencercnorton.github.io');
    check(extension?.state === 1, 'XDock must be active');
    const {DockManager} = await import(`file://${extension.path}/docking.js`);
    const manager = DockManager.getDefault();
    let dash = manager.mainDock.dash;
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const favorites = global.settings.get_strv('favorite-apps');
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    const button = state => pointer.notify_button(GLib.get_monotonic_time(), 1, state);
    // Magnified icons paint through a ui-group clone; the bin stays at 1.
    const binScale = icon =>
        icon._floatLayer?.visible ? icon._floatClone.scale_x : 1;
    const center = actor => {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        return [x + w / 2, y + h / 2];
    };
    const dateMenuVisible = Main.panel.statusArea.dateMenu.visible;
    const saved = {
        fixed: settings.get_boolean('dock-fixed'),
        position: settings.get_enum('dock-position'),
        magnify: settings.get_boolean('magnify-icons'),
        maxScale: settings.get_double('magnify-max-scale'),
        range: settings.get_double('magnify-range-factor'),
        duration: settings.get_int('magnify-duration'),
    };
    let pressed = false;
    const result = {};

    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 600, 400);
    await wait(150);

    try {
        settings.set_boolean('dock-fixed', true);
        settings.set_enum('dock-position', St.Side.BOTTOM);
        settings.set_double('magnify-max-scale', 1.6);
        settings.set_double('magnify-range-factor', 2.5);
        settings.set_int('magnify-duration', 125);
        settings.set_boolean('magnify-icons', true);
        global.settings.set_strv('favorite-apps', [
            'xdock-popup-test-00.desktop', 'xdock-popup-test-01.desktop',
            'xdock-popup-test-02.desktop', 'xdock-popup-test-03.desktop',
            'xdock-popup-test-04.desktop', 'xdock-popup-test-05.desktop',
        ]);
        Main.overview.hide();
        // The panel clock repaints once a second; hide it so the settled
        // check below measures only the dock (as in popup-interactions).
        Main.panel.statusArea.dateMenu.hide();
        move(100, 100);
        await wait(700);

        // Position/fixed changes rebuild the dock; observe the current native
        // instance after those settings and the favorites update have landed.
        dash = manager.mainDock.dash;
        const icons = dash.getAppIcons();
        check(icons.length >= 6, 'magnification needs at least six dock icons');
        const restWidth = dash._box.get_transformed_size()[0];
        check(icons.every(icon => binScale(icon) === 1), 'icons must start at rest');

        // Settle over the third icon: it must peak, its neighbours must
        // swell less, a far icon must not move, and the row must widen
        // around the pointer rather than slide away from it.
        const [px, py] = center(icons[2]);
        move(px, py);
        await wait(800);
        check(binScale(icons[2]) > 1.45,
            `icon under the pointer must magnify, got ${binScale(icons[2])}`);
        check(binScale(icons[1]) > 1.1 && binScale(icons[1]) < binScale(icons[2]),
            `neighbour must swell less, got ${binScale(icons[1])}`);
        check(binScale(icons[3]) > 1.1 && binScale(icons[3]) < binScale(icons[2]),
            `other neighbour must swell less, got ${binScale(icons[3])}`);
        check(Math.abs(binScale(icons[5]) - 1) < 0.01,
            `far icon must stay at rest, got ${binScale(icons[5])}`);
        const grownWidth = dash._box.get_transformed_size()[0];
        check(grownWidth > restWidth + 20,
            `magnification must widen the row: ${restWidth} -> ${grownWidth}`);
        const [anchoredX] = center(icons[2]);
        check(Math.abs(anchoredX - px) <= 12,
            `magnified icon must stay under the pointer: ${anchoredX} vs ${px}`);
        result.peak = binScale(icons[2]);

        // Dragging with magnification on: the drag must freeze it at rest
        // (Shell's placeholder maths assumes uniform widths) and still land.
        const draggedId = icons[2].app.get_id();
        const [dropX, dropY] = center(icons[4]);
        pressed = true;
        button(Clutter.ButtonState.PRESSED);
        await wait(120);
        for (let step = 1; step <= 10; step++) {
            move(px + (dropX - px) * step / 10, py + (dropY - py) * step / 10);
            // eslint-disable-next-line no-await-in-loop -- ordered native input
            await wait(40);
        }
        check(binScale(icons[2]) === 1, 'magnification must freeze at rest during a drag');
        check(!!dash._dragPlaceholder, 'drag over a magnifying dock must show a placeholder');
        button(Clutter.ButtonState.RELEASED);
        pressed = false;
        await wait(600);
        check(global.settings.get_strv('favorite-apps').includes(draggedId),
            'the dragged favorite must survive the drop');
        result.dragWithMagnify = 'pass';

        // Leaving settles everything back, and a settled dock stops drawing
        // even though the pointer watcher is still registered.
        move(100, 100);
        await wait(800);
        check(icons.every(icon => binScale(icon) === 1),
            'icons must settle back to rest after the pointer leaves');
        check(Math.abs(dash._box.get_transformed_size()[0] - restWidth) <= 2,
            'the row must return to its resting width');
        // A drag leaves a trailing relayout or two behind it, so allow a
        // few seconds to drain, then require a FULL quiet second: that is
        // the settled state whose absence would mean magnification (or
        // anything it woke) repaints forever.
        let frames = -1;
        const frameId = global.stage.connect('after-paint', () => frames++);
        for (let attempt = 0; attempt < 10 && frames !== 0; attempt++) {
            frames = 0;
            // eslint-disable-next-line no-await-in-loop -- successive quiet windows
            await wait(1000);
        }
        global.stage.disconnect(frameId);
        check(frames === 0, 'a settled magnifying dock must stop redrawing');
        result.idleFrames = frames;

        // Switching magnification off hands the bin back to plain hover.
        settings.set_boolean('magnify-icons', false);
        await wait(300);
        const [hx, hy] = center(icons[1]);
        move(hx, hy);
        await wait(500);
        check(icons[1].icon._iconBin.scale_x > 1 && icons[1].icon._iconBin.scale_x < 1.2,
            `plain hover must resume after magnification, got ${icons[1].icon._iconBin.scale_x}`);
        result.hoverAfterDisable = icons[1].icon._iconBin.scale_x;
        return result;
    } finally {
        if (pressed)
            button(Clutter.ButtonState.RELEASED);
        move(100, 100);
        global.settings.set_strv('favorite-apps', favorites);
        settings.set_boolean('dock-fixed', saved.fixed);
        settings.set_enum('dock-position', saved.position);
        settings.set_boolean('magnify-icons', saved.magnify);
        settings.set_double('magnify-max-scale', saved.maxScale);
        settings.set_double('magnify-range-factor', saved.range);
        settings.set_int('magnify-duration', saved.duration);
        Main.panel.statusArea.dateMenu.visible = dateMenuVisible;
        // Restoring position queues a dock replacement. Exercise its deferred
        // layout before the observer declares success or terminates Shell.
        await wait(700);
    }
}
