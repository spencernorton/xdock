import assert from 'node:assert/strict';

import {
    DockMotionController,
    DockMotionRequestResult,
    DockMotionState,
    DockMotionTarget,
    ICON_HOVER_LIFT,
    ICON_HOVER_SCALE,
    ICON_PRESS_SCALE,
    IndicatorTransition,
    ATTENTION_BOUNCE_DUTY,
    planAttentionBounce,
    planDockTransition,
    planIconMotion,
    planMagnification,
    planMagnifyApproach,
    planMagnifyOffsets,
    planIndicatorTransition
} from '../motion.js';

const FULL_DURATION = 200;
let assertions = 0;

function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    assertions++;
}

function deepEqual(actual, expected, message) {
    assert.deepEqual(actual, expected, message);
    assertions++;
}

function near(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 1e-9,
        `${message}: expected ${expected}, got ${actual}`);
    assertions++;
}

// Project each scaled slot onto the dock axis, as the painted row does.
// Keeping the spaces between these intervals preserves picking and layout.
function paintedRow(centers, sizes, scales, order, anchor) {
    const offsets = planMagnifyOffsets(sizes, scales, order, anchor);
    return order.map(index => {
        const center = centers[index] + offsets[index];
        const halfSize = sizes[index] * scales[index] / 2;
        return {center, start: center - halfSize, end: center + halfSize};
    });
}

class FakeClock {
    constructor() {
        this.now = 0;
        this._nextId = 1;
        this._timers = new Map();
        this._cancelled = new Map();
    }

    schedule(delay, callback) {
        const id = this._nextId++;
        this._timers.set(id, {
            id,
            due: this.now + delay,
            callback,
        });
        return id;
    }

    cancel(id) {
        const timer = this._timers.get(id);
        if (timer) {
            this._cancelled.set(id, timer.callback);
            this._timers.delete(id);
        }
    }

    advance(duration) {
        const targetTime = this.now + duration;

        while (true) {
            const nextTimer = [...this._timers.values()]
                .filter(timer => timer.due <= targetTime)
                .sort((first, second) =>
                    first.due - second.due || first.id - second.id)[0];
            if (!nextTimer)
                break;

            this._timers.delete(nextTimer.id);
            this.now = nextTimer.due;
            nextTimer.callback();
        }

        this.now = targetTime;
    }

    fireCancelled(id) {
        this._cancelled.get(id)?.();
    }
}

function createHarness({
    initialState = DockMotionState.HIDDEN,
    initialProgress = DockMotionTarget.HIDDEN,
    scheduleError = null,
    cancelError = null,
    stopError = null,
} = {}) {
    const clock = new FakeClock();
    const transitions = [];
    const cancelledTimers = [];
    const stateChanges = [];
    const startEffects = [];
    const terminalEffects = [];
    let progress = initialProgress;
    let activeTransition = null;
    let stopCount = 0;

    const controller = new DockMotionController({
        initialState,
        getProgress: () => progress,
        hasActiveTransition: () => activeTransition !== null,
        startTransition: (plan, onComplete) => {
            const transition = {plan, onComplete};
            transitions.push(transition);
            activeTransition = transition;

            if (plan.completeImmediately) {
                progress = plan.targetProgress;
                activeTransition = null;
                onComplete();
            }
        },
        stopTransition: () => {
            activeTransition = null;
            stopCount++;
            if (stopError)
                throw stopError;
        },
        scheduleDelay: (delay, callback) => {
            if (scheduleError)
                throw scheduleError;
            return clock.schedule(delay, callback);
        },
        cancelDelay: id => {
            cancelledTimers.push(id);
            if (cancelError)
                throw cancelError;
            clock.cancel(id);
        },
        onStateChanged: state => stateChanges.push(state),
        onTransitionStart: plan => startEffects.push(plan.targetProgress),
        onTransitionComplete: plan => terminalEffects.push(plan.targetProgress),
    });

    return {
        controller,
        clock,
        transitions,
        cancelledTimers,
        stateChanges,
        startEffects,
        terminalEffects,
        get progress() {
            return progress;
        },
        set progress(value) {
            progress = value;
        },
        get stopCount() {
            return stopCount;
        },
        complete(index) {
            const transition = transitions[index];
            if (activeTransition === transition) {
                progress = transition.plan.targetProgress;
                activeTransition = null;
            }
            transition.onComplete();
        },
        invokeCompletion(index) {
            transitions[index].onComplete();
        },
    };
}

