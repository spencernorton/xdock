// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

export const DockMotionState = Object.freeze({
    HIDDEN:  0,
    SHOWING: 1,
    SHOWN:   2,
    HIDING:  3,
});

export const DockMotionTarget = Object.freeze({
    HIDDEN: 0,
    SHOWN: 1,
});

export const DockMotionRequestResult = Object.freeze({
    STARTED: 'started',
    DELAYED: 'delayed',
    DEDUPLICATED: 'deduplicated',
});

// How a single dock icon answers the pointer. Values are visual taste, so they
// live next to each other rather than being scattered over the call site.
export const ICON_HOVER_SCALE = 1.08;
export const ICON_PRESS_SCALE = 0.94;
export const ICON_HOVER_LIFT = 3;

/**
 * Map one icon's interaction state to the transform that expresses it.
 *
 * Pressing wins over hovering, because you are necessarily hovering while you
 * press: without that precedence the two states fight over the same actor and
 * the icon reads as stuck large after a click.
 *
 * `lift` is a distance AWAY from the screen edge the dock sits against, not an
 * axis: the caller owns that mapping because only it knows St.Side. That is
 * what keeps this function testable without Clutter.
 *
 * @param {object} params interaction state
 * @param {boolean} params.hovered whether the pointer is over the icon
 * @param {boolean} params.pressed whether a button is held down on the icon
 * @returns {{scale: number, lift: number}} the transform to ease towards
 */
export function planIconMotion({hovered = false, pressed = false} = {}) {
    if (pressed)
        return {scale: ICON_PRESS_SCALE, lift: 0};
    if (hovered)
        return {scale: ICON_HOVER_SCALE, lift: ICON_HOVER_LIFT};

    return {scale: 1, lift: 0};
}

/**
 * Magnification scales for one row of dock icons, macOS-style: the icon under
 * the pointer reaches maxScale and its neighbours fall off with distance.
 *
 * Distances are measured between RESTING centres, never live ones: feeding
 * magnified geometry back into the falloff is what makes a dock hunt around
 * the pointer instead of settling under it. `influence` is the caller's
 * eased 0..1 "pointer is here" amount, so entering and leaving the dock
 * swell and settle through the same curve the pointer itself gets.
 *
 * The falloff is cos²: flat at the top (the magnified icon does not breathe
 * as the pointer crosses it) and flat where it lands (no visible seam where
 * magnification ends). Growth can be capped so a full dock magnifies less
 * rather than overflowing its monitor: every scale's excess is shrunk by
 * the same factor, which keeps the shape and only lowers the peak.
 *
 * @param {object} params magnification inputs, all in resting box pixels
 * @param {number[]} params.centers resting centre of each icon along the axis
 * @param {number} params.itemSize resting size of one icon along the axis
 * @param {number[]} [params.sizes] individual item sizes for the growth budget
 * @param {number} params.pointer pointer position along the axis
 * @param {number} params.influence eased presence of the pointer, 0..1
 * @param {number} params.maxScale scale of the icon under the pointer
 * @param {number} params.rangeFactor falloff reach, in icon sizes
 * @param {number} [params.maxTotal] longest total the row may grow to
 * @param {number} [params.restTotal] total length of the row at rest
 * @param {number[]} [scales] scratch space to reuse between frames
 * @returns {number[]} one scale per centre, each >= 1
 */
export function planMagnification({
    centers = [],
    itemSize,
    sizes,
    pointer,
    influence = 1,
    maxScale,
    rangeFactor,
    maxTotal = Infinity,
    restTotal = 0,
} = {}, scales = []) {
    scales.length = centers.length;
    const limited = Number.isFinite(maxTotal);
    if (!centers.length || !Number.isFinite(pointer) ||
        !Number.isFinite(itemSize) || itemSize <= 0 ||
        !Number.isFinite(maxScale) || maxScale <= 1 ||
        !Number.isFinite(rangeFactor) || rangeFactor <= 0 ||
        !Number.isFinite(influence) || influence <= 0 ||
        (limited && !(maxTotal > restTotal)))
        return scales.fill(1);

    const reach = rangeFactor * itemSize;
    const peak = (maxScale - 1) * Math.min(influence, 1);
    let growth = 0;
    for (let i = 0; i < centers.length; i++) {
        const center = centers[i];
        const distance = Number.isFinite(center) ? Math.abs(pointer - center) / reach : Infinity;
        const extra = distance < 1 ? peak * Math.cos(distance * Math.PI / 2) ** 2 : 0;
        scales[i] = 1 + extra;
        const size = sizes?.[i];
        growth += extra * (Number.isFinite(size) && size > 0 ? size : itemSize);
    }

    const headroom = maxTotal - restTotal;
    if (limited && growth > headroom) {
        for (let i = 0; i < scales.length; i++)
            scales[i] = 1 + (scales[i] - 1) * headroom / growth;
    }

    return scales;
}

