// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Gio,
    GLib,
    GObject,
    Meta,
    Mtk,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    AppDisplay,
    AppFavorites,
    Dash,
    Main,
    PopupMenu,
} from './dependencies/shell/ui.js';

import {
    ParentalControlsManager,
    Util,
} from './dependencies/shell/misc.js';

import {
    AppIconIndicators,
    DBusMenuUtils,
    Docking,
    Locations,
    Motion,
    PopupMenuUtils,
    Theming,
    Utils,
    WindowPreview,
} from './imports.js';

import {Extension} from './dependencies/shell/extensions/extension.js';

// Use __ () and N__() for the extension gettext domain, and reuse
// the shell domain with the default _() and N_()
const {gettext: __, ngettext} = Extension;

const DBusMenu = await DBusMenuUtils.haveDBusMenu();

const tracker = Shell.WindowTracker.get_default();

const Labels = Object.freeze({
    ISOLATE_MONITORS: Symbol('isolate-monitors'),
    ISOLATE_WORKSPACES: Symbol('isolate-workspaces'),
    URGENT_WINDOWS: Symbol('urgent-windows'),
});

const clickAction = Object.freeze({
    SKIP: 0,
    MINIMIZE: 1,
    LAUNCH: 2,
    CYCLE_WINDOWS: 3,
    MINIMIZE_OR_OVERVIEW: 4,
    PREVIEWS: 5,
    MINIMIZE_OR_PREVIEWS: 6,
    FOCUS_OR_PREVIEWS: 7,
    FOCUS_OR_APP_SPREAD: 8,
    FOCUS_MINIMIZE_OR_PREVIEWS: 9,
    FOCUS_MINIMIZE_OR_APP_SPREAD: 10,
    QUIT: 11,
});

const scrollAction = Object.freeze({
    DO_NOTHING: 0,
    CYCLE_WINDOWS: 1,
    SWITCH_WORKSPACE: 2,
});

// module "Dash" did not export DASH_ITEM_LABEL_SHOW_TIME, so let's define it.
const DASH_ITEM_LABEL_SHOW_TIME = Dash.DASH_ITEM_LABEL_SHOW_TIME ?? 150;

// motion_ms.fast. Hover and press are direct answers to the pointer, so they
// take the shortest step on the scale; anything slower reads as lag rather
// than feedback.
const ICON_MOTION_TIME = 190;

// Which way "up" is for a lifted icon: away from the screen edge the dock is
// docked against. Lives here rather than in motion.js because this is the only
// side that knows St.Side, which keeps planIconMotion() testable under node.
// The launch bounce: a full hop clear of the dock and a smaller second one,
// measured in icon sizes so a large dock bounces as far as it looks like it
// should. Each rise is an enter (motion_ms.fast) and each fall an exit
// (motion_ms.standard), which is also the right physics -- you decelerate on
// the way up and accelerate on the way down.
const ICON_LAUNCH_HOPS = Object.freeze([
    Object.freeze({height: 0.6, rise: 190, fall: 250}),
    Object.freeze({height: 0.22, rise: 150, fall: 190}),
]);

const ICON_LIFT_VECTOR = Object.freeze({
    [St.Side.TOP]: [0, 1],
    [St.Side.BOTTOM]: [0, -1],
    [St.Side.LEFT]: [1, 0],
    [St.Side.RIGHT]: [-1, 0],
});

let recentlyClickedAppLoopId = 0;
let recentlyClickedApp = null;
let recentlyClickedAppWindows = null;
let recentlyClickedAppIndex = 0;
let recentlyClickedAppMonitor = -1;

/**
 * Extend AppIcon
 *
 * - Apply a css class based on the number of windows of each application (#N);
 * - Customized indicators for running applications in place of the default "dot" style which is hidden (#N);
 *   a class of the form "running#N" is applied to the AppWellIcon actor.
 *   like the original .running one.
 * - Add a .focused style to the focused app
 * - Customize click actions.
 * - Update minimization animation target
 * - Update menu if open on windows change
 */
// The icon's floating copy. Inside the dash, the scroll view crops anything
// that leaves the dock's allocation (measured with a real AppIcon in a bare
// St.ScrollView; the same bin freed to the ui group paints in full), so every
// effect that has to travel past the dock edge -- magnification, the launch
// bounce, the attention bounce -- paints from a copy in the ui group instead.
// The layer carries the launch bounce and the clone inside it carries the
// magnified scale and the attention bounce, so all three compose without two
// animations ever writing one property. Neither is an input surface: without
// the empty pick, DND's PickMode.ALL target search would find them.
const FloatLayer = GObject.registerClass(
class FloatLayer extends Clutter.Actor {
    vfunc_pick() {}
});

const FloatClone = GObject.registerClass(
class FloatClone extends Clutter.Clone {
    vfunc_pick() {}
});

