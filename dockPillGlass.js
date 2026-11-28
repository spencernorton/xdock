// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
// SPDX-License-Identifier: GPL-3.0-or-later

import {
    Clutter,
    Cogl,
    GObject,
    Graphene,
    St,
} from './dependencies/gi.js';

const SHADOW_PAD_LOGICAL = 38;
const RIM_INSET_LOGICAL = 4;

const COMMON_SDF = `
uniform float u_w;
uniform float u_h;
uniform float u_pad;
uniform float u_radius;
uniform float u_exp;
uniform float u_scale;
uniform float u_opacity;

float xdock_squircle_sd(vec2 p, vec2 half_size, float r, float exp_n) {
    vec2 q = abs(p) - max(half_size - vec2(r), vec2(0.0));
    if (r <= 0.0 || exp_n <= 2.01)
        return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
    vec2 qc = max(q, vec2(0.0));
    float mc = max(qc.x, qc.y);
    if (mc <= 0.0)
        return max(q.x, q.y) - r;
    float rmin = min(qc.x, qc.y) / mc;
    float lp = (rmin > 0.0) ? mc * pow(1.0 + pow(rmin, exp_n), 1.0 / exp_n) : mc;
    return lp - r;
}

vec2 xdock_squircle_normal(vec2 p, vec2 half_size, float r, float exp_n) {
    vec2 q = abs(p) - max(half_size - vec2(r), vec2(0.0));
    vec2 qc = max(q, vec2(0.0));
    vec2 grad;
    float mc = max(qc.x, qc.y);
    if (mc <= 0.0) {
        grad = q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    } else if (r <= 0.0 || exp_n <= 2.01) {
        grad = normalize(qc);
    } else {
        vec2 nr = qc / mc;
        vec2 g = vec2(
            nr.x > 0.0 ? pow(nr.x, exp_n - 1.0) : 0.0,
            nr.y > 0.0 ? pow(nr.y, exp_n - 1.0) : 0.0
        );
        float gl = length(g);
        grad = gl > 0.0001 ? g / gl : vec2(0.7071, 0.7071);
    }
    return grad * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
}

float xdock_logistic(float d, float sigma) {
    return 1.0 / (1.0 + exp(clamp(d / max(sigma, 0.5), -14.0, 14.0)));
}
`;

const SHADOW_CODE = `
vec2 total = vec2(u_w + 2.0 * u_pad, u_h + 2.0 * u_pad);
vec2 pos = cogl_tex_coord_in[0].st * total - vec2(u_pad);
vec2 half_size = vec2(u_w, u_h) * 0.5;
vec2 rel = pos - half_size;
float r = clamp(u_radius, 0.0, max(min(half_size.x, half_size.y) - 0.5, 0.0));

float sd_base = xdock_squircle_sd(rel, half_size, r, u_exp);
float outside = smoothstep(-0.5, 0.75, sd_base);
if (outside <= 0.001) {
    cogl_color_out = vec4(0.0);
} else {
    float s = max(u_scale, 1.0);
    float d1 = xdock_squircle_sd(rel - vec2(0.0, 1.5 * s), half_size, r, u_exp);
    float d2 = xdock_squircle_sd(rel - vec2(0.0, 5.5 * s), half_size, r, u_exp);
    float d3 = xdock_squircle_sd(rel - vec2(0.0, 11.0 * s), half_size, r, u_exp);
    float a1 = 0.28 * xdock_logistic(d1, 2.6 * s);
    float a2 = 0.21 * xdock_logistic(d2, 9.5 * s);
    float a3 = 0.13 * xdock_logistic(d3, 21.0 * s);
    float fade = 1.0 - smoothstep(u_pad * 0.60, u_pad - 0.5, max(sd_base, 0.0));
    float alpha = (1.0 - (1.0 - a1) * (1.0 - a2) * (1.0 - a3)) * outside * fade * u_opacity;
    if (alpha > 0.0) {
        float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        alpha = clamp(alpha + (ign - 0.5) / 255.0, 0.0, 1.0);
    }
    cogl_color_out = vec4(0.0, 0.0, 0.0, alpha);
}
`;