for (const [progress, expectedDuration] of [
    [0.1, 20],
    [0.5, 100],
    [0.9, 180],
]) {
    const reverseToHidden = planDockTransition({
        currentProgress: progress,
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
    });
    equal(reverseToHidden.duration, expectedDuration);

    const reverseToShown = planDockTransition({
        currentProgress: 1 - progress,
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    equal(reverseToShown.duration, expectedDuration);
}

const reducedMotion = planDockTransition({
    currentProgress: 0.5,
    targetProgress: DockMotionTarget.SHOWN,
    fullDuration: FULL_DURATION,
    animationsEnabled: false,
});
equal(reducedMotion.duration, 0);
equal(reducedMotion.completeImmediately, true);

const zeroDuration = planDockTransition({
    currentProgress: 0.5,
    targetProgress: DockMotionTarget.HIDDEN,
    fullDuration: 0,
});
equal(zeroDuration.duration, 0);
equal(zeroDuration.completeImmediately, true);

const showing = planDockTransition({
    currentProgress: 0.5,
    targetProgress: DockMotionTarget.SHOWN,
    fullDuration: FULL_DURATION,
});
equal(showing.activeState, DockMotionState.SHOWING);
equal(showing.completedState, DockMotionState.SHOWN);
equal(showing.completeImmediately, false);

const hiding = planDockTransition({
    currentProgress: 0.5,
    targetProgress: DockMotionTarget.HIDDEN,
    fullDuration: FULL_DURATION,
});
equal(hiding.activeState, DockMotionState.HIDING);
equal(hiding.completedState, DockMotionState.HIDDEN);

{
    const harness = createHarness();
    harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    harness.progress = 0.5;
    const result = harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 200,
    });

    equal(result, DockMotionRequestResult.DELAYED);
    equal(harness.controller.state, DockMotionState.SHOWING);
    equal(harness.transitions.length, 1,
        'a hide grace period must not replace the active reveal');

    harness.clock.advance(100);
    harness.progress = 0.8;
    harness.clock.advance(100);

    equal(harness.transitions.length, 2);
    equal(harness.transitions[1].plan.targetProgress, DockMotionTarget.HIDDEN);
    equal(harness.transitions[1].plan.duration, 160,
        'the delayed leg must use progress sampled when its timer fires');
    equal(harness.controller.state, DockMotionState.HIDING);
}

{
    const harness = createHarness();
    harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    harness.progress = 0.4;
    harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 200,
    });
    const result = harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });

    equal(result, DockMotionRequestResult.DEDUPLICATED);
    equal(harness.controller.hasPendingHide, false);
    deepEqual(harness.cancelledTimers, [1]);
    harness.clock.advance(200);
    harness.clock.fireCancelled(1);
    equal(harness.transitions.length, 1,
        're-entry and a stale timer callback must not start a hide');
    equal(harness.controller.state, DockMotionState.SHOWING);
}

{
    const harness = createHarness();
    harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    harness.progress = 0.6;
    harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 200,
    });
    const result = harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 0,
    });

    equal(result, DockMotionRequestResult.STARTED);
    equal(harness.controller.hasPendingHide, false);
    equal(harness.transitions.length, 2);
    equal(harness.transitions[1].plan.duration, 120);
    equal(harness.controller.state, DockMotionState.HIDING);
    harness.clock.fireCancelled(1);
    equal(harness.transitions.length, 2,
        'a superseded delayed callback must be generation-guarded');
}

{
    const harness = createHarness();
    harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    harness.progress = 0.4;
    harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
    });

    harness.invokeCompletion(0);
    equal(harness.controller.state, DockMotionState.HIDING);
    deepEqual(harness.terminalEffects, [],
        'a stale transition completion must not run terminal effects');

    harness.complete(1);
    equal(harness.controller.state, DockMotionState.HIDDEN);
    deepEqual(harness.terminalEffects, [DockMotionTarget.HIDDEN]);
}

