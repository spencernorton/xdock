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

async function expect(condition, message) {
    for (let i = 0; i < 40; i++) {
        if (condition())
            return;
        // eslint-disable-next-line no-await-in-loop -- wait for native input and transitions
        await wait(50);
    }
    throw new Error(message);
}

export async function run() {
    if (GLib.getenv('GNOME_SHELL_DEV_HARNESS') !== '1')
        throw new Error('private test session required');
    const extension = Main.extensionManager.lookup('xdock@spencercnorton.github.io');
    const {DockManager, State} = await import(`file://${extension.path}/docking.js`);
    const settings = extension.stateObj.getSettings('org.gnome.shell.extensions.xdock');
    const values = new Map(Object.entries({
        'dock-fixed': false,
        'manualhide': false,
        'intellihide': false,
        'autohide': true,
        'require-pressure-to-show': false,
    }));
    const saved = [...values.keys()].map(key => [key, settings.get_boolean(key)]);
    const position = settings.get_enum('dock-position');
    const delay = settings.get_double('show-delay');
    const seat = global.stage.get_context().get_backend().get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);

    try {
        settings.set_enum('dock-position', St.Side.BOTTOM);
        settings.set_double('show-delay', 0.4);
        for (const [key, value] of values)
            settings.set_boolean(key, value);
        // Position and strut changes can rebuild the dock asynchronously.
        await wait(700);
        const dock = DockManager.getDefault().mainDock;
        const monitor = Main.layoutManager.monitors[dock.monitorIndex];
        // Stay clear of the centered dock and Shell's corner barriers.
        const x = monitor.x + Math.floor(monitor.width / 4);
        const y = monitor.y + monitor.height - 1;
        move(x, y - 200);
        await expect(() => dock.getDockState() === State.HIDDEN, 'autohide dock did not hide');
        move(x, y);
        await expect(() => !!dock._dockDwellTimeoutId, 'edge entry did not start dwell');
        move(x, y - 200);
        await expect(() => !dock._dockDwellTimeoutId, 'edge exit did not cancel dwell');
        await wait(450);
        if (dock.getDockState() !== State.HIDDEN)
            throw new Error('canceled dwell revealed the dock');

        move(x, y);
        await expect(() => dock.getDockState() === State.SHOWN, 'holding at the edge did not reveal the dock');
        settings.set_boolean('dock-fixed', true);
        await expect(() => !dock._dockDwellSignalId && !dock._dockDwellTimeoutId,
            'fixed mode left its edge input handler attached');
        return 'edge entry, cancellation, reveal and cleanup passed';
    } finally {
        saved.forEach(([key, value]) => settings.set_boolean(key, value));
        settings.set_double('show-delay', delay);
        settings.set_enum('dock-position', position);
    }
}