/**
 * One step of an exponential approach, for the eased pointer position and
 * influence magnification runs on. Reaches about 95% of the remaining
 * distance per `durationMs`, and snaps the last epsilon so a settled dock
 * truly stops instead of decaying towards rest forever.
 *
 * @param {number} current the current eased value
 * @param {number} target the value being approached
 * @param {number} durationMs the approach time constant window
 * @param {number} dtMs milliseconds since the previous step
 * @param {number} [epsilon] absolute distance at which to finish
 * @returns {number} the next eased value
 */
export function planMagnifyApproach(current, target, durationMs, dtMs, epsilon = 0.001) {
    if (!Number.isFinite(current))
        return target;
    if (!Number.isFinite(target) || !Number.isFinite(dtMs) || dtMs < 0 ||
        !Number.isFinite(durationMs) || durationMs <= 0)
        return target;

    const next = current + (target - current) * (1 - Math.exp(-3 * dtMs / durationMs));
    return Math.abs(target - next) <= epsilon ? target : next;
}

/**
 * Continuous shifts from resting icon centers. The visual order follows the
 * physical axis, including RTL rows. Anchor 0 holds the start edge, 1 holds
 * the end edge, and 0.5 keeps the row centered as it grows.
 *
 * @param {number[]} sizes resting item widths or heights
 * @param {number[]} scales current magnification scales
 * @param {number[]} order item indices in physical-axis order
 * @param {number} anchor fixed point within the row, from 0 to 1
 * @param {number[]} offsets reusable result
 * @returns {number[]} shifts along the dock axis
 */
export function planMagnifyOffsets(sizes, scales, order, anchor, offsets = []) {
    offsets.length = sizes.length;
    let growth = 0;
    for (let i = 0; i < sizes.length; i++)
        growth += sizes[i] * (scales[i] - 1);

    let position = -growth * anchor;
    for (const i of order) {
        const extra = sizes[i] * (scales[i] - 1);
        offsets[i] = position + extra / 2;
        position += extra;
    }
    return offsets;
}

export const IndicatorTransition = Object.freeze({
    REVEAL: 'reveal',
    // The app stopped: drop the dot immediately. See below for why this edge
    // cannot fade.
    HIDE: 'hide',
    // Same visibility, different contents (window count, colours, a theme
    // change): redraw and touch NOTHING else.
    REPAINT: 'repaint',
});

/**
 * Decide what a running-indicator update has to do.
 *
 * Only the appearing edge animates, and that asymmetry is a measured limit
 * rather than a preference. A fade-OUT has to keep showing a dot the live state
 * has already dropped, and it cannot: St.DrawingArea clears its surface
 * whenever it is invalidated, whether or not the repaint handler draws
 * anything. The source icon's own notify::running handler invalidates the area
 * about 3ms in, so by the time a fade-out could start there is nothing left on
 * the canvas to fade. The revealing edge has no such problem -- a repaint
 * landing mid-fade redraws the dot, because the app is running by then.
 *
 * REPAINT is separate from HIDE precisely so it can be made harmless: update()
 * runs for colour and theme changes too, and closing or opening a window fires
 * notify::focused alongside notify::running. A REPAINT that reset the opacity
 * or dropped the transition would cut every reveal short.
 *
 * @param {object} params indicator state
 * @param {boolean} params.wasVisible whether the indicator was last shown
 * @param {boolean} params.running whether the app is running now
 * @returns {string} one of IndicatorTransition
 */
