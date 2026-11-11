// Observe real paints in the disposable Shell. Never import this on a desktop.
/* eslint-disable no-await-in-loop -- native input and paint observations are ordered */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
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
const motionProperties = ['opacity', 'scale-x', 'scale-y', 'translation-x', 'translation-y'];

function state(actor) {
    const allocated = actor?.has_allocation();
    const [x, y] = allocated ? actor.get_transformed_position() : [0, 0];
    const box = allocated ? actor.get_allocation_box() : null;
    return {
        visible: !!actor?.visible,
        mapped: !!actor?.mapped,
        opacity: actor?.opacity ?? 0,
        scaleX: actor?.scale_x ?? 1,
        scaleY: actor?.scale_y ?? 1,
        x, y,
        width: (box?.get_width() ?? 0) * (actor?.scale_x ?? 1),
        height: (box?.get_height() ?? 0) * (actor?.scale_y ?? 1),
    };
}

async function paints(launcher, action, duration = 400) {
    const samples = [];
    const id = global.stage.connect('after-paint', () => {
        samples.push(state(launcher._menu?.actor));
    });
    try {
        action();
        await wait(duration);
    } finally {
        global.stage.disconnect(id);
    }
    return samples;
}

function checkSettled(actor) {
    check(actor.visible && actor.mapped, 'settled launcher must remain visible');
    check(actor.opacity === 255 && actor.scale_x === 1 && actor.scale_y === 1 &&
        actor.translation_x === 0 && actor.translation_y === 0,
    'settled launcher must have its final opaque, untransformed geometry');
    check(motionProperties.every(name => !actor.get_transition(name)),
        'settled launcher must release its native transitions');
}

function checkFit(launcher) {
    const rect = state(launcher._menu.actor);
    const area = launcher._getSourceWorkArea();
    check(rect.width > 0 && rect.height > 0 && area,
        'launcher and source work area must have real allocations');
    check(rect.x >= area.x - 1 && rect.y >= area.y - 1 &&
        rect.x + rect.width <= area.x + area.width + 1 &&
        rect.y + rect.height <= area.y + area.height + 1,
    `painted launcher must fit the work area: ${JSON.stringify({rect, area})}`);
    return rect;
}

function checkPickingAndFocus(launcher) {
    const icon = launcher._visibleButtons[0];
    check(icon?.mapped, 'an application must be visible');
    const [x, y] = icon.get_transformed_position();
    const [width, height] = icon.get_transformed_size();
    const picked = global.stage.get_actor_at_pos(Clutter.PickMode.ALL,
        x + width / 2, y + height / 2);
    check(picked === icon || icon.contains(picked),
        'painted application coordinates must pick that application');
    const focus = global.stage.get_key_focus();
    check(focus === launcher._entry || focus && launcher._entry.contains(focus),
        'opening must put keyboard focus in search');
}

