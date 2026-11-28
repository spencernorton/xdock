import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {URL} from 'node:url';

// dockBlur.js against stand-ins for the GNOME libraries it uses: what it
// attaches, what it gives back, when it asks for a redraw, and that without
// gnome-rounded-blur it leaves the dock alone.

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const gi = dataUrl(`
export const Clutter = {
    OffscreenRedirect: {AUTOMATIC_FOR_OPACITY: 1, ALWAYS: 2},
    ActorBox: {new: (x1, y1, x2, y2) => ({x1, y1, x2, y2})},
    Effect: class {
        _init() {}
        queue_repaint() {}
        get_actor() { return this._actor ?? null; }
        vfunc_set_actor(actor) { this._actor = actor; }
    },
    Clone: class {
        constructor({source}) {
            this.source = source;
            this.redraws = 0;
            this.box = [0, 0, 100, 40];
        }
        queue_redraw() { this.redraws++; }
        get_parent() { return this.parent; }
        vfunc_allocate(box) { this.allocation = box; }
        get_transformed_position() { return this.box.slice(0, 2); }
        get_transformed_size() { return this.box.slice(2); }
        destroy() {
            this.destroyed = true;
            this.parent.children.splice(this.parent.children.indexOf(this), 1);
        }
    },
};
export const GObject = {
    registerClass: (...args) => args.at(-1),
    Object: {
        find_property(name) {
            return this._props?.includes(name) ? {name} : null;
        },
    },
};
export const Mtk = {
    Rectangle: class { constructor(fields) { Object.assign(this, fields); } },
    RegionOverlap: {OUT: 0, IN: 1, PART: 2},
};
export const Cogl = {};
export const Graphene = {Point3D: class { constructor(p) { Object.assign(this, p); } }};
export const St = {
    Corner: {TOPLEFT: 0},
    ThemeContext: {get_for_stage: () => ({scaleFactor: 2})},
};
`);

const roundedBlur = dataUrl(`
export default {
    BlurMode: {ACTOR: 0, BACKGROUND: 1},
    BlurEffect: Object.assign(
        class {
            constructor(params) {
                Object.assign(this, {
                    enabled: true, radius: 0, brightness: 1, corner_radius: 0,
                    corner_exponent: 2.0, dither: false, unmap_release_delay: 0,
                    released: 0,
                }, params);
            }
            release_targets() { this.released++; }
        },
        {_props: ['corner-exponent', 'dither', 'unmap-release-delay']}
    ),
};
`);

// Installed, but its shared library does not load.
const brokenBlur = dataUrl(`
export default {
    BlurMode: {ACTOR: 0, BACKGROUND: 1},
    BlurEffect: class { constructor() { throw new Error('undefined symbol: gb_blur_effect_get_type'); } },
};
`);

globalThis.global = {stage: {}};
const logged = [];
globalThis.logError = (_error, message) => logged.push(message);

const pillSource = (await readFile(new URL('../dockPillGlass.js', import.meta.url), 'utf8'))
    .replace("'./dependencies/gi.js'", `'${gi}'`);
const pillUrl = dataUrl(pillSource);
const source = (await readFile(new URL('../dockBlur.js', import.meta.url), 'utf8'))
    .replace("'./dependencies/gi.js'", `'${gi}'`)
    .replace("'./dockPillGlass.js'", `'${pillUrl}'`);
const rounded = await import(dataUrl(source.replace("'gi://Blur'", `'${roundedBlur}'`)));
assert.deepEqual(logged, [], 'a usable library was reported as unusable');
const missing = await import(dataUrl(source));
assert.deepEqual(logged, [], 'a missing library was reported as an error');
const broken = await import(dataUrl(source.replace("'gi://Blur'", `'${brokenBlur}'`)));
assert.equal(logged.length, 1, 'an unusable library was not reported');

