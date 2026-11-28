// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    GObject,
    Mtk,
    St,
} from './dependencies/gi.js';
import {DockPillGlassEffect} from './dockPillGlass.js';

// gnome-rounded-blur's effect clips the blur to the dock's rounded corners.
// GNOME Shell's own effect cannot, and its square corners would show outside
// the dock, so without a usable library there is no blur at all.
const Blur = await import('gi://Blur').then(({default: blur}) => {
    try {
        new blur.BlurEffect();
        return blur;
    } catch (error) {
        logError(error, 'gnome-rounded-blur is installed but cannot be used');
        return null;
    }
}, () => null);

const BLUR_HAS_SQUIRCLE = Boolean(
    Blur && GObject.Object?.find_property?.call(Blur.BlurEffect, 'corner-exponent')
);
const BLUR_HAS_DITHER = Boolean(
    Blur && GObject.Object?.find_property?.call(Blur.BlurEffect, 'dither')
);
const BLUR_HAS_UNMAP_DELAY = Boolean(
    Blur && GObject.Object?.find_property?.call(Blur.BlurEffect, 'unmap-release-delay')
);

export const EFFECT_NAME = 'xdock-blur';
export const PILL_GLASS_EFFECT_NAME = 'xdock-pill-glass';

/**
 * @param {Mtk.Region} clip the part of the stage being redrawn
 * @param {Clutter.Actor} actor an actor on the stage
 * @returns {boolean} whether the clip holds all of the actor
 */
function covers(clip, actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    const [x1, y1] = [Math.ceil(x), Math.ceil(y)];
    const rect = new Mtk.Rectangle({
        x: x1,
        y: y1,
        width: Math.floor(x + width) - x1,
        height: Math.floor(y + height) - y1,
    });
    return clip.contains_rectangle(rect) === Mtk.RegionOverlap.IN;
}

/**
 * Keeps every redraw of a blurred surface whole.
 *
 * A background blur copies the screen under it, and where a redraw covers only
 * part of the dock, the rest of that copy is the dock itself from the frame
 * before, which it would blur back in. This child of the dash is a clone of
 * the icons that paints nothing: Clutter redraws a clone whenever anything in
 * its source redraws, so a hover or an animation on one icon redraws the whole
 * dock in the same frame. A partial redraw from behind the dock, which no
 * clone hears of, is followed by one whole redraw.
 */
export const WholeSurfaceRedraw = GObject.registerClass(
class XDockWholeSurfaceRedraw extends Clutter.Clone {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    // All of the dash, while taking no room in its layout.
    vfunc_allocate(_box) {
        const [width, height] = this.get_parent().get_allocation_box().get_size();
        super.vfunc_allocate(Clutter.ActorBox.new(0, 0, width, height));
    }

    vfunc_get_paint_volume(volume) {
        return volume.set_from_allocation(this);
    }

    // This clone paints nothing and must not intercept even PickMode.ALL,
    // which Shell's drag-and-drop uses for non-reactive actors too.
    vfunc_pick(_pickContext) {}

    vfunc_paint(paintContext) {
        const clip = paintContext.get_redraw_clip();
        const partial = clip !== null && !covers(clip, this);
        if (partial && !this._followingUp)
            this.queue_redraw();
        // A follow-up that still looks partial is not followed up again, so
        // this never keeps the dock redrawing by itself.
        this._followingUp = partial && !this._followingUp;
    }
});

/**
 * The blur behind the dock's background, owned by one dock's dash.
 *
 * Dash to Dock caches the whole dash in an offscreen framebuffer, and a
 * background blur painted into that framebuffer copies its empty contents
 * instead of the screen. While the blur is on, only the icons keep that cache,
 * and the background paints straight to the screen with the blur under it.
 * While it is off, or without gnome-rounded-blur, the dash is exactly as Dash
 * to Dock left it.
 */
export class DockBlur {
    /**
     * @param {object} dash the dock's DockDash
     * @param {Gio.Settings} settings the extension's settings
     */
    constructor(dash, settings) {
        this._dash = dash;
        this._settings = settings;
        this._effect = null;
        this._pillEffect = null;
        this._styleId = 0;
        this._mappedId = 0;
        this._savedClip = null;
        this._settingsIds = [];
        const keys = ['dock-blur', 'dock-blur-sigma', 'dock-blur-brightness', 'dock-glass-mode'];
        if (!Blur && !this._isLiveGlassMode())
            return;
        this._settingsIds = keys.map(key =>
            settings.connect(`changed::${key}`, () => this._update()));
        this._update();
    }

