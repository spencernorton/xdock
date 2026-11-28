/* eslint-disable no-await-in-loop -- ordered observations of the native frame clock */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const APP_ID = 'dev.norvi.PenguinMail.desktop';
const XDOCK = 'xdock@spencercnorton.github.io';
const wait = ms => new Promise(resolve => GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ms, resolve));
const check = (condition, message) => {
    if (!condition)
        throw new Error(message);
};

async function until(predicate, message) {
    for (let i = 0; i < 100; i++) {
        if (predicate())
            return;
        await wait(10);
    }
    throw new Error(message);
}

export async function run() {
    check(GLib.getenv('GNOME_SHELL_DEV_HARNESS') === '1', 'private test session required');
    const extension = Main.extensionManager.lookup(XDOCK);
    check(extension?.state === 1, 'XDock must be active');
    const {DockManager} = await import(`file://${extension.path}/docking.js`);
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const previousFavorites = global.settings.get_strv('favorite-apps');
    const previousAccent = desktop.get_string('accent-color');
    const previousBanners = notifications.get_boolean('show-banners');
    const previousClock = Main.panel.statusArea.dateMenu.visible;
    const saved = ['dock-fixed', 'dock-position', 'show-icons-emblems',
        'show-icons-notifications-counter', 'magnify-icons', 'notification-badge-style']
        .map(key => [key, settings.get_value(key)]);
    const st = St.Settings.get();
    const animationProperty = Object.getOwnPropertyDescriptor(st, 'enable_animations');
    const accessibility = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
    const previousContrast = accessibility.get_boolean('high-contrast');
    const previousReduced = St.ReducedMotion ? accessibility.get_string('reduced-motion') : null;
    let animations = true;
    Object.defineProperty(st, 'enable_animations', {get: () => animations, configurable: true});
    const publisher = Gio.DBusConnection.new_for_address_sync(GLib.getenv('DBUS_SESSION_BUS_ADDRESS'),
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
    const manager = () => DockManager.getDefault();
    const launcher = () => manager()._appLauncher;
    const dockIcon = () => manager().mainDock.dash.getAppIcons().find(icon => icon.app.get_id() === APP_ID);
    const tile = () => launcher()._visibleButtons.find(icon => icon.app.get_id() === APP_ID);
    const views = () => [dockIcon()?._notificationBadge, tile()?._notificationBadge];
    const both = count => views().every(view => view?._count === count);
    const bothHidden = () => views().every(view => !view?._pill);
    const bothStyles = style => views().every(view => view?._pill?.has_style_class_name(style));
    const settled = count => both(count) && views().every(view =>
        view._front.text === String(count) && view._front.scale_y === 1 && !view._flipping);
    const showCount = count => publisher.emit_signal(null, '/com/canonical/unity/launcherentry/test',
        'com.canonical.Unity.LauncherEntry', 'Update', new GLib.Variant('(sa{sv})', [`application://${APP_ID}`, {
            count: new GLib.Variant('x', count),
            'count-visible': new GLib.Variant('b', count > 0),
        }]));
    const open = async () => {
        check(launcher().open(manager().mainDock.dash.showAppsButton), 'launcher opens');
        await wait(200);
        launcher()._entry.set_text('Mailbox Badge Fixture');
        await until(() => tile()?.mapped, 'Mailbox fixture must map in the launcher');
    };
    let traySource = null;
    let replayId = null;
    try {
        notifications.set_boolean('show-banners', true);
        settings.set_boolean('show-icons-emblems', true);
        settings.set_boolean('show-icons-notifications-counter', true);
        settings.set_boolean('dock-fixed', true);
        settings.set_boolean('magnify-icons', false);
        settings.set_enum('dock-position', St.Side.BOTTOM);
        settings.set_string('notification-badge-style', 'frosted-tint');
        accessibility.set_boolean('high-contrast', false);
        await until(() => !st.high_contrast, 'Shell must use standard contrast for the style test');
        Main.panel.statusArea.dateMenu.hide();
        Main.overview.hide();
        global.settings.set_strv('favorite-apps', [APP_ID]);
        // The dock settings above queue a recreation of the Show Apps button.
        await wait(550);
        await until(() => dockIcon()?.mapped, 'Mailbox fixture must map in the dock');
        await open();
        await wait(350);

        let arrival = null;
        const started = GLib.get_monotonic_time();
        const paintId = global.stage.connect('after-paint', () => {
            if (arrival === null && both(4) && views().every(view =>
                view._pill.has_allocation() && view._pill.get_paint_opacity() > 0))
                arrival = (GLib.get_monotonic_time() - started) / 1000;
        });
        try {
            showCount(4);
            await until(() => arrival !== null, 'both surfaces must paint the first count');
        } finally {
            global.stage.disconnect(paintId);
        }
        await wait(280);

        const checkFlip = async (from, to) => {
            const frames = [[], []];
            const restHeights = views().map(view => view._front.get_transformed_size()[1]);
            const id = global.stage.connect('after-paint', () => {
                views().forEach(({_front: face}, i) => {
                    const [, height] = face.get_transformed_size();
                    const [, hinge] = face.get_pivot_point();
                    frames[i].push({text: face.text, scale: face.scale_y, hinge, height});
                });
            });
            try {
                showCount(to);
                await until(() => settled(to), 'both badges must finish the count flip');
            } finally {
                global.stage.disconnect(id);
            }
            // Let the last face's text removal reach the next allocation.
            await wait(40);
            const direction = to > from ? -1 : 1;
            frames.forEach((samples, i) => {
                const turning = (frame, text) => frame.text === String(text) &&
                    frame.scale > 0 && frame.scale < 0.97;
                const leave = samples.filter(frame => turning(frame, from));
                const enter = samples.filter(frame => turning(frame, to));
                check(leave.length >= 2 && enter.length >= 2,
                    'both faces must paint intermediate frames on each surface');
                check(leave.concat(enter).every(frame => (frame.hinge - 0.5) * direction > 0),
                    'both faces must share a hinge that follows the count direction');
                check(leave.some(frame => frame.height < restHeights[i] * 0.9) &&
                    enter.some(frame => frame.height < restHeights[i] * 0.9),
                'the outgoing and incoming digits must visibly foreshorten');
            });
            return frames.map(samples => samples.filter(frame => frame.scale !== 1).length);
        };
        const increaseFrames = await checkFlip(4, 17);
        const decreaseFrames = await checkFlip(17, 3);

        showCount(7);
        await until(() => both(7) && views().every(view => view._flipping && view._front.text === '3'),
            'the existing digits stay on the outgoing face');
        showCount(8);
        await until(() => both(8) && views().every(view => view._flipping && view._front.text === '8'),
            'the incoming face must use the latest count');
        showCount(9);
        await until(() => settled(9), 'an update during the reveal must settle at the newest count');
        showCount(3);
        await until(() => settled(3), 'both badges must settle before checking picking');
        const [badgeX, badgeY] = tile()._notificationBadge._pill.get_transformed_position();
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, badgeX + 3, badgeY + 3);
        check(picked === tile() || (picked && tile().contains(picked) &&
            !tile()._notificationBadge._overlay.contains(picked)), 'the badge must pass picking to its tile');

        const themeNodes = () => views().map(view => view._pill.get_theme_node());
        const color = () => themeNodes().map(node => node.get_background_color().to_string());
        const alpha = () => themeNodes().map(node => node.get_background_color().get_alpha());
        const bothBorderless = () => themeNodes().every(node => node.get_border_color(St.Side.TOP).get_alpha() === 0);
        check(bothStyles('frosted-tint') &&
            alpha().every(value => value > 0 && value < 1) &&
            themeNodes().every(node => {
                const [type, top, bottom] = node.get_background_gradient();
                const highlight = top.get_green() - bottom.get_green();
                return type === St.GradientType.VERTICAL && highlight > 0 && highlight < 0.1;
            }),
        'Frosted Tint must have a translucent gradient with a subtle highlight on both surfaces');
        desktop.set_string('accent-color', 'blue');
        await wait(135);
        const blue = color();
        desktop.set_string('accent-color', 'orange');
        await until(() => color().every((value, i) => value !== blue[i]), 'both badges must follow live accent changes');
        check(color()[0] === color()[1], 'the dock and popup must paint the same accent');
        const pills = views().map(view => view._pill);
        settings.set_string('notification-badge-style', 'accent-fill');
        await until(() => bothStyles('accent-fill'), 'both badges must switch to Accent Fill');
        check(alpha().every(value => value === 1) && bothBorderless() &&
            themeNodes().every(node => node.get_background_gradient()[0] === St.GradientType.NONE),
        'Accent Fill must use a solid, borderless accent on both surfaces');
        check(settled(3) && views().every((view, i) => view._pill === pills[i]),
            'changing style must keep the current badge and displayed number');
        const colorBeforeSwitch = color()[0];
        desktop.set_string('accent-color', 'blue');
        await until(() => color().every(value => value !== colorBeforeSwitch), 'Accent Fill must follow the OS accent');
        check(color()[0] === color()[1], 'Accent Fill must match on both surfaces');
        settings.set_string('notification-badge-style', 'frosted-tint');
        await until(() => bothStyles('frosted-tint'), 'both badges must switch back to Frosted Tint');
        accessibility.set_boolean('high-contrast', true);
        await until(() => bothStyles('high-contrast'), 'high contrast must override translucent badges');
        check(both(3) && color()[0] === color()[1] && alpha().every(value => value === 1),
            'high contrast must keep both badge colors and counts in sync');
        accessibility.set_boolean('high-contrast', false);
        await until(() => bothStyles('frosted-tint'), 'leaving high contrast must restore the selected style');

        traySource = new MessageTray.Source({title: 'Mailbox badge fixture', iconName: 'mail-unread-symbolic'});
        traySource.app = dockIcon().app;
        traySource.connect('destroy', () => (traySource = null));
        Main.messageTray.add(traySource);
        const notice = new MessageTray.Notification({
            source: traySource, title: 'A test message', urgency: MessageTray.Urgency.LOW,
        });
        traySource.addNotification(notice);
        await wait(150);
        check(both(3), 'one delivery notice must not inflate unread mail');
        notice.destroy();
        await wait(150);
        check(both(3), 'clearing a delivery notice must not mark mail read');

        notifications.set_boolean('show-banners', false);
        await until(() => !dockIcon()._notificationBadge && bothHidden(), 'Do Not Disturb must hide both badges');
        settings.set_string('notification-badge-style', 'accent-fill');
        showCount(108);
        await wait(120);
        notifications.set_boolean('show-banners', true);
        await until(() => both(108), 'ending Do Not Disturb restores the latest snapshot');
        check(bothStyles('accent-fill'), 'ending Do Not Disturb restores the selected style');
        check(views().every(view => view._front.text === '99+' && view._pill.accessible_name.includes('108')),
            'the compact count must keep the full accessible total');

        showCount(0);
        await until(() => both(0), 'an explicit zero must clear both counters');
        await until(bothHidden, 'the zero fade must release the actors');
        if (St.ReducedMotion) {
            accessibility.set_string('reduced-motion', 'reduce');
            await until(() => st.reducedMotion === St.ReducedMotion.REDUCE, 'Shell must receive reduced motion');
        } else {
            animations = false;
        }
        showCount(6);
        await until(() => both(6), 'reduced motion must deliver the count');
        check(views().every(view => view._pill.opacity === 255 && !view._pill.get_transition('opacity')),
            'reduced motion must show the badge immediately');
        showCount(8);
        await until(() => both(8), 'reduced motion must deliver the changed count');
        check(settled(8), 'reduced motion must skip the count flip');
        showCount(6);
        await until(() => settled(6), 'reduced motion must deliver the restored count');

        tile().grab_key_focus();
        await wait(650);
        let idleFrames = -1;
        const idleId = global.stage.connect('after-paint', () => idleFrames++);
        for (let attempt = 0; attempt < 3 && idleFrames !== 0; attempt++) {
            idleFrames = 0;
            await wait(1000);
        }
        global.stage.disconnect(idleId);
        check(idleFrames === 0, `settled badges must stop redrawing: ${idleFrames}`);

        // The popup holds dock magnification while it is open. Close it
        // before verifying that the badge follows the floating icon.
        launcher().close({animate: false});
        await wait(180);
        if (St.ReducedMotion)
            accessibility.set_string('reduced-motion', previousReduced);
        animations = true;
        settings.set_boolean('magnify-icons', true);
        const pointer = global.stage.get_context().get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        const {origin, size} = dockIcon().icon._iconBin.get_transformed_extents();
        move(origin.x + size.width / 2, origin.y + size.height / 2);
        await until(() => dockIcon()._notificationBadge?._floatBadge?.mapped,
            'the dock badge must float with a magnified icon');
        const {origin: iconOrigin, size: iconSize} = dockIcon()._floatClone.get_transformed_extents();
        const {origin: badgeOrigin, size: badgeSize} = dockIcon()._notificationBadge._floatBadge
            .get_transformed_extents();
        check(Math.abs(badgeOrigin.x + badgeSize.width - iconOrigin.x - iconSize.width) <= 2 &&
            Math.abs(badgeOrigin.y - iconOrigin.y) <= 2 &&
            dockIcon()._notificationBadge._overlay.opacity === 0,
        'the badge must stay on the painted corner and hide its dock copy');
        move(100, 100);
        settings.set_boolean('magnify-icons', false);
        await wait(150);

        replayId = publisher.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'com.canonical.Unity', Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _member, params) => {
                if (params.deep_unpack()[2])
                    showCount(6);
            });
        await Main.extensionManager.disableExtension(XDOCK);
        await Main.extensionManager.enableExtension(XDOCK);
        await until(() => dockIcon()?._notificationBadge?._count === 6, 'the reloaded dock must consume the replay');
        await open();
        await until(() => both(6), 'the reopened popup must consume the replay');
        publisher.signal_unsubscribe(replayId);
        replayId = null;
        publisher.close_sync(null);
        await until(() => both(0) && bothHidden(), 'a lost publisher must clear both badges');
        return {
            firstPaintMs: Math.round(arrival), idleFrames, increaseFrames, decreaseFrames, accent: 'pass',
            styles: 'pass',
            magnifies: 'pass', reload: 'pass', reducedMotion: 'pass',
        };
    } finally {
        if (!publisher.is_closed()) {
            if (replayId !== null)
                publisher.signal_unsubscribe(replayId);
            publisher.close_sync(null);
        }
        traySource?.destroy();
        launcher().close({animate: false});
        global.settings.set_strv('favorite-apps', previousFavorites);
        saved.forEach(([key, value]) => settings.set_value(key, value));
        desktop.set_string('accent-color', previousAccent);
        notifications.set_boolean('show-banners', previousBanners);
        accessibility.set_boolean('high-contrast', previousContrast);
        if (St.ReducedMotion)
            accessibility.set_string('reduced-motion', previousReduced);
        Main.panel.statusArea.dateMenu.visible = previousClock;
        if (animationProperty)
            Object.defineProperty(st, 'enable_animations', animationProperty);
        else
            delete st.enable_animations;
        await wait(450);
    }
}
