// Import and call run() from a private headless Shell's test harness. The
// harness must set GNOME_SHELL_DEV_HARNESS=1; never run on a live desktop.
// Supply the same xdock-popup-test-*.desktop fixtures as popup-interactions.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
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

async function checkRenderedRow(dash, settings, icons, move, center) {
    const indicatorIcon = icons[2];
    const savedStyle = settings.get_enum('running-indicator-style');
    const savedRunning = indicatorIcon.running;
    const savedCount = indicatorIcon.windowsCount;
    let signal = 0;
    let samples = 0;
    let dotSamples = 0;
    let modelError = 0;
    let anchorError = 0;
    let dotError = 0;
    let clipped = 0;
    let labelSamples = 0;
    let labelError = 0;
    let labelGapMin = Infinity;
    let labelGapMax = -Infinity;
    let labelFraction = 0;
    try {
        settings.set_enum('running-indicator-style', 9); // Single running dot.
        indicatorIcon.windowsCount = 1;
        indicatorIcon.running = true;
        move(100, 100);
        await wait(500);
        const baseline = dash._box.get_children().filter(item => item.setMagnifyScale && item.visible)
            .map(item => ({
                item,
                width: item.get_allocation_box().get_width(),
                center: center(item.child.icon?._iconBin ?? item.child)[0],
            })).sort((a, b) => a.center - b.center);

        signal = global.stage.connect('after-paint', () => {
            const rest = dash._magnifyRest;
            const scales = baseline.map(entry => rest?.scales[rest.items.indexOf(entry.item)]);
            if (!scales.every(Number.isFinite))
                return;
            // Derive the row from measured resting widths and current scales,
            // independently of BoxLayout allocations and floating-copy positions.
            const growth = baseline.map((entry, i) => entry.width * (scales[i] - 1));
            let offset = -growth.reduce((sum, value) => sum + value, 0) / 2;
            const [viewX] = dash._scrollView.get_transformed_position();
            const viewRight = viewX + dash._scrollView.get_allocation_box().get_width();
            baseline.forEach((entry, i) => {
                const expected = entry.center + offset + growth[i] / 2;
                offset += growth[i];
                const icon = entry.item.child;
                const bin = icon.icon?._iconBin ?? icon;
                if (!bin.has_allocation())
                    return;
                const box = bin.get_allocation_box();
                const [sourceX, sourceY] = bin.get_transformed_position();
                const floating = icon._floatLayer?.visible && icon._floatClone?.mapped;
                const clone = icon._floatClone;
                // Cached position reads preserve painted geometry. Transformed
                // size reads could force layout and conceal the stepped row.
                const [x, y] = floating ? clone.get_transformed_position() : [sourceX, sourceY];
                const scale = floating ? clone.scale_x : 1;
                const width = box.get_width() * scale;
                const actual = x + width / 2;
                modelError = Math.max(modelError, Math.abs(actual - expected));
                if (floating) {
                    anchorError = Math.max(anchorError,
                        Math.abs(actual - sourceX - box.get_width() / 2),
                        Math.abs(y + box.get_height() * clone.scale_y - sourceY - box.get_height()));
                } else {
                    clipped = Math.max(clipped, viewX - x, x + width - viewRight);
                }
                // The hover label rides on the painted icon: centred on it, a
                // constant gap above its grown top edge, on whole pixels.
                const label = entry.item.label;
                if (label?.visible && label.opacity > 0 && label.has_allocation()) {
                    const [labelX, labelY] = label.get_transformed_position();
                    const labelBox = label.get_allocation_box();
                    const gap = y - labelY - labelBox.get_height();
                    labelError = Math.max(labelError,
                        Math.abs(labelX + labelBox.get_width() / 2 - actual));
                    labelGapMin = Math.min(labelGapMin, gap);
                    labelGapMax = Math.max(labelGapMax, gap);
                    labelFraction = Math.max(labelFraction,
                        Math.abs(labelX - Math.round(labelX)), Math.abs(labelY - Math.round(labelY)));
                    labelSamples++;
                }
                if (icon === indicatorIcon) {
                    const area = icon._indicator._indicators.find(indicator => indicator._area)?._area;
                    if (area?.visible && area.has_allocation()) {
                        const [dotX] = area.get_transformed_position();
                        dotError = Math.max(dotError,
                            Math.abs(dotX + area.get_allocation_box().get_width() / 2 - actual));
                        dotSamples++;
                    }
                }
                samples++;
            });
        });
        const [left, y] = center(icons[0]);
        const [right] = center(icons.at(-1));
        let rebased = false;
        for (const [start, end] of [[left, right], [right, left]]) {
            move(start, y);
            // eslint-disable-next-line no-await-in-loop -- ordered native input
            await wait(400);
            for (let step = 1; step <= 80; step++) {
                move(start + (end - start) * step / 80, y);
                if (!rebased && step === 40) {
                    dash.invalidateMagnifyGeometry();
                    rebased = true;
                }
                // eslint-disable-next-line no-await-in-loop -- ordered native input
                await wait(15);
            }
        }
        // Hop between neighbours with the label already up: each icon grows
        // and settles under its label, which is where a label placed from a
        // stale size bounced by its margin.
        for (const index of [3, 2, 3, 2]) {
            move(baseline[index].center, y);
            // eslint-disable-next-line no-await-in-loop -- ordered native input
            await wait(400);
        }
        check(samples >= 30 && dotSamples >= 10, 'sweeps must paint the row and running indicator');
        check(modelError <= 0.25, `painted row must follow continuous widths: ${modelError}px`);
        check(anchorError <= 0.25, `painted clones must follow the row: ${anchorError}px`);
        check(dotError <= 0.02, `running dot must follow the painted icon center: ${dotError}px`);
        check(clipped <= 0.25, `resting icons must remain inside the viewport: ${clipped}px`);
        // Rounding to whole pixels allows half a pixel either way; a label
        // placed from a stale size or the rounded item bounces by more.
        check(labelSamples >= 10, 'sweeps must paint the hover label');
        check(labelFraction <= 0.01, `hover label must sit on whole pixels: ${labelFraction}px`);
        check(labelError <= 0.51, `hover label must stay centred on the painted icon: ${labelError}px`);
        check(labelGapMax - labelGapMin <= 1.01,
            `hover label must keep its gap above the painted icon: ${labelGapMin}-${labelGapMax}px`);

        move(100, 100);
        dash.invalidateMagnifyGeometry();
        for (let attempt = 0; attempt < 100 && (dash._magnifyRebasing ||
            dash._magnifyLayoutId || dash._magnifyTimeline?.is_playing()); attempt++) {
            // eslint-disable-next-line no-await-in-loop -- wait for semantic rebase completion
            await wait(50);
        }
        check(!dash._magnifyRebasing && !dash._magnifyLayoutId && !dash._magnifyTimeline?.is_playing(),
            'leaving the dock must finish the geometry rebase');
        check(dash._box.get_children().every(item => item.translation_x === 0 && item.translation_y === 0),
            'a completed rebase must clear item translations');
        return {
            sweepAnchorError: Math.round(anchorError * 1000) / 1000,
            sweepModelError: Math.round(modelError * 1000) / 1000,
            runningDotError: Math.round(dotError * 1000) / 1000,
            hoverLabelError: Math.round(labelError * 1000) / 1000,
            hoverLabelGapRange: Math.round((labelGapMax - labelGapMin) * 1000) / 1000,
            unclippedIcons: 'pass',
            rebaseReset: 'pass',
        };
    } finally {
        if (signal)
            global.stage.disconnect(signal);
        indicatorIcon.windowsCount = savedCount;
        indicatorIcon.running = savedRunning;
        settings.set_enum('running-indicator-style', savedStyle);
    }
}

