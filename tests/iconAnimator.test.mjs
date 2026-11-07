import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {URL} from 'node:url';

// iconAnimator.js against stand-ins for Clutter, GLib and St. What matters on
// a still screen is that nothing is left running: a playing timeline asks for
// a frame on every refresh even when no icon moves, and that is what kept a
// dock with an urgent app repainting continuously.

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const gi = dataUrl(`
class Emitter {
    constructor() {
        this.handlers = new Map();
        this.nextId = 1;
    }
    connect(signal, handler) {
        this.handlers.set(this.nextId, [signal, handler]);
        return this.nextId++;
    }
    disconnect(id) {
        if (!this.handlers.delete(id))
            throw new Error(\`no handler \${id}\`);
    }
    emit(signal) {
        for (const [name, handler] of [...this.handlers.values()]) {
            if (name === signal)
                handler(this);
        }
    }
}
globalThis.Emitter = Emitter;

class Timeline extends Emitter {
    constructor(params) {
        super();
        Object.assign(this, {duration: 1000, playing: false, progress: 0, starts: 0}, params);
        globalThis.timelines.push(this);
    }
    set_duration(duration) { this.duration = duration; }
    start() {
        this.playing = true;
        this.progress = 0;
        this.starts++;
    }
    stop() {
        this.playing = false;
        this.progress = 0;
    }
    is_playing() { return this.playing; }
    get_progress() { return this.progress; }
    // One frame of a playing timeline.
    frame(progress) {
        assert(this.playing, 'a frame from a timeline that is not playing');
        this.progress = progress;
        this.emit('new-frame');
    }
    // The last frame: Clutter stops the timeline, then emits completed.
    finish() {
        this.frame(1);
        this.playing = false;
        this.emit('completed');
    }
}
function assert(ok, message) {
    if (!ok)
        throw new Error(message);
}

export const Clutter = {Timeline};
export const GLib = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    timeout_add(_priority, ms, callback) {
        const id = globalThis.nextTimer++;
        globalThis.timers.set(id, {ms, callback});
        return id;
    },
    source_remove(id) {
        if (!globalThis.timers.delete(id))
            throw new Error(\`no source \${id}\`);
    },
};
export const St = {
    Side: {TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3},
    Settings: {get: () => globalThis.stSettings},
};
`);

const misc = dataUrl(`
export const AnimationUtils = {
    adjustAnimationTime: ms => globalThis.stSettings.enable_animations
        ? ms * globalThis.stSettings.slow_down_factor : 0,
};
`);

const utils = dataUrl('export const getPosition = () => globalThis.position;');
const animationSettings = dataUrl((await readFile(new URL('../animationSettings.js', import.meta.url), 'utf8'))
    .replace("'./dependencies/gi.js'", `'${gi}'`));

globalThis.timelines = [];
globalThis.timers = new Map();
globalThis.nextTimer = 1;

const source = (await readFile(new URL('../iconAnimator.js', import.meta.url), 'utf8'))
    .replace("'./dependencies/gi.js'", `'${gi}'`)
    .replace("'./dependencies/shell/misc.js'", `'${misc}'`)
    .replace("'./animationSettings.js'", `'${animationSettings}'`)
    .replace("'./motion.js'", `'${new URL('../motion.js', import.meta.url).href}'`)
    .replace("'./utils.js'", `'${utils}'`);
const {IconAnimator} = await import(dataUrl(source));
const {Emitter} = globalThis;
const BOTTOM = 2;

class Icon extends Emitter {
    constructor() {
        super();
        this._x = 0;
        this._y = 0;
        this.writes = 0;
    }
    get translation_x() { return this._x; }
    set translation_x(value) {
        this._x = value;
        this.writes++;
    }
    get translation_y() { return this._y; }
    set translation_y(value) {
        this._y = value;
        this.writes++;
    }
}

function setup({animations = true, started = true} = {}) {
    globalThis.stSettings = Object.assign(new Emitter(), {enable_animations: animations, slow_down_factor: 1});
    globalThis.position = BOTTOM;
    globalThis.timelines.length = 0;
    globalThis.timers.clear();
    const animator = new IconAnimator({});
    const [timeline] = globalThis.timelines;
    if (started)
        animator.start();
    return {animator, timeline};
}

const pendingTimers = () => [...globalThis.timers.values()];
const fireTimer = () => {
    const [[id, {callback}]] = globalThis.timers;
    globalThis.timers.delete(id);
    callback();
};
const setAnimations = on => {
    globalThis.stSettings.enable_animations = on;
    globalThis.stSettings.emit('notify::enable-animations');
};
// Nothing that would produce a frame: no playing timeline, and no icon moved.
const idle = (timeline, ...icons) => !timeline.is_playing() &&
    icons.every(icon => icon.translation_x === 0 && icon.translation_y === 0);