class Settings {
    constructor(values = {}) {
        this.values = {
            'dock-blur': true, 'dock-blur-sigma': 30, 'dock-blur-brightness': 0.6,
            'dock-glass-mode': 'static', ...values,
        };
        this.handlers = new Map();
        this._id = 0;
    }

    get_boolean(key) { return this.values[key]; }
    get_int(key) { return this.values[key]; }
    get_double(key) { return this.values[key]; }
    get_string(key) { return this.values[key]; }

    connect(signal, callback) {
        this.handlers.set(++this._id, [signal, callback]);
        return this._id;
    }

    disconnect(id) {
        assert.ok(this.handlers.delete(id), `disconnect of an unknown settings handler ${id}`);
    }

    set(key, value) {
        this.values[key] = value;
        for (const [signal, callback] of [...this.handlers.values()]) {
            if (signal === `changed::${key}`)
                callback();
        }
    }
}

function makeDash({alpha = 94, radius = 18, onStage = true} = {}) {
    const background = {
        effects: new Map(),
        handlers: new Map(),
        _id: 0,
        onStage,
        alpha,
        mapped: true,
        clip_to_allocation: true,
        add_effect_with_name(name, effect) {
            assert.ok(!this.effects.has(name), `a second effect named ${name}`);
            this.effects.set(name, effect);
        },
        remove_effect(effect) {
            for (const [name, attached] of this.effects) {
                if (attached === effect)
                    this.effects.delete(name);
            }
        },
        connect(signal, callback) {
            this.handlers.set(++this._id, [signal, callback]);
            return this._id;
        },
        disconnect(id) {
            assert.ok(this.handlers.delete(id), `disconnect of an unknown background handler ${id}`);
        },
        emit(signal) {
            for (const [name, callback] of this.handlers.values()) {
                if (name === signal)
                    callback();
            }
        },
        get_stage() { return this.onStage ? {} : null; },
        get_theme_node() {
            assert.ok(this.onStage, 'theme node asked for off the stage');
            return {
                get_border_radius: () => radius,
                get_background_color: () => ({alpha: this.alpha}),
            };
        },
    };
    return {
        offscreen_redirect: 2,
        get_allocation_box: () => ({get_size: () => [144, 84]}),
        _background: background,
        _dashContainer: {offscreen_redirect: 0},
        children: [],
        add_child(child) {
            this.children.push(child);
            child.parent = this;
        },
    };
}

test('on by default: the background blurs, the icons keep the offscreen cache, the dash does not', () => {
    const dash = makeDash();
    const blur = new rounded.DockBlur(dash, new Settings());
    const effect = dash._background.effects.get(rounded.EFFECT_NAME);
    assert.ok(effect, 'no effect on the background');
    assert.equal(effect.mode, 1, 'not a background-mode blur');
    assert.equal(dash.offscreen_redirect, 1, 'the dash is still redirected offscreen');
    assert.equal(dash._dashContainer.offscreen_redirect, 2, 'the icons lost their cache');
    assert.equal(dash.children.length, 1);
    assert.equal(dash.children[0].source, dash._dashContainer, 'the redraw clone does not watch the icons');
    dash.children[0].vfunc_allocate({x1: 72, y1: 42, x2: 72, y2: 42});
    assert.deepEqual(dash.children[0].allocation, {x1: 0, y1: 0, x2: 144, y2: 84},
        'the redraw clone does not cover the whole dash');
    blur.destroy();
});

test('the blur takes its strength, brightness and corners from the settings and the theme', () => {
    const dash = makeDash({radius: 14});
    const settings = new Settings({'dock-blur-sigma': 20, 'dock-blur-brightness': 0.8});
    const blur = new rounded.DockBlur(dash, settings);
    const effect = dash._background.effects.get(rounded.EFFECT_NAME);
    assert.equal(effect.radius, 40, 'the radius is not scaled by the scale factor');
    assert.equal(effect.brightness, 0.8);
    assert.equal(effect.corner_radius, 14, 'the rounded blur ignores the dock radius');
    settings.set('dock-blur-sigma', 5);
    assert.equal(effect.radius, 10);
    blur.destroy();
});