    _isLiveGlassMode() {
        return typeof this._settings.get_string === 'function' &&
            this._settings.get_string('dock-glass-mode') === 'live';
    }

    _update() {
        const wantBlur = Boolean(Blur) && this._settings.get_boolean('dock-blur');
        const wantLivePill = this._isLiveGlassMode();

        if (wantBlur)
            this._attach();
        else
            this._detach();

        if (wantLivePill)
            this._attachPillGlass();
        else
            this._detachPillGlass();

        this._syncStyleWatcher();
        this._sync();
    }

    _syncStyleWatcher() {
        const background = this._dash._background;
        const needWatcher = Boolean(this._effect || this._pillEffect);
        if (needWatcher && !this._styleId) {
            this._styleId = background.connect('style-changed', () => this._sync());
        } else if (!needWatcher && this._styleId) {
            background.disconnect(this._styleId);
            this._styleId = 0;
        }
    }

    _attach() {
        if (this._effect)
            return;
        const {_background: background, _dashContainer: icons} = this._dash;
        const effect = new Blur.BlurEffect({mode: Blur.BlurMode.BACKGROUND});
        this._redraw = new WholeSurfaceRedraw({source: icons});
        this._redirects = [this._dash.offscreen_redirect, icons.offscreen_redirect];
        this._dash.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY;
        icons.offscreen_redirect = Clutter.OffscreenRedirect.ALWAYS;
        background.add_effect_with_name(EFFECT_NAME, effect);
        this._effect = effect;
        this._dash.add_child(this._redraw);
        this._mappedId = background.connect('notify::mapped', () => {
            if (!background.mapped && typeof this._effect?.release_targets === 'function')
                this._effect.release_targets();
        });
    }

    _detach() {
        if (!this._effect)
            return;
        const {_background: background, _dashContainer: icons} = this._dash;
        if (this._mappedId) {
            background.disconnect(this._mappedId);
            this._mappedId = 0;
        }
        this._redraw.destroy();
        background.remove_effect(this._effect);
        [this._dash.offscreen_redirect, icons.offscreen_redirect] = this._redirects;
        this._effect = this._redraw = null;
    }

    _attachPillGlass() {
        if (this._pillEffect)
            return;
        const {_background: background} = this._dash;
        const pillEffect = new DockPillGlassEffect();
        this._savedClip = background.clip_to_allocation;
        background.clip_to_allocation = false;
        background.add_effect_with_name(PILL_GLASS_EFFECT_NAME, pillEffect);
        this._pillEffect = pillEffect;
    }

    _detachPillGlass() {
        if (!this._pillEffect)
            return;
        const {_background: background} = this._dash;
        background.remove_effect(this._pillEffect);
        if (this._savedClip !== null)
            background.clip_to_allocation = this._savedClip;
        this._savedClip = null;
        this._pillEffect = null;
    }

    _sync() {
        const background = this._dash._background;
        // A theme node exists only on the stage; style-changed follows there.
        if ((!this._effect && !this._pillEffect) || !background.get_stage())
            return;
        const node = background.get_theme_node();
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const cornerRadius = node.get_border_radius(St.Corner.TOPLEFT);
        const translucent = node.get_background_color().alpha < 255;
        const liveMode = this._isLiveGlassMode();

        if (this._effect) {
            this._effect.radius = this._settings.get_int('dock-blur-sigma') * scaleFactor;
            this._effect.brightness = this._settings.get_double('dock-blur-brightness');
            this._effect.corner_radius = cornerRadius;
            if (BLUR_HAS_SQUIRCLE)
                this._effect.corner_exponent = liveMode ? 3.0 : 2.0;
            if (BLUR_HAS_DITHER)
                this._effect.dither = true;
            if (BLUR_HAS_UNMAP_DELAY)
                this._effect.unmap_release_delay = 2000;
            // Nothing shows through an opaque background, such as the one high
            // contrast gives the dock.
            this._effect.enabled = translucent;
        }
        if (this._pillEffect) {
            this._pillEffect.cornerRadius = cornerRadius;
            this._pillEffect.cornerExponent = 3.0;
            this._pillEffect.enabled = translucent;
        }
    }

    destroy() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];
        this._detachPillGlass();
        this._detach();
        this._syncStyleWatcher();
    }
}