test('with animations off an urgent icon starts nothing', () => {
    const {animator, timeline} = setup({animations: false});
    const icon = new Icon();
    animator.addAnimation(icon, 'bounce');
    assert.ok(idle(timeline, icon), 'a timeline plays although animations are off');
    assert.equal(timeline.starts, 0);
    assert.deepEqual(pendingTimers(), []);
    assert.equal(icon.writes, 0, 'the icon was written to');
});

test('one hop, a rest with nothing playing, then the next hop', () => {
    const {animator, timeline} = setup();
    const icon = new Icon();
    animator.addAnimation(icon, 'bounce');
    assert.ok(timeline.is_playing(), 'the first hop did not start at once');
    assert.equal(timeline.duration, 500);

    timeline.frame(0.25);
    assert.ok(icon.translation_y < -8, `the icon did not hop up (${icon.translation_y})`);
    assert.equal(icon.translation_x, 0);

    timeline.finish();
    assert.ok(idle(timeline, icon), 'something still runs, or the icon is still up, after the hop');
    assert.deepEqual(pendingTimers().map(timer => timer.ms), [2500], 'the rest is not one 2.5 s timeout');

    fireTimer();
    assert.ok(timeline.is_playing(), 'the next hop did not start after the rest');
    assert.equal(timeline.starts, 2);
    assert.deepEqual(pendingTimers(), []);
});

test('the slow-down factor stretches the hop and the rest alike', () => {
    const {animator, timeline} = setup({started: false});
    globalThis.stSettings.slow_down_factor = 2;
    animator.start();
    animator.addAnimation(new Icon(), 'bounce');
    assert.equal(timeline.duration, 1000);
    timeline.finish();
    assert.deepEqual(pendingTimers().map(timer => timer.ms), [5000]);
});

test('animations turned off mid-hop stop it and put the icon back', () => {
    const {animator, timeline} = setup();
    const icon = new Icon();
    animator.addAnimation(icon, 'bounce');
    timeline.frame(0.25);
    setAnimations(false);
    assert.ok(idle(timeline, icon));
    assert.deepEqual(pendingTimers(), []);

    setAnimations(true);
    assert.ok(timeline.is_playing(), 'turning animations back on did not resume the hops');
});

test('animations turned off mid-rest cancel the rest', () => {
    const {animator, timeline} = setup();
    animator.addAnimation(new Icon(), 'bounce');
    timeline.finish();
    setAnimations(false);
    assert.deepEqual(pendingTimers(), []);
    assert.ok(!timeline.is_playing());
});

test('a hidden dock runs nothing; shown again, it hops at once', () => {
    const {animator, timeline} = setup();
    const icon = new Icon();
    animator.addAnimation(icon, 'bounce');
    timeline.frame(0.25);
    animator.pause();
    assert.ok(idle(timeline, icon));
    assert.deepEqual(pendingTimers(), []);

    animator.start();
    assert.ok(timeline.is_playing());
});

test('the last urgent icon going away stops everything', () => {
    const {animator, timeline} = setup();
    const first = new Icon();
    const second = new Icon();
    animator.addAnimation(first, 'bounce');
    animator.addAnimation(second, 'bounce');
    timeline.frame(0.25);
    assert.equal(first.translation_y, second.translation_y, 'the icons are not in step');

    animator.removeAnimation(first, 'bounce');
    assert.ok(timeline.is_playing(), 'one urgent icon left, but the hop stopped');
    second.emit('destroy');
    assert.ok(!timeline.is_playing());
    assert.deepEqual(pendingTimers(), []);
    assert.equal(first.handlers.size + second.handlers.size, 0, 'a destroy handler was left behind');
});

test('an icon only writes when its offset changes', () => {
    const {animator, timeline} = setup();
    const icon = new Icon();
    animator.addAnimation(icon, 'bounce');
    timeline.frame(0.25);
    timeline.finish();
    const writes = icon.writes;
    animator.pause();
    animator.start();
    animator.pause();
    assert.equal(icon.writes, writes, 'an icon already at rest was written to again');
});

test('icons hop away from the edge the dock is on', () => {
    for (const [side, axis, sign] of [[0, 'translation_y', 1], [3, 'translation_x', 1], [1, 'translation_x', -1]]) {
        const {animator, timeline} = setup();
        globalThis.position = side;
        const icon = new Icon();
        animator.addAnimation(icon, 'bounce');
        timeline.frame(0.25);
        assert.ok(Math.sign(icon[axis]) === sign, `side ${side}: ${axis} is ${icon[axis]}`);
    }
});

test('destroy cancels the rest and disconnects everything', () => {
    const {animator, timeline} = setup();
    const icon = new Icon();
    animator.addAnimation(icon, 'bounce');
    timeline.finish();
    animator.destroy();
    assert.deepEqual(pendingTimers(), []);
    assert.equal(timeline.handlers.size, 0);
    assert.equal(globalThis.stSettings.handlers.size, 0);
    assert.equal(icon.handlers.size, 0);
});