export async function run() {
    check(GLib.getenv('GNOME_SHELL_DEV_HARNESS') === '1', 'private test session required');
    const extension = Main.extensionManager.lookup('xdock@spencercnorton.github.io');
    check(extension?.state === 1, 'XDock must be active');
    const {DockManager} = await import(`file://${extension.path}/docking.js`);
    const manager = DockManager.getDefault();
    const launcher = manager._appLauncher;
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const position = settings.get_enum('dock-position');
    const fixed = settings.get_boolean('dock-fixed');
    const clockVisible = Main.panel.statusArea.dateMenu.visible;
    const forcedAnimations = global.force_animations;
    const animationSettings = St.Settings.get();
    const animationProperty = Object.getOwnPropertyDescriptor(animationSettings, 'enable_animations');
    let animations = true;
    Object.defineProperty(animationSettings, 'enable_animations', {get: () => animations, configurable: true});
    const accessibility = St.ReducedMotion
        ? new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'}) : null;
    const reducedMotion = accessibility?.get_string('reduced-motion');
    const pointer = global.stage.get_context().get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const result = {sides: []};
    try {
        settings.set_boolean('dock-fixed', true);
        Main.overview.hide();
        Main.panel.statusArea.dateMenu.hide();
        global.force_animations = true;
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 100);

        for (const side of [St.Side.BOTTOM, St.Side.TOP, St.Side.LEFT, St.Side.RIGHT]) {
            launcher.close({animate: false});
            settings.set_enum('dock-position', side);
            await wait(400);
            const samples = await paints(launcher, () => {
                check(launcher.open(manager.mainDock.dash.showAppsButton), 'launcher must open');
            });
            check(samples.length >= 2 && samples.some(sample =>
                sample.mapped && sample.opacity > 0 && sample.opacity < 255),
            'opening must paint intermediate opacity, rather than flash fully opaque');
            check(samples.every(sample => !sample.mapped ||
                sample.scaleX > 0 && sample.scaleX <= 1 &&
                sample.scaleY > 0 && sample.scaleY <= 1),
            'opening must not overshoot or invert its painted surface');
            const actor = launcher._menu.actor;
            checkSettled(actor);
            const rect = checkFit(launcher);
            checkPickingAndFocus(launcher);
            const [pivotX, pivotY] = actor.get_pivot_point();
            check([pivotX, pivotY].every(value => Number.isFinite(value) && value >= 0 && value <= 1),
                'popup origin must remain on its surface');

            // Compare actual allocations, not only the pure grid budget. A
            // short search must not shrink the surface underneath the pointer.
            launcher._entry.set_text('Popup Test 00');
            await wait(150);
            check(launcher._visibleButtons.length === 1, 'search fixture must contain one match');
            const filtered = checkFit(launcher);
            check(Math.abs(filtered.width - rect.width) <= 1 &&
                Math.abs(filtered.height - rect.height) <= 1,
            'filtering must preserve the painted launcher size');
            result.sides.push({
                side, frames: samples.length,
                width: rect.width, height: rect.height, pivotX, pivotY,
            });
        }

        launcher.close({animate: false});
        settings.set_enum('dock-position', St.Side.BOTTOM);
        await wait(400);
        check(launcher.open(manager.mainDock.dash.showAppsButton), 'interruption fixture must open');
        await wait(65);
        const actor = launcher._menu.actor;
        check(actor.visible && actor.opacity > 0 && actor.opacity < 255,
            'close must interrupt a real opening transition');
        launcher.close();
        await wait(30);
        const beforeReopen = state(actor);
        check(beforeReopen.visible && beforeReopen.opacity > 0,
            'reopen must interrupt a real closing transition');
        const reversed = await paints(launcher, () => {
            check(launcher.open(manager.mainDock.dash.showAppsButton), 'interrupted popup must reopen');
        }, 450);
        check(reversed.length >= 2 && reversed.every(sample => sample.visible && sample.mapped),
            'an interrupted close must never hide the reopened launcher');
        let previousOpacity = beforeReopen.opacity;
        let previousScaleX = beforeReopen.scaleX;
        let previousScaleY = beforeReopen.scaleY;
        for (const sample of reversed) {
            check(sample.opacity >= previousOpacity - 1 &&
                sample.scaleX >= previousScaleX - 0.001 && sample.scaleY >= previousScaleY - 0.001,
            'reopening must continue from the painted state without an opacity or scale reset');
            previousOpacity = sample.opacity;
            previousScaleX = sample.scaleX;
            previousScaleY = sample.scaleY;
        }
        checkSettled(actor);
        checkPickingAndFocus(launcher);
        result.interrupted = {frames: reversed.length, fromOpacity: beforeReopen.opacity};

        for (const reduced of [false, ...accessibility ? [true] : []]) {
            launcher.close({animate: false});
            animations = reduced;
            global.force_animations = false;
            if (reduced) {
                accessibility.set_string('reduced-motion', 'reduce');
                await wait(100);
                check(animationSettings.reducedMotion === St.ReducedMotion.REDUCE,
                    'Shell must receive the real reduced-motion preference');
            }
            check(launcher.open(manager.mainDock.dash.showAppsButton), 'no-motion launcher must open');
            checkSettled(launcher._menu.actor);
            launcher.close();
            check(!launcher._menu.actor.visible &&
                motionProperties.every(name => !launcher._menu.actor.get_transition(name)),
            'no-motion close must hide immediately without a native transition');
        }
        result.reducedMotion = 'pass';

        if (accessibility)
            accessibility.set_string('reduced-motion', reducedMotion);
        animations = true;
        global.force_animations = true;
        check(launcher.open(manager.mainDock.dash.showAppsButton), 'idle fixture must open');
        await wait(500);
        // Keep the grab and keyboard focus inside the launcher, but remove the
        // search caret's unrelated blink from the still-screen measurement.
        launcher._visibleButtons[0].grab_key_focus();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 100);
        await wait(500);
        check(launcher.isOpen, 'the idle observation must measure an open launcher');
        let frames = 0;
        const id = global.stage.connect('after-paint', () => frames++);
        await wait(750);
        global.stage.disconnect(id);
        check(frames === 0, `settled launcher must stop painting: ${frames} frames`);
        result.idleFrames = frames;
        return result;
    } finally {
        launcher.close({animate: false});
        global.stage.set_key_focus(null);
        if (accessibility)
            accessibility.set_string('reduced-motion', reducedMotion);
        if (animationProperty)
            Object.defineProperty(animationSettings, 'enable_animations', animationProperty);
        else
            delete animationSettings.enable_animations;
        global.force_animations = forcedAnimations;
        settings.set_enum('dock-position', position);
        settings.set_boolean('dock-fixed', fixed);
        Main.panel.statusArea.dateMenu.visible = clockVisible;
        await wait(500);
    }
}