export const DockAbstractAppIcon = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
    Properties: {
        'focused': GObject.ParamSpec.boolean(
            'focused', 'focused', 'focused',
            GObject.ParamFlags.READWRITE,
            false),
        'running': GObject.ParamSpec.boolean(
            'running', 'running', 'running',
            GObject.ParamFlags.READWRITE,
            false),
        'urgent': GObject.ParamSpec.boolean(
            'urgent', 'urgent', 'urgent',
            GObject.ParamFlags.READWRITE,
            false),
        'updating': GObject.ParamSpec.boolean(
            'updating', 'updating', 'updating',
            GObject.ParamFlags.READWRITE,
            false),
        'windows-count': GObject.ParamSpec.uint(
            'windows-count', 'windows-count', 'windows-count',
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXUINT32, 0),
    },
}, class DockAbstractAppIcon extends Dash.DashIcon {
    // settings are required inside.
    _init(app, monitorIndex, iconAnimator) {
        super._init(app);

        // a prefix is required to avoid conflicting with the parent class variable
        this.monitorIndex = monitorIndex;
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this.iconAnimator = iconAnimator;
        this._indicator = new AppIconIndicators.AppIconIndicator(this);
        this._urgentWindows = new Set();

        // Monitor windows-changes instead of app state.
        // Keep using the same Id and function callback (that is extended)
        if (this._stateChangedId > 0) {
            this.app.disconnect(this._stateChangedId);
            this._stateChangedId = 0;
        }

        this._signalsHandler.add(this.app, 'windows-changed', () => this._updateWindows());
        this._signalsHandler.add(this.app, 'notify::state', () => this._updateRunningState());
        this._signalsHandler.add(global.display, 'window-demands-attention', (_dpy, window) =>
            this._onWindowDemandsAttention(window));
        this._signalsHandler.add(global.display, 'window-marked-urgent', (_dpy, window) =>
            this._onWindowDemandsAttention(window));

        // In Wayland sessions, this signal is needed to track the state of windows dragged
        // from one monitor to another. As this is triggered quite often (whenever a new
        // window of any application opened or moved to a different desktop),
        // we restrict this signal to  the case when Labels.ISOLATE_MONITORS is true,
        // and if there are at least 2 monitors.
        if (Docking.DockManager.settings.isolateMonitors &&
            Main.layoutManager.monitors.length > 1) {
            this._signalsHandler.addWithLabel(Labels.ISOLATE_MONITORS,
                global.display,
                'window-entered-monitor',
                this._onWindowEntered.bind(this));
        }

        this.connect('notify::running', () => {
            if (this.running)
                this.add_style_class_name('running');
            else
                this.remove_style_class_name('running');
        });
        this.notify('running');

        this.connect('notify::focused', () => {
            if (this.focused)
                this.add_style_class_name('focused');
            else
                this.remove_style_class_name('focused');
        });
        this.notify('focused');

        this.connect('notify::updating', () => {
            if (this.updating)
                this.add_style_class_name('updating');
            else
                this.remove_style_class_name('updating');
        });
        this.notify('updating');

        this._magnifyScale = 1;
        this._floatLayer = null;
        this._floatClone = null;
        this._floatChain = [];
        this._floatChainToken = {};
        this.connect('destroy', () => {
            this._floatGone = true;
            this._disconnectFloatChain();
            this._floatLayer?.destroy();
            this._floatLayer = null;
            this._floatClone = null;
        });

        const {notificationsMonitor} = Docking.DockManager.getDefault();

        this.connect('notify::urgent', () => {
            // Bounces the floating clone (see FloatLayer), so the hop clears
            // the dock edge instead of being cropped by it, and the indicator
            // dots stay put under the icon the way a dock's do.
            this._signalsHandler.removeWithLabel(Labels.URGENT_WINDOWS);
            if (this.urgent) {
                if (Docking.DockManager.settings.danceUrgentApplications &&
                    notificationsMonitor.enabled && this._ensureFloat())
                    this.iconAnimator.addAnimation(this._floatClone, 'bounce');

                if (this.running && !this._urgentWindows.size) {
                    const urgentWindows = this.getInterestingWindows();
                    urgentWindows.forEach(w => (w._manualUrgency = true));
                    this._updateUrgentWindows(urgentWindows);
                }
            } else if (this._floatClone) {
                this.iconAnimator.removeAnimation(this._floatClone, 'bounce');
                this._floatClone.translation_x = 0;
                this._floatClone.translation_y = 0;
            }
            if (!this.urgent) {
                this._urgentWindows.forEach(w => delete w._manualUrgency);
                this._updateUrgentWindows();
            }
        });
        this.notify('urgent');

        // Hover and press feedback. This transforms this.icon._iconBin -- a
        // DESCENDANT of the reactive St.Button -- and never the button itself
        // or its DashItemContainer. That distinction is the whole feature:
        // measured on Clutter 18, a fixed stage point picked a DIFFERENT icon
        // once the reactive actor was translated or scaled, while the same
        // transform on a non-reactive child left picking exactly where the
        // layout put it. Transforming the reactive side is what made an
        // earlier hover-magnification prototype tremble, mis-target and fight
        // its own leave handler. _iconBin is upstream-private, but the urgent
        // wiggle above already depends on it, so this adds no new coupling --
        // and it uses the same (0.5, 0.5) pivot, so the two never fight over
        // it.
        //
        // Driven off St.Button's own `hover` and `pressed` properties rather
        // than button-press/release events: measured here, St.Button claims the
        // press through a Clutter 18 gesture, so `button-release-event` never
        // reaches a handler on the actor and the icon stayed shrunk after every
        // click. The properties are maintained by St.Button whatever route the
        // events take, including when a press turns into a drag.
        this._signalsHandler.add(this, 'notify::hover', () => this._updateIconMotion());
        this._signalsHandler.add(this, 'notify::pressed', () => this._updateIconMotion());

        this._progressOverlayArea = null;
        this._progress = 0;

        [
            'apply-custom-theme',
            'running-indicator-style',
            'show-icons-emblems',
            'show-icons-notifications-counter',
            'application-counter-overrides-notifications',
        ].forEach(key => {
            this._signalsHandler.add(
                Docking.DockManager.settings,
                `changed::${key}`, () => {
                    this._indicator.destroy();
                    this._indicator = new AppIconIndicators.AppIconIndicator(this);
                }
            );
        });

        this._signalsHandler.add(notificationsMonitor, 'state-changed', () => {
            this._indicator.destroy();
            this._indicator = new AppIconIndicators.AppIconIndicator(this);
        });

        this._updateState();
        this._numberOverlay();

        this._previewMenuManager = null;
        this._previewMenu = null;
    }

    // The inherited animateLaunch() is GNOME's OVERVIEW feedback: it clones the
    // icon, scales the clone up and fades it out. In the overview the original
    // is going away, so that reads correctly; on a dock the icon stays exactly
    // where it is, so the same animation reads as the icon vanishing rather
    // than as the app starting. A bounce is the dock idiom, and it falls out
    // of the motion tokens exactly -- no overshoot curve, so no
    // motion-exception.
    //
    // Bounces the float layer: the icon has to clear the dock to read as a
    // launch, and only the floating copy can leave the dock (see FloatLayer).
    // The indicator dots stay in the dock, so the icon hops over them.
    animateLaunch() {
        // Reduced motion gets no bounce at all rather than an instant one: a
        // bounce with no duration is not feedback, it is a no-op with extra
        // steps.
        if (!St.Settings.get().enable_animations || !this._ensureFloat())
            return;

        // The label sits just past the (possibly magnified) icon, right where
        // the bounce goes; the click has already answered what it said.
        this.get_parent()?.hideLabel?.();

        const layer = this._floatLayer;
        const [dx, dy] = ICON_LIFT_VECTOR[Utils.getPosition()] ??
            ICON_LIFT_VECTOR[St.Side.BOTTOM];
        const size = this.icon.iconSize || this.icon._iconBin.height;

        // A second launch mid-bounce restarts from wherever the icon currently
        // is. remove_all_transitions() suppresses the old arc's onComplete, so
        // two arcs cannot both be scheduling the next leg.
        layer.remove_all_transitions();
        const hop = index => {
            const leg = ICON_LAUNCH_HOPS[index];
            if (!leg)
                return;
            layer.ease({
                translation_x: leg.height * size * dx,
                translation_y: leg.height * size * dy,
                duration: leg.rise,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => layer.ease({
                    translation_x: 0,
                    translation_y: 0,
                    duration: leg.fall,
                    mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                    onComplete: () => hop(index + 1),
                }),
            });
        };
        hop(0);
    }

    // Magnification (dash.js) sets the scale; the floating clone paints it,
    // pivoted on the screen-edge side so growth spills towards the screen
    // interior. The scale arrives already eased at the pointer, so there is
    // nothing to tween here.
    setMagnifyScale(scale) {
        if (this._floatGone || scale === this._magnifyScale)
            return;
        this._magnifyScale = scale;
        if (scale > 1)
            this._ensureFloat();
        this._syncFloat();
    }

    _ensureFloat() {
        const iconBin = this._floatGone ? null : this.icon?._iconBin;
        if (!iconBin)
            return null;
        if (this._floatLayer)
            return this._floatLayer;

        this._floatLayer = new FloatLayer({reactive: false, visible: false});
        this._floatClone = new FloatClone({source: iconBin, reactive: false});
        this._floatLayer.add_child(this._floatClone);
        Main.uiGroup.add_child(this._floatLayer);

        // The animations write these; floating starts and ends with them.
        const sync = () => this._syncFloat();
        this._floatLayer.connectObject(
            'notify::translation-x', sync,
            'notify::translation-y', sync, this);
        this._floatClone.connectObject(
            'notify::translation-x', sync,
            'notify::translation-y', sync, this);
        // The chain can only reach the stage once the icon is in the dock.
        this.connectObject('notify::mapped', () => this._connectFloatChain(), this);
        this._connectFloatChain();
        return this._floatLayer;
    }

    // The copy follows the bin through every layout change between it and the
    // ui group: magnification widening its neighbours, the dock re-centring
    // as it grows, the dock sliding in and out. Allocation notifications fire
    // inside the layout pass, so the position is current for the frame being
    // painted rather than one frame late (the earlier BEFORE_REDRAW hook ran
    // before relayout and left every clone where the previous frame had it).
    _connectFloatChain() {
        this._disconnectFloatChain();
        const iconBin = this.icon?._iconBin;
        const sync = () => this._syncFloat();
        for (let actor = iconBin; actor && actor !== Main.uiGroup; actor = actor.get_parent()) {
            actor.connectObject(
                'notify::allocation', sync,
                'notify::translation-x', sync,
                'notify::translation-y', sync,
                'notify::scale-x', sync, this._floatChainToken);
            this._floatChain.push(actor);
        }
        this._syncFloat();
    }

    _disconnectFloatChain() {
        for (const actor of this._floatChain)
            actor.disconnectObject(this._floatChainToken);
        this._floatChain = [];
    }

    // Just above the dock, so the copy paints over the dock's own background
    // (and is not blurred into it), with the label above the copy. Checked
    // each time the copy appears: the dock can be restacked in between.
    _stackFloat() {
        let dock = this;
        while (dock && dock.get_parent() !== Main.uiGroup)
            dock = dock.get_parent();
        if (!dock)
            return;
        Main.uiGroup.set_child_above_sibling(this._floatLayer, dock);
        const label = this.get_parent()?.label;
        if (label?.get_parent() === Main.uiGroup)
            Main.uiGroup.set_child_above_sibling(label, this._floatLayer);
    }

    _syncFloat() {
        const layer = this._floatLayer;
        const clone = this._floatClone;
        const iconBin = this._floatGone ? null : this.icon?._iconBin;
        if (!layer || !iconBin)
            return;

        const floating = this.mapped && (this._magnifyScale > 1 ||
            layer.translation_x !== 0 || layer.translation_y !== 0 ||
            clone.translation_x !== 0 || clone.translation_y !== 0);
        if (floating !== layer.visible) {
            if (floating)
                this._stackFloat();
            layer.visible = floating;
            // Hides the bin and its tile background together; the background
            // left in the dock would read as an empty slot under the floating
            // icon. Opacity rather than a style change: a new style starts a
            // theme transition that keeps repainting after the bounce ends.
            // The clone paints the bin at its own opacity, so it is unaffected.
            this.icon.opacity = floating ? 0 : 255;
        }
        this.get_parent()?.syncLabelPosition?.();
        if (!floating)
            return;

        // Rest position of the bin. Its own hover/press transform is applied
        // to the clone below rather than read back through the stage, where
        // it would count twice.
        const [parentX, parentY] = iconBin.get_parent().get_transformed_position();
        const box = iconBin.get_allocation_box();
        layer.set_position(
            parentX + box.x1 + iconBin.translation_x,
            parentY + box.y1 + iconBin.translation_y);

        const [dx, dy] = ICON_LIFT_VECTOR[Utils.getPosition()] ??
            ICON_LIFT_VECTOR[St.Side.BOTTOM];
        const scale = this._magnifyScale * iconBin.scale_x;
        clone.set_pivot_point(0.5 - dx / 2, 0.5 - dy / 2);
        if (clone.scale_x !== scale)
            clone.set_scale(scale, scale);
    }

    _updateIconMotion() {
        const iconBin = this.icon?._iconBin;
        if (!iconBin)
            return;

        // Magnification already answers hover, so while it is on only the
        // press shrink plays; the floating clone multiplies it into the
        // magnified scale (see _syncFloat).
        const {settings} = Docking.DockManager;
        const magnifying = settings.magnifyIcons && !settings.iconSizeFixed;
        const {scale, lift} = Motion.planIconMotion({
            hovered: this.hover && !magnifying,
            pressed: this.pressed,
        });
        const [dx, dy] = ICON_LIFT_VECTOR[Utils.getPosition()] ??
            ICON_LIFT_VECTOR[St.Side.BOTTOM];
        // motion_easing is reversible: taking on a state is an enter, returning
        // to rest is an exit.
        const resting = scale === 1 && lift === 0;

        iconBin.set_pivot_point(0.5, 0.5);
        iconBin.ease({
            scale_x: scale,
            scale_y: scale,
            translation_x: lift * dx,
            translation_y: lift * dy,
            // ease() applies Shell's slow-down factor itself; only the reduced
            // motion case zeroes the base duration (motion_ms.reduced).
            duration: St.Settings.get().enable_animations ? ICON_MOTION_TIME : 0,
            mode: resting
                ? Clutter.AnimationMode.EASE_IN_CUBIC
                : Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _onDestroy() {
        super._onDestroy();

        // This is necessary due to an upstream bug
        // https://bugzilla.gnome.org/show_bug.cgi?id=757556
        // It can be safely removed once it get solved upstream.
        if (this._menu)
            PopupMenuUtils.close(this._menu, {animate: false});
        delete this._menu;
    }

    ownsWindow(window) {
        return this.app === tracker.get_window_app(window);
    }

    _onWindowEntered(metaScreen, monitorIndex, metaWin) {
        if (this.ownsWindow(metaWin))
            this._updateWindows();
    }

    vfunc_scroll_event(scrollEvent) {
        const {settings} = Docking.DockManager;
        const isEnabled = settings.scrollAction === scrollAction.CYCLE_WINDOWS;
        if (!isEnabled)
            return Clutter.EVENT_PROPAGATE;

        // We only activate windows of running applications, i.e. we never open new windows
        // We check if the app is running, and that the # of windows is > 0 in
        // case we use workspace isolation,
        if (!this.running)
            return Clutter.EVENT_PROPAGATE;

        if (this._optionalScrollCycleWindowsDeadTimeId) {
            return Clutter.EVENT_PROPAGATE;
        } else {
            this._optionalScrollCycleWindowsDeadTimeId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 250, () => {
                    this._optionalScrollCycleWindowsDeadTimeId = 0;
                });
        }

        let direction = null;

        switch (scrollEvent.direction) {
        case Clutter.ScrollDirection.UP:
            direction = Meta.MotionDirection.UP;
            break;
        case Clutter.ScrollDirection.DOWN:
            direction = Meta.MotionDirection.DOWN;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = Clutter.get_current_event().get_scroll_delta();
            if (dy < 0)
                direction = Meta.MotionDirection.UP;
            else if (dy > 0)
                direction = Meta.MotionDirection.DOWN;
        }
            break;
        }

        if (!Main.overview.visible) {
            const reversed = direction === Meta.MotionDirection.UP;
            if (this.focused && !this._urgentWindows.size) {
                this._cycleThroughWindows(reversed);
            } else {
                // Activate the first window
                const windows = this.getInterestingWindows();
                if (windows.length > 0) {
                    const [w] = windows;
                    Main.activateWindow(w);
                }
            }
        } else {
            this.app.activate();
        }
        return Clutter.EVENT_STOP;
    }

    _updateWindows() {
        if (this._menu && this._menu.isOpen)
            this._menu.update();

        this._updateState();
        this.updateIconGeometry();
    }

    _updateState() {
        this._urgentWindows.clear();
        const interestingWindows = this.getInterestingWindows();
        this.windowsCount = interestingWindows.length;
        this._updateRunningState();
        this._updateFocusState();
        this._updateUrgentWindows(interestingWindows);

        if (Docking.DockManager.settings.isolateWorkspaces) {
            this._signalsHandler.removeWithLabel(Labels.ISOLATE_WORKSPACES);
            interestingWindows.forEach(window =>
                this._signalsHandler.addWithLabel(Labels.ISOLATE_WORKSPACES,
                    window, 'workspace-changed', () => this._updateWindows()));
        }
    }

    _updateRunningState() {
        this.running = (this.app.state === Shell.AppState.RUNNING) && this.windowsCount;
    }

    _updateFocusState() {
        this.focused = tracker.focus_app === this.app && this.running;
    }

    _updateUrgentWindows(interestingWindows) {
        this._signalsHandler.removeWithLabel(Labels.URGENT_WINDOWS);
        this._urgentWindows.clear();
        if (interestingWindows === undefined)
            interestingWindows = this.getInterestingWindows();
        interestingWindows.filter(isWindowUrgent).forEach(win => this._addUrgentWindow(win));
        this.urgent = !!this._urgentWindows.size;
    }

    _onWindowDemandsAttention(window) {
        if (this.ownsWindow(window) && isWindowUrgent(window))
            this._addUrgentWindow(window);
    }

    _updateDotStyle() {
        super._updateDotStyle();
        const themeNode = this._dot.get_theme_node();
        this._dot.translationX = themeNode.get_length('offset-x');
        this._dot.translationY = 0;
    }

    _addUrgentWindow(window) {
        if (this._urgentWindows.has(window))
            return;

        if (window._manualUrgency && window.has_focus()) {
            delete window._manualUrgency;
            return;
        }

        this._urgentWindows.add(window);
        this.urgent = true;

        const onDemandsAttentionChanged = () => {
            if (!isWindowUrgent(window))
                this._updateUrgentWindows();
        };

        if (window.demandsAttention) {
            this._signalsHandler.addWithLabel(Labels.URGENT_WINDOWS, window,
                'notify::demands-attention', () => onDemandsAttentionChanged());
        }
        if (window.urgent) {
            this._signalsHandler.addWithLabel(Labels.URGENT_WINDOWS, window,
                'notify::urgent', () => onDemandsAttentionChanged());
        }
        if (window._manualUrgency) {
            this._signalsHandler.addWithLabel(Labels.URGENT_WINDOWS, window,
                'focus', () => {
                    delete window._manualUrgency;
                    onDemandsAttentionChanged();
                });
        }
    }

    /**
     * Update target for minimization animation
     */
    updateIconGeometry() {
        // If (for unknown reason) the actor is not on the stage the reported size
        // and position are random values, which might exceeds the integer range
        // resulting in an error when assigned to the a rect. This is a more like
        // a workaround to prevent flooding the system with errors.
        if (!this.get_stage())
            return;

        const rect = new Mtk.Rectangle();

        [rect.x, rect.y] = this.get_transformed_position();
        [rect.width, rect.height] = this.get_transformed_size();

        let windows = this.getWindows();
        if (Docking.DockManager.settings.multiMonitor) {
            const {monitorIndex} = this;
            windows = windows.filter(w => w.get_monitor() === monitorIndex);
        }
        windows.forEach(w => w.set_icon_geometry(rect));
    }

    _updateRunningStyle() {
        // The logic originally in this function has been moved to
        // AppIconIndicatorBase._updateDefaultDot(). However it cannot be removed as
        // it called by the parent constructor.
    }

    notifyAppIconUpdating(monitorIndex) {
        const icon = Gio.Icon.new_for_string('action-unavailable-symbolic');
        const {osdWindowManager} = Main;
        const showOsd = osdWindowManager.showOne ?? osdWindowManager.show;
        showOsd.call(osdWindowManager, monitorIndex ?? this.monitorIndex, icon,
            _('%s is updating, try again later').format(this.name), null);
    }

    popupMenu() {
        this._removeMenuTimeout?.();
        this.fake_release();
        this._draggable.fakeRelease?.();

        if (!this._menu) {
            this._menu = new DockAppIconMenu(this);
            this._menu.connect('activate-window', (menu, window) => {
                if (window) {
                    Main.activateWindow(window);
                } else {
                    Main.overview.hide();
                    Main.panel.closeCalendar();
                }
            });
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp) {
                    this._onMenuPoppedDown();
                } else {
                    // Setting the max-height is s useful if part of the menu is
                    // scrollable so the minimum height is smaller than the natural height.
                    const monitorIndex = Main.layoutManager.findIndexForActor(this);
                    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
                    const position = Utils.getPosition();
                    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
                    const isHorizontal = position === St.Side.TOP || position === St.Side.BOTTOM;
                    // If horizontal also remove the height of the dash
                    const {dockFixed: fixedDock} = Docking.DockManager.settings;
                    const additionalMargin = isHorizontal && !fixedDock ? Main.overview.dash.height : 0;
                    const verticalMargins = this._menu.actor.margin_top + this._menu.actor.margin_bottom;
                    const maxMenuHeight = workArea.height - additionalMargin - verticalMargins;
                    // Also set a max width to the menu, so long labels (long windows title) get truncated
                    this._menu.actor.style = 'max-width: 400px; ' +
                        `max-height: ${Math.round(maxMenuHeight / scaleFactor)}px;`;
                }
            });
            const id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this._menu.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.set_hover(true);
        this._menu.popup();
        // Removed in GNOME 50.
        this._menuManager.ignoreRelease?.();
        this.emit('sync-tooltip');

        return false;
    }

    activate(button) {
        const event = Clutter.get_current_event();
        let modifiers = event ? event.get_state() : 0;

        // Only consider SHIFT and CONTROL as modifiers (exclude SUPER, CAPS-LOCK, etc.)
        modifiers &= Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK;

        // We don't change the CTRL-click behavior: in such case we just chain
        // up the parent method and return.
        if (modifiers & Clutter.ModifierType.CONTROL_MASK) {
            // Keep default behavior: launch new window
            // By calling the parent method I make it compatible
            // with other extensions tweaking ctrl + click
            super.activate(button);
            return;
        }

        // We check what type of click we have and if the modifier SHIFT is
        // being used. We then define what buttonAction should be for this
        // event.
        let buttonAction = 0;
        const {settings} = Docking.DockManager;
        if (button && button === 2) {
            if (modifiers & Clutter.ModifierType.SHIFT_MASK)
                buttonAction = settings.shiftMiddleClickAction;
            else
                buttonAction = settings.middleClickAction;
        } else if (button && button === 1) {
            if (modifiers & Clutter.ModifierType.SHIFT_MASK)
                buttonAction = settings.shiftClickAction;
            else
                buttonAction = settings.clickAction;
        }

        switch (buttonAction) {
        case clickAction.FOCUS_OR_APP_SPREAD:
            if (!Docking.DockManager.getDefault().appSpread.supported)
                buttonAction = clickAction.FOCUS_OR_PREVIEWS;
            break;

        case clickAction.FOCUS_MINIMIZE_OR_APP_SPREAD:
            if (!Docking.DockManager.getDefault().appSpread.supported)
                buttonAction = clickAction.FOCUS_MINIMIZE_OR_PREVIEWS;
            break;
        }

        // We check if the app is running, and that the # of windows is > 0 in
        // case we use workspace isolation.
        const windows = this.getInterestingWindows();

        // Some action modes (e.g. MINIMIZE_OR_OVERVIEW) require overview to remain open
        // This variable keeps track of this
        let shouldHideOverview = true;

        // We customize the action only when the application is already running
        if (this.running) {
            const hasUrgentWindows = !!this._urgentWindows.size;
            const singleOrUrgentWindows = windows.length === 1 || hasUrgentWindows;
            switch (buttonAction) {
            case clickAction.MINIMIZE:
                // In overview just activate the app, unless the action is explicitly
                // requested with a keyboard modifier
                if (!Main.overview.visible || modifiers) {
                    // If we have button=2 or a modifier, allow minimization even if
                    // the app is not focused
                    if (this.focused && !hasUrgentWindows || button === 2 ||
                        modifiers & Clutter.ModifierType.SHIFT_MASK) {
                        // minimize all windows on double click and always in
                        // the case of primary click without additional modifiers
                        let clickCount = 0;
                        if (event?.type() === Clutter.EventType.BUTTON_PRESS)
                            clickCount = event.get_click_count();
                        const allWindows = (button === 1 && !modifiers) || clickCount > 1;
                        this._minimizeWindow(allWindows);
                    } else {
                        this._activateAllWindows();
                    }
                } else {
                    const [w] = windows;
                    Main.activateWindow(w);
                }
                break;

            case clickAction.MINIMIZE_OR_OVERVIEW:
                // When a single window is present, toggle minimization
                // If only one windows is present toggle minimization, but
                // only when triggered with the simple click action
                // (no modifiers, no middle click).
                if (singleOrUrgentWindows && !modifiers && button === 1) {
                    const [w] = windows;
                    if (this.focused) {
                        if (buttonAction !== clickAction.FOCUS_OR_APP_SPREAD) {
                            // Window is raised, minimize it
                            this._minimizeWindow(w);
                        }
                    } else {
                        // Window is minimized, raise it
                        Main.activateWindow(w);
                    }
                    // Launch overview when multiple windows are present
                    // TODO: only show current app windows when gnome shell API will allow it
                } else {
                    shouldHideOverview = false;
                    Main.overview.toggle();
                }
                break;

            case clickAction.CYCLE_WINDOWS:
                if (!Main.overview.visible) {
                    if (this.focused && !hasUrgentWindows) {
                        this._cycleThroughWindows();
                    } else {
                        // Activate the first window
                        const [w] = windows;
                        Main.activateWindow(w);
                    }
                } else {
                    this.app.activate();
                }
                break;

            case clickAction.FOCUS_OR_PREVIEWS:
                if (this.focused && !hasUrgentWindows &&
                    (windows.length > 1 || modifiers || button !== 1)) {
                    this._windowPreviews();
                } else {
                    // Activate the first window
                    const [w] = windows;
                    Main.activateWindow(w);
                }
                break;

            case clickAction.FOCUS_MINIMIZE_OR_PREVIEWS:
                if (this.focused && !hasUrgentWindows) {
                    if (windows.length > 1 || modifiers || button !== 1)
                        this._windowPreviews();
                    else if (!Main.overview.visible)
                        this._minimizeWindow();
                } else {
                    // Activate the first window
                    const [w] = windows;
                    Main.activateWindow(w);
                }
                break;

            case clickAction.LAUNCH:
                this.launchNewWindow();
                break;

            case clickAction.PREVIEWS:
                if (!Main.overview.visible) {
                    // If only one windows is present just switch to it,
                    // but only when triggered with the simple click action
                    // (no modifiers, no middle click).
                    if (singleOrUrgentWindows && !modifiers && button === 1) {
                        const [w] = windows;
                        Main.activateWindow(w);
                    } else {
                        this._windowPreviews();
                    }
                } else {
                    this.app.activate();
                }
                break;

            case clickAction.MINIMIZE_OR_PREVIEWS:
                // When a single window is present, toggle minimization
                // If only one windows is present toggle minimization, but only
                // when triggered with the standard click action (no modifiers,
                // no middle click).
                if (!Main.overview.visible) {
                    if (singleOrUrgentWindows && !modifiers && button === 1) {
                        const [w] = windows;
                        if (this.focused) {
                            // Window is raised, minimize it
                            this._minimizeWindow(w);
                        } else {
                            // Window is minimized, raise it
                            Main.activateWindow(w);
                        }
                    } else {
                        // Launch previews when multiple windows are present
                        this._windowPreviews();
                    }
                } else {
                    this.app.activate();
                }
                break;

            case clickAction.FOCUS_OR_APP_SPREAD:
                if (this.focused && !singleOrUrgentWindows && !modifiers && button === 1) {
                    shouldHideOverview = false;
                    Docking.DockManager.getDefault().appSpread.toggle(this.app);
                } else {
                    // Activate the first window
                    Main.activateWindow(windows[0]);
                }
                break;

            case clickAction.FOCUS_MINIMIZE_OR_APP_SPREAD:
                if (this.focused && !singleOrUrgentWindows && !modifiers && button === 1) {
                    shouldHideOverview = false;
                    Docking.DockManager.getDefault().appSpread.toggle(this.app);
                } else if (!this.focused) {
                    // Activate the first window
                    Main.activateWindow(windows[0]);
                } else {
                    this._minimizeWindow();
                }
                break;

            case clickAction.QUIT:
                this.closeAllWindows();
                break;

            case clickAction.SKIP:
                Main.activateWindow(windows[0]);
                break;
            }
        } else {
            this.launchNewWindow();
        }

        // Hide overview except when action mode requires it
        if (shouldHideOverview)
            Main.overview.hide();
    }

    shouldShowTooltip() {
        return super.shouldShowTooltip() && !this._previewMenu?.isOpen &&
            !Docking.DockManager.settings.hideTooltip;
    }

    _windowPreviews() {
        if (!this._previewMenu) {
            this._previewMenuManager = new PopupMenu.PopupMenuManager(this);

            this._previewMenu = new WindowPreview.WindowPreviewMenu(this);

            this._previewMenuManager.addMenu(this._previewMenu);

            this._previewMenu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            const id = Main.overview.connect('hiding', () => {
                this._previewMenu.close();
            });
            this._previewMenu.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });
        }

        this.emit('menu-state-changed', !this._previewMenu.isOpen);

        if (this._previewMenu.isOpen)
            this._previewMenu.close();
        else
            this._previewMenu.popup();

        return false;
    }

    // Try to do the right thing when attempting to launch a new window of an app. In
    // particular, if the application doesn't allow to launch a new window, activate
    // the existing window instead.
    launchNewWindow() {
        if (this.updating) {
            this.notifyAppIconUpdating();
            return;
        }

        if (this.app.state === Shell.AppState.RUNNING &&
            this.app.can_open_new_window()) {
            this.animateLaunch();
            this.app.open_new_window(-1);
        } else {
            // Try to manually activate the first window. Otherwise, when the
            // app is activated by switching to a different workspace, a launch
            // spinning icon is shown and disappears only after a timeout.
            const windows = this.getWindows();
            if (windows.length > 0) {
                Main.activateWindow(windows[0]);
            } else {
                this.app.activate();
                this.animateLaunch();
            }
        }
    }

    _numberOverlay() {
        // Add label for a Hot-Key visual aid
        this._numberOverlayLabel = new St.Label();
        this._numberOverlayBin = new St.Bin({
            child: this._numberOverlayLabel,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            x_expand: true, y_expand: true,
        });
        this._numberOverlayLabel.add_style_class_name('number-overlay');
        this._numberOverlayOrder = -1;
        this._numberOverlayBin.hide();

        this._iconContainer.add_child(this._numberOverlayBin);
    }

    updateNumberOverlay() {
        // We apply an overall scale factor that might come from a HiDPI monitor.
        // Clutter dimensions are in physical pixels, but CSS measures are in logical
        // pixels, so make sure to consider the scale.
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Set the font size to something smaller than the whole icon so it is
        // still visible. The border radius is large to make the shape circular
        const [minWidth_, natWidth] = this._iconContainer.get_preferred_width(-1);
        const fontSize = Math.round(Math.max(12, 0.3 * natWidth) / scaleFactor);
        const size = Math.round(fontSize * 1.2);
        this._numberOverlayLabel.set_style(
            `font-size: ${fontSize}px;` +
           `border-radius: ${this.icon.iconSize}px;` +
           `width: ${size}px; height: ${size}px;`
        );
    }

    setNumberOverlay(number) {
        this._numberOverlayOrder = number;
        this._numberOverlayLabel.set_text(number.toString());
    }

    toggleNumberOverlay(activate) {
        if (activate && this._numberOverlayOrder > -1) {
            this.updateNumberOverlay();
            this._numberOverlayBin.show();
        } else {
            this._numberOverlayBin.hide();
        }
    }

    _minimizeWindow(param) {
        // Param true make all app windows minimize
        const windows = this.getInterestingWindows();
        const currentWorkspace = global.workspace_manager.get_active_workspace();
        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            if (w.get_workspace() === currentWorkspace && w.showing_on_its_workspace()) {
                w.minimize();
                // Just minimize one window. By specification it should be the
                // focused window on the current workspace.
                if (!param)
                    break;
            }
        }
    }

    // By default only non minimized windows are activated.
    // This activates all windows in the current workspace.
    _activateAllWindows() {
        // First activate first window so workspace is switched if needed.
        // We don't do this if isolation is on!
        if (!Docking.DockManager.settings.isolateWorkspaces &&
            !Docking.DockManager.settings.isolateMonitors) {
            if (!this.running)
                this.animateLaunch();
            this.app.activate();
        }

        // then activate all other app windows in the current workspace
        const windows = this.getInterestingWindows();
        const activeWorkspace = global.workspace_manager.get_active_workspace_index();

        if (windows.length <= 0)
            return;

        for (let i = windows.length - 1; i >= 0; i--) {
            if (windows[i].get_workspace()?.index() === activeWorkspace)
                Main.activateWindow(windows[i]);
        }
    }

    // This closes all windows of the app.
    closeAllWindows() {
        const windows = this.getInterestingWindows();
        const time = global.get_current_time();
        windows.forEach(w => w.delete(time));
    }

    _cycleThroughWindows(reversed) {
        // Store for a little amount of time last clicked app and its windows
        // since the order changes upon window interaction
        const MEMORY_TIME = 3000;

        const appWindows = this.getInterestingWindows();

        if (appWindows.length < 1)
            return;

        if (recentlyClickedAppLoopId > 0)
            GLib.source_remove(recentlyClickedAppLoopId);
        recentlyClickedAppLoopId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, MEMORY_TIME, this._resetRecentlyClickedApp);

        // If there isn't already a list of windows for the current app,
        // or the stored list is outdated, use the current windows list.
        const monitorIsolation = Docking.DockManager.settings.isolateMonitors;
        if (!recentlyClickedApp ||
            recentlyClickedApp.get_id() !== this.app.get_id() ||
            recentlyClickedAppWindows.length !== appWindows.length ||
            (recentlyClickedAppMonitor !== this.monitorIndex && monitorIsolation)) {
            recentlyClickedApp = this.app;
            recentlyClickedAppWindows = appWindows;
            recentlyClickedAppMonitor = this.monitorIndex;
            recentlyClickedAppIndex = 0;
        }

        if (reversed) {
            recentlyClickedAppIndex--;
            if (recentlyClickedAppIndex < 0)
                recentlyClickedAppIndex = recentlyClickedAppWindows.length - 1;
        } else {
            recentlyClickedAppIndex++;
        }
        const index = recentlyClickedAppIndex % recentlyClickedAppWindows.length;
        const window = recentlyClickedAppWindows[index];

        Main.activateWindow(window);
    }

    _resetRecentlyClickedApp() {
        if (recentlyClickedAppLoopId > 0)
            GLib.source_remove(recentlyClickedAppLoopId);
        recentlyClickedAppLoopId = 0;
        recentlyClickedApp = null;
        recentlyClickedAppWindows = null;
        recentlyClickedAppIndex = 0;
        recentlyClickedAppMonitor = -1;

        return false;
    }

    getWindows() {
        return this.app.get_windows();
    }

    // Filter out unnecessary windows, for instance
    // nautilus desktop window.
    getInterestingWindows() {
        const interestingWindows = getInterestingWindows(this.getWindows(),
            this.monitorIndex);

        if (!this._urgentWindows.size)
            return interestingWindows;

        return [...new Set([...this._urgentWindows, ...interestingWindows])];
    }

    getSnapName() {
        return this.app.appInfo?.get_string('X-SnapInstanceName');
    }
});