{
    const harness = createHarness();
    const first = harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    const duplicate = harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });

    equal(first, DockMotionRequestResult.STARTED);
    equal(duplicate, DockMotionRequestResult.DEDUPLICATED);
    equal(harness.transitions.length, 1);
    deepEqual(harness.startEffects, [DockMotionTarget.SHOWN]);
}

{
    const harness = createHarness({initialProgress: 0.25});
    const result = harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
        animationsEnabled: false,
    });

    equal(result, DockMotionRequestResult.STARTED);
    equal(harness.transitions[0].plan.duration, 0);
    equal(harness.controller.state, DockMotionState.SHOWN,
        'synchronous completion must leave the terminal state installed');
    equal(harness.controller.targetProgress, null);
    deepEqual(harness.startEffects, [DockMotionTarget.SHOWN]);
    deepEqual(harness.terminalEffects, [DockMotionTarget.SHOWN]);

    const duplicate = harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    equal(duplicate, DockMotionRequestResult.DEDUPLICATED);
    equal(harness.transitions.length, 1);
}

{
    const harness = createHarness({
        initialState: DockMotionState.SHOWN,
        initialProgress: DockMotionTarget.SHOWN,
    });
    harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 200,
    });
    harness.controller.cancel();
    harness.clock.fireCancelled(1);

    equal(harness.stopCount, 1);
    equal(harness.controller.hasPendingHide, false);
    equal(harness.transitions.length, 0);
}

{
    const scheduleError = new Error('delay scheduling failed');
    const harness = createHarness({
        initialState: DockMotionState.SHOWN,
        initialProgress: DockMotionTarget.SHOWN,
        scheduleError,
    });

    assert.throws(() => harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 200,
    }), error => error === scheduleError);
    assertions++;
    equal(harness.controller.hasPendingHide, false,
        'a scheduling failure must roll back pending ownership');
}

{
    const cancelError = new Error('delay cancellation failed');
    const harness = createHarness({cancelError});
    harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    harness.progress = 0.5;
    harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 200,
    });

    assert.throws(() => harness.controller.cancel(), error => error === cancelError);
    assertions++;
    equal(harness.controller.hasPendingHide, false);
    equal(harness.stopCount, 1,
        'an active transition must still be stopped after delay cancellation fails');
    harness.clock.advance(200);
    equal(harness.transitions.length, 1,
        'a timer left by failed cancellation must remain generation-inert');
}

{
    const cancelError = new Error('delay cancellation failed');
    const stopError = new Error('transition cancellation failed');
    const harness = createHarness({cancelError, stopError});
    harness.controller.request({
        targetProgress: DockMotionTarget.SHOWN,
        fullDuration: FULL_DURATION,
    });
    harness.controller.request({
        targetProgress: DockMotionTarget.HIDDEN,
        fullDuration: FULL_DURATION,
        delay: 200,
    });

    assert.throws(() => harness.controller.cancel(), error =>
        error instanceof AggregateError &&
        error.errors[0] === cancelError &&
        error.errors[1] === stopError);
    assertions++;
    equal(harness.stopCount, 1,
        'both cancellation resources must be attempted');
}

{
    // Rest is the identity transform: a resting icon must not carry a lift, or
    // every icon in the dock sits permanently off its slot.
    assert.deepEqual(planIconMotion({}), {scale: 1, lift: 0});
    assertions++;

    assert.deepEqual(planIconMotion({hovered: true}),
        {scale: ICON_HOVER_SCALE, lift: ICON_HOVER_LIFT});
    assertions++;

    // Press beats hover, and a press does not lift: you are necessarily
    // hovering while pressing, so without the precedence a click reads as
    // "nothing happened" and the icon just stays large.
    assert.deepEqual(planIconMotion({hovered: true, pressed: true}),
        {scale: ICON_PRESS_SCALE, lift: 0});
    assertions++;
    assert.deepEqual(planIconMotion({pressed: true}),
        {scale: ICON_PRESS_SCALE, lift: 0});
    assertions++;

    // The two states must differ in DIRECTION, or press feedback is invisible
    // on a hovered icon -- which is every icon you can press.
    assert.ok(ICON_PRESS_SCALE < 1 && ICON_HOVER_SCALE > 1,
        'press must shrink and hover must grow, or they cancel out');
    assertions++;
}