const RIM_CODE = `
vec2 total = vec2(u_w + 2.0 * u_pad, u_h + 2.0 * u_pad);
vec2 pos = cogl_tex_coord_in[0].st * total - vec2(u_pad);
vec2 half_size = vec2(u_w, u_h) * 0.5;
vec2 rel = pos - half_size;
float r = clamp(u_radius, 0.0, max(min(half_size.x, half_size.y) - 0.5, 0.0));
float s = max(u_scale, 1.0);

float sd = xdock_squircle_sd(rel, half_size, r, u_exp);
float rim = smoothstep(-2.0 * s, -0.35 * s, sd) * (1.0 - smoothstep(-0.35 * s, 0.35 * s, sd));
float contour = smoothstep(-0.4 * s, 0.25 * s, sd) * (1.0 - smoothstep(0.45 * s, 1.15 * s, sd));

if (rim <= 0.001 && contour <= 0.001) {
    cogl_color_out = vec4(0.0);
} else {
    vec2 n = xdock_squircle_normal(rel, half_size, r, u_exp);
    float lobe_tl = pow(max(0.0, dot(n, normalize(vec2(-0.55, -0.84)))), 2.0);
    float lobe_br = pow(max(0.0, dot(n, normalize(vec2(0.55, 0.84)))), 2.5);
    float glint_a = rim * (0.12 + 0.88 * (lobe_tl + 0.32 * lobe_br)) * 0.30 * u_opacity;
    float dark_a = contour * 0.34 * u_opacity;
    float out_a = clamp(glint_a + dark_a * (1.0 - glint_a), 0.0, 1.0);
    cogl_color_out = vec4(vec3(glint_a), out_a);
}
`;

let sharedWhiteTex = null;
let sharedWhiteCtx = null;

function getWhiteTexture(context) {
    if (sharedWhiteTex && sharedWhiteCtx === context)
        return sharedWhiteTex;
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = Cogl.Texture2D.new_from_data(
        context, 1, 1, Cogl.PixelFormat.RGBA_8888_PRE, 4, data
    );
    sharedWhiteTex = tex;
    sharedWhiteCtx = context;
    return tex;
}

function buildPipeline(context, fragmentCode) {
    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_layer_texture(0, getWhiteTexture(context));
    pipeline.set_layer_filters(0, Cogl.PipelineFilter.NEAREST, Cogl.PipelineFilter.NEAREST);
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, COMMON_SDF, null);
    snippet.set_replace(fragmentCode);
    pipeline.add_snippet(snippet);
    return {
        pipeline,
        uniforms: {
            w: pipeline.get_uniform_location('u_w'),
            h: pipeline.get_uniform_location('u_h'),
            pad: pipeline.get_uniform_location('u_pad'),
            radius: pipeline.get_uniform_location('u_radius'),
            exp: pipeline.get_uniform_location('u_exp'),
            scale: pipeline.get_uniform_location('u_scale'),
            opacity: pipeline.get_uniform_location('u_opacity'),
        },
    };
}

function setUniforms(entry, w, h, pad, radius, exp, scale, opacity) {
    const {pipeline, uniforms: u} = entry;
    if (u.w > -1)
        pipeline.set_uniform_1f(u.w, w);
    if (u.h > -1)
        pipeline.set_uniform_1f(u.h, h);
    if (u.pad > -1)
        pipeline.set_uniform_1f(u.pad, pad);
    if (u.radius > -1)
        pipeline.set_uniform_1f(u.radius, radius);
    if (u.exp > -1)
        pipeline.set_uniform_1f(u.exp, exp);
    if (u.scale > -1)
        pipeline.set_uniform_1f(u.scale, scale);
    if (u.opacity > -1)
        pipeline.set_uniform_1f(u.opacity, opacity);
}

/**
 * Pure-Cogl hollow 3-layer analytic SDF shadow and bevel rim finish for the
 * dock pill background. Allocates zero offscreen framebuffers and schedules
 * zero idle redraws.
 */
