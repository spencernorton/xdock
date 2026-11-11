// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Clutter} from './dependencies/gi.js';
import {BoxPointer} from './dependencies/shell/ui.js';
import {animationsEnabled} from './animationSettings.js';

const OPEN_TIME = 200;
const CLOSE_TIME = 130;
const NATIVE_TIME = BoxPointer.POPUP_ANIMATION_TIME ?? 150;
const PAINT_PROPERTIES = {
    opacity: 'opacity',
    'scale-x': 'scale_x',
    'scale-y': 'scale_y',
    'translation-x': 'translation_x',
    'translation-y': 'translation_y',
};

/**
 * Refine one popup's native transitions without taking over its lifecycle.
 *
 * BoxPointer owns positioning, input muting, visibility and completion signals
 * on both supported Shell versions. Keep its transition objects and callbacks;
 * only adjust their intervals and timing before the first frame is painted.
 * No animation loop or extra surface is needed after the popup settles.
 *
 * @param {object} menu a native PopupMenu
 */
export function refinePopupMotion(menu) {
    const pointer = menu._boxPointer;
    if (!pointer?.get_transition || !pointer.open || !pointer.close)
        return;

    const {open, close} = pointer;

    function refine(opening, from = null) {
        for (const [name, property] of Object.entries(PAINT_PROPERTIES)) {
            const transition = pointer.get_transition(name);
            // Native zero-duration/reduced-motion paths create no transition.
            if (!transition)
                continue;

            if (from)
                transition.set_from(from[property]);
            // Native ease() has already applied the user's slow-down factor.
            // Scale that duration instead of applying the factor a second time.
            transition.set_duration(Math.round(transition.get_duration() *
                (opening ? OPEN_TIME : CLOSE_TIME) / NATIVE_TIME));
            transition.set_progress_mode(opening
                ? Clutter.AnimationMode.EASE_OUT_CUBIC
                : Clutter.AnimationMode.EASE_IN_CUBIC);
        }
    }

    pointer.open = function (animate, ...args) {
        // Reopening a closing popup must start at the last painted state.
        // Native open() otherwise resets opacity to zero and scale to 0.96.
        // Shell 51 shows the actor before it asks BoxPointer to open it, so
        // visibility alone does not mean an earlier animation is in flight.
        const from = this.visible && Object.keys(PAINT_PROPERTIES)
            .some(name => this.get_transition(name))
            ? Object.fromEntries(Object.values(PAINT_PROPERTIES)
                .map(property => [property, this[property]]))
            : null;
        const result = open.call(this,
            animationsEnabled() ? animate : BoxPointer.PopupAnimation.NONE, ...args);
        refine(true, from);
        return result;
    };

    pointer.close = function (animate, ...args) {
        const result = close.call(this,
            animationsEnabled() ? animate : BoxPointer.PopupAnimation.NONE, ...args);
        refine(false);
        return result;
    };
}