{
    const plan = (wasVisible, running) =>
        planIndicatorTransition({wasVisible, running});

    assert.equal(plan(false, true), IndicatorTransition.REVEAL);
    assertions++;

    // Stopping is a HIDE -- instant, not a fade. St.DrawingArea clears its surface on
    // every invalidation whether or not the handler draws -- measured, with the
    // draw suppressed and the actor pinned opaque, the dot still vanished -- so
    // there is nothing left to fade out of. If someone adds a CONCEAL here
    // later, this is the assertion that should stop them.
    assert.equal(plan(true, false), IndicatorTransition.HIDE);
    assertions++;

    // update() also runs for colour and theme changes, so a same-state update
    // must not restart the fade.
    assert.equal(plan(true, true), IndicatorTransition.REPAINT);
    assertions++;
    assert.equal(plan(false, false), IndicatorTransition.REPAINT);
    assertions++;

    // The flag starts undefined on an indicator built before its area exists,
    // so the comparison must be loose about falsiness.
    assert.equal(plan(undefined, true), IndicatorTransition.REVEAL);
    assertions++;
    assert.equal(plan(undefined, false), IndicatorTransition.REPAINT);
    assertions++;

    // REPAINT must stay distinct from HIDE: the caller relies on it to leave
    // the opacity and any running transition alone, so a same-state update
    // cannot cut a reveal short.
    assert.notEqual(IndicatorTransition.REPAINT, IndicatorTransition.HIDE);
    assertions++;
}

{
    // Rests for five sixths of the cycle. This is the whole difference between
    // an icon asking for attention every few seconds and one that vibrates
    // continuously, so it is asserted rather than left to the shape.
    assert.equal(planAttentionBounce(0), 0);
    assertions++;
    assert.equal(planAttentionBounce(ATTENTION_BOUNCE_DUTY), 0);
    assertions++;
    for (const p of [0.2, 0.5, 0.9, 1]) {
        assert.equal(planAttentionBounce(p), 0,
            `progress ${p} is past the duty cycle and must be at rest`);
        assertions++;
    }

    // Two hops, the second clearly smaller: one hop reads as a twitch, and
    // equal hops read as a vibration.
    const first = planAttentionBounce(ATTENTION_BOUNCE_DUTY * 0.25);
    const trough = planAttentionBounce(ATTENTION_BOUNCE_DUTY * 0.5);
    const second = planAttentionBounce(ATTENTION_BOUNCE_DUTY * 0.75);
    assert.ok(first > 0.5, `first hop should be tall, got ${first}`);
    assertions++;
    assert.ok(trough < 0.05, `hops must return to the ground, got ${trough}`);
    assertions++;
    assert.ok(second > 0.1 && second < first / 2,
        `second hop should be a fraction of the first, got ${second} vs ${first}`);
    assertions++;

    // Never leaves the icon displaced, and never inverts.
    for (let i = 0; i <= 100; i++) {
        const v = planAttentionBounce(i / 100);
        assert.ok(v >= 0 && v <= 1, `bounce out of range at ${i / 100}: ${v}`);
    }
    assertions++;

    assert.equal(planAttentionBounce(NaN), 0);
    assertions++;
    assert.equal(planAttentionBounce(-1), 0);
    assertions++;
}

