import {St} from './dependencies/gi.js';

// Shell 50 uses enable-animations. Shell 51 also exposes the user's
// separate accessibility preference for reduced motion.
export const animationSettingSignals = St.ReducedMotion
    ? ['notify::enable-animations', 'notify::reduced-motion']
    : ['notify::enable-animations'];

export function animationsEnabled() {
    const settings = St.Settings.get();
    return settings.enable_animations &&
        (!St.ReducedMotion || settings.reducedMotion !== St.ReducedMotion.REDUCE);
}
