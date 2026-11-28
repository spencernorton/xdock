import {Clutter, GObject} from './dependencies/gi.js';
import {Main} from './dependencies/shell/ui.js';
import {AnimationUtils} from './dependencies/shell/misc.js';

import {animationsEnabled} from './animationSettings.js';

const DROP_DURATION = 250;

// Shell's DND searches with PickMode.ALL. Exclude the whole subtree so even
// a second drag can pick through a settling icon.
const DropLayer = GObject.registerClass(
class DropLayer extends Clutter.Actor {
    vfunc_pick() {}
});

export class IconDropAnimation {
    #layer = null;
    #timeline = null;
    #dockIcon = null;
    #onStopped = null;

    start(actor, getDestination, {drawer = false, onStopped = null} = {}) {
        this.cancel();
        if (!animationsEnabled() || actor?.get_parent() !== Main.uiGroup)
            return false;

        const duration = Math.round(AnimationUtils.adjustAnimationTime(DROP_DURATION));
        const [width, height] = actor.get_size();
        const paintedWidth = width * actor.scale_x;
        if (duration <= 0 || paintedWidth <= 0 || height <= 0)
            return false;

        // Motion and release can arrive together before Clutter reallocates
        // the drag sprite. Use its current position and pivot directly.
        const [actorX, actorY] = actor.get_position();
        const [pivotX, pivotY] = actor.get_pivot_point();
        const startX = actorX + actor.translation_x + width * (pivotX + (0.5 - pivotX) * actor.scale_x);
        const startY = actorY + actor.translation_y + height * (pivotY + (0.5 - pivotY) * actor.scale_y);
        const layer = new DropLayer({name: 'xdock-icon-drop', x: startX, y: startY});
        const timeline = new Clutter.Timeline({actor: layer, duration});
        this.#layer = layer;
        this.#timeline = timeline;
        this.#onStopped = onStopped;

        // An accepting target can take ownership of the drag sprite. Giving
        // it a new parent lets Shell finish the gesture and release its grab
        // while the exact same image keeps moving.
        actor.remove_all_transitions();
        Main.uiGroup.add_child(layer);
        Main.uiGroup.remove_child(actor);
        layer.add_child(actor);
        actor.set_position(actorX - startX, actorY - startY);

        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        timeline.connect('new-frame', () => {
            if (!animationsEnabled()) {
                this.cancel();
                return;
            }

            const destination = getDestination();
            // The dock's native favorites update and relayout may still be
            // queued. Keep the release pose until the actual slot is ready.
            if (!destination?.mapped || !destination.has_allocation())
                return;

            const {origin, size} = destination.get_transformed_extents();
            const progress = timeline.get_progress();
            const x = origin.x + size.width / 2;
            const y = origin.y + size.height / 2;
            const endScale = drawer ? 0.2 : size.width / paintedWidth;
            const scale = 1 + (endScale - 1) * progress;
            layer.set_translation((x - startX) * progress,
                (y - startY) * progress - 6 * Math.sin(Math.PI * progress), 0);
            layer.set_scale(scale, scale);

            // The drawer absorbs the thumbnail. On the dock, blend into the
            // real icon near the end and leave its running indicator alone.
            const fade = drawer ? progress ** 2 : Math.max(0, (progress - 0.85) / 0.15);
            layer.opacity = Math.round(255 * (1 - fade));
            if (!drawer)
                this.blendDockIcon(destination, fade);
        });
        timeline.connect('completed', () => this.cancel());
        timeline.start();
        return true;
    }

    blendDockIcon(icon, fade = 0) {
        if (this.#dockIcon?.actor !== icon) {
            this.#restoreDockIcon();
            const {opacity} = icon;
            const destroyId = icon.connect('destroy', () => {
                this.#dockIcon = null;
            });
            this.#dockIcon = {actor: icon, opacity, destroyId};
        }
        icon.opacity = Math.round(this.#dockIcon.opacity * fade);
    }

    #restoreDockIcon() {
        if (!this.#dockIcon)
            return;

        const {actor, opacity, destroyId} = this.#dockIcon;
        this.#dockIcon = null;
        actor.disconnect(destroyId);
        actor.opacity = opacity;
    }

    cancel() {
        if (!this.#timeline)
            return;

        const onStopped = this.#onStopped;
        this.#timeline.stop();
        this.#timeline = null;
        this.#layer.destroy();
        this.#layer = null;
        this.#restoreDockIcon();
        this.#onStopped = null;
        onStopped?.();
    }
}