{
    // Seven icons, 80px pitch, pointer resting over the middle one. The
    // pointer's own icon must reach the peak exactly, or the setting lies.
    const centers = [40, 120, 200, 280, 360, 440, 520];
    const base = {
        centers, itemSize: 80, pointer: 280, maxScale: 1.6, rangeFactor: 2.5,
    };
    const scales = planMagnification(base);
    assert.equal(scales.length, centers.length);
    assertions++;
    assert.ok(Math.abs(scales[3] - 1.6) < 1e-9,
        `icon under the pointer must reach maxScale, got ${scales[3]}`);
    assertions++;

    // Symmetric, strictly falling with distance, and back to exactly 1
    // outside the reach: a neighbour left at 1.001 would hold layout open
    // by a fraction of a pixel forever.
    assert.ok(scales[2] > 1 && scales[2] < scales[3] && scales[2] === scales[4]);
    assertions++;
    assert.ok(scales[1] > 1 && scales[1] < scales[2] && scales[1] === scales[5]);
    assertions++;
    assert.equal(scales[0], 1);
    assertions++;
    assert.equal(scales[6], 1);
    assertions++;

    // Influence scales the excess, so halfway in, the peak is halfway.
    const half = planMagnification({...base, influence: 0.5});
    assert.ok(Math.abs(half[3] - 1.3) < 1e-9, `half influence peak, got ${half[3]}`);
    assertions++;
    assert.deepEqual(planMagnification({...base, influence: 0}), centers.map(() => 1));
    assertions++;

    const scratch = [];
    assert.equal(planMagnification(base, scratch), scratch);
    assert.deepEqual(scratch, scales);
    assert.equal(planMagnification({...base, influence: 0}, scratch), scratch);
    assert.deepEqual(scratch, centers.map(() => 1), 'reused space clears the previous peak');
    assertions += 4;

    // A full dock keeps the shape but lowers the peak to fit its budget.
    const capped = planMagnification({...base, restTotal: 560, maxTotal: 600});
    const growth = capped.reduce((sum, s) => sum + (s - 1) * 80, 0);
    assert.ok(growth <= 40 + 1e-9, `growth must fit the headroom, got ${growth}`);
    assertions++;
    assert.ok(capped[3] > 1 && capped[3] < 1.6 && capped[2] === capped[4],
        'capping must preserve the falloff shape');
    assertions++;
    assert.deepEqual(planMagnification({...base, restTotal: 560, maxTotal: 560}),
        centers.map(() => 1), 'no headroom means no magnification');
    assertions++;

    // Garbage in, rest out: a NaN pointer mid-frame must never scale an icon.
    for (const bad of [
        {pointer: NaN}, {itemSize: 0}, {maxScale: 1}, {maxScale: NaN},
        {rangeFactor: 0}, {influence: NaN}, {centers: []},
    ]) {
        assert.deepEqual(planMagnification({...base, ...bad}),
            (bad.centers ?? centers).map(() => 1), `bad input ${JSON.stringify(bad)}`);
        assertions++;
    }
}

{
    // Unequal slots occupy [0, 248] with three 8 px gaps. The caller's
    // available row budget leaves exactly 20 px for magnification.
    const centers = [16, 80, 152, 216];
    const sizes = [32, 80, 48, 64];
    const order = [0, 1, 2, 3];
    const base = {
        centers, sizes, itemSize: 64, pointer: 80, maxScale: 1.9, rangeFactor: 3,
        restTotal: 248,
    };
    const uncapped = paintedRow(centers, sizes, planMagnification(base), order, 0.5);
    assert.ok(uncapped.at(-1).end - uncapped[0].start > 268,
        'this row needs to be capped to fit the available space');
    assertions++;

    const scales = planMagnification({...base, maxTotal: 268});
    const row = paintedRow(centers, sizes, scales, order, 0.5);
    near(row[0].start, -10, 'a centered capped row uses half the headroom on the left');
    near(row.at(-1).end, 258, 'a centered capped row uses half the headroom on the right');
    near(row.at(-1).end - row[0].start, 268, 'unequal slots consume the exact row budget');
    for (let i = 1; i < row.length; i++)
        near(row[i].start - row[i - 1].end, 8, 'capping preserves the resting slot gaps');
}