const DockAppIcon = GObject.registerClass({
}, class DockAppIcon extends DockAbstractAppIcon {
    // Marks a source actor DockAppIconMenu may offer favourite and app-details
    // actions for. This was previously spelled `instanceof DockAppIcon`, which
    // correctly excluded DockLocationAppIcon (a mounted volume is not pinnable)
    // but also excluded the launcher's AppIcon-derived results, so "Pin to
    // Dock" never appeared in a launcher result's menu.
    get canManageFavorites() {
        return true;
    }

    _init(app, monitorIndex, iconAnimator) {
        super._init(app, monitorIndex, iconAnimator);

        this._signalsHandler.add(tracker, 'notify::focus-app', () => this._updateFocusState());
    }
});

const DockLocationAppIcon = GObject.registerClass({
}, class DockLocationAppIcon extends DockAbstractAppIcon {
    _init(app, monitorIndex, iconAnimator) {
        if (!(app.appInfo instanceof Locations.LocationAppInfo))
            throw new Error('Provided application %s is not a Location'.format(app));

        super._init(app, monitorIndex, iconAnimator);

        if (Docking.DockManager.settings.isolateLocations) {
            this._signalsHandler.add(tracker, 'notify::focus-app', () => this._updateFocusState());
        } else {
            this._signalsHandler.add(global.display, 'notify::focus-window',
                () => this._updateFocusState());
        }

        this._signalsHandler.add(this.app, 'notify::icon', () => this.icon.update());
    }

    get location() {
        return this.app.location;
    }

    _updateFocusState() {
        if (Docking.DockManager.settings.isolateLocations) {
            super._updateFocusState();
            return;
        }

        this.focused = this.app.isFocused && this.running;
    }
});