for (const [what, module] of [['missing', missing], ['installed but unusable', broken]]) {
    test(`with gnome-rounded-blur ${what}, blur is inactive and live glass toggles cleanly`, () => {
        const dash = makeDash({radius: 18});
        const settings = new Settings();
        const blur = new module.DockBlur(dash, settings);
        settings.set('dock-blur', false);
        settings.set('dock-blur', true);
        assert.equal(dash._background.effects.size, 0, 'an effect is attached');
        assert.equal(dash.offscreen_redirect, 2, 'the dash lost its offscreen cache');
        assert.equal(dash._dashContainer.offscreen_redirect, 0, 'the icons were redirected');
        assert.equal(dash.children.length, 0, 'a redraw clone is attached');
        assert.equal(dash._background.handlers.size, 0, 'a style handler is connected');
        assert.equal(settings.handlers.size, 1, 'only dock-glass-mode should be watched without Blur');

        settings.set('dock-glass-mode', 'live');
        assert.equal(
            dash._background.effects.has(module.PILL_GLASS_EFFECT_NAME),
            true,
            'live pill glass should toggle without Blur'
        );
        assert.equal(
            dash._background.effects.has(module.EFFECT_NAME),
            false,
            'blur effect must stay absent'
        );

        settings.set('dock-glass-mode', 'static');
        assert.equal(dash._background.effects.size, 0, 'rollback to static must detach pill glass');
        assert.equal(dash._background.handlers.size, 0, 'style watcher must disconnect on static rollback');
        blur.destroy();
        assert.equal(settings.handlers.size, 0, 'destroy must disconnect all settings handlers');
    });
}

test('an opaque background, as in high contrast, turns the effect off until it is translucent again', () => {
    const dash = makeDash({alpha: 255});
    const blur = new rounded.DockBlur(dash, new Settings());
    const effect = dash._background.effects.get(rounded.EFFECT_NAME);
    assert.equal(effect.enabled, false);
    dash._background.alpha = 94;
    dash._background.emit('style-changed');
    assert.equal(effect.enabled, true);
    blur.destroy();
});

test('turning it off gives the dash back exactly as it was, and on again attaches once', () => {
    const dash = makeDash();
    dash.offscreen_redirect = 3;
    dash._dashContainer.offscreen_redirect = 4;
    const settings = new Settings();
    const blur = new rounded.DockBlur(dash, settings);
    const clone = dash.children[0];
    settings.set('dock-blur', false);
    assert.equal(dash._background.effects.size, 0);
    assert.equal(dash.offscreen_redirect, 3);
    assert.equal(dash._dashContainer.offscreen_redirect, 4);
    assert.ok(clone.destroyed && dash.children.length === 0, 'the redraw clone is left behind');
    assert.equal(dash._background.handlers.size, 0, 'the style handler is left connected');
    settings.set('dock-blur', true);
    settings.set('dock-blur', true);
    assert.equal(dash._background.effects.size, 1);
    assert.equal(dash.children.length, 1);
    blur.destroy();
    assert.equal(dash.offscreen_redirect, 3);
    assert.equal(settings.handlers.size, 0, 'a settings handler is left connected');
});

test('off from the start, the dash is never touched', () => {
    const dash = makeDash();
    const settings = new Settings({'dock-blur': false});
    const blur = new rounded.DockBlur(dash, settings);
    settings.set('dock-blur-sigma', 12);
    settings.set('dock-blur-brightness', 0.5);
    assert.equal(dash._background.effects.size, 0);
    assert.equal(dash.offscreen_redirect, 2);
    assert.equal(dash._dashContainer.offscreen_redirect, 0);
    assert.equal(dash.children.length, 0);
    assert.equal(dash._background.handlers.size, 0);
    blur.destroy();
    assert.equal(settings.handlers.size, 0);
});

