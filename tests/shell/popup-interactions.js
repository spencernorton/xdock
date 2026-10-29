// Import and call run() from a private headless Shell's test harness. The
// harness must set GNOME_SHELL_DEV_HARNESS=1; never run on a live desktop.
// Supply at least 60 test desktop files in its private XDG_DATA_HOME, named
// xdock-popup-test-*.desktop with Name=Popup Test NN and a symbolic icon.
/* eslint-disable no-await-in-loop -- native input and frame observations must run in order */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
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
    const launcher = manager._appLauncher;
    const favorites = global.settings.get_strv('favorite-apps');
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const position = settings.get_enum('dock-position');
    const fixed = settings.get_boolean('dock-fixed');
    const dateMenuVisible = Main.panel.statusArea.dateMenu.visible;
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    const button = state => pointer.notify_button(GLib.get_monotonic_time(), 1, state);
    let pressed = false;
    let blur = null;
    let note = null;
    const clips = [];
    const result = {drops: []};

    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 600, 400);
    await wait(150);

    try {
        settings.set_boolean('dock-fixed', true);
        settings.set_enum('dock-position', St.Side.BOTTOM);
        Main.overview.hide();
        Main.panel.statusArea.dateMenu.hide();
        global.settings.set_strv('favorite-apps', ['xdock-popup-test-00.desktop']);
        await wait(500);

        // Reorder within the dock itself. Drag targeting picks with
        // PickMode.ALL, so any actor layered over the icons that still
        // answers a pick (the dock blur's redraw clone did, before it
        // learned not to) silently eats every drop: the drag starts, no
        // placeholder ever appears, and the release just cancels. Assert
        // the whole arc, not only the final order.
        global.settings.set_strv('favorite-apps', [
            'xdock-popup-test-00.desktop', 'xdock-popup-test-01.desktop',
            'xdock-popup-test-02.desktop', 'xdock-popup-test-03.desktop',
        ]);
        await wait(500);
        const dash = manager.mainDock.dash;
        const dockIcons = dash.getAppIcons();
        check(dockIcons.length >= 3, 'reorder needs at least three dock icons');
        const draggedId = dockIcons[0].app.get_id();
        const [rx, ry] = dockIcons[0].get_transformed_position();
        const startX = rx + dockIcons[0].width / 2;
        const startY = ry + dockIcons[0].height / 2;
        const [tx2, ty2] = dockIcons[2].get_transformed_position();
        const endX = tx2 + dockIcons[2].width / 2 + 10;
        const endY = ty2 + dockIcons[2].height / 2;
        move(startX, startY);
        await wait(120);
        pressed = true;
        button(Clutter.ButtonState.PRESSED);
        await wait(120);
        for (let step = 1; step <= 10; step++) {
            move(startX + (endX - startX) * step / 10,
                startY + (endY - startY) * step / 10);
            // eslint-disable-next-line no-await-in-loop -- ordered native input
            await wait(40);
        }
        check(!!dockIcons[0]._dragging, 'dock icon drag must start');
        check(!!dash._dragPlaceholder, 'drag over the dock must show a placeholder');
        // Shell's placeholder includes the source icon. Removing that icon
        // shifts a later drop slot left by one; the live layout can put the
        // placeholder before or after the target icon's center.
        const before = global.settings.get_strv('favorite-apps');
        const originalIndex = before.indexOf(draggedId);
        const dropIndex = dash._dragPlaceholderPos - (originalIndex < dash._dragPlaceholderPos ? 1 : 0);
        check(dropIndex !== originalIndex, 'the reorder gesture must target a different slot');
        const expectedOrder = before.filter(id => id !== draggedId);
        expectedOrder.splice(dropIndex, 0, draggedId);
        button(Clutter.ButtonState.RELEASED);
        pressed = false;
        await wait(600);
        check(JSON.stringify(global.settings.get_strv('favorite-apps')) === JSON.stringify(expectedOrder),
            'drop must move the favorite to the placeholder position');
        result.reorder = 'pass';
        global.settings.set_strv('favorite-apps', ['xdock-popup-test-00.desktop']);
        await wait(500);

        const open = async () => {
            launcher.open(manager.mainDock.dash.showAppsButton);
            await wait(200);
            launcher._entry.set_text('Popup Test');
            await wait(200);
            check(launcher._visibleButtons.length >= 60, '60 private test applications required');
        };
        await open();
        const helper = launcher._menu.box.get_children()
            .find(actor => actor.constructor.name === 'XDockWholeSurfaceRedraw');
        check(helper?.width === launcher._menu.box.width &&
            helper.height === launcher._menu.box.height, 'helper must cover the popup');
        const first = launcher._visibleButtons[0];
        const [x, y] = first.get_transformed_position();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.ALL,
            x + first.width / 2, y + first.height / 2);
        check(first === picked || first.contains(picked), 'helper must not intercept grid picking');

        launcher._showHoverLabel(first);
        check(launcher._hoverLabel.visible, 'label must show');
        const adjustment = launcher._scrollView.vadjustment;
        check(adjustment.upper > adjustment.page_size, 'fixture must scroll');
        adjustment.value = 80;
        check(!launcher._hoverLabel.visible, 'scroll must hide the floating label');
        adjustment.value = 0;
        launcher._showHoverLabel(first);
        launcher._menu.close(0);
        check(!launcher._hoverLabel.visible, 'native close must hide the floating label');
        result.labels = 'pass';
        await open();

        // When Blur my Shell is included in the private session, observe its
        // real popup blur surface rather than substituting a test effect.
        blur = Main.uiGroup.get_children()
            .find(actor => actor.name === 'bms-popup-blurred-widget' && actor.visible);
        if (blur) {
            const Note = GObject.registerClass(class PopupInteractionClipNote extends Clutter.Effect {
                vfunc_paint(node, context, flags) {
                    const clip = context.get_redraw_clip();
                    const [bx, by] = blur.get_transformed_position();
                    const [width, height] = blur.get_transformed_size();
                    const rect = new Mtk.Rectangle({
                        x: Math.ceil(bx), y: Math.ceil(by),
                        width: Math.floor(bx + width) - Math.ceil(bx),
                        height: Math.floor(by + height) - Math.ceil(by),
                    });
                    clips.push(clip === null || clip.contains_rectangle(rect) === Mtk.RegionOverlap.IN);
                    super.vfunc_paint(node, context, flags);
                }
            });
            note = new Note();
            blur.add_effect(note);
            await wait(300);
            clips.length = 0;
            for (const icon of launcher._visibleButtons.slice(0, 6)) {
                const [ix, iy] = icon.get_transformed_position();
                move(ix + icon.width / 2, iy + icon.height / 2);
                await wait(100);
            }
            for (const value of [40, 80, 120, 0]) {
                adjustment.value = value;
                await wait(100);
            }
            await wait(300);
            check(clips.length > 0 && clips.every(Boolean), 'popup blur must receive whole-surface redraws');
            result.blurFrames = clips.length;
            blur.remove_effect(note);
            note = null;
        } else {
            result.blurFrames = 'not tested: no popup blur provider';
        }

        move(100, 100);
        global.stage.set_key_focus(null);
        await wait(500);
        let frames = 0;
        const frameId = global.stage.connect('after-paint', () => frames++);
        await wait(1000);
        global.stage.disconnect(frameId);
        check(frames === 0, 'an idle popup must stop redrawing');
        result.idleFrames = frames;

        // Normal handoff, immediate release, and a vertical dock. A quick
        // release deliberately arrives without an intermediate hover frame.
        for (const [side, fast] of [[St.Side.BOTTOM, false], [St.Side.BOTTOM, true], [St.Side.LEFT, true]]) {
            launcher.close({animate: false});
            settings.set_enum('dock-position', side);
            await wait(400);
            await open();
            const pinned = new Set(global.settings.get_strv('favorite-apps'));
            const icon = launcher._visibleButtons.find(item => !pinned.has(item.app.get_id()));
            const appId = icon.app.get_id();
            const [ix, iy] = icon.get_transformed_position();
            move(ix + icon.width / 2, iy + icon.height / 2);
            await wait(60);
            pressed = true;
            button(Clutter.ButtonState.PRESSED);
            await wait(60);
            move(ix + icon.width / 2 - 30, iy + icon.height / 2 + 30);
            await wait(120);
            check(launcher._draggingIcon === icon, 'native gesture must start the drag');
            const box = manager.mainDock.dash._box;
            const [dx, dy] = box.get_transformed_position();
            move(dx + (side === St.Side.BOTTOM ? 10 : box.width / 2),
                dy + (side === St.Side.BOTTOM ? box.height / 2 : 10));
            if (!fast)
                await wait(200);
            button(Clutter.ButtonState.RELEASED);
            pressed = false;
            await wait(500);
            check(global.settings.get_strv('favorite-apps').includes(appId), 'drop must pin the application');
            check(!launcher.isOpen, 'successful dock drop must close the launcher');
            check(!launcher._draggingIcon && !launcher._dragCloseId && launcher._idleSources.size === 0,
                'drag completion must release sources and callbacks');
            result.drops.push({side, fast, pinned: true});
        }
        return result;
    } finally {
        if (pressed)
            button(Clutter.ButtonState.RELEASED);
        if (note)
            blur.remove_effect(note);
        launcher.close({animate: false});
        global.settings.set_strv('favorite-apps', favorites);
        settings.set_enum('dock-position', position);
        settings.set_boolean('dock-fixed', fixed);
        Main.panel.statusArea.dateMenu.visible = dateMenuVisible;
        await wait(700);
    }
}