/**
 * @param app
 * @param monitorIndex
 * @param iconAnimator
 */
export function makeAppIcon(app, monitorIndex, iconAnimator) {
    if (app.appInfo instanceof Locations.LocationAppInfo)
        return new DockLocationAppIcon(app, monitorIndex, iconAnimator);

    return new DockAppIcon(app, monitorIndex, iconAnimator);
}

/**
 * DockAppIconMenu
 *
 * - set popup arrow side based on dash orientation
 * - Add close windows option based on quitfromdash extension
 *   (https://github.com/deuill/shell-extension-quitfromdash)
 * - Add open windows thumbnails instead of list
 * - update menu when application windows change
 */
export const DockAppIconMenu = class DockAppIconMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0.5, Utils.getPosition());

        this._signalsHandler = new Utils.GlobalSignalsHandler(this);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this.actor.add_style_class_name('app-menu');
        this.actor.add_style_class_name('dock-app-menu');

        // Chain our visibility and lifecycle to that of the source
        this._signalsHandler.add(source, 'notify::mapped', () => {
            if (!source.mapped)
                this.close();
        });
        this._signalsHandler.add(source, 'destroy', () => this.destroy());

        Main.uiGroup.add_child(this.actor);

        const {remoteModel} = Docking.DockManager.getDefault();
        const remoteModelApp = remoteModel?.lookupById(this.sourceActor?.app?.id);
        if (remoteModelApp && DBusMenu) {
            const [onQuickList, onDynamicSection] = Utils.splitHandler((sender,
                {quicklist}, dynamicSection) => {
                dynamicSection.removeAll();
                if (quicklist) {
                    quicklist.get_children().forEach(remoteItem =>
                        dynamicSection.addMenuItem(
                            DBusMenuUtils.makePopupMenuItem(remoteItem, false)));
                }
            });

            this._signalsHandler.add([
                remoteModelApp,
                'quicklist-changed',
                onQuickList,
            ], [
                this,
                'dynamic-section-changed',
                onDynamicSection,
            ]);
        }
    }

    destroy() {
        super.destroy();
        delete this.sourceActor;
        delete this._signalsHandler;
    }

    _appendSeparator() {
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _appendMenuItem(labelText, params) {
        const item = new PopupMenu.PopupMenuItem(labelText, params);
        this.addMenuItem(item);
        return item;
    }

    popup(_activatingButton) {
        this._rebuildMenu();
        PopupMenuUtils.open(this);
    }

    removeAll() {
        super.removeAll();

        delete this._allWindowsMenuItem;
        delete this._quitMenuItem;
    }

    _rebuildMenu() {
        this.removeAll();

        const appItemLabel = this.sourceActor.updating
            ? _('%s is being updated…').format(this.sourceActor.name)
            : this.sourceActor.name;
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(appItemLabel));

        const {app} = this.sourceActor;

        if (Docking.DockManager.settings.showWindowsPreview) {
            // Display the app windows menu items and the separator between windows
            // of the current desktop and other windows.
            const windows = this.sourceActor.getInterestingWindows();

            this._allWindowsMenuItem = new PopupMenu.PopupSubMenuMenuItem(__('All Windows'), false);
            if (this._allWindowsMenuItem.menu?.actor)
                this._allWindowsMenuItem.menu.actor.overlayScrollbars = true;
            this._allWindowsMenuItem.hide();
            if (windows.length > 0)
                this.addMenuItem(this._allWindowsMenuItem);
        } else {
            const windows = this.sourceActor.getInterestingWindows();

            if (windows.length > 0) {
                this.addMenuItem(
                    /* Translators: This is the heading of a list of open windows */
                    new PopupMenu.PopupSeparatorMenuItem(_('Open Windows')));
            }

            windows.forEach(window => {
                const title = window.title ? window.title : app.get_name();
                const item = this._appendMenuItem(title);
                item.connect('activate', () => {
                    this.emit('activate-window', window);
                });
            });
        }

        if (!app.is_window_backed()) {
            this._appendSeparator();

            const appInfo = app.get_app_info();
            const actions = this.sourceActor.updating ? [] : appInfo.list_actions();
            if (!this.sourceActor.updating &&
                app.can_open_new_window() &&
                actions.indexOf('new-window') === -1) {
                const newMenuItem = this._appendMenuItem(_('New Window'));
                newMenuItem.connect('activate', () => {
                    if (app.state === Shell.AppState.STOPPED)
                        this.sourceActor.animateLaunch();

                    app.open_new_window(-1);
                    this.emit('activate-window', null);
                });
                this._appendSeparator();
            }

            if (!this.sourceActor.updating &&
                Docking.DockManager.getDefault().discreteGpuAvailable &&
                app.state === Shell.AppState.STOPPED) {
                const appPrefersNonDefaultGPU = appInfo.get_boolean('PrefersNonDefaultGPU');
                const gpuPref = appPrefersNonDefaultGPU
                    ? Shell.AppLaunchGpu.DEFAULT
                    : Shell.AppLaunchGpu.DISCRETE;
                const gpuMenuItem = this._appendMenuItem(appPrefersNonDefaultGPU
                    ? _('Launch using Integrated Graphics Card')
                    : _('Launch using Discrete Graphics Card'));
                gpuMenuItem.connect('activate', () => {
                    this.sourceActor.animateLaunch();
                    app.launch(0, -1, gpuPref);
                    this.emit('activate-window', null);
                });
            }

            for (let i = 0; i < actions.length; i++) {
                const action = actions[i];
                const item = this._appendMenuItem(appInfo.get_action_name(action));
                item.sensitive = !appInfo.busy;
                item.connect('activate', (emitter, event) => {
                    app.launch_action(action, event.get_time(), -1);
                    this.emit('activate-window', null);
                });
            }

            const canFavorite = global.settings.is_writable('favorite-apps') &&
                this.sourceActor?.canManageFavorites === true &&
                ParentalControlsManager.getDefault().shouldShowApp(app.appInfo);

            if (canFavorite) {
                this._appendSeparator();

                const isFavorite = AppFavorites.getAppFavorites().isFavorite(app.get_id());
                if (isFavorite) {
                    const item = this._appendMenuItem(_('Unpin'));
                    item.connect('activate', () => {
                        const favs = AppFavorites.getAppFavorites();
                        favs.removeFavorite(app.get_id());
                    });
                } else {
                    const item = this._appendMenuItem(__('Pin to Dock'));
                    item.connect('activate', () => {
                        const favs = AppFavorites.getAppFavorites();
                        favs.addFavorite(app.get_id());
                    });
                }
            }

            if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop') &&
                this.sourceActor?.canManageFavorites === true &&
                !this.sourceActor.getSnapName()) {
                this._appendSeparator();
                const item = this._appendMenuItem(_('App Details'));
                item.connect('activate', () => {
                    const id = app.get_id();
                    const args = GLib.Variant.new('(ss)', [id, '']);
                    Gio.DBus.get(Gio.BusType.SESSION, null,
                        (o, res) => {
                            const bus = Gio.DBus.get_finish(res);
                            bus.call('org.gnome.Software',
                                '/org/gnome/Software',
                                'org.gtk.Actions', 'Activate',
                                GLib.Variant.new('(sava{sv})',
                                    ['details', [args], null]),
                                null, 0, -1, null, null);
                            Main.overview.hide();
                        });
                });
            }

            if (this.sourceActor?.canManageFavorites === true) {
                const snapName = this.sourceActor.getSnapName();
                const snapStore = snapName
                    ? Shell.AppSystem.get_default().lookup_app(
                        'snap-store_snap-store.desktop') : null;

                if (snapStore) {
                    this._appendSeparator();
                    const item = this._appendMenuItem(_('App Details'));
                    item.connect('activate', (_, event) => {
                        snapStore.activate_full(-1, event.get_time());
                        Util.spawnApp(
                            [...snapStore.appInfo.get_commandline().split(' '), snapName]);
                        Main.overview.hide();
                    });
                }
            }
        }

        // dynamic menu
        const items = this._getMenuItems();
        let i = items.length;
        if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop'))
            i -= 2;

        if (global.settings.is_writable('favorite-apps'))
            i -= 2;

        if (i < 0)
            i = 0;

        const dynamicSection = new PopupMenu.PopupMenuSection();
        this.addMenuItem(dynamicSection, i);
        this.emit('dynamic-section-changed', dynamicSection);

        // quit menu
        this._appendSeparator();
        this._quitMenuItem = this._appendMenuItem(_('Quit'));
        this._quitMenuItem.connect('activate', () => this.sourceActor.closeAllWindows());

        this.update();
    }

    // update menu content when application windows change. This is desirable as actions
    // acting on windows (closing) are performed while the menu is shown.
    update() {
        // update, show or hide the quit menu
        if (this.sourceActor.windowsCount > 0) {
            if (this.sourceActor.windowsCount === 1) {
                this._quitMenuItem.label.set_text(_('Quit'));
            } else {
                this._quitMenuItem.label.set_text(ngettext(
                    'Quit %d Window', 'Quit %d Windows', this.sourceActor.windowsCount).format(
                    this.sourceActor.windowsCount));
            }

            this._quitMenuItem.actor.show();
        } else {
            this._quitMenuItem.actor.hide();
        }

        if (Docking.DockManager.settings.showWindowsPreview) {
            const windows = this.sourceActor.getInterestingWindows();

            // update, show, or hide the allWindows menu
            // Check if there are new windows not already displayed. In such case,
            // repopulate the allWindows menu. Windows removal is already handled
            // by each preview being connected to the destroy signal
            const oldWindows = this._allWindowsMenuItem.menu._getMenuItems().map(item => {
                return item._window;
            });

            const newWindows = windows.filter(w =>
                oldWindows.indexOf(w) < 0);
            if (newWindows.length > 0) {
                this._populateAllWindowMenu(windows);

                // Try to set the width to that of the submenu.
                // TODO: can't get the actual size, getting a bit less.
                // Temporary workaround: add 15px to compensate
                this._allWindowsMenuItem.width =  this._allWindowsMenuItem.menu.actor.width + 15;
            }

            // The menu is created hidden and never hidden after being shown.
            // Instead, a signal connected to its items destroy will set is
            // insensitive if no more windows preview are shown.
            if (windows.length > 0) {
                this._allWindowsMenuItem.show();
                this._allWindowsMenuItem.setSensitive(true);

                if (Docking.DockManager.settings.defaultWindowsPreviewToOpen)
                    this._allWindowsMenuItem.menu.open();
            }
        }

        // Update separators
        this._getMenuItems().forEach(item => {
            if ('label' in item)
                this._updateSeparatorVisibility(item);
        });
    }

    _populateAllWindowMenu(windows) {
        this._allWindowsMenuItem.menu.removeAll();

        if (windows.length > 0) {
            const activeWorkspace = global.workspace_manager.get_active_workspace();
            let separatorShown =  windows[0].get_workspace() !== activeWorkspace;

            for (let i = 0; i < windows.length; i++) {
                const window = windows[i];
                if (!separatorShown && window.get_workspace() !== activeWorkspace) {
                    this._allWindowsMenuItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    separatorShown = true;
                }

                const item = new WindowPreview.WindowPreviewMenuItem(window,
                    St.Side.LEFT);
                this._allWindowsMenuItem.menu.addMenuItem(item);
                item.connect('activate', () => {
                    this.emit('activate-window', window);
                });

                // This is to achieve a more graceful transition when the last
                // window is closed.
                item.connect('destroy', () => {
                    // It's still counting the item just going to be destroyed
                    if (this._allWindowsMenuItem.menu._getMenuItems().length === 1)
                        this._allWindowsMenuItem.setSensitive(false);
                });
            }
        }
    }
};

