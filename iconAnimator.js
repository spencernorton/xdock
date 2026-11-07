// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    GLib,
    St,
} from './dependencies/gi.js';

import {
    AnimationUtils,
} from './dependencies/shell/misc.js';

import {
    ATTENTION_BOUNCE_DUTY,
    planAttentionBounce,
} from './motion.js';

import {getPosition} from './utils.js';
import {animationsEnabled, animationSettingSignals} from './animationSettings.js';

// One attention cycle is a hop and then a rest; see planAttentionBounce().
const CYCLE_TIME = 3000;
const HOP_TIME = CYCLE_TIME * ATTENTION_BOUNCE_DUTY;
const REST_TIME = CYCLE_TIME - HOP_TIME;

// Peak displacement of the hop, away from the screen edge the dock sits
// against. The shape peaks at about 0.76 of this, so ~27px lands: the hop
// plays on the icon's floating copy, which can clear the dock edge.
const HOP_HEIGHT = 36;

const HOP_VECTOR = Object.freeze({
    [St.Side.TOP]: [0, 1],
    [St.Side.BOTTOM]: [0, -1],
    [St.Side.LEFT]: [1, 0],
    [St.Side.RIGHT]: [-1, 0],
});

/**
 * Bounces the dock's urgent icons, all in step.
 *
 * The hop plays on a timeline and the rest between hops is a plain timeout,
 * so nothing asks for frames while no icon moves. A playing timeline wants a
 * new frame on every refresh, whether or not anything changes; the one this
 * replaces played for as long as any app was urgent, and every frame of it
 * repainted the dock. With animations off (reduced motion, or a session the
 * Shell renders in software, where it turns them off itself) nothing runs at
 * all and the icons stay put. The dock pauses it while hidden.
 */
export class IconAnimator {
    constructor(actor) {
        this._count = 0;
        this._started = false;
        this._animations = {
            bounce: [],
        };
        this._offset = 0;
        this._restId = 0;
        this._timeline = new Clutter.Timeline({actor});
        this._newFrameId = this._timeline.connect('new-frame', () =>
            this._setOffset(planAttentionBounce(
                this._timeline.get_progress() * ATTENTION_BOUNCE_DUTY)));
        this._completedId = this._timeline.connect('completed', () => this._rest());
        const settings = St.Settings.get();
        this._settingsChangedIds = animationSettingSignals.map(signal =>
            settings.connect(signal, () => this._sync()));
    }

    destroy() {
        this._started = false;
        this._sync();
        const settings = St.Settings.get();
        this._settingsChangedIds.forEach(id => settings.disconnect(id));
        this._timeline.disconnect(this._newFrameId);
        this._timeline.disconnect(this._completedId);
        delete this._timeline;
        for (const pairs of Object.values(this._animations)) {
            for (const {target, targetDestroyId} of pairs)
                target.disconnect(targetDestroyId);
        }
        this._animations = null;
    }

    pause() {
        this._started = false;
        this._sync();
    }

    start() {
        this._started = true;
        this._sync();
    }

    addAnimation(target, name) {
        const targetDestroyId = target.connect('destroy',
            () => this.removeAnimation(target, name));
        this._animations[name].push({target, targetDestroyId});
        this._count++;
        this._sync();
    }

    removeAnimation(target, name) {
        const pairs = this._animations[name];
        const index = pairs.findIndex(pair => pair.target === target);
        if (index === -1)
            return;

        target.disconnect(pairs[index].targetDestroyId);
        pairs.splice(index, 1);
        this._count--;
        this._sync();
    }

    // Starts a hop when one is due and none is playing or resting. When none
    // is due, stops both and puts the icons back.
    _sync() {
        if (!this._started || this._count === 0 ||
            !animationsEnabled()) {
            this._timeline.stop();
            if (this._restId)
                GLib.source_remove(this._restId);
            this._restId = 0;
            this._setOffset(0);
        } else if (!this._timeline.is_playing() && !this._restId) {
            this._timeline.set_duration(
                Math.round(AnimationUtils.adjustAnimationTime(HOP_TIME)));
            this._timeline.start();
        }
    }

    _rest() {
        this._setOffset(0);
        this._restId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            Math.round(AnimationUtils.adjustAnimationTime(REST_TIME)), () => {
                this._restId = 0;
                this._sync();
                return GLib.SOURCE_REMOVE;
            });
    }

    // Writing a translation queues a redraw even when the value is the same,
    // so only a change is written.
    _setOffset(fraction) {
        if (fraction === this._offset)
            return;

        this._offset = fraction;
        const [dx, dy] = HOP_VECTOR[getPosition()] ?? HOP_VECTOR[St.Side.BOTTOM];
        const offset = HOP_HEIGHT * fraction;
        for (const {target} of this._animations.bounce) {
            target.translation_x = offset * dx;
            target.translation_y = offset * dy;
        }
    }
}
