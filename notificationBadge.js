import {Atk, Clutter, GObject, St} from './dependencies/gi.js';
import {Extension} from './dependencies/shell/extensions/extension.js';
import {animationsEnabled} from './animationSettings.js';
import {isMailboxApp} from './appBadgeCounts.js';

const {gettext: __} = Extension;
const FLIP_HALF_TIME = 115;
const EDGE_OPACITY = 176;
const HINGE_OFFSET = 0.12;
const SETTLE_TIME = 190;
const EXIT_TIME = 150;

// The overlay has no preferred size and never enters picking, even when
// Shell's drag handler picks with PickMode.ALL.
const BadgeOverlay = GObject.registerClass(
class BadgeOverlay extends Clutter.Actor {
    _init(anchor, host) {
        super._init({x_expand: true, y_expand: true});
        this._anchor = anchor;
        this.add_child(host);
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_pick() {}

    vfunc_allocate(box) {
        this.set_allocation(box);
        const host = this.get_first_child();
        let left = 0;
        let top = 0;
        const container = this.get_parent();
        for (let actor = this._anchor; actor && actor !== container; actor = actor.get_parent()) {
            left += actor.allocation.x1;
            top += actor.allocation.y1;
        }
        const [, preferredWidth] = host.get_preferred_width(-1);
        const width = Math.min(preferredWidth, box.get_width());
        const [, preferredHeight] = host.get_preferred_height(width);
        const height = Math.min(preferredHeight, box.get_height());
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        const corner = rtl ? left : left + this._anchor.width - width;
        const x = Math.round(Math.max(0, Math.min(corner, box.get_width() - width)));
        const y = Math.round(Math.max(0, Math.min(top, box.get_height() - height)));
        host.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + width, y2: y + height}));
    }
});

export class NotificationBadge {
    constructor(source, counts, canAnimate = () => true) {
        this._source = source;
        this._counts = counts;
        this._canAnimate = canAnimate;
        this._id = source.app.get_id();
        this._count = 0;
        source._notificationBadge = this;
        this._mapId = source.connect('notify::mapped', () => this._syncMapped());
        this._destroyId = source.connect('destroy', () => this.destroy());
        this._syncMapped();
    }

    _syncMapped() {
        if (this._source.mapped) {
            // Updating the hidden face can invalidate the tile's allocation
            // until the next frame. Keep using the active flip in that gap.
            this._unsubscribe ??= this._counts.subscribe(this._id, (count, animate, style) =>
                this._setCount(count, animate && (this._flipping || this._canAnimate()), style));
        } else {
            this._unsubscribe?.();
            this._unsubscribe = null;
            this._count = 0;
            this._removeBadge();
        }
    }

    _createBadge() {
        this._pill = new St.Widget({
            style_class: `xdock-count-badge ${this._style}`,
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            accessible_role: Atk.Role.LABEL,
        });
        this._pill.set_pivot_point(0.5, 0.5);
        const createLabel = () => {
            const label = new St.Label({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                accessible_role: Atk.Role.REDUNDANT_OBJECT,
            });
            label.set_pivot_point(0.5, 0.5);
            return label;
        };
        this._front = createLabel();
        this._back = createLabel();
        this._pill.add_child(this._front);
        this._pill.add_child(this._back);
        this._host = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._host.add_child(this._pill);
        this._overlay = new BadgeOverlay(this._source.icon._iconBin, this._host);
        this._host.connect('notify::allocation', () => this.syncFloating());
        this._source._iconContainer.add_child(this._overlay);
        this.syncFloating();
    }