// Close a popup and watch it fade out: how far it moves while still visible,
// whether `scale` holds until it has gone, and the steps it eases back by after.
// A popup's laid-out position: what its anchor moves, as opposed to the
// translation and scale of its own open and close animation.
function anchored(actor) {
    const box = actor.get_allocation_box();
    return [box.x1, box.y1];
}

async function observeClose(actor, close, scale) {
    const [startX, startY] = anchored(actor);
    const heldScale = scale();
    let drift = 0;
    let closingFrames = 0;
    let heldWhileClosing = true;
    const eased = new Set();
    const id = global.stage.connect('after-paint', () => {
        if (actor.visible) {
            closingFrames++;
            const [x, y] = anchored(actor);
            drift = Math.max(drift, Math.hypot(x - startX, y - startY));
            heldWhileClosing &&= Math.abs(scale() - heldScale) < 0.01;
        } else {
            eased.add(Math.round(scale() * 100));
        }
    });
    close();
    await wait(900);
    global.stage.disconnect(id);
    const between = [...eased].filter(value => value > 100 && value < Math.round(heldScale * 100));
    return {drift, closingFrames, heldWhileClosing, easedFrames: between.length, eased: [...eased]};
}

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
    const forceAnimations = global.force_animations;
    const saved = {
        fixed: settings.get_boolean('dock-fixed'),
        manualHide: settings.get_boolean('manualhide'),
        fixedIcons: settings.get_boolean('icon-size-fixed'),
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
        settings.set_boolean('manualhide', false);
        settings.set_boolean('icon-size-fixed', false);
        settings.set_enum('dock-position', St.Side.BOTTOM);
        settings.set_double('magnify-max-scale', 1.6);
        settings.set_double('magnify-range-factor', 2.5);
        settings.set_int('magnify-duration', 125);
        settings.set_boolean('magnify-icons', true);
        global.force_animations = true;
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
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const texture = icon => icon.icon.icon.get_first_child()?.get_content()?.get_texture();
        const checkResolution = scale => {
            // A successful drop can replace an icon; inspect the live actors.
            for (const icon of dash.getAppIcons()) {
                const actor = icon.icon.icon;
                const requested = Math.ceil(icon.icon.iconSize * scale);
                check(actor.icon_size === requested,
                    `source icon must request ${requested}px, got ${actor.icon_size}`);
                const pixels = Math.ceil(requested * actor.get_resource_scale());
                check(texture(icon)?.get_width() >= pixels,
                    'magnification must have a loaded texture for its peak size');
                check(actor.width === icon.icon.iconSize * scaleFactor && actor.height === actor.width,
                    'higher-resolution textures must preserve the resting allocation');
            }
        };
        // Configuration changes refresh the source before hover; pointer motion
        // must only transform the same cached texture, including after resizing.
        for (const scale of [1.3, 2, 2.5, 1.6]) {
            settings.set_double('magnify-max-scale', scale);
            // eslint-disable-next-line no-await-in-loop -- wait for native icon loading
            await wait(400);
            checkResolution(scale);
        }
        settings.set_boolean('icon-size-fixed', true);
        await wait(400);
        checkResolution(1);
        settings.set_boolean('icon-size-fixed', false);
        await wait(400);
        checkResolution(1.6);
        const sourceActors = icons.map(icon => icon.icon.icon);
        const sourceTextures = icons.map(texture);
        result.textureResolution = 'pass';
        const restWidth = dash._box.get_transformed_size()[0];
        check(icons.every(icon => binScale(icon) === 1), 'icons must start at rest');
        move(160, 120);
        await wait(100);
        check(!dash._magnifyTimeline, 'off-dock motion must not start a frame timeline');
        check(St.Settings.get().enable_animations, 'native test needs animations on');

        // Settle over the third icon: it must peak, its neighbours must
        // swell less, a far icon must not move, and the row must widen
        // around the pointer rather than slide away from it.
        const [px, py] = center(icons[2]);
        const [, iconTop] = icons[2].get_transformed_position();
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
        check(dash._magnifyTimeline && !dash._magnifyTimeline.is_playing(),
            'the frame timeline must stop once the pointer has settled on the dock');
        check(icons.every((icon, i) => icon.icon.icon === sourceActors[i] && texture(icon) === sourceTextures[i]),
            'hover must reuse the prepared source actors and textures');
        result.textureReuse = 'pass';

        // Resetting a magnified row queues its narrower allocation. A new
        // pointer sample must capture that row's current origin along with
        // its new item centers, before the next animation frame.
        dash._resetMagnify();
        dash._magnifyOnPointer();
        check(dash._magnifyRest, 'stationary hover must capture the reset row');
        const resetOrigin = dash._box.get_transformed_position()[0];
        check(Math.abs(dash._magnifyRest.axisStart - resetOrigin) <= 1,
            `rest capture must use the allocated row origin: ${dash._magnifyRest.axisStart} vs ${resetOrigin}`);
        await wait(800);
        check(binScale(icons[2]) > 1.45, 'stationary hover must recover after the row resets');
        result.resetCapture = 'pass';

        Object.assign(result, await checkRenderedRow(dash, settings, icons, move, center));
        move(px, py);
        await wait(800);

        // The painted clone extends past the icon's input surface. Moving
        // onto the overflow should hold the magnification without moving
        // the reactive icon or making the clone intercept pointer events.
        move(px, iconTop - 8);
        dash._queueRedisplay();
        await wait(350);
        check(binScale(icons[2]) > 1.45,
            'painted overflow must keep the icon magnified during an unchanged redisplay');
        move(px, py);
        await wait(250);
        result.overflow = 'pass';

        // An icon's menu holds the dock as it is painted, wherever the pointer
        // goes, and opens past the magnified icon instead of over it. Closing
        // it with the pointer away eases the row back rather than snapping.
        await wait(600);
        const held = icons.map(binScale);
        check(held[2] > 1.45, 'the menu fixture must start magnified');
        icons[2].popupMenu();
        await wait(400);
        const menu = icons[2]._menu;
        check(menu?.isOpen, 'the icon menu must open');
        const holding = () => icons.every((icon, i) => Math.abs(binScale(icon) - held[i]) < 0.01);
        check(holding(), `opening a menu must hold the magnified row: ${icons.map(binScale)}`);
        move(100, 100);
        await wait(500);
        check(holding(), `leaving the dock with a menu open must hold the row: ${icons.map(binScale)}`);
        const [, cloneTop] = icons[2]._floatClone.get_transformed_position();
        const [, menuY] = menu.actor.get_transformed_position();
        const menuBottom = menuY + menu.actor.get_allocation_box().get_height();
        check(menuBottom <= cloneTop + 0.5,
            `the menu must open past the magnified icon: menu ends ${menuBottom}, icon starts ${cloneTop}`);
        // The menu fades out where it is: the row stays held until the menu
        // has gone, and only then eases back.
        const closingMenu = await observeClose(menu.actor, () => menu.close(BoxPointer.PopupAnimation.FULL),
            () => binScale(icons[2]));
        check(closingMenu.closingFrames >= 3, 'the menu must fade out over several frames');
        check(closingMenu.drift <= 0.5, `a closing menu must not move: ${closingMenu.drift}px`);
        check(closingMenu.heldWhileClosing, 'the row must stay held until the menu has gone');
        check(icons.every(icon => binScale(icon) === 1),
            'closing the menu away from the dock must settle the row at rest');
        check(closingMenu.easedFrames >= 3,
            `the row must ease back after the menu, not snap: ${closingMenu.eased}`);
        result.menuHold = {clearance: Math.round(cloneTop - menuBottom), easedFrames: closingMenu.easedFrames};
        move(px, py);
        await wait(800);

        // The launcher is anchored to the Applications button, which moves as
        // the row eases back. The dock holds its magnification while the
        // launcher is open and until it has faded out, so it stays put.
        const launcher = DockManager.getDefault()._appLauncher;
        const peakBefore = binScale(icons[2]);
        check(peakBefore > 1.45, 'the launcher fixture must start magnified');
        check(launcher.open(dash.showAppsButton), 'the launcher must open');
        await wait(400);
        const launcherAt = anchored(launcher._menu.actor);
        move(100, 100);
        await wait(500);
        const launcherMoved = anchored(launcher._menu.actor);
        check(Math.abs(binScale(icons[2]) - peakBefore) < 0.01,
            `the row must hold while the launcher is open: ${binScale(icons[2])}`);
        check(Math.hypot(launcherMoved[0] - launcherAt[0], launcherMoved[1] - launcherAt[1]) <= 0.5,
            'the launcher must stay put while the pointer leaves the dock');
        const closingLauncher = await observeClose(launcher._menu.actor, () => launcher.close(),
            () => binScale(icons[2]));
        check(closingLauncher.drift <= 0.5, `a closing launcher must not move: ${closingLauncher.drift}px`);
        check(closingLauncher.heldWhileClosing, 'the row must stay held until the launcher has gone');
        check(icons.every(icon => binScale(icon) === 1), 'the row must settle at rest after the launcher');
        check(closingLauncher.easedFrames >= 3, `the row must ease back after the launcher: ${closingLauncher.eased}`);
        result.launcherHold = {easedFrames: closingLauncher.easedFrames};
        move(px, py);
        await wait(800);

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

        // Leaving settles everything back, and a settled dock stops drawing.
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

        // A hidden dock must release the cursor even with magnification on.
        settings.set_boolean('manualhide', true);
        await wait(250);
        move(px, py);
        await wait(100);
        check(!dash._magnifyCursorTracker && !dash._magnifyTimeline.is_playing(),
            'a hidden dock must release the cursor and the frame clock');
        move(100, 100);
        settings.set_boolean('manualhide', false);
        await wait(400);
        check(!!dash._magnifyCursorTracker, 'revealing the dock must restore cursor tracking');
        result.hiddenCursor = 'pass';

        // Switching magnification off hands the bin back to plain hover.
        settings.set_boolean('magnify-icons', false);
        await wait(300);
        check(!dash._magnifyCursorTracker, 'disabling magnification must disconnect the cursor');
        checkResolution(1);
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
        settings.set_boolean('manualhide', saved.manualHide);
        settings.set_boolean('icon-size-fixed', saved.fixedIcons);
        settings.set_enum('dock-position', saved.position);
        settings.set_boolean('magnify-icons', saved.magnify);
        settings.set_double('magnify-max-scale', saved.maxScale);
        settings.set_double('magnify-range-factor', saved.range);
        settings.set_int('magnify-duration', saved.duration);
        global.force_animations = forceAnimations;
        Main.panel.statusArea.dateMenu.visible = dateMenuVisible;
        // Restoring position queues a dock replacement. Exercise its deferred
        // layout before the observer declares success or terminates Shell.
        await wait(700);
    }
}
