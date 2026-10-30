// Run only in a private Shell with the popup-test desktop fixtures installed.
/* eslint-disable no-await-in-loop -- ordered native input and animation observations */
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
    const launcher = manager._appLauncher;
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const fixed = settings.get_boolean('dock-fixed');
    const clockVisible = Main.panel.statusArea.dateMenu.visible;
    const animationSettings = St.Settings.get();
    const animationProperty = Object.getOwnPropertyDescriptor(animationSettings, 'enable_animations');
    let animations = true;
    Object.defineProperty(animationSettings, 'enable_animations', {get: () => animations, configurable: true});
    const pointer = global.stage.get_context().get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    const wheel = direction => {
        // Initial font/icon loading can reposition an anchored popup. Target
        // its current allocation rather than the position from the last open.
        const view = launcher._scrollView;
        const [x, y] = view.get_transformed_position();
        const [w, h] = view.get_transformed_size();
        move(x + w / 2, y + h / 2);
        pointer.notify_discrete_scroll(GLib.get_monotonic_time(), direction, Clutter.ScrollSource.WHEEL);
    };
    const open = async () => {
        check(launcher.open(manager.mainDock.dash.showAppsButton), 'popup opens');
        launcher._entry.set_text('Popup Test');
        await wait(500);
        const view = launcher._scrollView;
        const [x, y] = view.get_transformed_position();
        const [w, h] = view.get_transformed_size();
        move(x + w / 2, y + h / 2);
        await wait(200);
        check(view.vadjustment.upper > view.vadjustment.page_size, 'fixture must scroll');
        return view.vadjustment;
    };
    const waitForMotion = async adjustment => {
        for (let i = 0; i < 25 && !adjustment.get_transition('value'); i++)
            await wait(10);
        check(adjustment.get_transition('value'), 'wheel must start a native transition');
    };
    let pressed = false;
    const result = {};
    try {
        settings.set_boolean('dock-fixed', true);
        Main.overview.hide();
        Main.panel.statusArea.dateMenu.hide();
        await wait(500);
        let adjustment = await open();
        const unit = Math.pow(adjustment.page_size, 2 / 3);
        check(adjustment.upper - adjustment.page_size > unit * 2, 'fixture needs two full wheel steps');
        adjustment.value = 0;
        launcher._showHoverLabel(launcher._visibleButtons[0]);
        await wait(200);
        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        await wait(35);
        check(adjustment.value > 0 && adjustment.value < unit, 'wheel must interpolate instead of jumping');
        check(!launcher._hoverLabel.visible, 'scroll must hide the floating label');
        result.intermediate = {value: adjustment.value, target: launcher._scrollTarget};
        wheel(Clutter.ScrollDirection.DOWN);
        await wait(35);
        check(Math.abs(launcher._scrollTarget - unit * 2) < 0.01, 'rapid ticks retain both distances');
        await wait(300);
        check(Math.abs(adjustment.value - unit * 2) < 0.01, 'wheel reaches its accumulated target');
        check(!adjustment.get_transition('value') && launcher._scrollTarget === null, 'wheel settles');
        result.wheel = 'pass';

        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        await wait(30);
        wheel(Clutter.ScrollDirection.UP);
        await wait(30);
        check(launcher._scrollTarget < adjustment.value, 'wheel reversal changes direction immediately');
        await wait(300);
        result.reversal = 'pass';

        for (const [start, direction, end] of [
            [adjustment.upper - adjustment.page_size - 1, Clutter.ScrollDirection.DOWN,
                adjustment.upper - adjustment.page_size],
            [1, Clutter.ScrollDirection.UP, 0],
        ]) {
            adjustment.value = start;
            wheel(direction);
            await wait(300);
            check(Math.abs(adjustment.value - end) < 0.01, 'wheel target must clamp to the viewport');
            wheel(direction);
            await wait(50);
            check(!adjustment.get_transition('value'), 'scrolling at a boundary must not animate');
        }
        result.bounds = 'pass';

        adjustment.value = unit;
        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 0.1,
            Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
        await wait(50);
        check(launcher._scrollTarget === null && !adjustment.get_transition('value'),
            'touchpad scrolling must take control directly');
        result.touchpad = 'pass';

        adjustment.value = 0;
        pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 0.25,
            Clutter.ScrollSource.WHEEL, Clutter.ScrollFinishFlags.NONE);
        await wait(70);
        // The virtual backend marks a wheel's smooth partner as emulated.
        // Counting it as well as the discrete tick would double the distance.
        check(adjustment.value === 0 && !adjustment.get_transition('value'),
            'an emulated smooth partner must not duplicate wheel scrolling');
        result.emulatedWheel = 'pass';

        adjustment.value = 0;
        animations = false;
        wheel(Clutter.ScrollDirection.DOWN);
        await wait(70);
        check(Math.abs(adjustment.value - unit) < 0.01 && !adjustment.get_transition('value'),
            'reduced motion must update immediately');
        animations = true;
        result.reducedMotion = 'pass';

        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        launcher._focusResult(launcher._visibleButtons.length - 1);
        check(!adjustment.get_transition('value') && launcher._scrollTarget === null,
            'keyboard focus must cancel wheel motion');
        launcher._entry.grab_key_focus();
        adjustment.value = 0;
        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        launcher._entry.set_text('Popup Test 00');
        await wait(350);
        check(launcher._visibleButtons.length === 1, 'search filters results');
        check(!adjustment.get_transition('value') && launcher._scrollTarget === null,
            'filtering must cancel wheel motion');
        result.keyboardAndSearch = 'pass';

        adjustment = await open();
        adjustment.value = 0;
        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        const scrollbar = launcher._scrollView.get_children()
            .find(actor => actor instanceof St.ScrollBar && actor.height > actor.width);
        check(scrollbar, 'vertical scrollbar is present');
        const [barX, barY] = scrollbar.get_transformed_position();
        move(barX + scrollbar.width / 2, barY + scrollbar.height / 2);
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
        pressed = true;
        await wait(50);
        check(launcher._scrollTarget === null, 'scrollbar interaction takes control');
        pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        pressed = false;
        result.scrollbar = 'pass';

        adjustment = await open();
        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        launcher.close({animate: false});
        check(!adjustment.get_transition('value') && launcher._scrollTarget === null,
            'closing must cancel scroll animation');
        adjustment = await open();
        check(adjustment.value === 0, 'reopening starts at the top');
        wheel(Clutter.ScrollDirection.DOWN);
        await waitForMotion(adjustment);
        let transitionStopped = false;
        adjustment.get_transition('value').connectObject('stopped', () => {
            transitionStopped = true;
        }, launcher._menu.actor);
        launcher._destroyMenu();
        check(transitionStopped && launcher._scrollTarget === null,
            'rebuilding must release the previous adjustment');
        adjustment = await open();
        result.closeAndRebuild = 'pass';
        move(100, 100);
        await wait(1000);
        let frames = 0;
        const id = global.stage.connect('after-paint', () => frames++);
        await wait(1000);
        global.stage.disconnect(id);
        check(frames === 0, `settled popup must stop drawing, got ${frames} frames`);
        result.idleFrames = frames;
        return result;
    } finally {
        if (pressed)
            pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
        move(100, 100);
        launcher.close({animate: false});
        settings.set_boolean('dock-fixed', fixed);
        Main.panel.statusArea.dateMenu.visible = clockVisible;
        if (animationProperty)
            Object.defineProperty(animationSettings, 'enable_animations', animationProperty);
        else
            delete animationSettings.enable_animations;
    }
}