export function planIndicatorTransition({wasVisible, running}) {
    if (!!wasVisible === !!running)
        return IndicatorTransition.REPAINT;

    return running
        ? IndicatorTransition.REVEAL
        : IndicatorTransition.HIDE;
}

// The bounce occupies the first sixth of IconAnimator's shared cycle and rests
// for the other five sixths. That ratio is the difference between an icon
// asking for attention and an icon vibrating continuously.
export const ATTENTION_BOUNCE_DUTY = 1 / 6;

/**
 * Shape of the urgent-application bounce, as a fraction of its peak height.
 *
 * Two hops, the second about a third of the first, then flat. |sin| gives the
 * right arc for free -- fast off the ground, slow at the apex -- and the linear
 * decay does the damping. Returns 0 for the whole rest of the cycle, which is
 * what makes this read as a bounce every few seconds rather than a jitter.
 *
 * Peaks at ~0.76, not 1: the decay has already started by the time the first
 * arc reaches its top. Callers scale by their own height constant.
 *
 * @param {number} progress timeline progress in [0, 1]
 * @returns {number} displacement as a fraction of the peak height
 */
export function planAttentionBounce(progress) {
    if (!Number.isFinite(progress))
        return 0;

    const p = progress / ATTENTION_BOUNCE_DUTY;
    if (p < 0 || p >= 1)
        return 0;

    return Math.abs(Math.sin(p * 2 * Math.PI)) * (1 - p);
}

function clampProgress(progress) {
    if (!Number.isFinite(progress))
        return DockMotionTarget.HIDDEN;

    return Math.min(Math.max(progress, DockMotionTarget.HIDDEN), DockMotionTarget.SHOWN);
}

/**
 * Plan one leg of the dock's reversible reveal/hide motion.
 *
 * Durations are proportional to the distance left, so retargeting an active
 * transition neither waits for the old target nor restarts a full-duration
 * animation. The caller supplies whether Shell animations are enabled so this
 * module remains pure and independently testable.
 *
 * @param {object} params motion inputs
 * @param {number} params.currentProgress current slide progress in [0, 1]
 * @param {number} params.targetProgress either DockMotionTarget value
 * @param {number} params.fullDuration full-travel duration in milliseconds
 * @param {boolean} params.animationsEnabled Shell animation policy result
 * @returns {{targetProgress: number, activeState: number, completedState: number,
 *   duration: number, completeImmediately: boolean}}
 */
export function planDockTransition({
    currentProgress,
    targetProgress,
    fullDuration,
    animationsEnabled = true,
}) {
    if (targetProgress !== DockMotionTarget.HIDDEN &&
        targetProgress !== DockMotionTarget.SHOWN)
        throw new RangeError('Dock motion target must be 0 or 1');

    const progress = clampProgress(currentProgress);
    const safeDuration = Number.isFinite(fullDuration) ? Math.max(0, fullDuration) : 0;
    const remainingDistance = Math.abs(targetProgress - progress);
    const duration = animationsEnabled
        ? Math.round(safeDuration * remainingDistance)
        : 0;
    const showing = targetProgress === DockMotionTarget.SHOWN;

    return {
        targetProgress,
        activeState: showing ? DockMotionState.SHOWING : DockMotionState.HIDING,
        completedState: showing ? DockMotionState.SHOWN : DockMotionState.HIDDEN,
        duration,
        completeImmediately: duration === 0,
    };
}

/**
 * Own the dock's transition and delayed-hide request lifecycle.
 *
 * Scheduling is injected so the state machine can be tested without Clutter or
 * GLib. A delayed hide is intentionally separate from the slide transition:
 * an in-flight reveal continues during the grace period and the hide leg is
 * planned from the live progress only when the timer fires.
 */
export class DockMotionController {
    constructor({
        initialState = DockMotionState.HIDDEN,
        getProgress,
        hasActiveTransition,
        startTransition,
        stopTransition,
        scheduleDelay,
        cancelDelay,
        onStateChanged = () => undefined,
        onTransitionStart = () => undefined,
        onTransitionComplete = () => undefined,
    }) {
        this._state = initialState;
        this._getProgress = getProgress;
        this._hasActiveTransition = hasActiveTransition;
        this._startTransition = startTransition;
        this._stopTransition = stopTransition;
        this._scheduleDelay = scheduleDelay;
        this._cancelDelay = cancelDelay;
        this._onStateChanged = onStateChanged;
        this._onTransitionStart = onTransitionStart;
        this._onTransitionComplete = onTransitionComplete;

        this._targetProgress = null;
        this._requestId = 0;
        this._delayGeneration = 0;
        this._pendingHide = null;
    }