{
    // These widths gain 78 px in total. Centered, start-aligned and
    // end-aligned docks each retain their intended anchor as the row grows.
    const centers = [16, 80, 152, 216];
    const sizes = [32, 80, 48, 64];
    const scales = [1.25, 1.4, 1.125, 1.5];
    for (const [anchor, start, end] of [[0.5, -39, 287], [0, 0, 326], [1, -78, 248]]) {
        const row = paintedRow(centers, sizes, scales, [0, 1, 2, 3], anchor);
        near(row[0].start, start, `anchor ${anchor} keeps the expected start edge`);
        near(row.at(-1).end, end, `anchor ${anchor} keeps the expected end edge`);
        near(row.at(-1).end - row[0].start, 326, 'anchor choice preserves the total row extent');
        for (let i = 1; i < row.length; i++)
            near(row[i].start - row[i - 1].end, 8, 'anchor choice preserves every gap');

        // RTL changes actor indexing, while physical order still runs
        // from the low coordinate to the high coordinate on screen.
        const rtl = paintedRow(centers.toReversed(), sizes.toReversed(), scales.toReversed(),
            [3, 2, 1, 0], anchor);
        for (let i = 0; i < row.length; i++) {
            near(rtl[i].start, row[i].start, 'RTL slots keep the same physical start');
            near(rtl[i].end, row[i].end, 'RTL slots keep the same physical end');
        }
    }
}

{
    // Transfer 30 px of growth from one icon to its neighbor without
    // changing the outer row bounds. Each frame moves them less than a
    // pixel, so integer rounding or a stale offset produces a visible jump.
    const centers = [30, 98, 166];
    const sizes = [60, 60, 60];
    const order = [0, 1, 2];
    let previous = paintedRow(centers, sizes, [1.5, 1, 1], order, 0.5);
    for (let frame = 1; frame <= 100; frame++) {
        const transfer = frame / 100;
        const scales = [1.5 - transfer / 2, 1 + transfer / 2, 1];
        const row = paintedRow(centers, sizes, scales, order, 0.5);
        near(row[0].start, -15, 'growth transfer holds the left edge');
        near(row.at(-1).end, 211, 'growth transfer holds the right edge');
        near(row[1].start - row[0].end, 8, 'growth transfer preserves the first gap');
        near(row[2].start - row[1].end, 8, 'growth transfer preserves the second gap');
        near(row[2].center, previous[2].center, 'the far slot stays still during transfer');
        for (const index of [0, 1]) {
            const movement = previous[index].center - row[index].center;
            assert.ok(movement > 0 && movement < 0.2,
                `frame ${frame}, slot ${index} must move smoothly by a fraction of a pixel, got ${movement}`);
            assertions++;
        }
        previous = row;
    }
    near(previous[0].center, 15, 'the first icon completes its continuous shift');
    near(previous[1].center, 98, 'the next icon completes its continuous shift');
}

{
    // Approaches monotonically, most of the way within one duration, and
    // then snaps: an asymptote here would keep the dock relayouting forever.
    let value = 0;
    for (let i = 0; i < 8; i++)
        value = planMagnifyApproach(value, 100, 125, 16);
    assert.ok(value > 90 && value <= 100, `after ~one duration, got ${value}`);
    assertions++;
    for (let i = 0; i < 60 && value !== 100; i++)
        value = planMagnifyApproach(value, 100, 125, 16);
    assert.equal(value, 100, 'the approach must terminate exactly');
    assertions++;
    assert.equal(planMagnifyApproach(5, 9, 0, 16), 9, 'zero duration is instant');
    assertions++;
    assert.equal(planMagnifyApproach(NaN, 9, 125, 16), 9);
    assertions++;

    const refreshProgress = [60, 120, 240].map(rate => {
        let position = 2800;
        for (let frame = 0; frame < rate / 10; frame++)
            position = planMagnifyApproach(position, 3200, 125, 1000 / rate, 0.125);
        return position;
    });
    for (const position of refreshProgress)
        assert.ok(Math.abs(position - refreshProgress[0]) < 1e-9, 'same motion after 100 ms');
    assertions += refreshProgress.length;

    const nearEnd = planMagnifyApproach(3198, 3200, 125, 1000 / 240, 0.125);
    assert.ok(nearEnd > 3198 && nearEnd < 3200, 'a distant icon cannot snap early');
    assertions++;
}

console.log(`motion: ${assertions} assertions passed`);