/**
 * @param w
 */
function isWindowUrgent(w) {
    return w.urgent || w.demandsAttention || w._manualUrgency;
}

/**
 * Filter out unnecessary windows, for instance
 * nautilus desktop window.
 *
 * @param windows
 * @param monitorIndex
 */
export function getInterestingWindows(windows, monitorIndex) {
    const {settings} = Docking.DockManager;

    // When using workspace isolation, we filter out windows
    // that are neither in the current workspace nor marked urgent
    if (settings.isolateWorkspaces) {
        const showUrgent = settings.workspaceAgnosticUrgentWindows;
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        windows = windows.filter(w => {
            const inWorkspace = w.get_workspace() === activeWorkspace;
            return inWorkspace || (showUrgent && isWindowUrgent(w));
        });
    }

    if (settings.isolateMonitors && monitorIndex >= 0) {
        windows = windows.filter(w => {
            return w.get_monitor() === monitorIndex;
        });
    }

    return windows.filter(w => !w.skipTaskbar);
}

/**
 * A ShowAppsIcon improved class.
 *
 * - set label position based on dash orientation
 *   Note: we are am reusing most machinery of the appIcon class.
 * - implement a popupMenu based on the AppIcon code
 *   Note: we are reusing most machinery of the appIcon class)
 *
 */