    get state() {
        return this._state;
    }

    get targetProgress() {
        return this._targetProgress;
    }

    get hasPendingHide() {
        return this._pendingHide !== null;
    }

    request({
        targetProgress,
        fullDuration,
        delay = 0,
        animationsEnabled = true,
    }) {
        if (targetProgress !== DockMotionTarget.HIDDEN &&
            targetProgress !== DockMotionTarget.SHOWN)
            throw new RangeError('Dock motion target must be 0 or 1');

        const safeDelay = Number.isFinite(delay) ? Math.max(0, delay) : 0;

        if (targetProgress === DockMotionTarget.SHOWN || safeDelay === 0) {
            this.cancelPendingHide();
            return this._start({
                targetProgress,
                fullDuration,
                animationsEnabled,
            });
        }

        if (this._pendingHide || this._isActiveTarget(targetProgress) ||
            this._isCompletedTarget(targetProgress))
            return DockMotionRequestResult.DEDUPLICATED;

        const generation = ++this._delayGeneration;
        const pendingHide = {
            sourceId: null,
            generation,
            targetProgress,
            fullDuration,
            animationsEnabled,
        };
        this._pendingHide = pendingHide;
        try {
            pendingHide.sourceId = this._scheduleDelay(safeDelay, () => {
                if (this._pendingHide !== pendingHide ||
                    generation !== this._delayGeneration)
                    return;

                this._pendingHide = null;
                this._start({
                    targetProgress,
                    fullDuration,
                    animationsEnabled,
                });
            });
        } catch (error) {
            if (this._pendingHide === pendingHide) {
                this._pendingHide = null;
                this._delayGeneration++;
            }
            throw error;
        }

        return DockMotionRequestResult.DELAYED;
    }

    cancelPendingHide() {
        const pendingHide = this._pendingHide;
        if (!pendingHide)
            return false;

        this._pendingHide = null;
        this._delayGeneration++;
        this._cancelDelay(pendingHide.sourceId);
        return true;
    }

    cancel() {
        const errors = [];
        try {
            this.cancelPendingHide();
        } catch (error) {
            errors.push(error);
        }

        this._requestId++;
        this._targetProgress = null;
        try {
            this._stopTransition();
        } catch (error) {
            errors.push(error);
        }

        if (errors.length === 1)
            throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, 'Failed to cancel dock motion');
    }

    _start({targetProgress, fullDuration, animationsEnabled}) {
        if (this._isActiveTarget(targetProgress) ||
            this._isCompletedTarget(targetProgress))
            return DockMotionRequestResult.DEDUPLICATED;

        const plan = planDockTransition({
            currentProgress: this._getProgress(),
            targetProgress,
            fullDuration,
            animationsEnabled,
        });
        const requestId = ++this._requestId;

        this._targetProgress = targetProgress;
        this._setState(plan.activeState);
        this._onTransitionStart(plan);
        this._startTransition(plan,
            () => this._complete(plan, requestId));

        return DockMotionRequestResult.STARTED;
    }

    _complete(plan, requestId) {
        if (requestId !== this._requestId)
            return;

        this._targetProgress = null;
        this._setState(plan.completedState);
        this._onTransitionComplete(plan);
    }

    _isActiveTarget(targetProgress) {
        return this._targetProgress === targetProgress &&
            this._hasActiveTransition();
    }

    _isCompletedTarget(targetProgress) {
        const completedState = targetProgress === DockMotionTarget.SHOWN
            ? DockMotionState.SHOWN
            : DockMotionState.HIDDEN;

        return this._state === completedState &&
            !this._hasActiveTransition() &&
            clampProgress(this._getProgress()) === targetProgress;
    }

    _setState(state) {
        this._state = state;
        this._onStateChanged(state);
    }
}
