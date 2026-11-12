// Drag the launcher's rim in the disposable Shell. Never import this on a desktop.
/* eslint-disable no-await-in-loop -- native input and paint observations are ordered */
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

function rect(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}

export async function run() {
    check(GLib.getenv('GNOME_SHELL_DEV_HARNESS') === '1', 'private test session required');
    const extension = Main.extensionManager.lookup('xdock@spencercnorton.github.io');
    check(extension?.state === 1, 'XDock must be active');
    const {DockManager} = await import(`file://${extension.path}/docking.js`);
    const manager = DockManager.getDefault();
    const launcher = manager._appLauncher;
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const saved = {
        position: settings.get_enum('dock-position'),
        fixed: settings.get_boolean('dock-fixed'),
        appsAtTop: settings.get_boolean('show-apps-at-top'),
    };
    const clockVisible = Main.panel.statusArea.dateMenu.visible;
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const now = () => GLib.get_monotonic_time();
    const move = (x, y) => pointer.notify_absolute_motion(now(), x, y);
    const button = state => pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, state);
    let pressed = false;
    const surface = () => rect(launcher._menu.box);
    const cursor = () => launcher._menu.actor.get_cursor_type();
    const size = () => ({
        gridWidth: launcher._gridWidth,
        columns: launcher._columns,
        gridHeight: launcher._gridHeight,
    });
    const stored = () => ({
        gridWidth: settings.get_int('launcher-grid-width'),
        columns: settings.get_int('launcher-columns'),
        gridHeight: settings.get_int('launcher-grid-height'),
    });
    const nothingStored = () => Object.values(stored()).every(value => value === 0);
    const forget = () => ['launcher-grid-width', 'launcher-columns', 'launcher-grid-height']
        .forEach(key => settings.reset(key));
    const open = async () => {
        launcher.close({animate: false});
        await wait(100);
        check(launcher.open(manager.mainDock.dash.showAppsButton), 'launcher must open');
        await wait(600);
        check(launcher.isOpen, 'launcher must stay open');
    };
    // Press on a point, travel in steps, release: what a hand does.
    const drag = async (from, to, {release = true} = {}) => {
        move(from.x, from.y);
        await wait(80);
        button(Clutter.ButtonState.PRESSED);
        pressed = true;
        await wait(60);
        for (let step = 1; step <= 12; step++) {
            move(from.x + (to.x - from.x) * step / 12, from.y + (to.y - from.y) * step / 12);
            await wait(25);
        }
        await wait(120);
        if (release) {
            button(Clutter.ButtonState.RELEASED);
            pressed = false;
            await wait(250);
        }
    };
    const result = {};

    try {
        forget();
        settings.set_boolean('dock-fixed', true);
        // Show Apps at the start of a centred dock leaves the popup room to
        // grow on both sides, so a dragged edge can be held to the pointer.
        settings.set_boolean('show-apps-at-top', true);
        settings.set_enum('dock-position', St.Side.BOTTOM);
        Main.overview.hide();
        Main.panel.statusArea.dateMenu.hide();
        move(640, 300);
        await wait(700);
        await open();

        // The rim is padding: no control of the popup may sit under it.
        const before = surface();
        for (const actor of [launcher._entry, launcher._scrollView, launcher._sidebar,
            launcher._header, launcher._footer]) {
            const r = rect(actor);
            for (let i = 0; i <= 10; i++) {
                for (const [x, y] of [[r.x + r.width * i / 10, r.y], [r.x + r.width * i / 10, r.y + r.height - 1],
                    [r.x, r.y + r.height * i / 10], [r.x + r.width - 1, r.y + r.height * i / 10]]) {
                    check(!launcher._resizeEdgeAt(x, y),
                        `the resize rim must not cover ${actor.style_class}: ${JSON.stringify({x, y, before})}`);
                }
            }
        }
        result.rimClearOfControls = 'pass';

        // Hovering announces the edge; the middle and the dock's edge do not.
        const centerX = before.x + before.width / 2;
        move(centerX, before.y + 3);
        await wait(120);
        check(cursor() === Clutter.CursorType.N_RESIZE, `top edge must show a resize cursor, got ${cursor()}`);
        move(before.x + before.width - 3, before.y + 3);
        await wait(120);
        check(cursor() === Clutter.CursorType.NE_RESIZE, `top-right corner must show a diagonal cursor, got ${cursor()}`);
        move(centerX, before.y + before.height / 2);
        await wait(120);
        check(cursor() === Clutter.CursorType.INHERIT, 'the popup body must not show a resize cursor');
        move(centerX, before.y + before.height - 3);
        await wait(120);
        check(cursor() === Clutter.CursorType.INHERIT, 'the edge against the dock must not resize');
        result.cursors = 'pass';

        // A click on the rim neither closes the popup nor saves a size.
        move(centerX, before.y + 3);
        await wait(80);
        button(Clutter.ButtonState.PRESSED);
        await wait(60);
        button(Clutter.ButtonState.RELEASED);
        await wait(500);
        check(launcher.isOpen, 'clicking the rim must keep the launcher open');
        check(nothingStored(), 'a click must not save a size');

        // Taller: the top edge follows the pointer and the arrow stays put.
        const start = size();
        await drag({x: centerX, y: before.y + 3}, {x: centerX, y: before.y + 3 - 80});
        const taller = surface();
        check(launcher.isOpen, 'resizing must keep the launcher open');
        check(size().gridHeight === start.gridHeight + 80,
            `the results must grow by the drag: ${start.gridHeight} -> ${size().gridHeight}`);
        check(Math.abs(taller.y - (before.y - 80)) <= 1.5,
            `the top edge must follow the pointer: ${before.y} -> ${taller.y}`);
        check(Math.abs(taller.y + taller.height - before.y - before.height) <= 1.5,
            'the edge against the dock must not move');
        check(stored().gridHeight === size().gridHeight && stored().gridWidth === 0,
            `only the dragged axis is saved: ${JSON.stringify(stored())}`);
        result.taller = {from: start.gridHeight, to: size().gridHeight};

        // Wider: the dragged edge follows the pointer to the pixel, whether the
        // popup is centred on its button (both edges move) or pushed along by
        // the screen edge (one does), and glides rather than jumping a column.
        const [buttonX] = manager.mainDock.dash.showAppsButton.get_transformed_position();
        const buttonCenter = buttonX + manager.mainDock.dash.showAppsButton.get_transformed_size()[0] / 2;
        const centred = Math.abs(taller.x + taller.width / 2 - buttonCenter) <= 2;
        let lastEdge = taller.x + taller.width;
        let edgeStep = 0;
        const edgeSampler = global.stage.connect('after-paint', () => {
            const box = launcher._menu?.box;
            if (!box?.has_allocation())
                return;
            const edge = box.get_transformed_position()[0] + box.get_allocation_box().get_width();
            edgeStep = Math.max(edgeStep, Math.abs(edge - lastEdge));
            lastEdge = edge;
        });
        await drag({x: taller.x + taller.width - 3, y: taller.y + taller.height / 2},
            {x: taller.x + taller.width - 3 + 120, y: taller.y + taller.height / 2});
        global.stage.disconnect(edgeSampler);
        const wider = surface();
        const centredAfter = Math.abs(wider.x + wider.width / 2 - buttonCenter) <= 2;
        const edgeError = Math.abs(wider.x + wider.width - taller.x - taller.width - 120);
        check(size().columns > start.columns, `dragging out must add columns: ${size().columns}`);
        check(edgeError <= 1.5,
            `the right edge must follow the pointer: ${taller.x + taller.width} -> ${wider.x + wider.width} ` +
            `(${centred ? 'centred' : 'held'} -> ${centredAfter ? 'centred' : 'held'})`);
        // The drag moves the pointer 10px at a time; a column is 80px.
        check(edgeStep <= 25, `the dragged edge must glide, not jump: ${edgeStep}px in one frame`);
        check(stored().gridWidth === size().gridWidth && stored().columns === 0, 'the width must be saved');
        const widths = launcher._visibleButtons.filter(b => b.mapped).map(b => rect(b).width);
        check(widths.length > 0 && widths.every(width => width >= launcher._cellWidth - 1) &&
            Math.max(...widths) - Math.min(...widths) <= 1,
        `result tiles must share the width evenly and never shrink: ${widths}`);
        result.wider = {
            columns: size().columns,
            centred,
            centredAfter,
            edgeError: Math.round(edgeError * 10) / 10,
            maxFrameStep: Math.round(edgeStep * 10) / 10,
        };

        // A size saved on this screen outlives the popup.
        const resized = size();
        await open();
        check(size().gridWidth === resized.gridWidth && size().gridHeight === resized.gridHeight,
            `reopening must keep the dragged size: ${JSON.stringify(size())}`);
        const reopened = surface();
        check(Math.abs(reopened.width - wider.width) <= 1 && Math.abs(reopened.height - wider.height) <= 1,
            'reopening must paint the dragged size');
        result.persisted = 'pass';

        // Escape abandons a drag where it is: same size, nothing saved, still open.
        await drag({x: reopened.x + reopened.width / 2, y: reopened.y + 3},
            {x: reopened.x + reopened.width / 2, y: reopened.y + 3 + 60}, {release: false});
        check(size().gridHeight < resized.gridHeight, 'the top edge must shrink the popup during the drag');
        keyboard.notify_keyval(now(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(now(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await wait(150);
        button(Clutter.ButtonState.RELEASED);
        pressed = false;
        await wait(300);
        check(launcher.isOpen, 'Escape during a drag must not close the launcher');
        check(size().gridHeight === resized.gridHeight && stored().gridHeight === resized.gridHeight,
            `Escape must restore the size before the drag: ${JSON.stringify(size())}`);
        result.escapeCancels = 'pass';

        // Dragging past the screen stops at the screen.
        await drag({x: reopened.x + reopened.width / 2, y: reopened.y + 3},
            {x: reopened.x + reopened.width / 2, y: 0});
        const tallest = surface();
        const area = launcher._getSourceWorkArea();
        check(tallest.y >= area.y - 1 && tallest.y + tallest.height <= area.y + area.height + 1,
            `the popup must stay inside the work area: ${JSON.stringify({tallest, area})}`);
        result.clamped = {gridHeight: size().gridHeight};

        // Double-clicking the rim restores the default size.
        const rim = surface();
        move(rim.x + rim.width / 2, rim.y + 3);
        await wait(80);
        for (let click = 0; click < 2; click++) {
            button(Clutter.ButtonState.PRESSED);
            await wait(30);
            button(Clutter.ButtonState.RELEASED);
            await wait(30);
        }
        await wait(400);
        check(launcher.isOpen, 'double-clicking the rim must keep the launcher open');
        check(nothingStored(), 'double-click must forget the size');
        check(size().gridWidth === start.gridWidth && size().gridHeight === start.gridHeight,
            `double-click must restore the default size: ${JSON.stringify(size())}`);
        result.resetByDoubleClick = 'pass';

        // A width saved as columns by the previous version opens at that
        // width, and the next drag saves it in pixels instead.
        launcher.close({animate: false});
        settings.set_int('launcher-columns', 4);
        await open();
        check(size().gridWidth === 4 * launcher._cellWidth, `a saved column count must still apply: ${size().gridWidth}`);
        const legacy = surface();
        await drag({x: legacy.x + legacy.width - 3, y: legacy.y + legacy.height / 2},
            {x: legacy.x + legacy.width - 3 + 20, y: legacy.y + legacy.height / 2});
        check(stored().gridWidth === size().gridWidth && stored().columns === 0,
            `a drag must replace the column count with a width: ${JSON.stringify(stored())}`);
        forget();
        result.legacyColumns = 'pass';

        // A dock at the left: the popup opens to the right, and its left edge
        // stays against the dock.
        launcher.close({animate: false});
        settings.set_enum('dock-position', St.Side.LEFT);
        await wait(700);
        await open();
        const side = surface();
        move(side.x + 3, side.y + side.height / 2);
        await wait(120);
        check(cursor() === Clutter.CursorType.INHERIT, 'the edge against a left dock must not resize');
        await drag({x: side.x + side.width - 3, y: side.y + side.height / 2},
            {x: side.x + side.width - 3 + 80, y: side.y + side.height / 2});
        const sideWider = surface();
        check(Math.abs(sideWider.x + sideWider.width - (side.x + side.width + 80)) <= 1.5,
            `away from a side dock the edge follows the pointer: ${side.x + side.width} -> ${sideWider.x + sideWider.width}`);
        check(size().columns === start.columns + 1,
            `away from a side dock one column per column of travel: ${size().columns}`);
        check(Math.abs(sideWider.x - side.x) <= 1.5, 'the edge against the dock must not move');
        result.leftDock = {columns: size().columns};

        // A resized popup at rest draws nothing.
        move(sideWider.x + sideWider.width / 2, sideWider.y + sideWider.height / 2);
        await wait(800);
        let frames = 0;
        const frameId = global.stage.connect('after-paint', () => frames++);
        await wait(1000);
        global.stage.disconnect(frameId);
        check(frames === 0, `a resized launcher at rest must not repaint: ${frames} frames`);
        result.idleFrames = frames;
        return result;
    } finally {
        if (pressed)
            button(Clutter.ButtonState.RELEASED);
        launcher.close({animate: false});
        move(640, 300);
        forget();
        settings.set_enum('dock-position', saved.position);
        settings.set_boolean('dock-fixed', saved.fixed);
        settings.set_boolean('show-apps-at-top', saved.appsAtTop);
        Main.panel.statusArea.dateMenu.visible = clockVisible;
        await wait(700);
    }
}