export const DockShowAppsIcon = GObject.registerClass({
    Signals: {
        'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'sync-tooltip': {},
    },
}
, class DockShowAppsIcon extends Dash.ShowAppsIcon {
    _init(position) {
        super._init();

        // Re-use appIcon methods
        const {prototype: appIconPrototype} = AppDisplay.AppIcon;
        this.toggleButton.y_expand = false;
        this.toggleButton.connect('popup-menu', () =>
            appIconPrototype._onKeyboardPopupMenu.call(this));
        this.toggleButton.connect('clicked', () =>
            this._removeMenuTimeout());

        this.reactive = true;
        this.toggleButton.popupMenu = (...args) =>
            this.popupMenu(...args);
        this.toggleButton._setPopupTimeout = (...args) =>
            this._setPopupTimeout(...args);
        this.toggleButton._removeMenuTimeout = (...args) =>
            this._removeMenuTimeout(...args);

        Utils.deferActorDestroy(this.label);
        this.label?.add_style_class_name(Theming.PositionStyleClass[position]);
        if (Docking.DockManager.settings.customThemeShrink)
            this.label?.add_style_class_name('shrink');

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuTimeoutId = 0;

        this._maybeEnablePopupGestures();
    }

    _createIcon(size) {
        this._iconActor = super._createIcon(size);
        this._iconActor.fallbackIconName = this._iconActor.iconName;
        this._iconActor.fallbackGicon = this._iconActor.gicon;
        this._iconActor.iconName = `view-app-grid-${Main.sessionMode.currentMode}-symbolic`;
        return this._iconActor;
    }

    vfunc_leave_event(...args) {
        return AppDisplay.AppIcon.prototype.vfunc_leave_event.call(
            this.toggleButton, ...args);
    }

    vfunc_button_press_event(...args) {
        try {
            // TODO: Drop this when not supporting GNOME 48 (and older) anymore.
            return AppDisplay.AppIcon.prototype.vfunc_button_press_event.call(
                this.toggleButton, ...args);
        } catch {
            return Clutter.EVENT_PROPAGATE;
        }
    }

    vfunc_touch_event(...args) {
        try {
            // TODO: Drop this when not supporting GNOME 48 (and older) anymore.
            return AppDisplay.AppIcon.prototype.vfunc_touch_event.call(
                this.toggleButton, ...args);
        } catch {
            return Clutter.EVENT_PROPAGATE;
        }
    }

    showLabel(...args) {
        itemShowLabel.call(this, ...args);
    }

    setForcedHighlight(...args) {
        AppDisplay.AppIcon.prototype.setForcedHighlight.call(this, ...args);
    }

    _onMenuPoppedDown(...args) {
        AppDisplay.AppIcon.prototype._onMenuPoppedDown.call(this, ...args);
    }

    _setPopupTimeout(...args) {
        AppDisplay.AppIcon.prototype._setPopupTimeout.call(this, ...args);
    }

    _removeMenuTimeout(...args) {
        AppDisplay.AppIcon.prototype._removeMenuTimeout?.call(this, ...args);
    }

    _hasPopupMenu() {
        return Docking.DockManager.extension.uuid !== 'ubuntu-dock@ubuntu.com';
    }

    _maybeEnablePopupGestures() {
        if (!this._hasPopupMenu())
            return;

        if (!Clutter.LongPressGesture || !Clutter.ClickGesture)
            return;

        const longPressGesture = new Clutter.LongPressGesture();
        longPressGesture.connect('recognize', () => this.popupMenu());
        this.add_action(longPressGesture);

        const rightClickGesture = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClickGesture.connect('recognize', () => this.popupMenu());
        this.add_action(rightClickGesture);
    }

    popupMenu() {
        if (!this._hasPopupMenu())
            return false;

        this._removeMenuTimeout();
        this.toggleButton.fake_release();

        if (!this._menu) {
            this._menu = new DockShowAppsIconMenu(this);
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            const id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this._menu.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });
            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.toggleButton.set_hover(true);
        this._menu.popup();
        // Removed in GNOME 50.
        this._menuManager.ignoreRelease?.();
        this.emit('sync-tooltip');

        return false;
    }
});