    _setCount(count, animate, style) {
        if (this._style !== style) {
            this._style = style;
            this._pill?.set_style_class_name(`xdock-count-badge ${style}`);
        }

        const previous = this._count;
        this._count = count;
        if (previous === count)
            return;

        const motion = animate && animationsEnabled();
        if (!count) {
            if (!this._pill)
                return;
            this._pill.remove_all_transitions();
            if (motion) {
                this._pill.ease({
                    opacity: 0, scale_x: 0.82, scale_y: 0.82, duration: EXIT_TIME,
                    mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                    onComplete: () => this._removeBadge(),
                });
            } else {
                this._removeBadge();
            }
            return;
        }

        const newBadge = !this._pill;
        if (newBadge)
            this._createBadge();
        const number = Math.min(count, 99).toLocaleString();
        const text = count > 99 ? __('%s+').format(number) : number;
        const fullCount = count.toLocaleString();
        let accessibleLabel = __('Notifications (%s)');
        if (this._source.app?.isTrash)
            accessibleLabel = __('Trash (%s)');
        else if (isMailboxApp(this._id))
            accessibleLabel = __('Unread mail (%s)');
        this._pill.accessible_name = accessibleLabel.format(fullCount);
        this._targetText = text;

        if (previous && text === this._front.text && (motion || !this._flipping))
            return;

        this._pill.remove_all_transitions();
        const mode = Clutter.AnimationMode.EASE_OUT_CUBIC;
        if (!motion || !previous) {
            for (const label of [this._front, this._back]) {
                label.remove_all_transitions();
                label.scale_y = 1;
            }
            this._flipping = false;
            this._paintedCount = count;
            this._front.opacity = 255;
            this._back.opacity = 0;
            this._front.text = text;
            this._back.text = '';
            if (motion && newBadge) {
                this._pill.opacity = 0;
                this._pill.set_scale(0.82, 0.82);
                this._pill.ease({
                    opacity: 255, scale_x: 1.06, scale_y: 1.06, duration: 110, mode,
                    onComplete: () => this._pill.ease({
                        scale_x: 1, scale_y: 1, duration: 80, mode,
                    }),
                });
                return;
            }
        } else {
            this._flipToLatest();
        }
        this._pill.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: motion ? SETTLE_TIME : 0, mode});
    }

    _flipToLatest() {
        if (this._flipping || !this._count || this._front.text === this._targetText)
            return;

        this._flipping = true;
        const outgoing = this._front;
        const incoming = this._back;
        // Project the turn locally so the edge stays thin even on a dock
        // at the edge of Shell's perspective-projected stage.
        const hinge = 0.5 + (this._count > this._paintedCount ? -HINGE_OFFSET : HINGE_OFFSET);
        incoming.text = this._targetText;
        outgoing.set_pivot_point(0.5, hinge);
        outgoing.ease({
            scale_y: 0, opacity: EDGE_OPACITY, duration: FLIP_HALF_TIME,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                // Swap faces edge-on. Use the newest count if several arrived
                // while the outgoing face was folding away.
                outgoing.opacity = 0;
                incoming.text = this._targetText;
                incoming.set_pivot_point(0.5, hinge);
                incoming.scale_y = 0;
                incoming.opacity = EDGE_OPACITY;
                [this._front, this._back] = [incoming, outgoing];
                if (this._count)
                    this._paintedCount = this._count;
                incoming.ease({
                    scale_y: 1, opacity: 255, duration: FLIP_HALF_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => {
                        outgoing.text = '';
                        this._flipping = false;
                        this._flipToLatest();
                    },
                });
            },
        });
    }

    syncFloating() {
        if (!this._overlay)
            return;

        const {_floatLayer: layer, _floatClone: icon} = this._source;
        const floating = !!layer?.visible;
        this._overlay.opacity = floating ? 0 : 255;
        if (!floating) {
            this._floatBadge?.hide();
            return;
        }
        if (!this._floatBadge) {
            this._floatBadge = new Clutter.Clone({source: this._host});
            this._floatBadge.connect('destroy', () => (this._floatBadge = null));
            layer.add_child(this._floatBadge);
        }
        const iconBin = this._source.icon._iconBin;
        const [px, py] = icon.get_pivot_point();
        const left = icon.translation_x + iconBin.width * px * (1 - icon.scale_x);
        const top = icon.translation_y + iconBin.height * py * (1 - icon.scale_y);
        const rtl = this._overlay.get_text_direction() === Clutter.TextDirection.RTL;
        const x = rtl ? left : left + iconBin.width * icon.scale_x - this._host.width;
        this._floatBadge.set_translation(x, top, 0);
        this._floatBadge.show();
    }

    _removeBadge() {
        this._flipping = false;
        this._floatBadge?.destroy();
        this._floatBadge = null;
        this._overlay?.destroy();
        this._overlay = this._host = this._pill = this._front = this._back = null;
    }

    destroy() {
        if (!this._source)
            return;
        this._source.disconnect(this._mapId);
        this._source.disconnect(this._destroyId);
        this._source._notificationBadge = null;
        this._source = null;
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._removeBadge();
    }
}