export const DockPillGlassEffect = GObject.registerClass({
    GTypeName: 'XDockPillGlassEffect',
}, class XDockPillGlassEffect extends Clutter.Effect {
    _init(params = {}) {
        super._init();
        this._cornerRadius = params.cornerRadius ?? 18;
        this._cornerExponent = params.cornerExponent ?? 3.0;
        this._context = null;
        this._shadow = null;
        this._rim = null;
        this._lastKey = null;
    }

    set cornerRadius(value) {
        if (this._cornerRadius === value)
            return;
        this._cornerRadius = value;
        this.queue_repaint();
    }

    get cornerRadius() {
        return this._cornerRadius;
    }

    set cornerExponent(value) {
        if (this._cornerExponent === value)
            return;
        this._cornerExponent = value;
        this.queue_repaint();
    }

    get cornerExponent() {
        return this._cornerExponent;
    }

    _ensurePipelines(context) {
        if (this._context === context && this._shadow && this._rim)
            return;
        this._shadow = buildPipeline(context, SHADOW_CODE);
        this._rim = buildPipeline(context, RIM_CODE);
        this._context = context;
        this._lastKey = null;
    }

    _getPad(actor) {
        const stage = actor?.get_stage();
        const scale = stage ? St.ThemeContext.get_for_stage(stage).scale_factor : 1;
        return Math.round(SHADOW_PAD_LOGICAL * scale);
    }

    vfunc_modify_paint_volume(volume) {
        const actor = this.get_actor();
        if (!actor)
            return super.vfunc_modify_paint_volume(volume);
        const pad = this._getPad(actor);
        const origin = volume.get_origin();
        const width = volume.get_width();
        const height = volume.get_height();
        volume.set_origin(new Graphene.Point3D({
            x: origin.x - pad,
            y: origin.y - pad,
            z: origin.z,
        }));
        volume.set_width(width + 2 * pad);
        volume.set_height(height + 2 * pad);
        return true;
    }

    vfunc_paint_node(node, paintContext, _flags) {
        const actor = this.get_actor();
        if (!actor || !actor.mapped) {
            if (actor)
                node.add_child(new Clutter.ActorNode(actor, -1));
            return;
        }
        const {width: w, height: h} = actor;
        const opacity = actor.get_paint_opacity() / 255;
        const fb = paintContext.get_framebuffer?.();
        const context = fb?.get_context?.();
        if (!context || w < 4 || h < 4 || opacity <= 0.005) {
            node.add_child(new Clutter.ActorNode(actor, -1));
            return;
        }

        const stage = actor.get_stage();
        const scale = stage ? St.ThemeContext.get_for_stage(stage).scale_factor : 1;
        const pad = Math.round(SHADOW_PAD_LOGICAL * scale);
        const rimIn = Math.round(RIM_INSET_LOGICAL * scale);
        const radius = Math.min(this._cornerRadius, Math.min(w, h) * 0.5);
        this._ensurePipelines(context);
        const key = `${w}|${h}|${pad}|${radius}|${this._cornerExponent}|${scale}|${opacity.toFixed(4)}`;
        if (this._lastKey !== key) {
            setUniforms(this._shadow, w, h, pad, radius, this._cornerExponent, scale, opacity);
            setUniforms(this._rim, w, h, pad, radius, this._cornerExponent, scale, opacity);
            this._lastKey = key;
        }

        const tw = w + 2 * pad;
        const th = h + 2 * pad;
        const emitQuad = (pNode, x1, y1, x2, y2) => {
            if (x2 <= x1 || y2 <= y1)
                return;
            pNode.add_texture_rectangle(
                new Clutter.ActorBox({x1, y1, x2, y2}),
                (x1 + pad) / tw, (y1 + pad) / th,
                (x2 + pad) / tw, (y2 + pad) / th
            );
        };

        const cr = Math.min(Math.ceil(radius) + 2, Math.floor(Math.min(w, h) * 0.5));

        // 1. Hollow 3-layer shadow strictly outside the pill behind the actor.
        const shadowNode = new Clutter.PipelineNode(this._shadow.pipeline);
        shadowNode.set_name('XDockPillShadow');
        emitQuad(shadowNode, -pad, -pad, w + pad, 0);
        emitQuad(shadowNode, -pad, h, w + pad, h + pad);
        emitQuad(shadowNode, -pad, 0, 0, h);
        emitQuad(shadowNode, w, 0, w + pad, h);
        if (cr > 0) {
            emitQuad(shadowNode, 0, 0, cr, cr);
            emitQuad(shadowNode, w - cr, 0, w, cr);
            emitQuad(shadowNode, 0, h - cr, cr, h);
            emitQuad(shadowNode, w - cr, h - cr, w, h);
        }
        node.add_child(shadowNode);

        // 2. Continue normal actor + blur painting inside the pill.
        node.add_child(new Clutter.ActorNode(actor, -1));

        // 3. Subtle bevel rim glint + 0.75pt dark outer contour strictly along perimeter.
        const rimNode = new Clutter.PipelineNode(this._rim.pipeline);
        rimNode.set_name('XDockPillRim');
        const outPad = Math.ceil(2 * scale);
        emitQuad(rimNode, -outPad, -outPad, w + outPad, rimIn);
        emitQuad(rimNode, -outPad, h - rimIn, w + outPad, h + outPad);
        emitQuad(rimNode, -outPad, rimIn, rimIn, h - rimIn);
        emitQuad(rimNode, w - rimIn, rimIn, w + outPad, h - rimIn);
        if (cr > rimIn) {
            emitQuad(rimNode, rimIn, rimIn, cr, cr);
            emitQuad(rimNode, w - cr, rimIn, w - rimIn, cr);
            emitQuad(rimNode, rimIn, h - cr, cr, h - rimIn);
            emitQuad(rimNode, w - cr, h - cr, w - rimIn, h - rimIn);
        }
        node.add_child(rimNode);
    }

    vfunc_set_actor(actor) {
        if (!actor) {
            this._context = null;
            this._shadow = null;
            this._rim = null;
            this._lastKey = null;
        }
        super.vfunc_set_actor(actor);
    }
});