/**
 * A menu for the showAppsIcon
 */
class DockShowAppsIconMenu extends DockAppIconMenu {
    _rebuildMenu() {
        this.removeAll();

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(__('XDock')));

        const item = this._appendMenuItem(_('Settings'));
        item.connect('activate', () =>
            Docking.DockManager.extension.openPreferences());
    }
}

/**
 * This function is used for both DockShowAppsIcon and DockDashItemContainer
 */
export function itemShowLabel() {
    /* eslint-disable no-invalid-this */
    // Check if the label is still present at all. When switching workspace, the
    // item might have been destroyed in between.
    if (!this._labelText || !this.label.get_stage())
        return;

    this.label.set_text(this._labelText);
    this.label.opacity = 0;
    this.label.show();

    const [x, y] = itemPlaceLabel.call(this);
    this.label.remove_all_transitions();
    this.label.set_position(x, y);
    this.label.ease({
        opacity: 255,
        duration: DASH_ITEM_LABEL_SHOW_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
    /* eslint-enable no-invalid-this */
}

/**
 * Where an item's label goes: beside the item, towards the screen interior,
 * and past a magnified icon's grown edge rather than over it.
 *
 * @returns {number[]} the label's stage position
 */
export function itemPlaceLabel() {
    /* eslint-disable no-invalid-this */
    const [stageX, stageY] = this.get_transformed_position();
    const node = this.label.get_theme_node();

    const itemWidth  = this.allocation.x2 - this.allocation.x1;
    const itemHeight = this.allocation.y2 - this.allocation.y1;

    const labelWidth = this.label.get_width();
    const labelHeight = this.label.get_height();

    let x, y, xOffset, yOffset;

    const position = Utils.getPosition();
    const labelOffset = node.get_length('-x-offset');

    switch (position) {
    case St.Side.LEFT:
        yOffset = Math.floor((itemHeight - labelHeight) / 2);
        y = stageY + yOffset;
        xOffset = labelOffset;
        x = stageX + this.get_width() + xOffset;
        break;
    case St.Side.RIGHT:
        yOffset = Math.floor((itemHeight - labelHeight) / 2);
        y = stageY + yOffset;
        xOffset = labelOffset;
        x = Math.round(stageX) - labelWidth - xOffset;
        break;
    case St.Side.TOP:
        y = stageY + labelOffset + itemHeight;
        xOffset = Math.floor((itemWidth - labelWidth) / 2);
        x = stageX + xOffset;
        break;
    case St.Side.BOTTOM:
        yOffset = labelOffset;
        y = stageY - labelHeight - yOffset;
        xOffset = Math.floor((itemWidth - labelWidth) / 2);
        x = stageX + xOffset;
        break;
    }

    // The item is laid out at rest height across the dock; a magnified icon
    // grows past it towards the screen interior by its extra scale.
    const iconBin = this.child?.icon?._iconBin;
    const grow = (this.child?._magnifyScale ?? 1) - 1;
    if (iconBin && grow > 0) {
        if (position === St.Side.BOTTOM)
            y -= iconBin.height * grow;
        else if (position === St.Side.TOP)
            y += iconBin.height * grow;
        else if (position === St.Side.LEFT)
            x += iconBin.width * grow;
        else if (position === St.Side.RIGHT)
            x -= iconBin.width * grow;
    }

    // keep the label inside the screen border
    // Only needed fot the x coordinate.

    // Leave a few pixel gap
    const gap = 5;
    const monitor = Main.layoutManager.findMonitorForActor(this);
    if (x - monitor.x < gap)
        x += monitor.x - x + labelOffset;
    else if (x + labelWidth > monitor.x + monitor.width - gap)
        x -= x + labelWidth - (monitor.x + monitor.width) + gap;

    return [x, y];
    /* eslint-enable no-invalid-this */
}