test('the theme is read only once the dash is on the stage', () => {
    const dash = makeDash({onStage: false});
    const blur = new rounded.DockBlur(dash, new Settings());
    const effect = dash._background.effects.get(rounded.EFFECT_NAME);
    assert.equal(effect.radius, 0);
    dash._background.onStage = true;
    dash._background.emit('style-changed');
    assert.equal(effect.radius, 60);
    assert.equal(effect.corner_radius, 18);
    blur.destroy();
});

test('a partial redraw is followed by exactly one whole redraw, and nothing more', () => {
    const dash = makeDash();
    const blur = new rounded.DockBlur(dash, new Settings());
    const [clone] = dash.children;
    const context = overlap => ({
        get_redraw_clip: () => overlap === null ? null : {
            contains_rectangle: rect => {
                assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [0, 0, 100, 40]);
                return overlap;
            },
        },
    });
    clone.vfunc_paint(context(2));
    assert.equal(clone.redraws, 1, 'a partial redraw is not followed up');
    clone.vfunc_paint(context(2));
    assert.equal(clone.redraws, 1, 'the follow-up was followed up again');
    clone.vfunc_paint(context(1));
    clone.vfunc_paint(context(null));
    assert.equal(clone.redraws, 1, 'a whole or unclipped redraw asked for another');
    clone.vfunc_paint(context(2));
    assert.equal(clone.redraws, 2, 'a later partial redraw is not followed up');
    blur.destroy();
});

test('the shared redraw helper takes no layout space and never picks drag targets', () => {
    const helper = new missing.WholeSurfaceRedraw({source: {}});
    helper.parent = {get_allocation_box: () => ({get_size: () => [800, 600]})};
    assert.deepEqual(helper.vfunc_get_preferred_width(-1), [0, 0]);
    assert.deepEqual(helper.vfunc_get_preferred_height(-1), [0, 0]);
    helper.vfunc_allocate({});
    assert.deepEqual(helper.allocation, {x1: 0, y1: 0, x2: 800, y2: 600});
    helper.vfunc_pick({push_rectangle() { assert.fail('invisible helper intercepted a drop'); }});
});

test('live pill glass mode enables squircle, hollow shadow/rim, and instant static rollback', () => {
    const dash = makeDash({radius: 18});
    const settings = new Settings();
    const blur = new rounded.DockBlur(dash, settings);
    const effect = dash._background.effects.get(rounded.EFFECT_NAME);
    assert.equal(effect.corner_exponent, 2.0);
    assert.equal(dash._background.effects.has(rounded.PILL_GLASS_EFFECT_NAME), false);
    assert.equal(dash._background.clip_to_allocation, true);

    settings.set('dock-glass-mode', 'live');
    assert.equal(effect.corner_exponent, 3.0);
    assert.equal(effect.dither, true);
    assert.equal(effect.unmap_release_delay, 2000);
    const pill = dash._background.effects.get(rounded.PILL_GLASS_EFFECT_NAME);
    assert.ok(pill, 'pill glass effect not attached in live mode');
    assert.equal(pill.cornerRadius, 18);
    assert.equal(pill.cornerExponent, 3.0);
    assert.equal(dash._background.clip_to_allocation, false);

    // Unmapping the dock (autohide) releases blur FBO targets immediately
    dash._background.mapped = false;
    dash._background.emit('notify::mapped');
    assert.equal(effect.released, 1);

    // Instant rollback to static mode restores circular corners, clip, and removes pill effect
    settings.set('dock-glass-mode', 'static');
    assert.equal(effect.corner_exponent, 2.0);
    assert.equal(dash._background.effects.has(rounded.PILL_GLASS_EFFECT_NAME), false);
    assert.equal(dash._background.clip_to_allocation, true);
    blur.destroy();
    assert.equal(dash._background.handlers.size, 0);
});
