// Counts the frames GNOME Shell paints while nothing on screen changes, with
// XDock enabled, for tests/shell/idle-frames.sh. A still screen must paint
// nothing: with the dock blur on and with it off, and while an app on the dock
// asks for attention. With animations on, that app's bounce must rest, with no
// frames, between its hops.

/* eslint-disable no-await-in-loop -- one step at a time, by design */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {run as popupInteractions} from '../popup-interactions.js';
import {run as magnifyInteractions} from '../magnify-interactions.js';

const XDOCK = 'xdock@spencercnorton.github.io';

const wait = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

const report = (name, value) => console.log(`IDLE-FRAMES ${name}: ${value}`);

// Which parts of the Shell's UI the frames repainted, so that a failure says
// where the change was: an effect on each child of the UI group notes that
// child whenever it is painted, and a frame paints little more than what it
// repaints.
let painted = null;
const PaintNote = GObject.registerClass(
class PaintNote extends Clutter.Effect {
    vfunc_paint(node, paintContext, flags) {
        painted?.add(this.actor.name || GObject.type_name(this.actor.constructor.$gtype));
        super.vfunc_paint(node, paintContext, flags);
    }
});

// The number of frames painted in the next `ms` milliseconds, and what they
// repainted.
async function frames(ms) {
    let count = 0;
    painted = new Set();
    const id = global.stage.connect('after-paint', () => count++);
    await wait(ms);
    global.stage.disconnect(id);
    const parts = [...painted];
    painted = null;
    return {count, parts};
}

async function dash() {
    for (let i = 0; i < 50; i++) {
        const dock = Main.uiGroup.get_children().find(actor => actor.name === 'xdockContainer');
        if (dock?.dash.getAppIcons().length)
            return dock.dash;
        await wait(100);
    }
    throw new Error('no app icon on the dock');
}

export default class IdleFramesProbe extends Extension {
    enable() {
        const run = () => this._run()
            .catch(error => report('result', `fail: ${error}\n${error.stack}`))
            .finally(() => report('done', 'yes'));
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connect('startup-complete', run);
        else
            run();
    }

    disable() {}

    async _run() {
        const xdock = Main.extensionManager.lookup(XDOCK);
        if (xdock?.state !== 1)
            throw new Error(`XDock is not active (state ${xdock?.state}, ${xdock?.error})`);

        // One pinned app, whichever is installed, and a translucent dock, so
        // the blur (with GNOME Rounded Blur) has something to draw.
        const [app] = Shell.AppSystem.get_default().get_installed().filter(info => info.should_show());
        global.settings.set_strv('favorite-apps', [app.get_id()]);
        const settings = xdock.stateObj.getSettings('org.gnome.shell.extensions.xdock');
        settings.set_enum('transparency-mode', 1);
        settings.set_boolean('custom-background-color', true);
        settings.set_double('background-opacity', 0.4);
        Main.overview.hide();
        // The top bar's clock repaints once a minute.
        Main.panel.statusArea.dateMenu.hide();
        const notes = Main.uiGroup.get_children().map(actor => {
            const note = new PaintNote();
            actor.add_effect(note);
            return note;
        });
        // Let startup and the changes above settle. The Shell runs the work
        // they queue for its hidden views (the overview's dash and app grid)
        // within 20 s, and that repaints once.
        await wait(21000);

        let failed = false;
        const expect = (name, result, ok) => {
            report(name, `${result.count} frames${ok ? '' : ` (FAIL: ${result.parts.join(', ')})`}`);
            failed ||= !ok;
        };

        report('animations', St.Settings.get().enable_animations ? 'on' : 'off');
        for (const blur of [true, false]) {
            const name = blur ? 'blur on' : 'blur off';
            settings.set_boolean('dock-blur', blur);
            await wait(1500);
            const icon = (await dash()).getAppIcons()[0];
            const effect = (await dash())._background.get_effect('xdock-blur');
            report(`${name}, effect`, effect ? 'attached' : 'none');
            const still = await frames(3000);
            expect(`${name}, still screen, 3 s`, still, still.count === 0);

            icon.urgent = true;
            await wait(1000);
            const urgent = await frames(3000);
            icon.urgent = false;
            await wait(1000);
            // With animations off an urgent app does not move, so nothing may paint.
            expect(`${name}, an app asking for attention, 3 s`, urgent,
                St.Settings.get().enable_animations || urgent.count === 0);
        }

        // Animations forced on: a hop of half a second, then a rest of two and
        // a half with no frames at all.
        global.force_animations = true;
        await wait(500);
        if (St.Settings.get().enable_animations) {
            const icon = (await dash()).getAppIcons()[0];
            icon.urgent = true;
            const hop = await frames(600);
            const rest = await frames(2000);
            icon.urgent = false;
            expect('animations forced on, the hop, first 0.6 s', hop, hop.count > 0);
            expect('animations forced on, the rest, next 2 s', rest, rest.count === 0);
        } else {
            report('animations forced on', 'not possible (FAIL)');
            failed = true;
        }
        global.force_animations = false;

        notes.forEach(note => note.actor?.remove_effect(note));
        report('popup interactions', JSON.stringify(await popupInteractions()));
        report('magnify interactions', JSON.stringify(await magnifyInteractions()));
        report('result', failed ? 'fail' : 'pass');
    }
}
