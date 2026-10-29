// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    GLib,
    Gio,
    GObject,
    Meta,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    AppMenu,
    AppDisplay,
    Dash,
    Layout,
    Main,
    OverviewControls,
    PointerWatcher,
    PopupMenu,
    SwitcherPopup,
    Workspace,
    WorkspacesView,
    WorkspaceSwitcherPopup,
} from './dependencies/shell/ui.js';

import {
    AnimationUtils,
} from './dependencies/shell/misc.js';

import {
    AppIconsDecorator,
    AppLauncher,
    AppSpread,
    DockDash,
    DesktopIconsIntegration,
    FileManager1API,
    Intellihide,
    LauncherAPI,
    Locations,
    Motion,
    NotificationsMonitor,
    Theming,
    Utils,
} from './imports.js';

import {Extension} from './dependencies/shell/extensions/extension.js';
import {DockBlur} from './dockBlur.js';
import {
    DeferredTask,
    LifecycleState,
    RestorableValue,
    retryPendingRestorations,
    runCleanupTasks,
} from './lifecycle.js';
import {
    UnsupportedShellError,
    formatUnsupportedShellMessage,
    probeShellCapabilities,
    runShellCapabilityGate,
} from './shellApi.js';

// Use __ () and N__() for the extension gettext domain, and reuse
// the shell domain with the default _() and N_()
const {gettext: __} = Extension;

const {signals: Signals} = imports;

const DOCK_DWELL_CHECK_INTERVAL = 100;
const STARTUP_ANIMATION_TIME = 500;
const STARTUP_RESTORATION_RETRY_INTERVAL = 50;
const STARTUP_RESTORATION_RETRY_ATTEMPTS = 5;

export const State = Motion.DockMotionState;

const scrollAction = Object.freeze({
    DO_NOTHING: 0,
    CYCLE_WINDOWS: 1,
    SWITCH_WORKSPACE: 2,
});

const Labels = Object.freeze({
    INITIALIZE: Symbol('initialize'),
    ISOLATION: Symbol('isolation'),
    LOCATIONS: Symbol('locations'),
    MAIN_DASH: Symbol('main-dash'),
    OLD_DASH_CHANGES: Symbol('old-dash-changes'),
    SETTINGS: Symbol('settings'),
    STARTUP_ANIMATION: Symbol('startup-animation'),
    WORKSPACE_SWITCH_SCROLL: Symbol('workspace-switch-scroll'),
});

const DEFAULT_SHELL_API = Object.freeze({
    AppDisplay,
    AppMenu,
    Dash,
    Main,
    OverviewControls,
    PopupMenu,
    SwitcherPopup,
    Workspace,
    WorkspacesView,
});

/**
 * A simple St.Widget with one child whose allocation takes into account the
 * slide out of its child via the slide-x property ([0:1]).
 *
 * Required since I want to track the input region of this container which is
 * based on its allocation even if the child overflows the parent actor. By doing
 * this the region of the dash that is slide-out is not stealing anymore the input
 * regions making the extension usable when the primary monitor is the right one.
 *
 * The slide-x parameter can be used to directly animate the sliding. The parent
 * must have a WEST (SOUTH) anchor_point to achieve the sliding to the RIGHT (BOTTOM)
 * side.
 */
const DashSlideContainer = GObject.registerClass({
    Properties: {
        'monitor-index': GObject.ParamSpec.uint(
            'monitor-index', 'monitor-index', 'monitor-index',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32, 0),
        'side': GObject.ParamSpec.enum(
            'side', 'side', 'side',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            St.Side, St.Side.LEFT),
        'slide-x': GObject.ParamSpec.double(
            'slide-x', 'slide-x', 'slide-x',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            0, 1, 1),
    },
}, class DashSlideContainer extends St.Bin {
    _init(params = {}) {
        super._init(params);

        this._slideoutSize = 0; // minimum size when slided out
        this.connect('notify::slide-x', () => this.queue_relayout());

        if (this.side === St.Side.TOP && DockManager.settings.dockFixed) {
            this._signalsHandler = new Utils.GlobalSignalsHandler(this);
            this._signalsHandler.add(Main.panel, 'notify::height',
                () => this.queue_relayout());
        }
    }

    vfunc_allocate(box) {
        const contentBox = this.get_theme_node().get_content_box(box);

        this.set_allocation(box);

        if (!this.child)
            return;

        const availWidth = contentBox.x2 - contentBox.x1;
        let availHeight = contentBox.y2 - contentBox.y1;
        const [, , natChildWidth, natChildHeight] =
            this.child.get_preferred_size();

        const childWidth = natChildWidth;
        const childHeight = natChildHeight;

        const childBox = new Clutter.ActorBox();

        const slideoutSize = this._slideoutSize;

        if (this.side === St.Side.LEFT) {
            childBox.x1 = (this.slideX - 1) * (childWidth - slideoutSize);
            childBox.x2 = slideoutSize + this.slideX * (childWidth - slideoutSize);
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        } else if ((this.side === St.Side.RIGHT) || (this.side === St.Side.BOTTOM)) {
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        } else if (this.side === St.Side.TOP) {
            const monitor = Main.layoutManager.monitors[this.monitorIndex];
            let yOffset = 0;
            if (Main.panel.x === monitor.x && Main.panel.y === monitor.y &&
                DockManager.settings.dockFixed)
                yOffset = Main.panel.height;
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = (this.slideX - 1) * (childHeight - slideoutSize) + yOffset;
            childBox.y2 = slideoutSize + this.slideX * (childHeight - slideoutSize) + yOffset;
            availHeight += yOffset;
        }

        this.child.allocate(childBox);

        this.child.set_clip(-childBox.x1, -childBox.y1,
            -childBox.x1 + availWidth, -childBox.y1 + availHeight);
    }

    /**
     * Just the child width but taking into account the slided out part
     *
     * @param forHeight
     */
    vfunc_get_preferred_width(forHeight) {
        let [minWidth, natWidth] = super.vfunc_get_preferred_width(forHeight || 0);
        if ((this.side ===  St.Side.LEFT) || (this.side === St.Side.RIGHT)) {
            minWidth = (minWidth - this._slideoutSize) * this.slideX + this._slideoutSize;
            natWidth = (natWidth - this._slideoutSize) * this.slideX + this._slideoutSize;
        }
        return [minWidth, natWidth];
    }

    /**
     * Just the child height but taking into account the slided out part
     *
     * @param forWidth
     */
    vfunc_get_preferred_height(forWidth) {
        let [minHeight, natHeight] = super.vfunc_get_preferred_height(forWidth || 0);
        if ((this.side ===  St.Side.TOP) || (this.side ===  St.Side.BOTTOM)) {
            minHeight = (minHeight - this._slideoutSize) * this.slideX + this._slideoutSize;
            natHeight = (natHeight - this._slideoutSize) * this.slideX + this._slideoutSize;

            if (this.side === St.Side.TOP && DockManager.settings.dockFixed) {
                const monitor = Main.layoutManager.monitors[this.monitorIndex];
                if (Main.panel.x === monitor.x && Main.panel.y === monitor.y) {
                    minHeight += Main.panel.height;
                    natHeight += Main.panel.height;
                }
            }
        }
        return [minHeight, natHeight];
    }
});

const XDock = GObject.registerClass({
    Properties: {
        'is-main': GObject.ParamSpec.boolean(
            'is-main', 'is-main', 'is-main',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            false),
        'monitor-index': GObject.ParamSpec.uint(
            'monitor-index', 'monitor-index', 'monitor-index',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32, 0),
    },
    Signals: {
        'showing': {},
        'hiding': {},
    },
}, class XDock extends St.Bin {
    _init(params) {
        this._position = Utils.getPosition();

        // This is the centering actor
        super._init({
            ...params,
            name: 'xdockContainer',
            reactive: false,
            style_class: Theming.PositionStyleClass[this._position],
        });

        this._lifecycle = new LifecycleState(
            'dock',
            () => this._cleanup(),
            (error, operation) => logError(error, `Destroying ${operation}`));
        this.connect('destroy', () => this._lifecycle.destroy());

        try {
            this._lifecycle.enable(() => this._initializeDock());
        } catch (error) {
            // LifecycleState already released every owned external resource.
            // Destroy the partially initialized actor itself before propagating
            // the original construction failure to DockManager.
            this.destroy();
            throw error;
        }
    }

    _initializeDock() {
        // Seed every cleanup-owned slot before constructing an object that can
        // fail after publishing signals, sources, or compositor state.
        this._signalsHandler = null;
        this._intellihide = null;
        this._themeManager = null;
        this._blur = null;
        this._workspaceSwitcherPopup = null;
        this.dash = null;
        this._slider = null;
        this._motionController = null;
        this._box = null;
        this._marginLater = 0;
        this._triggerTimeoutId = 0;
        this._optionalScrollWorkspaceSwitchDeadTimeId = 0;
        this._pressureBarrier = null;
        this._barrier = null;
        this._removeBarrierTimeoutId = 0;
        this._dockWatch = null;
        this._dockDwellTimeoutId = 0;
        this._rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;

        // Load settings
        const {settings} = DockManager;
        this._isHorizontal = (this._position === St.Side.TOP) || (this._position === St.Side.BOTTOM);

        // Temporary ignore hover events linked to autohide for whatever reason
        this._ignoreHover = false;
        this._oldIgnoreHover = null;
        // This variables are linked to the settings regardles of autohide or intellihide
        // being temporary disable. Get set by _updateVisibilityMode;
        this._autohideIsEnabled = null;
        this._intellihideIsEnabled = null;

        // This variable marks if _disableUnredirect() is called
        // to help restore the original state when intelihide is disabled.
        this._unredirectDisabled = false;

        // Create intellihide object to monitor windows overlapping
        this._intellihide = new Intellihide.Intellihide(this.monitorIndex);

        // initialize dock state
        this._dockState = State.HIDDEN;

        // Put dock on the required monitor
        this._monitor = Main.layoutManager.monitors[this.monitorIndex];

        // this store size and the position where the dash is shown;
        // used by intellihide module to check window overlap.
        this._staticBox = new Clutter.ActorBox();

        // Initialize pressure barrier variables
        this._canUsePressure = false;
        this._pressureBarrier = null;
        this._barrier = null;
        this._removeBarrierTimeoutId = 0;

        // Initialize dwelling system variables
        this._dockDwelling = false;
        this._dockWatch = null;
        this._dockDwellUserTime = 0;
        this._dockDwellTimeoutId = 0;

        // Create a new dash object
        this.dash = new DockDash.DockDash(this.monitorIndex);

        if (Main.overview.isDummy || !settings.showShowAppsButton)
            this.dash.hideShowAppsButton();

        // Create the containers for sliding in and out and
        // centering, turn on track hover
        // This is the sliding actor whose allocation is to be tracked for input regions
        this._slider = new DashSlideContainer({
            monitor_index: this._monitor.index,
            side: this._position,
            slide_x: Main.layoutManager._startingUp ? 0 : 1,
            ...this._isHorizontal ? {
                x_align: Clutter.ActorAlign.CENTER,
            } : {
                y_align: Clutter.ActorAlign.CENTER,
            },
        });

        this._motionController = new Motion.DockMotionController({
            initialState: this._dockState,
            getProgress: () => this._slider.slideX,
            hasActiveTransition: () =>
                this._slider.get_transition('slide-x') !== null,
            startTransition: (plan, onComplete) => {
                // This one transition serves BOTH directions, so a single mode
                // would apply the enter curve to conceals. motion_easing is
                // declared `reversible`, so pick per direction: revealing is an
                // enter, hiding is an exit.
                const revealing =
                    plan.targetProgress === Motion.DockMotionTarget.SHOWN;
                this._slider.ease_property('slide-x', plan.targetProgress, {
                    duration: plan.duration,
                    mode: revealing
                        ? Clutter.AnimationMode.EASE_OUT_CUBIC
                        : Clutter.AnimationMode.EASE_IN_CUBIC,
                    onComplete,
                });
            },
            stopTransition: () => this._slider.remove_transition('slide-x'),
            scheduleDelay: (delay, callback) => {
                const sourceId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, Math.round(delay), () => {
                        callback();
                        return GLib.SOURCE_REMOVE;
                    });
                try {
                    GLib.Source.set_name_by_id(sourceId,
                        '[xdock] delayed hide');
                } catch (error) {
                    GLib.source_remove(sourceId);
                    throw error;
                }
                return sourceId;
            },
            cancelDelay: sourceId => GLib.source_remove(sourceId),
            onStateChanged: state => (this._dockState = state),
            onTransitionStart: plan => this._startDockTransition(plan),
            onTransitionComplete: plan => this._completeDockTransition(plan),
        });

        // This is the actor whose hover status us tracked for autohide
        this._box = new St.BoxLayout({
            name: 'xdockBox',
            reactive: true,
            track_hover: true,
        });
        this._box.connect('notify::hover', this._hoverChanged.bind(this));

        // Connect global signals
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._bindSettingsChanges();
        this._signalsHandler.add([
            // update when workarea changes, for instance if  other extensions modify the struts
            // (like moving th panel at the bottom)
            global.display,
            'workareas-changed',
            this._resetPosition.bind(this),
        ], [
            global.display,
            'in-fullscreen-changed',
            this._updateBarrier.bind(this),
        ], [
            // Monitor windows overlapping
            this._intellihide,
            'status-changed',
            this._updateDashVisibility.bind(this),
        ], [
            this.dash,
            'menu-opened',
            () => {
                this._onMenuOpened();
            },
        ], [
            // sync hover after a popupmenu is closed
            this.dash,
            'menu-closed',
            () => {
                this._onMenuClosed();
            },
        ], [
            this.dash,
            'notify::requires-visibility',
            () => this._updateDashVisibility(),
        ]);

        if (!Main.overview.isDummy) {
            this._signalsHandler.add([
                Main.overview,
                'item-drag-begin',
                this._onDragStart.bind(this),
            ], [
                Main.overview,
                'item-drag-end',
                this._onDragEnd.bind(this),
            ], [
                Main.overview,
                'item-drag-cancelled',
                this._onDragEnd.bind(this),
            ], [
                Main.overview,
                'showing',
                this._onOverviewShowing.bind(this),
            ], [
                Main.overview,
                'hiding',
                this._onOverviewHiding.bind(this),
            ],
            [
                Main.overview,
                'hidden',
                this._onOverviewHidden.bind(this),
            ]);
        }

        this._themeManager = new Theming.ThemeManager(this);
        this._signalsHandler.add(this._themeManager, 'updated',
            () => this.dash.resetAppIcons());
        this._blur = new DockBlur(this.dash, settings);

        this._signalsHandler.add(DockManager.iconTheme, 'changed',
            () => this.dash.resetAppIcons());

        // Since the actor is not a topLevel child and its parent is now not added to the Chrome,
        // the allocation change of the parent container (slide in and slideout) doesn't trigger
        // anymore an update of the input regions. Force the update manually.
        this.connect('notify::allocation',
            Main.layoutManager._queueUpdateRegions.bind(Main.layoutManager));


        // Since Clutter has no longer ClutterAllocationFlags,
        // "allocation-changed" signal has been removed. MR !1245
        this.dash._container.connect('notify::allocation', this._updateStaticBox.bind(this));
        this._slider.connect(this._isHorizontal ? 'notify::x' : 'notify::y',
            this._updateStaticBox.bind(this));

        // Load optional features that need to be activated for one dock only
        if (this.isMain)
            this._enableExtraFeatures();
        // Load optional features that need to be activated once per dock
        this._optionalScrollWorkspaceSwitch();

        // Add dash container actor and the container to the Chrome.
        this.set_child(this._slider);
        this._slider.set_child(this._box);
        this._box.add_child(this.dash);

        // Delay operations that require the shell to be fully loaded and with
        // user theme applied.
        if (Main.layoutManager._startingUp) {
            this._signalsHandler.addWithLabel(Labels.STARTUP_ANIMATION,
                Main.layoutManager, 'startup-complete', () => {
                    this._signalsHandler.removeWithLabel(Labels.STARTUP_ANIMATION);
                    this._trackDock();
                    this._initialize();
                });
        } else {
            this._trackDock();
            // Show the dock only once fully initialized. This workarounds a
            // resize glitch we are seeing if the dock is initialized without
            // an animation.
            // $SOMETHING seems to resize it, but it's yet unclear what it is.
            this.opacity = 0;
            this._signalsHandler.addWithLabel(Labels.INITIALIZE, global.stage,
                'after-paint', () => {
                    this._signalsHandler.removeWithLabel(Labels.INITIALIZE);
                    this._initialize();
                    this.opacity = 255;
                });
        }
    }

    // A layout pass queued before a settings rebuild can still measure the
    // detached dock. St's default measurement needs a stage theme context.
    vfunc_get_preferred_height(forWidth) {
        if (!this._lifecycle || this._lifecycle.destroying || this._lifecycle.destroyed || !this.get_stage())
            return [0, 0];
        return super.vfunc_get_preferred_height(forWidth);
    }

    vfunc_get_preferred_width(forHeight) {
        if (!this._lifecycle || this._lifecycle.destroying || this._lifecycle.destroyed || !this.get_stage())
            return [0, 0];
        return super.vfunc_get_preferred_width(forHeight);
    }

    vfunc_allocate(box) {
        if (!this._lifecycle || this._lifecycle.destroying || this._lifecycle.destroyed || !this.get_stage())
            return;
        super.vfunc_allocate(box);
    }

    get position() {
        return this._position;
    }

    get isHorizontal() {
        return this._isHorizontal;
    }

    /**
     * Versioned actor contract for Blur My Shell and similar visual
     * integrations. Consumers must reject versions they do not understand
     * instead of traversing this actor's private children.
     *
     * @returns {object} the stable v1 dock-surface actors
     */
    getBlurMyShellIntegration() {
        return {
            version: 1,
            dashBox: this._box,
            dash: this.dash,
            background: this.dash?._background ?? null,
        };
    }

    _untrackDock() {
        Main.layoutManager.untrackChrome(this);
    }

    _trackDock() {
        if (DockManager.settings.dockFixed) {
            if (this.get_parent())
                Main.layoutManager.removeChrome(this);
            Main.layoutManager.addChrome(this, {
                trackFullscreen: true,
                affectsStruts: true,
            });
        } else {
            if (this.get_parent())
                Main.layoutManager.removeChrome(this);
            Main.layoutManager.addChrome(this);
        }

        // Set the initial position.
        this._resetPosition();
    }

    _initialize() {
        // Create and apply height/width constraint to the dash.
        if (this._isHorizontal) {
            this.bind_property('width', this.dash, 'max-width',
                GObject.BindingFlags.SYNC_CREATE);
        } else {
            this.bind_property('height', this.dash, 'max-height',
                GObject.BindingFlags.SYNC_CREATE);
        }

        if (this._position === St.Side.RIGHT) {
            this.translation_x = -this.width;
            this.connect('notify::width', () =>
                (this.translation_x = -this.width));
        } else if (this._position === St.Side.BOTTOM) {
            this.translation_y = -this.height;
            this.connect('notify::height', () =>
                (this.translation_y = -this.height));
        }

        this._updateVisibilityMode();

        // In case we are already inside the overview when the extension is loaded,
        // for instance on unlocking the screen if it was locked with the overview open.
        if (Main.overview.visibleTarget)
            this._onOverviewShowing();

        this._updateAutoHideBarriers();
    }

    _cleanup() {
        const errors = runCleanupTasks([
            // Our destroy handler runs before LayoutManager's. Disposing the
            // children can synchronously update struts after Clutter has
            // detached the dock; stop tracking it before those notifications.
            ['chrome tracking', () => Main.layoutManager.untrackChrome(this)],
            // Cancel the delayed-hide source and active slide transition while
            // the slider and dependent actors are still alive. Retain the
            // controller if cancellation itself fails so the error remains
            // inspectable rather than silently discarding its ownership state.
            ['motion controller', () => {
                this._motionController?.cancel();
                this._motionController = null;
            }],
            // Disconnect cross-component callbacks before disposing any of
            // their GObject signal sources. GJS cannot disconnect a handler
            // from an already-disposed actor; doing so emitted critical
            // warnings from the Shell shutdown path during logout.
            ['dock signals', () => this._signalsHandler?.destroy()],
            // The blur is attached to the dash and must go before it.
            ['dock blur', () => this._blur?.destroy()],
            // These objects own global signals internally. Keep each teardown
            // independent because any one of them may be only partly built.
            ['dash', () => this.dash?.destroy()],
            ['intellihide', () => this._intellihide?.destroy()],
            ['theme manager', () => this._themeManager?.destroy()],
            ['workspace switcher popup', () => this._workspaceSwitcherPopup?.destroy()],
            // The slider and box are constructed before they are parented.
            // Destroy them explicitly so a fault anywhere in that interval
            // cannot leak native actors or their direct signal handlers.
            ['dock box actor', () => {
                const box = this._box;
                this._box = null;
                box?.destroy();
            }],
            ['dock slider actor', () => {
                const slider = this._slider;
                this._slider = null;
                slider?.destroy();
            }],
            ['margin later', () => {
                if (this._marginLater)
                    Utils.laterRemove(this._marginLater);
                delete this._marginLater;
            }],
            ['trigger timeout', () => {
                if (this._triggerTimeoutId)
                    GLib.source_remove(this._triggerTimeoutId);
                delete this._triggerTimeoutId;
            }],
            ['dock dwell', () => this._cancelDockDwell?.()],
            ['unredirect state', () => this._restoreUnredirect?.()],
            ['barrier timeout', () => {
                if (this._removeBarrierTimeoutId > 0)
                    GLib.source_remove(this._removeBarrierTimeoutId);
                this._removeBarrierTimeoutId = 0;
            }],
            ['barrier detachment', () => {
                if (this._barrier && this._pressureBarrier)
                    this._pressureBarrier.removeBarrier(this._barrier);
            }],
            ['barrier', () => {
                this._barrier?.destroy();
                this._barrier = null;
            }],
            ['pressure barrier signals', () =>
                this._pressureBarrier?.disconnectObject(this)],
            ['pressure barrier', () => {
                this._pressureBarrier?.destroy();
                this._pressureBarrier = null;
            }],
            ['pointer watcher', () => {
                if (this._dockWatch)
                    PointerWatcher.getPointerWatcher()._removeWatch(this._dockWatch);
                this._dockWatch = null;
            }],
            ['workspace switch timeout', () => {
                if (this._optionalScrollWorkspaceSwitchDeadTimeId)
                    GLib.source_remove(this._optionalScrollWorkspaceSwitchDeadTimeId);
                delete this._optionalScrollWorkspaceSwitchDeadTimeId;
            }],
        ], (error, operation) => logError(error, `Destroying dock ${operation}`));

        delete this._staticBox;
        return errors;
    }

    _updateAutoHideBarriers() {
        // Remove pointer watcher
        if (this._dockWatch) {
            PointerWatcher.getPointerWatcher()._removeWatch(this._dockWatch);
            this._dockWatch = null;
        }

        // Setup pressure barrier (GS38+ only)
        this._updatePressureBarrier();
        this._updateBarrier();

        // setup dwelling system if pressure barriers are not available
        this._setupDockDwellIfNeeded();
    }

    _bindSettingsChanges() {
        const {settings} = DockManager;
        this._signalsHandler.add([
            settings,
            'changed::scroll-action',
            () => {
                this._optionalScrollWorkspaceSwitch();
            },
        ], [
            settings,
            'changed::dash-max-icon-size',
            () => {
                this.dash.setIconSize(settings.dashMaxIconSize);
            },
        ], [
            settings,
            'changed::icon-size-fixed',
            () => {
                this.dash.setIconSize(settings.dashMaxIconSize);
            },
        ], [
            settings,
            'changed::show-favorites',
            () => {
                this.dash.resetAppIcons();
            },
        ], [
            settings,
            'changed::show-trash',
            () => {
                this.dash.resetAppIcons();
            },
            Utils.SignalsHandlerFlags.CONNECT_AFTER,
        ], [
            settings,
            'changed::show-mounts',
            () => {
                this.dash.resetAppIcons();
            },
            Utils.SignalsHandlerFlags.CONNECT_AFTER,
        ], [
            settings,
            'changed::isolate-locations',
            () => this.dash.resetAppIcons(),
            Utils.SignalsHandlerFlags.CONNECT_AFTER,
        ], [
            settings,
            'changed::dance-urgent-applications',
            () => this.dash.resetAppIcons(),
            Utils.SignalsHandlerFlags.CONNECT_AFTER,
        ], [
            settings,
            'changed::show-running',
            () => {
                this.dash.resetAppIcons();
            },
        ], [
            settings,
            'changed::show-apps-always-in-the-edge',
            () => {
                this.dash.updateShowAppsButton();
            },
        ], [
            settings,
            'changed::show-apps-at-top',
            () => {
                this.dash.updateShowAppsButton();
            },
        ], [
            settings,
            'changed::show-show-apps-button',
            () => {
                if (!Main.overview.isDummy &&
                        settings.showShowAppsButton)
                    this.dash.showShowAppsButton();
                else
                    this.dash.hideShowAppsButton();
            },
        ], [
            settings,
            'changed::dock-fixed',
            () => {
                this._untrackDock();
                this._trackDock();

                this._updateAutoHideBarriers();
                this._updateVisibilityMode();
            },
        ], [
            settings,
            'changed::manualhide',
            () => {
                this._updateVisibilityMode();
            },
        ], [
            settings,
            'changed::intellihide',
            () => {
                this._updateVisibilityMode();
                this._updateVisibleDesktop();
            },
        ], [
            settings,
            'changed::intellihide-mode',
            () => {
                this._intellihide.forceUpdate();
            },
        ], [
            settings,
            'changed::autohide',
            () => {
                this._updateVisibilityMode();
                this._updateAutoHideBarriers();
            },
        ], [
            settings,
            'changed::autohide-in-fullscreen',
            this._updateBarrier.bind(this),
        ], [
            settings,
            'changed::show-dock-urgent-notify',
            () => {
                this.dash.resetAppIcons();
            },
        ],
        [
            settings,
            'changed::extend-height',
            this._resetPosition.bind(this),
        ], [
            settings,
            'changed::height-fraction',
            this._resetPosition.bind(this),
        ], [
            settings,
            'changed::always-center-icons',
            () => this.dash.resetAppIcons(),
        ], [
            settings,
            'changed::require-pressure-to-show',
            () => this._updateAutoHideBarriers(),
        ], [
            settings,
            'changed::pressure-threshold',
            () => {
                this._updatePressureBarrier();
                this._updateBarrier();
            },
        ]);
    }

    _disableUnredirect() {
        if (!this._unredirectDisabled) {
            if (Meta.disable_unredirect_for_display !== undefined)
                Meta.disable_unredirect_for_display(global.display);
            else if (global.compositor.disable_unredirect !== undefined)
                global.compositor.disable_unredirect();
            this._unredirectDisabled = true;
        }
    }

    _restoreUnredirect() {
        if (this._unredirectDisabled) {
            if (Meta.enable_unredirect_for_display !== undefined)
                Meta.enable_unredirect_for_display(global.display);
            else if (global.compositor.enable_unredirect !== undefined)
                global.compositor.enable_unredirect();
            this._unredirectDisabled = false;
        }
    }

    /**
     * This is call when visibility settings change
     */
    _updateVisibilityMode() {
        const {settings} = DockManager;
        if (DockManager.settings.dockFixed || DockManager.settings.manualhide) {
            this._autohideIsEnabled = false;
            this._intellihideIsEnabled = false;
        } else {
            this._autohideIsEnabled = settings.autohide;
            this._intellihideIsEnabled = settings.intellihide;
        }

        if (this._autohideIsEnabled)
            this.add_style_class_name('autohide');
        else
            this.remove_style_class_name('autohide');

        if (this._intellihideIsEnabled) {
            this._intellihide.enable();
        } else {
            this._intellihide.disable();
            this._restoreUnredirect();
        }

        this._updateDashVisibility();
    }

    /**
     * Show/hide dash based on, in order of priority:
     * overview visibility
     * fixed mode
     * intellihide
     * autohide
     * overview visibility
     */
    _updateDashVisibility() {
        if (DockManager.settings.manualhide) {
            this._ignoreHover = true;
            this._removeAnimations();
            this._animateOut(0, 0);
            return;
        }

        if (Main.overview.visibleTarget)
            return;

        const {settings} = DockManager;

        if (DockManager.settings.dockFixed) {
            this._removeAnimations();
            this._animateIn(settings.animationTime, 0);
        } else if (this._intellihideIsEnabled) {
            if (!this.dash.requiresVisibility && this._intellihide.getOverlapStatus()) {
                this._ignoreHover = false;
                // Do not hide if autohide is enabled and mouse is hover
                if (!this._box.hover || !this._autohideIsEnabled)
                    this._animateOut(settings.animationTime, 0);
            } else {
                this._ignoreHover = true;
                this._removeAnimations();
                this._animateIn(settings.animationTime, 0);
            }
        } else if (this._autohideIsEnabled) {
            this._ignoreHover = false;

            if (this._box.hover || this.dash.requiresVisibility)
                this._animateIn(settings.animationTime, 0);
            else
                this._animateOut(settings.animationTime, 0);
        } else {
            this._animateOut(settings.animationTime, 0);
        }
    }

    _onOverviewShowing() {
        this.add_style_class_name('overview');

        this._ignoreHover = true;
        this._intellihide.disable();
        this._removeAnimations();
        this._animateIn(DockManager.settings.animationTime, 0);
    }

    _onOverviewHiding() {
        this._intellihide.enable();
        this._updateDashVisibility();
    }

    _onOverviewHidden() {
        this.remove_style_class_name('overview');
        this._updateDashVisibility();
    }

    _onMenuOpened() {
        this._ignoreHover = true;
    }

    _onMenuClosed() {
        this._ignoreHover = false;
        this._box.sync_hover();
        this._updateDashVisibility();
    }

    _hoverChanged() {
        if (!this._ignoreHover) {
            // Skip if dock is not in autohide mode for instance because it is shown
            // by intellihide.
            if (this._autohideIsEnabled) {
                if (this._box.hover || Main.overview.visible)
                    this._show();
                else
                    this._hide();
            }
        }
    }

    getDockState() {
        return this._dockState;
    }

    _show() {
        // Re-entering the dock cancels the grace-period hide without touching
        // a reveal that is already moving toward the shown position.
        this._motionController.cancelPendingHide();
        if ((this._dockState === State.HIDDEN) || (this._dockState === State.HIDING)) {
            this.emit('showing');
            this._animateIn(DockManager.settings.animationTime, 0);
        }
    }

    _hide() {
        // If no hiding animation is running or queued
        if (!this._motionController.hasPendingHide &&
            ((this._dockState === State.SHOWN) || (this._dockState === State.SHOWING))) {
            const {settings} = DockManager;
            const delay = settings.hideDelay;

            this.emit('hiding');
            this._animateOut(settings.animationTime, delay);
        }
    }

    _animateIn(time, delay) {
        this._animateTo(Motion.DockMotionTarget.SHOWN, time, delay);
    }

    _animateOut(time, delay) {
        this._animateTo(Motion.DockMotionTarget.HIDDEN, time, delay);
    }

    _animateTo(targetProgress, time, delay) {
        const delayMs = Number.isFinite(delay) ? Math.max(0, delay * 1000) : 0;
        const fullDuration = Number.isFinite(time) ? Math.max(0, time * 1000) : 0;
        // ease_property() applies Shell's policy to the base duration. The
        // standalone delay timer must apply that policy itself, including the
        // slow-down factor and the disabled-animations zero-delay behavior.
        const animationsEnabled = AnimationUtils.adjustAnimationTime(fullDuration) > 0;
        const adjustedDelay = AnimationUtils.adjustAnimationTime(delayMs);

        this._motionController.request({
            targetProgress,
            fullDuration,
            animationsEnabled,
            delay: adjustedDelay,
        });
    }

    _startDockTransition(plan) {
        if (plan.targetProgress === Motion.DockMotionTarget.SHOWN) {
            if (this._intellihideIsEnabled)
                this._disableUnredirect();
            this.dash.iconAnimator.start();
        }
    }

    _completeDockTransition(plan) {
        if (plan.targetProgress === Motion.DockMotionTarget.SHOWN) {
            // Remove barrier so that the mouse pointer is released and can
            // reach monitors on the other side of the dock. The short delay
            // gives users an opportunity to move from the edge onto the dock.
            if (this._removeBarrierTimeoutId > 0)
                GLib.source_remove(this._removeBarrierTimeoutId);
            this._removeBarrierTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 100, this._removeBarrier.bind(this));
            return;
        }

        if (this._intellihideIsEnabled)
            this._restoreUnredirect();
        // Remove queued barrier removal timeout if any.
        if (this._removeBarrierTimeoutId > 0)
            GLib.source_remove(this._removeBarrierTimeoutId);
        this._updateBarrier();
        this.dash.iconAnimator.pause();
    }

    /**
     * Dwelling system based on the GNOME Shell 3.14 messageTray code.
     */
    _setupDockDwellIfNeeded() {
        // If we don't have extended barrier features, then we need
        // to support the old tray dwelling mechanism.
        if (this._autohideIsEnabled &&
            (!Utils.supportsExtendedBarriers() ||
             !DockManager.settings.requirePressureToShow)) {
            const pointerWatcher = PointerWatcher.getPointerWatcher();
            this._dockWatch = pointerWatcher.addWatch(
                DOCK_DWELL_CHECK_INTERVAL, this._checkDockDwell.bind(this));
            this._dockDwelling = false;
            this._dockDwellUserTime = 0;
        }
    }

    _checkDockDwell(x, y) {
        const workArea = Main.layoutManager.getWorkAreaForMonitor(this._monitor.index);
        let shouldDwell;
        // Check for the correct screen edge, extending the sensitive area to the whole workarea,
        // minus 1 px to avoid conflicting with other active corners.
        if (this._position === St.Side.LEFT) {
            shouldDwell = (x === this._monitor.x) && (y > workArea.y) &&
                (y < workArea.y + workArea.height);
        } else if (this._position === St.Side.RIGHT) {
            shouldDwell = (x === this._monitor.x + this._monitor.width - 1) &&
                (y > workArea.y) && (y < workArea.y + workArea.height);
        } else if (this._position === St.Side.TOP) {
            shouldDwell = (y === this._monitor.y) && (x > workArea.x) &&
                (x < workArea.x + workArea.width);
        } else if (this._position === St.Side.BOTTOM) {
            shouldDwell = (y === this._monitor.y + this._monitor.height - 1) &&
                (x > workArea.x) && (x < workArea.x + workArea.width);
        }

        if (shouldDwell) {
            // We only set up dwell timeout when the user is not hovering over the dock
            // already (!this._box.hover).
            // The _dockDwelling variable is used so that we only try to
            // fire off one dock dwell - if it fails (because, say, the user has the mouse down),
            // we don't try again until the user moves the mouse up and down again.
            if (!this._dockDwelling && !this._box.hover && (this._dockDwellTimeoutId === 0)) {
                // Save the interaction timestamp so we can detect user input
                const focusWindow = global.display.focus_window;
                this._dockDwellUserTime = focusWindow ? focusWindow.user_time : 0;

                this._dockDwellTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    DockManager.settings.showDelay * 1000,
                    this._dockDwellTimeout.bind(this));
                GLib.Source.set_name_by_id(this._dockDwellTimeoutId,
                    '[xdock] this._dockDwellTimeout');
            }
            this._dockDwelling = true;
        } else {
            this._cancelDockDwell();
            this._dockDwelling = false;
        }
    }

    _cancelDockDwell() {
        if (this._dockDwellTimeoutId !== 0) {
            GLib.source_remove(this._dockDwellTimeoutId);
            this._dockDwellTimeoutId = 0;
        }
    }

    _dockDwellTimeout() {
        this._dockDwellTimeoutId = 0;

        if (!DockManager.settings.autohideInFullscreen &&
            this._monitor.inFullscreen)
            return GLib.SOURCE_REMOVE;

        // We don't want to open the tray when a modal dialog
        // is up, so we check the modal count for that. When we are in the
        // overview we have to take the overview's modal push into account
        if (Main.modalCount > (Main.overview.visible ? 1 : 0))
            return GLib.SOURCE_REMOVE;

        // If the user interacted with the focus window since we started the tray
        // dwell (by clicking or typing), don't activate the message tray
        const focusWindow = global.display.focus_window;
        const currentUserTime = focusWindow ? focusWindow.user_time : 0;
        if (currentUserTime !== this._dockDwellUserTime)
            return GLib.SOURCE_REMOVE;

        // Reuse the pressure version function, the logic is the same
        this._onPressureSensed();
        return GLib.SOURCE_REMOVE;
    }

    _updatePressureBarrier() {
        const {settings} = DockManager;
        this._canUsePressure = Utils.supportsExtendedBarriers();
        const {pressureThreshold} = settings;

        // Remove existing pressure barrier
        if (this._pressureBarrier) {
            this._pressureBarrier.disconnectObject(this);
            this._pressureBarrier.destroy();
            this._pressureBarrier = null;
        }

        if (this._barrier) {
            this._barrier.destroy();
            this._barrier = null;
        }

        // Create new pressure barrier based on pressure threshold setting
        if (this._canUsePressure && this._autohideIsEnabled &&
            DockManager.settings.requirePressureToShow) {
            this._pressureBarrier = new Layout.PressureBarrier(
                pressureThreshold, settings.showDelay * 1000,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
            this._pressureBarrier.connectObject('trigger', () => {
                if (!settings.autohideInFullscreen && this._monitor.inFullscreen)
                    return;
                this._onPressureSensed();
            }, this);
        }
    }

    /**
     * handler for mouse pressure sensed
     */
    _onPressureSensed() {
        if (Main.overview.visibleTarget)
            return;

        if (this._triggerTimeoutId)
            GLib.source_remove(this._triggerTimeoutId);

        // In case the mouse move away from the dock area before hovering it,
        // in such case the leave event would never be triggered and the dock
        // would stay visible forever.
        this._triggerTimeoutId =  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            const [x, y, mods_] = global.get_pointer();
            let shouldHide = true;
            switch (this._position) {
            case St.Side.LEFT:
                if (x <= this._staticBox.x2 &&
                    x >= this._monitor.x &&
                    y >= this._monitor.y &&
                    y <= this._monitor.y + this._monitor.height)
                    shouldHide = false;

                break;
            case St.Side.RIGHT:
                if (x >= this._staticBox.x1 &&
                    x <= this._monitor.x + this._monitor.width &&
                    y >= this._monitor.y &&
                    y <= this._monitor.y + this._monitor.height)
                    shouldHide = false;

                break;
            case St.Side.TOP:
                if (x >= this._monitor.x &&
                    x <= this._monitor.x + this._monitor.width &&
                    y <= this._staticBox.y2 &&
                    y >= this._monitor.y)
                    shouldHide = false;

                break;
            case St.Side.BOTTOM:
                if (x >= this._monitor.x &&
                    x <= this._monitor.x + this._monitor.width &&
                    y >= this._staticBox.y1 &&
                    y <= this._monitor.y + this._monitor.height)
                    shouldHide = false;
            }
            if (shouldHide) {
                this._triggerTimeoutId = 0;
                this._hoverChanged();
                return GLib.SOURCE_REMOVE;
            } else {
                return GLib.SOURCE_CONTINUE;
            }
        });

        this._show();
    }

    /**
     * Remove pressure barrier
     */
    _removeBarrier() {
        if (this._barrier) {
            if (this._pressureBarrier)
                this._pressureBarrier.removeBarrier(this._barrier);
            this._barrier.destroy();
            this._barrier = null;
        }
        this._removeBarrierTimeoutId = 0;
        return false;
    }

    /**
     * Update pressure barrier size
     */
    _updateBarrier() {
        // Remove existing barrier
        this._removeBarrier();

        // The barrier needs to be removed in fullscreen with autohide disabled
        // otherwise the mouse can get trapped on monitor.
        if (this._monitor.inFullscreen &&
            !DockManager.settings.autohideInFullscreen)
            return;

        // Manually reset pressure barrier
        // This is necessary because we remove the pressure barrier when it is
        // triggered to show the dock.
        // _reset()/_isTriggered are private Layout.PressureBarrier internals; guard
        // them so a future Shell rename disables the reset instead of throwing.
        if (this._pressureBarrier && typeof this._pressureBarrier._reset === 'function') {
            this._pressureBarrier._reset();
            this._pressureBarrier._isTriggered = false;
        }

        // Create new barrier
        // The barrier extends to the whole workarea, minus 1 px to avoid
        // conflicting with other active corners
        // Note: dash in fixed position doesn't use pressure barrier.
        if (this._canUsePressure && this._autohideIsEnabled &&
            DockManager.settings.requirePressureToShow) {
            let x1, x2, y1, y2, direction;
            const workArea = Main.layoutManager.getWorkAreaForMonitor(
                this._monitor.index);

            if (this._position === St.Side.LEFT) {
                x1 = this._monitor.x + 1;
                x2 = x1;
                y1 = workArea.y + 1;
                y2 = workArea.y + workArea.height - 1;
                direction = Meta.BarrierDirection.POSITIVE_X;
            } else if (this._position === St.Side.RIGHT) {
                x1 = this._monitor.x + this._monitor.width - 1;
                x2 = x1;
                y1 = workArea.y + 1;
                y2 = workArea.y + workArea.height - 1;
                direction = Meta.BarrierDirection.NEGATIVE_X;
            } else if (this._position === St.Side.TOP) {
                x1 = workArea.x + 1;
                x2 = workArea.x + workArea.width - 1;
                y1 = this._monitor.y;
                y2 = y1;
                direction = Meta.BarrierDirection.POSITIVE_Y;
            } else if (this._position === St.Side.BOTTOM) {
                x1 = workArea.x + 1;
                x2 = workArea.x + workArea.width - 1;
                y1 = this._monitor.y + this._monitor.height;
                y2 = y1;
                direction = Meta.BarrierDirection.NEGATIVE_Y;
            }

            if (this._pressureBarrier && this._dockState === State.HIDDEN) {
                this._barrier = new Meta.Barrier({
                    backend: global.backend,
                    x1,
                    x2,
                    y1,
                    y2,
                    directions: direction,
                });
                this._pressureBarrier.addBarrier(this._barrier);
            }
        }
    }

    _isPrimaryMonitor() {
        return this.monitorIndex === Main.layoutManager.primaryIndex;
    }

    _resetPosition() {
        // Ensure variables linked to settings are updated.
        this._updateVisibilityMode();

        const {dockFixed: fixedIsEnabled, dockExtended: extendHeight} = DockManager.settings;

        if (fixedIsEnabled)
            this.add_style_class_name('fixed');
        else
            this.remove_style_class_name('fixed');

        // Note: do not use the workarea coordinates in the direction on which the dock is placed,
        // to avoid a loop [position change -> workArea change -> position change] with
        // fixed dock.
        const workArea = Main.layoutManager.getWorkAreaForMonitor(this.monitorIndex);

        let fraction = DockManager.settings.heightFraction;
        if (extendHeight)
            fraction = 1;
        else if ((fraction < 0) || (fraction > 1))
            fraction = 0.95;

        if (this._isHorizontal) {
            this.width = Math.round(fraction * workArea.width);

            let posY = this._monitor.y;
            if (this._position === St.Side.BOTTOM)
                posY += this._monitor.height;

            this.x = workArea.x + Math.round((1 - fraction) / 2 * workArea.width);
            this.y = posY;

            if (extendHeight) {
                this.dash._container.set_width(this.width);
                this.add_style_class_name('extended');
            } else {
                this.dash._container.set_width(-1);
                this.remove_style_class_name('extended');
            }
        } else {
            this.height = Math.round(fraction * workArea.height);

            let posX = this._monitor.x;
            if (this._position === St.Side.RIGHT)
                posX += this._monitor.width;

            this.x = posX;
            this.y = workArea.y + Math.round((1 - fraction) / 2 * workArea.height);

            if (extendHeight) {
                this.dash._container.set_height(this.height);
                this.add_style_class_name('extended');
            } else {
                this.dash._container.set_height(-1);
                this.remove_style_class_name('extended');
            }
        }
    }

    _updateVisibleDesktop() {
        if (!this._intellihideIsEnabled)
            return;

        const {desktopIconsUsableArea} = DockManager.getDefault();
        if (this._position === St.Side.BOTTOM)
            desktopIconsUsableArea.setMargins(this.monitorIndex, 0, this._box.height, 0, 0);
        else if (this._position === St.Side.TOP)
            desktopIconsUsableArea.setMargins(this.monitorIndex, this._box.height, 0, 0, 0);
        else if (this._position === St.Side.RIGHT)
            desktopIconsUsableArea.setMargins(this.monitorIndex, 0, 0, 0, this._box.width);
        else if (this._position === St.Side.LEFT)
            desktopIconsUsableArea.setMargins(this.monitorIndex, 0, 0, this._box.width, 0);
    }

    _updateStaticBox() {
        this._staticBox.init_rect(
            this.x + this._slider.x - (this._position === St.Side.RIGHT ? this._box.width : 0),
            this.y + this._slider.y - (this._position === St.Side.BOTTOM ? this._box.height : 0),
            this._box.width,
            this._box.height
        );

        this._intellihide.updateTargetBox(this._staticBox);
        this._updateVisibleDesktop();
    }

    _removeAnimations() {
        this._motionController.cancel();
    }

    _onDragStart() {
        this._oldIgnoreHover = this._ignoreHover;
        this._ignoreHover = true;
        this._animateIn(DockManager.settings.animationTime, 0);
    }

    _onDragEnd() {
        if (this._oldIgnoreHover)
            this._ignoreHover = this._oldIgnoreHover;
        this._oldIgnoreHover = null;
        this._box.sync_hover();
        this._updateDashVisibility();
    }

    /**
     * Show dock and give key focus to it
     */
    _onAccessibilityFocus(timestamp) {
        if (!Main.overview.visible)
            global.display.unset_input_focus(timestamp);
        this._box.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        this._animateIn(DockManager.settings.animationTime, 0);
    }

    // Optional features to be enabled only for the main Dock
    _enableExtraFeatures() {
        // Restore dash accessibility
        Main.ctrlAltTabManager.addGroup(
            this.dash, _('Dash'), 'user-bookmarks-symbolic',
            {focusCallback: timestamp => this._onAccessibilityFocus(timestamp)});
    }

    /**
     * Switch workspace by scrolling over the dock
     */
    _optionalScrollWorkspaceSwitch() {
        const isEnabled = () =>
            DockManager.settings.scrollAction === scrollAction.SWITCH_WORKSPACE;

        const enable = () => {
            this._signalsHandler.removeWithLabel(Labels.WORKSPACE_SWITCH_SCROLL);

            this._signalsHandler.addWithLabel(Labels.WORKSPACE_SWITCH_SCROLL,
                this._box, 'scroll-event', (_, e) => onScrollEvent(e));
        };

        const disable = () => {
            this._signalsHandler.removeWithLabel(Labels.WORKSPACE_SWITCH_SCROLL);

            if (this._optionalScrollWorkspaceSwitchDeadTimeId) {
                GLib.source_remove(this._optionalScrollWorkspaceSwitchDeadTimeId);
                this._optionalScrollWorkspaceSwitchDeadTimeId = 0;
            }
        };

        if (isEnabled())
            enable();
        else
            disable();

        // This was inspired to desktop-scroller@obsidien.github.com
        const onScrollEvent = event => {
            // When in overview change workspace only in windows view
            if (Main.overview.visible)
                return false;

            const activeWs = global.workspace_manager.get_active_workspace();
            let direction = null;

            let prevDirection, nextDirection;
            if (global.workspace_manager.layout_columns > global.workspace_manager.layout_rows) {
                prevDirection = Meta.MotionDirection.UP;
                nextDirection = Meta.MotionDirection.DOWN;
            } else {
                prevDirection = Meta.MotionDirection.LEFT;
                nextDirection = Meta.MotionDirection.RIGHT;
            }

            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                direction = prevDirection;
                break;
            case Clutter.ScrollDirection.DOWN:
                direction = nextDirection;
                break;
            case Clutter.ScrollDirection.SMOOTH: {
                const [dx_, dy] = event.get_scroll_delta();
                if (dy < 0)
                    direction = prevDirection;
                else if (dy > 0)
                    direction = nextDirection;
            }
                break;
            }

            if (direction) {
                // Prevent scroll events from triggering too many workspace switches
                // by adding a 250ms dead time between each scroll event.
                // Useful on laptops when using a touch pad.

                // During the deadtime do nothing
                if (this._optionalScrollWorkspaceSwitchDeadTimeId) {
                    return false;
                } else {
                    this._optionalScrollWorkspaceSwitchDeadTimeId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, 250, () => {
                            this._optionalScrollWorkspaceSwitchDeadTimeId = 0;
                        });
                }

                let ws;

                ws = activeWs.get_neighbor(direction);

                if (!Main.wm._workspaceSwitcherPopup) {
                    // Support Workspace Grid extension showing their custom
                    // Grid Workspace Switcher
                    if (global.workspace_manager.workspace_grid !== undefined) {
                        Main.wm._workspaceSwitcherPopup =
                            global.workspace_manager.workspace_grid.getWorkspaceSwitcherPopup();
                    } else {
                        Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
                        this._workspaceSwitcherPopup = Main.wm._workspaceSwitcherPopup;

                        this._signalsHandler.add(Main.wm._workspaceSwitcherPopup, 'destroy', actor => {
                            delete this._workspaceSwitcherPopup;
                            if (Main.wm._workspaceSwitcherPopup === actor)
                                delete Main.wm._workspaceSwitcherPopup;
                        });
                    }
                }
                // Set the actor non reactive, so that it doesn't prevent the
                // clicks events from reaching the dash actor. I can't see a reason
                // why it should be reactive.
                Main.wm._workspaceSwitcherPopup.reactive = false;

                // If Workspace Grid is installed, let them handle the scroll behavior.
                if (global.workspace_manager.workspace_grid !== undefined)
                    ws = global.workspace_manager.workspace_grid.actionMoveWorkspace(direction);
                else
                    Main.wm.actionMoveWorkspace(ws);

                // Do not show workspaceSwitcher in overview
                if (!Main.overview.visible)
                    Main.wm._workspaceSwitcherPopup.display(ws.index());

                return true;
            } else {
                return false;
            }
        };
    }

    _activateApp(appIndex) {
        const children = this.dash._box.get_children().filter(actor => {
            return actor.child &&
                       actor.child.app;
        });

        // Apps currently in the dash
        const apps = children.map(actor => {
            return actor.child;
        });

        // Activate with button = 1, i.e. same as left click
        const button = 1;
        if (appIndex < apps.length)
            apps[appIndex].activate(button);
    }
});

/*
 * Handle keyboard shortcuts
 */
const NUM_HOTKEYS = 10;

const KeyboardShortcuts = class XDockKeyboardShortcuts {
    constructor() {
        this._signalsHandler = null;
        this._registeredKeybindings = new Set();
        this._hotKeysEnabled = false;
        this._shortcutIsSet = false;
        this._lifecycle = new LifecycleState(
            'keyboard shortcuts',
            () => this._cleanup(),
            (error, operation) => logError(error, `Destroying ${operation}`));
    }

    enable() {
        this._lifecycle.enable(() => this._initialize());
    }

    _initialize() {
        this._signalsHandler = new Utils.GlobalSignalsHandler();
        if (DockManager.settings.hotKeys)
            this._enableHotKeys();

        this._signalsHandler.add([
            DockManager.settings,
            'changed::hot-keys',
            () => {
                if (DockManager.settings.hotKeys)
                    this._enableHotKeys.bind(this)();
                else
                    this._disableHotKeys.bind(this)();
            },
        ]);

        this._optionalNumberOverlay();
    }

    destroy() {
        return this._lifecycle.destroy();
    }

    _cleanup() {
        return runCleanupTasks([
            ['number overlays', () => {
                for (const dock of DockManager.getDefault()?._allDocks ?? []) {
                    if (dock._numberOverlayTimeoutId)
                        GLib.source_remove(dock._numberOverlayTimeoutId);
                    delete dock._numberOverlayTimeoutId;
                }
            }],
            ['keybindings', () => this._removeRegisteredKeybindings()],
            ['shortcut signals', () => this._signalsHandler?.destroy()],
        ], (error, operation) =>
            logError(error, `Destroying keyboard shortcuts ${operation}`));
    }

    _addKeybinding(name, callback) {
        // Record ownership before calling into Shell. If Shell throws after
        // registering the binding, lifecycle rollback still knows to remove it.
        this._registeredKeybindings.add(name);
        Main.wm.addKeybinding(name, DockManager.settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            callback);
    }

    _removeRegisteredKeybindings(filter = () => true) {
        return runCleanupTasks(
            [...this._registeredKeybindings]
                .filter(filter)
                .map(name => [name, () => {
                    Main.wm.removeKeybinding(name);
                    this._registeredKeybindings.delete(name);
                }]),
            (error, name) => logError(error, `Removing keybinding ${name}`));
    }

    _enableHotKeys() {
        if (this._hotKeysEnabled)
            return;

        // Setup keyboard bindings for dash elements
        const keys = ['app-hotkey-', 'app-shift-hotkey-', 'app-ctrl-hotkey-'];
        const {mainDock} = DockManager.getDefault();
        keys.forEach(function (key) {
            for (let i = 0; i < NUM_HOTKEYS; i++) {
                const appNum = i;
                this._addKeybinding(key + (i + 1),
                    () => {
                        mainDock._activateApp(appNum);
                        this._showOverlay();
                    });
            }
        }, this);

        this._hotKeysEnabled = true;
    }

    _disableHotKeys() {
        const errors = this._removeRegisteredKeybindings(name => name !== 'shortcut');
        if (!this._hotKeysEnabled && errors.length === 0)
            return;

        if (errors.length)
            throw errors[0].error;
        this._hotKeysEnabled = false;
    }

    _optionalNumberOverlay() {
        const {settings} = DockManager;
        // Enable extra shortcut if either 'overlay' or 'show-dock' are true
        if (settings.hotKeys &&
           (settings.hotkeysOverlay || settings.hotkeysShowDock))
            this._enableExtraShortcut();

        this._signalsHandler.add([
            settings,
            'changed::hot-keys',
            this._checkHotkeysOptions.bind(this),
        ], [
            settings,
            'changed::hotkeys-overlay',
            this._checkHotkeysOptions.bind(this),
        ], [
            settings,
            'changed::hotkeys-show-dock',
            this._checkHotkeysOptions.bind(this),
        ]);
    }

    _checkHotkeysOptions() {
        const {settings} = DockManager;

        if (settings.hotKeys &&
           (settings.hotkeysOverlay || settings.hotkeysShowDock))
            this._enableExtraShortcut();
        else
            this._disableExtraShortcut();
    }

    _enableExtraShortcut() {
        if (!this._shortcutIsSet) {
            this._addKeybinding('shortcut', this._showOverlay.bind(this));
            this._shortcutIsSet = true;
        }
    }

    _disableExtraShortcut() {
        if (!this._shortcutIsSet && !this._registeredKeybindings.has('shortcut'))
            return;

        const errors = this._removeRegisteredKeybindings(name => name === 'shortcut');
        if (errors.length)
            throw errors[0].error;
        this._shortcutIsSet = false;
    }

    _showOverlay() {
        for (const dock of DockManager.allDocks) {
            if (DockManager.settings.hotkeysOverlay)
                dock.dash.toggleNumberOverlay(true);

            // Restart the counting if the shortcut is pressed again
            if (dock._numberOverlayTimeoutId) {
                GLib.source_remove(dock._numberOverlayTimeoutId);
                dock._numberOverlayTimeoutId = 0;
            }

            // Hide the overlay/dock after the timeout
            const timeout = DockManager.settings.shortcutTimeout * 1000;
            dock._numberOverlayTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, timeout, () => {
                    dock._numberOverlayTimeoutId = 0;
                    dock.dash.toggleNumberOverlay(false);
                    // Hide the dock again if necessary
                    dock._updateDashVisibility();
                });

            // Show the dock if it is hidden
            if (DockManager.settings.hotkeysShowDock) {
                const showDock = dock._intellihideIsEnabled || dock._autohideIsEnabled;
                if (showDock)
                    dock._show();
            }
        }
    }
};

/**
 * Isolate overview to open new windows for inactive apps
 * Note: the future implementation is not fully contained here.
 * Some bits are around in other methods of other classes.
 * This class just take care of enabling/disabling the option.
 */
const WorkspaceIsolation = class XDockWorkspaceIsolation {
    constructor() {
        this._signalsHandler = null;
        this._injectionsHandler = null;
        this._lifecycle = new LifecycleState(
            'workspace isolation',
            () => this._cleanup(),
            (error, operation) => logError(error, `Destroying ${operation}`));
    }

    enable() {
        this._lifecycle.enable(() => this._initialize());
    }

    _initialize() {
        const {settings} = DockManager;

        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._injectionsHandler = new Utils.InjectionsHandler();

        const updateAllDocks = () => {
            DockManager.allDocks.forEach(dock =>
                dock.dash.resetAppIcons());
            if (settings.isolateWorkspaces ||
                settings.isolateMonitors)
                this._enable.bind(this)();
            else
                this._disable.bind(this)();
        };
        this._signalsHandler.add(
            [settings, 'changed::isolate-workspaces', updateAllDocks],
            [settings, 'changed::workspace-agnostic-urgent-windows', updateAllDocks],
            [settings, 'changed::isolate-monitors', updateAllDocks]
        );

        if (settings.isolateWorkspaces ||
            settings.isolateMonitors)
            this._enable();
    }

    _enable() {
        // ensure I never double-register/inject
        // although it should never happen
        this._disable();

        DockManager.allDocks.forEach(dock => {
            global.display.connectObject('restacked',
                () => dock.dash._queueRedisplay(), dock.dash);
            global.display.connectObject('window-marked-urgent',
                () => dock.dash._queueRedisplay(), dock.dash);
            global.display.connectObject('window-demands-attention',
                () => dock.dash._queueRedisplay(), dock.dash);
            global.window_manager.connectObject('switch-workspace',
                () => dock.dash._queueRedisplay(), dock.dash);

            // This last signal is only needed for monitor isolation, as windows
            // might migrate from one monitor to another without triggering 'restacked'
            if (DockManager.settings.isolateMonitors) {
                global.display.connectObject('window-entered-monitor',
                    () => dock.dash._queueRedisplay(), dock.dash);
            }
        });

        /**
         * here this is the Shell.App
         */
        function IsolatedOverview() {
            // These lines take care of Nautilus for icons on Desktop
            const activeWorkspaceIndex =
                global.workspaceManager.get_active_workspace_index();
            const windows = this.get_windows().filter(w =>
                !w.skipTaskbar && w.get_workspace().index() === activeWorkspaceIndex);

            if (windows.length)
                return Main.activateWindow(windows[0]);
            return this.open_new_window(-1);
        }

        this._injectionsHandler.addWithLabel(Labels.ISOLATION,
            Shell.App.prototype,
            'activate',
            IsolatedOverview);
    }

    _disable(bestEffort = false) {
        const docks = [...DockManager.getDefault()?._allDocks ?? []];
        const errors = runCleanupTasks([
            ...docks.flatMap((dock, index) => [
                [`dock ${index + 1} display signals`, () =>
                    global.display.disconnectObject(dock.dash)],
                [`dock ${index + 1} window-manager signals`, () =>
                    global.window_manager.disconnectObject(dock.dash)],
            ]),
            ['activation injection', () =>
                this._injectionsHandler?.removeWithLabel(Labels.ISOLATION)],
        ], (error, operation) =>
            logError(error, `Disabling workspace isolation ${operation}`));

        if (!bestEffort && errors.length)
            throw errors[0].error;
        return errors;
    }

    destroy() {
        return this._lifecycle.destroy();
    }

    _cleanup() {
        return runCleanupTasks([
            ['isolation state', () => this._disable(true)],
            ['isolation settings signals', () => this._signalsHandler?.destroy()],
            ['isolation injections', () => this._injectionsHandler?.destroy()],
        ], (error, operation) =>
            logError(error, `Destroying workspace isolation ${operation}`));
    }
};


export class DockManager {
    constructor(extension, {
        shellApi = DEFAULT_SHELL_API,
        capabilityProbe = probeShellCapabilities,
        onFailClosed = null,
    } = {}) {
        if (DockManager._singleton)
            throw new Error('XDock has been already initialized');

        // A previous teardown can retain a failed hasOverview restoration
        // independently of its destroyed manager. Repair that state before a
        // new manager is allowed to capture or temporarily change it again.
        const pendingRestorationErrors = retryPendingRestorations(error =>
            logError(error, 'Restoring detached startup overview state'));
        if (pendingRestorationErrors.length)
            throw pendingRestorationErrors[0].error;

        // This must run before the provisional singleton, settings handlers,
        // child constructors, stock Dash visibility, or overview injections.
        // Unsupported Shells therefore retain the untouched stock overview.
        runShellCapabilityGate(shellApi, () => {}, report => {
            throw new UnsupportedShellError(report);
        }, capabilityProbe);

        this._destroyed = false;
        this._destroying = false;
        this._capabilityFailureLogged = false;
        this._shellApi = shellApi;
        this._capabilityProbe = capabilityProbe;
        this._onFailClosed = onFailClosed;
        this._mainDashPrepared = false;
        this._allDocks = [];
        this._extension = extension;
        this._startupOverviewOverride = new RestorableValue(
            () => Main.sessionMode.hasOverview,
            value => (Main.sessionMode.hasOverview = value));
        // Replacing docks from BEFORE_REDRAW can invalidate actors already in
        // Clutter's layout snapshot. Own the replacement in a normal idle.
        this._toggleTask = new DeferredTask(
            callback => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            id => GLib.source_remove(id));

        // Some child constructors use the static DockManager accessors. Publish
        // provisionally, then synchronously roll back on every initialization
        // failure so a failed enable cannot poison the rest of the Shell session.
        DockManager._singleton = this;

        try {
            this._initialize();
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    _initialize() {
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._methodInjections = new Utils.InjectionsHandler(this);
        this._vfuncInjections = new Utils.VFuncInjectionsHandler(this);
        this._propertyInjections = new Utils.PropertyInjectionsHandler(this);
        this._settings = this._extension.getSettings(
            'org.gnome.shell.extensions.xdock');
        this._appSwitcherSettings = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});
        this._mapSettingsValues();

        this._iconTheme = new St.IconTheme();

        this._desktopIconsUsableArea =
            new DesktopIconsIntegration.DesktopIconsUsableAreaClass(this._extension);
        this._oldDash = Main.overview.isDummy ? null : Main.overview.dash;
        this._discreteGpuAvailable = AppDisplay.discreteGpuAvailable;
        this._appSpread = new AppSpread.AppSpread();
        this._appLauncher = new AppLauncher.AppGridLauncher();
        this._notificationsMonitor = new NotificationsMonitor.NotificationsMonitor();

        const needsRemoteModel = () =>
            !this._notificationsMonitor.dndMode && this._settings.showIconsEmblems;

        const ensureRemoteModel = () => {
            const shouldHaveRemoteModel = needsRemoteModel();
            if (shouldHaveRemoteModel && !this._remoteModel) {
                this._remoteModel = new LauncherAPI.LauncherEntryRemoteModel();
                this._appIconsDecorator = new AppIconsDecorator.AppIconsDecorator();
            } else if (!shouldHaveRemoteModel) {
                this._remoteModel?.destroy();
                delete this._remoteModel;
                this._appIconsDecorator?.destroy();
                delete this._appIconsDecorator;
            }
        };
        ensureRemoteModel();

        this._signalsHandler.add(this._notificationsMonitor, 'state-changed',
            () => ensureRemoteModel());
        this._signalsHandler.add(this._settings, 'changed::show-icons-emblems',
            () => ensureRemoteModel());

        if (this._discreteGpuAvailable === undefined) {
            const updateDiscreteGpuAvailable = () => {
                const switcherooProxy = global.get_switcheroo_control();
                if (switcherooProxy) {
                    const prop = switcherooProxy.get_cached_property('HasDualGpu');
                    this._discreteGpuAvailable = prop?.unpack() ?? false;
                } else {
                    this._discreteGpuAvailable = false;
                }
            };
            this._signalsHandler.add(global, 'notify::switcheroo-control',
                () => updateDiscreteGpuAvailable());
            updateDiscreteGpuAvailable();
        }

        // Connect relevant signals to the toggling function
        this._bindSettingsChanges();

        this._ensureLocations();

        this._createDocks();

        this._overrideAppMenus();

        // status variable: true when the overview is shown through the dash
        // applications button.
        this._forcedOverview = false;
    }

    static getDefault() {
        return DockManager._singleton;
    }

    static get allDocks() {
        return DockManager.getDefault()._allDocks;
    }

    static get extension() {
        return DockManager.getDefault().extension;
    }

    static get settings() {
        return DockManager.getDefault().settings;
    }

    get extension() {
        return this._extension;
    }

    get settings() {
        return this._settings;
    }

    static get iconTheme() {
        return DockManager.getDefault().iconTheme;
    }

    get iconTheme() {
        return this._iconTheme;
    }

    get fm1Client() {
        return this._fm1Client;
    }

    get remoteModel() {
        return this._remoteModel;
    }

    get mainDock() {
        return this._allDocks[0] ?? null;
    }

    get removables() {
        return this._removables;
    }

    get trash() {
        return this._trash;
    }

    get desktopIconsUsableArea() {
        return this._desktopIconsUsableArea;
    }

    get discreteGpuAvailable() {
        return AppDisplay.discreteGpuAvailable || this._discreteGpuAvailable;
    }

    get appSpread() {
        return this._appSpread;
    }

    get notificationsMonitor() {
        return this._notificationsMonitor;
    }

    _runCleanupTasks(tasks) {
        return runCleanupTasks(tasks,
            (error, operation) => logError(error, `XDock cleanup: ${operation}`));
    }

    getDockByMonitor(monitorIndex) {
        return this._allDocks.find(d => d.monitorIndex === monitorIndex);
    }

    _ensureLocations() {
        const {showMounts, showTrash} = this.settings;

        if (showTrash || showMounts) {
            if (!this._fm1Client)
                this._fm1Client = new FileManager1API.FileManager1Client();
        } else if (this._fm1Client) {
            this._fm1Client.destroy();
            this._fm1Client = null;
        }

        if (showMounts && !this._removables) {
            this._removables = new Locations.Removables();
        } else if (!showMounts && this._removables) {
            this._removables.destroy();
            this._removables = null;
        }

        if (showTrash && !this._trash) {
            this._trash = new Locations.Trash();
        } else if (!showTrash && this._trash) {
            this._trash.destroy();
            this._trash = null;
        }

        Locations.unWrapFileManagerApp();
        [this._methodInjections, this._propertyInjections].forEach(
            injections => injections.removeWithLabel(Labels.LOCATIONS));

        if (showMounts || showTrash) {
            if (this.settings.isolateLocations) {
                const fileManagerApp = Locations.wrapFileManagerApp();

                this._methodInjections.addWithLabel(Labels.LOCATIONS, [
                    Shell.AppSystem.prototype, 'get_running',
                    function (originalMethod, ...args) {
                        /* eslint-disable no-invalid-this */
                        const runningApps = originalMethod.call(this, ...args);
                        const locationApps = Locations.getRunningApps();
                        if (!locationApps.length)
                            return runningApps;

                        const fileManagerIdx = runningApps.indexOf(fileManagerApp);
                        if (fileManagerIdx > -1 && fileManagerApp?.state !== Shell.AppState.RUNNING)
                            runningApps.splice(fileManagerIdx, 1);

                        return [...runningApps, ...locationApps].sort(Utils.shellAppCompare);
                        /* eslint-enable no-invalid-this */
                    },
                ],
                [
                    Shell.WindowTracker.prototype, 'get_window_app',
                    function (originalMethod, window) {
                        /* eslint-disable no-invalid-this */
                        const locationApp = Locations.getRunningApps().find(a =>
                            a.get_windows().includes(window));
                        return locationApp ?? originalMethod.call(this, window);
                        /* eslint-enable no-invalid-this */
                    },
                ],
                [
                    Shell.WindowTracker.prototype, 'get_app_from_pid',
                    function (originalMethod, pid) {
                        /* eslint-disable no-invalid-this */
                        const locationApp = Locations.getRunningApps().find(a =>
                            a.get_pids().includes(pid));
                        return locationApp ?? originalMethod.call(this, pid);
                        /* eslint-enable no-invalid-this */
                    },
                ]);

                const {get: defaultFocusAppGetter} = Object.getOwnPropertyDescriptor(
                    Shell.WindowTracker.prototype, 'focus_app');
                this._propertyInjections.addWithLabel(Labels.LOCATIONS,
                    Shell.WindowTracker.prototype, 'focus_app', {
                        get() {
                            const locationApp = Locations.getRunningApps().find(a => a.isFocused);
                            return locationApp ?? defaultFocusAppGetter.call(this);
                        },
                    });
            }
        }
    }

    _toggle() {
        if (this._destroying || this._destroyed)
            return;

        this._toggleTask.schedule(() => {
            if (this._destroying || this._destroyed)
                return;

            const supported = runShellCapabilityGate(this._shellApi,
                () => true,
                report => {
                    this._failClosedForUnsupportedShell(report);
                    return false;
                }, this._capabilityProbe);
            if (!supported)
                return;

            this._restoreDash();
            if (this._destroying || this._destroyed)
                return;

            this._deleteDocks();
            if (this._destroying || this._destroyed)
                return;

            try {
                this._createDocks();
            } catch (error) {
                if (!(error instanceof UnsupportedShellError))
                    throw error;

                // The mutation-boundary probe can observe a session-mode
                // replacement that raced the first probe above. At this point
                // the previous custom docks are already gone and stock Dash is
                // restored, so tear down the remaining manager state as well.
                this._failClosedForUnsupportedShell(error.report);
                return;
            }
            if (this._destroying || this._destroyed)
                return;

            this.emit('toggled');
        });
    }

    _mapExternalSetting(settings, key, mappedKey, mapValueFunction) {
        const camelMappedKey = mappedKey.replace(/-([a-z\d])/g, k => k[1].toUpperCase());

        const dockPropertyDesc = Object.getOwnPropertyDescriptor(this.settings, camelMappedKey);

        if (!dockPropertyDesc)
            throw new Error('Setting %s not found in dock'.format(mappedKey));

        const mappedValue = () => mapValueFunction(settings.get_value(key).recursiveUnpack());
        Object.defineProperty(this.settings, camelMappedKey, {
            get: () => mappedValue() ?? dockPropertyDesc.value,
            set: value => {
                if (mappedValue())
                    dockPropertyDesc.value = value;
            },
        });

        this._signalsHandler.addWithLabel(Labels.SETTINGS, settings,
            'changed::%s'.format(key), () => {
                try {
                    this._signalsHandler.blockWithLabel(Labels.SETTINGS);
                    this.settings.emit('changed::%s'.format(mappedKey), mappedKey);
                } finally {
                    this._signalsHandler.unblockWithLabel(Labels.SETTINGS);
                }
            });
    }

    _mapSettingsValues() {
        this.settings.settingsSchema.list_keys().forEach(key => {
            const camelKey = key.replace(/-([a-z\d])/g, k => k[1].toUpperCase());
            const updateSetting = () => {
                const schemaKey = this.settings.settingsSchema.get_key(key);
                if (schemaKey.get_range().deepUnpack()[0] === 'enum')
                    this.settings[camelKey] = this.settings.get_enum(key);
                else
                    this.settings[camelKey] = this.settings.get_value(key).recursiveUnpack();
            };
            updateSetting();
            this._signalsHandler.addWithLabel(Labels.SETTINGS, this.settings,
                `changed::${key}`, updateSetting);
            if (key !== camelKey) {
                Object.defineProperty(this.settings, key,
                    {get: () => this.settings[camelKey]});
            }
        });
        Object.defineProperties(this.settings, {
            dockExtended: {get: () => this.settings.extendHeight},
        });
    }

    _bindSettingsChanges() {
        // Connect relevant signals to the toggling function
        this._signalsHandler.addWithLabel(Labels.SETTINGS, [
            Utils.getMonitorManager(),
            'monitors-changed',
            this._toggle.bind(this),
        ], [
            Main.sessionMode,
            'updated',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::multi-monitor',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::preferred-monitor',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::preferred-monitor-by-connector',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::dock-position',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::extend-height',
            () => this._adjustPanelCorners(),
        ], [
            this._settings,
            'changed::dock-fixed',
            () => this._adjustPanelCorners(),
        ], [
            this._settings,
            'changed::show-trash',
            () => this._ensureLocations(),
        ], [
            this._settings,
            'changed::show-mounts',
            () => this._ensureLocations(),
        ], [
            this._settings,
            'changed::isolate-locations',
            () => this._ensureLocations(),
        ], [
            this._settings,
            'changed::intellihide',
            () => {
                if (!this._settings.intellihide)
                    this._desktopIconsUsableArea.resetMargins();
            },
        ], [
            this._settings,
            'changed::show-apps-action',
            () => {
                this._allDocks.forEach(dock => this._syncShowAppsButtonMode(dock));
                if (this._settings.showAppsAction !== 1 /* launcher */)
                    this._appLauncher.close();
            },
        ]);

        this._mapExternalSetting(this._appSwitcherSettings, 'current-workspace-only',
            'isolate-workspaces', value => value || undefined);
    }

    _createDocks() {
        // Keep this guard at the mutation boundary as well as in the
        // constructor. Session-mode changes can replace overview internals
        // while the extension remains loaded.
        runShellCapabilityGate(this._shellApi, () => {}, report => {
            throw new UnsupportedShellError(report);
        }, this._capabilityProbe);

        // If there are no monitors (headless configurations, but it can also
        // happen temporary while disconnecting and reconnecting monitors), just
        // do nothing. When a monitor will be connected we we'll be notified and
        // and thus create the docks. This prevents pointing trying to access
        // monitors throughout the code, were we are assuming that at least the
        // primary monitor is present.
        if (Main.layoutManager.monitors.length <= 0)
            return;

        // Session-mode transitions can create a real overview after this
        // manager started against a dummy one. Capture that newly-created stock
        // Dash before constructing or publishing its replacement.
        if (!Main.overview.isDummy)
            this._oldDash = Main.overview.dash;


        this._preferredMonitorIndex = this.settings.preferredMonitor;
        if (this._preferredMonitorIndex === -2) {
            const monitorManager = Utils.getMonitorManager();
            this._preferredMonitorIndex = monitorManager.get_monitor_for_connector(
                this.settings.preferredMonitorByConnector);
        } else if (this._preferredMonitorIndex >= 0) {
            // Primary monitor used to be always 0 in Gdk, but the shell has a different
            // concept (where the order depends on mutter order).
            // So even if now the extension settings may use the same logic of the shell
            // we prefer not to break the previously configured systems, and so we still
            // assume that the gsettings monitor numbering follows the old strategy.
            // This ensure the indexing in the settings and in the shell are matched,
            // i.e. that we start counting from the primaryMonitorIndex
            this._preferredMonitorIndex =
                (Main.layoutManager.primaryIndex + this._preferredMonitorIndex) %
                Main.layoutManager.monitors.length;
        }

        // In case of multi-monitor, we consider the dock on the primary monitor
        // to be the preferred (main) one regardless of the settings the dock
        // goes on the primary monitor also if the settings are inconsistent
        // (e.g. desired monitor not connected).
        if (this.settings.multiMonitor ||
            this._preferredMonitorIndex < 0 ||
            this._preferredMonitorIndex > Main.layoutManager.monitors.length - 1)
            this._preferredMonitorIndex = Main.layoutManager.primaryIndex;


        // First we create the main Dock, to get the extra features to bind to this one
        this._createDock({
            monitorIndex: this._preferredMonitorIndex,
            isMain: true,
        });

        // Make the necessary changes to Main.overview.dash
        this._prepareMainDash();

        // Adjust corners if necessary
        this._adjustPanelCorners();

        if (this.settings.multiMonitor) {
            const nMon = Main.layoutManager.monitors.length;
            for (let iMon = 0; iMon < nMon; iMon++) {
                if (iMon === this._preferredMonitorIndex)
                    continue;

                this._createDock({monitorIndex: iMon});
            }
        }

        // Load optional features. We load *after* the docks are created, since
        // we need to connect the signals to all dock instances.
        this._workspaceIsolation = new WorkspaceIsolation();
        this._workspaceIsolation.enable();
        this._keyboardShortcuts = new KeyboardShortcuts();
        this._keyboardShortcuts.enable();

        this.emit('docks-ready');
    }

    _failClosedForUnsupportedShell(report) {
        if (this._capabilityFailureLogged)
            return this.destroy();

        this._capabilityFailureLogged = true;
        const message = formatUnsupportedShellMessage(report);
        const onFailClosed = this._onFailClosed;
        this._onFailClosed = null;
        try {
            onFailClosed?.(this);
        } catch (error) {
            logError(error, 'Releasing failed XDock manager export');
        }
        const errors = this.destroy();
        log(message);
        return errors;
    }

    _createDock(params) {
        const dock = new XDock(params);
        this._allDocks.push(dock);

        // connect app icon into the view selector
        dock.dash.showAppsButton.connectObject(
            'notify::checked', button => this._onShowAppsButtonToggled(button),
            'clicked', button => this._onShowAppsButtonClicked(button),
            dock);
        this._syncShowAppsButtonMode(dock);

        const id = dock.connect('destroy', () => {
            dock.disconnect(id);
            const index = this._allDocks.indexOf(dock);
            if (index !== -1)
                this._allDocks.splice(index, 1);
        });

        return dock;
    }

    _prepareStartupAnimation() {
        DockManager.allDocks.forEach(dock => {
            const {dash} = dock;

            dock.opacity = 255;
            dash.set({
                opacity: 0,
                translation_x: 0,
                translation_y: 0,
            });
        });
    }

    _runStartupAnimation() {
        DockManager.allDocks.forEach(dock => {
            const {dash} = dock;

            switch (dock.position) {
            case St.Side.LEFT:
                dash.translation_x = -dash.width;
                break;
            case St.Side.RIGHT:
                dash.translation_x = dash.width;
                break;
            case St.Side.BOTTOM:
                dash.translation_y = dash.height;
                break;
            case St.Side.TOP:
                dash.translation_y = -dash.height;
                break;
            }

            dash.ease({
                opacity: 255,
                translation_x: 0,
                translation_y: 0,
                duration: STARTUP_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
    }

    _prepareMainDash() {
        // Set this before the first mutation so constructor rollback can repair
        // even a partially prepared overview.
        this._mainDashPrepared = true;

        // Ensure Main.overview.dash is set to our dash in dummy mode
        // while just use the default getter otherwise.
        // The getter must be dynamic and not set only when we've a dummy
        // overview because the mode can change dynamically.
        this._propertyInjections.removeWithLabel(Labels.MAIN_DASH);
        const defaultDashGetter = Object.getOwnPropertyDescriptor(
            Main.overview.constructor.prototype, 'dash').get;
        this._propertyInjections.addWithLabel(Labels.MAIN_DASH, Main.overview, 'dash', {
            get: () => Main.overview.isDummy
                ? this.mainDock.dash : defaultDashGetter.call(Main.overview),
        });

        if (Main.overview.isDummy)
            return;

        // Hide usual Dash
        this._oldDash.hide();

        // Also set dash width to 1, so it's almost not taken into account by code
        // calculating the reserved space in the overview. The reason to keep it at 1 is
        // to allow its visibility change to trigger an allocation of the appGrid which
        // in turn is triggering the appsIcon spring animation, required when no other
        // actors has this effect, i.e in horizontal mode and without the workspaceThumbnails
        // 1 static workspace only)
        this._oldDash.set_height(1);

        this._signalsHandler.addWithLabel(Labels.OLD_DASH_CHANGES, [
            this._oldDash,
            'notify::visible',
            () => this._oldDash.hide(),
        ], [
            this._oldDash,
            'notify::height',
            () => this._oldDash.set_height(1),
        ]);

        // Pretend I'm the dash: meant to make app grid swarm animation come from
        // the right position of the appShowButton.
        this.overviewControls.dash = this.mainDock.dash;
        this.searchController._showAppsButton = this.mainDock.dash.showAppsButton;

        // We also need to ignore max-size changes
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
            'setMaxSize', () => {});
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
            'allocate', () => {});
        // And to return the preferred height depending on the state
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
            'get_preferred_height', (_originalMethod, ...args) => {
                if (this.mainDock.get_stage() && this.mainDock.isHorizontal &&
                    !this.settings.dockFixed)
                    return this.mainDock.get_preferred_height(...args);
                return [0, 0];
            });

        // FIXME: https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/2890
        // const { ControlsManagerLayout } = OverviewControls;
        const ControlsManagerLayout = this.overviewControls.layout_manager.constructor;

        const maybeAdjustBoxSize = (state, box, spacing) => {
            // ensure that an undefined value will be converted into a valid one
            spacing = spacing ?? 0;

            if (state === OverviewControls.ControlsState.WINDOW_PICKER) {
                const searchBox = this.overviewControls._searchEntry.get_allocation_box();
                const {shouldShow: wsThumbnails} = this.overviewControls._thumbnailsBox;

                if (!wsThumbnails) {
                    box.y1 += spacing;
                    box.y2 -= spacing;
                }

                box.y2 -= searchBox.get_height() + 2 * spacing;
            }

            return box;
        };

        const maybeAdjustBoxToDock = (state, box, spacing) => {
            maybeAdjustBoxSize(state, box, spacing);

            if (!this.mainDock.get_stage() || this.mainDock.isHorizontal ||
                this.settings.dockFixed)
                return box;

            const [, preferredWidth] = this.mainDock.get_preferred_width(
                box.get_height());

            if (this.mainDock.position === St.Side.LEFT)
                box.x1 += preferredWidth;
            else if (this.mainDock.position === St.Side.RIGHT)
                box.x2 -= preferredWidth;

            return box;
        };

        this._vfuncInjections.addWithLabel(Labels.MAIN_DASH, ControlsManagerLayout.prototype,
            'allocate', function (container) {
                /* eslint-disable no-invalid-this */
                const oldPostAllocation = this._runPostAllocation;
                this._runPostAllocation = () => {};
                try {
                    const monitor = Main.layoutManager.findMonitorForActor(container);
                    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
                    const startX = workArea.x - monitor.x;
                    const startY = workArea.y - monitor.y;
                    const workAreaBox = new Clutter.ActorBox();
                    workAreaBox.set_origin(startX, startY);
                    workAreaBox.set_size(workArea.width, workArea.height);

                    // GNOME 46 changes "spacing" to "_spacing".
                    const spacing = this.spacing ?? this._spacing;

                    maybeAdjustBoxToDock(undefined, workAreaBox, spacing);
                    const oldStartY = workAreaBox.y1;

                    const propertyInjections = new Utils.PropertyInjectionsHandler();
                    try {
                        propertyInjections.add(
                            Main.layoutManager.panelBox, 'height', {value: startY});

                        if (Main.layoutManager.panelBox.y === Main.layoutManager.primaryMonitor.y)
                            workAreaBox.y1 -= oldStartY;

                        this.vfunc_allocate(container, workAreaBox);
                    } finally {
                        propertyInjections.destroy();
                    }
                    workAreaBox.y1 = oldStartY;

                    const adjustActorHorizontalAllocation = actor => {
                        if (!actor.visible || !workAreaBox.x1)
                            return;

                        const contentBox = actor.get_allocation_box();
                        contentBox.set_size(workAreaBox.get_width(), contentBox.get_height());
                        contentBox.set_origin(workAreaBox.x1, contentBox.y1);
                        actor.allocate(contentBox);
                    };

                    [this._searchEntry, this._workspacesThumbnails,
                        this._searchController].forEach(
                        actor => adjustActorHorizontalAllocation(actor));
                } finally {
                    this._runPostAllocation = oldPostAllocation;
                }
                this._runPostAllocation();
                /* eslint-enable no-invalid-this */
            });

        /**
         * This can be removed or bypassed when GNOME/gnome-shell!1892 will be merged
         *
         * @param originalFunction
         * @param state
         * @param workAreaBox
         * @param {...any} args
         */
        function workspaceBoxOriginFixer(originalFunction, state, workAreaBox, ...args) {
            /* eslint-disable no-invalid-this */
            const workspaceBox = originalFunction.call(this, state, workAreaBox, ...args);
            workspaceBox.set_origin(workAreaBox.x1, workspaceBox.y1);
            return workspaceBox;
            /* eslint-enable no-invalid-this */
        }

        this._methodInjections.addWithLabel(Labels.MAIN_DASH, [
            ControlsManagerLayout.prototype,
            '_computeWorkspacesBoxForState',
            function (originalFunction, state, ...args) {
                /* eslint-disable no-invalid-this */
                if (state === OverviewControls.ControlsState.HIDDEN)
                    return originalFunction.call(this, state, ...args);

                const box = workspaceBoxOriginFixer.call(this, originalFunction, state, ...args);
                // GNOME 46 changes "spacing" to "_spacing".
                const spacing = this.spacing ?? this._spacing;
                const dock = DockManager.getDefault().getDockByMonitor(Main.layoutManager.primaryIndex);
                if (!dock)
                    return box;
                else
                    return maybeAdjustBoxSize(state, box, spacing);
                /* eslint-enable no-invalid-this */
            },
        ], [
            WorkspacesView.SecondaryMonitorDisplay.prototype,
            '_getWorkspacesBoxForState',
            function (originalFunction, state, ...args) {
                /* eslint-disable no-invalid-this */
                if (state === OverviewControls.ControlsState.HIDDEN)
                    return originalFunction.call(this, state, ...args);

                const box = workspaceBoxOriginFixer.call(this, originalFunction, state, ...args);
                const dock = DockManager.getDefault().getDockByMonitor(this._monitorIndex);
                if (!dock)
                    return box;
                if (state === OverviewControls.ControlsState.WINDOW_PICKER &&
                    dock.position === St.Side.BOTTOM) {
                    const [, preferredHeight] = dock.get_preferred_height(box.get_width());
                    box.y2 -= preferredHeight;
                }
                return box;
                /* eslint-enable no-invalid-this */
            },
        ], [
            ControlsManagerLayout.prototype,
            '_getAppDisplayBoxForState',
            function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                return workspaceBoxOriginFixer.call(this, originalFunction, ...args);
                /* eslint-enable no-invalid-this */
            },
        ], [
            // Sadly CtrlAltTabPopup is not exported, so we cannot just patch it.
            SwitcherPopup.SwitcherPopup.prototype,
            '_finish',
            function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                if (this.constructor.name === 'CtrlAltTabPopup') {
                    const dockManager = DockManager.getDefault();
                    if (!dockManager || dockManager._inCtrlAltTabSwitcher)
                        return;

                    dockManager._inCtrlAltTabSwitcher = true;
                    try {
                        this.constructor.prototype._finish.call(this, ...args);
                    } finally {
                        delete dockManager._inCtrlAltTabSwitcher;
                    }
                }
                originalFunction.call(this, ...args);
                /* eslint-enable no-invalid-this */
            },
        ]);

        this._vfuncInjections.addWithLabel(Labels.MAIN_DASH, Workspace.WorkspaceBackground.prototype,
            'allocate', function (box) {
                /* eslint-disable no-invalid-this */
                this.vfunc_allocate(box);

                // This code has been submitted upstream via GNOME/gnome-shell!1892
                // so can be removed when that gets merged (or bypassed on newer shell
                // versions).
                const monitor = Main.layoutManager.monitors[this._monitorIndex];
                const [contentWidth, contentHeight] = this._bin.get_content_box().get_size();
                const [mX1, mX2] = [monitor.x, monitor.x + monitor.width];
                const [mY1, mY2] = [monitor.y, monitor.y + monitor.height];
                const [wX1, wX2] = [this._workarea.x, this._workarea.x + this._workarea.width];
                const [wY1, wY2] = [this._workarea.y, this._workarea.y + this._workarea.height];
                const xScale = contentWidth / this._workarea.width;
                const yScale = contentHeight / this._workarea.height;
                const leftOffset = wX1 - mX1;
                const topOffset = wY1 - mY1;
                const rightOffset = mX2 - wX2;
                const bottomOffset = mY2 - wY2;

                const contentBox = new Clutter.ActorBox();
                contentBox.set_origin(-leftOffset * xScale, -topOffset * yScale);
                contentBox.set_size(
                    contentWidth + (leftOffset + rightOffset) * xScale,
                    contentHeight + (topOffset + bottomOffset) * yScale);

                this._backgroundGroup.allocate(contentBox);
                /* eslint-enable no-invalid-this */
            });

        // Reduce the space that the workspaces can use in secondary monitors
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, WorkspacesView.WorkspacesView.prototype,
            '_getFirstFitAllWorkspaceBox', function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                const box = originalFunction.call(this, ...args);
                if (DockManager.settings.dockFixed ||
                    this._monitorIndex === Main.layoutManager.primaryIndex)
                    return box;

                const dock = DockManager.getDefault().getDockByMonitor(this._monitorIndex);
                if (!dock)
                    return box;

                if (dock.isHorizontal) {
                    const [, preferredHeight] = dock.get_preferred_height(box.get_width());
                    box.y2 -= preferredHeight;
                    if (dock.position === St.Side.TOP)
                        box.set_origin(box.x1, box.y1 + preferredHeight);
                } else {
                    const [, preferredWidth] = dock.get_preferred_width(box.get_height());
                    box.x2 -= preferredWidth / 2;
                    if (dock.position === St.Side.LEFT)
                        box.set_origin(box.x1 + preferredWidth, box.y1);
                }
                return box;
                /* eslint-enable no-invalid-this */
            });

        if (Main.layoutManager._startingUp) {
            // A settings toggle can rebuild the docks before startup completes.
            // Own exactly one startup callback across all such rebuilds.
            this._signalsHandler.removeWithLabel(Labels.STARTUP_ANIMATION);
            this._prepareStartupAnimation();

            // Convince LayoutManager to use the legacy startup animation:
            // Reset overview controls state to HIDDEN, as skipping the startup
            // overview leaves it stuck at WINDOW_PICKER
            if (this._settings.disableOverviewOnStartup) {
                try {
                    // RestorableValue captures the pre-extension value once;
                    // repeated pre-startup dock rebuilds only reapply false.
                    this._startupOverviewOverride.setTemporary(false);
                    Main.overview._overview.controls._stateAdjustment.value =
                        OverviewControls.ControlsState.HIDDEN;
                } catch (error) {
                    this._runCleanupTasks([
                        ['startup overview state', () => this._restoreStartupOverview()],
                    ]);
                    throw error;
                }
            } else {
                this._restoreStartupOverview();
            }

            this._signalsHandler.addWithLabel(Labels.STARTUP_ANIMATION,
                Main.layoutManager, 'startup-complete', () => {
                    this._runCleanupTasks([
                        ['startup animation signal', () =>
                            this._signalsHandler.removeWithLabel(Labels.STARTUP_ANIMATION)],
                        ['startup overview state', () => this._restoreStartupOverview()],
                        ['startup animation', () => this._runStartupAnimation()],
                    ]);
                });
        } else {
            this._signalsHandler.removeWithLabel(Labels.STARTUP_ANIMATION);
            this._restoreStartupOverview();
        }
    }

    _restoreStartupOverview() {
        return this._startupOverviewOverride?.restore();
    }

    _deleteDocks(bestEffort = false) {
        const workspaceIsolation = this._workspaceIsolation;
        const keyboardShortcuts = this._keyboardShortcuts;
        const docks = [...this._allDocks ?? []];
        this._workspaceIsolation = null;
        this._keyboardShortcuts = null;

        const errors = this._runCleanupTasks([
            ['workspace isolation', () => workspaceIsolation?.destroy()],
            ['keyboard shortcuts', () => keyboardShortcuts?.destroy()],
            ['desktop icon margins', () => this._desktopIconsUsableArea?.resetMargins()],
            ...docks.map((dock, index) => [
                `dock ${index + 1}`,
                () => dock.destroy(),
            ]),
            ['docks-destroyed signal', () => this.emit('docks-destroyed')],
        ]);

        if (bestEffort || errors.length === 0)
            this._allDocks = [];
        if (!bestEffort && errors.length)
            throw errors[0].error;
        return errors;
    }

    _restoreDash(bestEffort = false) {
        if (!this._mainDashPrepared)
            return [];

        this._mainDashPrepared = false;
        const oldDash = this._oldDash;

        const errors = this._runCleanupTasks([
            ['old Dash signals', () =>
                this._signalsHandler?.removeWithLabel(Labels.OLD_DASH_CHANGES)],
            ['main Dash method injections', () =>
                this._methodInjections?.removeWithLabel(Labels.MAIN_DASH)],
            ['main Dash vfunc injections', () =>
                this._vfuncInjections?.removeWithLabel(Labels.MAIN_DASH)],
            ['main Dash property injections', () =>
                this._propertyInjections?.removeWithLabel(Labels.MAIN_DASH)],
            ['overview layout Dash', () => {
                if (oldDash)
                    this.overviewControls.layout_manager._dash = oldDash;
            }],
            ['overview controls Dash', () => {
                if (oldDash)
                    this.overviewControls.dash = oldDash;
            }],
            ['search controller applications button', () => {
                if (oldDash)
                    this.searchController._showAppsButton = oldDash.showAppsButton;
            }],
            ['stock Dash visibility', () => oldDash?.show()],
            ['stock Dash height', () => oldDash?.set_height(-1)],
            // Force recalculation of the stock Dash icon size.
            ['stock Dash maximum height', () => {
                if (oldDash)
                    oldDash._maxHeight = -1;
            }],
        ]);

        if (!bestEffort && errors.length) {
            this._mainDashPrepared = true;
            throw errors[0].error;
        }
        return errors;
    }

    get overviewControls() {
        return Main.overview._overview.controls;
    }

    get searchController() {
        return this.overviewControls._searchController;
    }

    // With the launcher chosen, the Applications button stops being a toggle:
    // a click opens the launcher and nothing else. `checked` then stays the
    // overview's, which sets it whenever the app grid shows, so Super+A and
    // the overview's own ways into the app grid work as in the Shell. The
    // launcher used to follow `checked` instead, and so opened on top of the
    // app grid every time Super+A showed it.
    _syncShowAppsButtonMode(dock) {
        const launcher = this.settings.showAppsAction === 1;
        dock.dash.showAppsButton.toggle_mode = !launcher;
    }

    _onShowAppsButtonClicked(button) {
        if (this.settings.showAppsAction !== 1 /* launcher */)
            return;

        if (Main.overview.visible)
            Main.overview.hide();
        this._appLauncher.toggle(button);
    }

    _onShowAppsButtonToggled(button) {
        const {checked} = button;
        const {overviewControls} = this;

        if (!Main.overview.visible) {
            this.mainDock.dash.showAppsButton._fromDesktop = true;
            Main.overview.show(OverviewControls.ControlsState.APP_GRID);
        } else if (!checked && this.mainDock.dash.showAppsButton._fromDesktop &&
            !this._inCtrlAltTabSwitcher) {
            Main.overview.hide();
            this.mainDock.dash.showAppsButton._fromDesktop = false;
        } else {
            // TODO: I'm not sure how reliable this is, we might need to move the
            // _onShowAppsButtonToggled logic into the extension.
            if (!checked)
                this.mainDock.dash.showAppsButton._fromDesktop = false;


            // Instead of "syncing" the stock button, let's call its callback directly.
            overviewControls._onShowAppsButtonToggled();
        }

        // Because we "disconnected" from the search controller, we have to manage its state.
        this.searchController._setSearchActive(false);
    }

    _overrideAppMenus() {
        this._methodInjections.add(AppMenu.AppMenu.prototype,
            '_updateFavoriteItem', function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                originalFunction.call(this, ...args);
                if (!this._toggleFavoriteItem.visible)
                    return;

                const {id} = this._app;
                this._toggleFavoriteItem.label.text = this._appFavorites.isFavorite(id)
                    ? _('Unpin') : __('Pin to Dock');
                /* eslint-enable no-invalid-this */
            });
    }

    destroy() {
        if (this._destroyed || this._destroying)
            return [];

        this._destroying = true;
        const startupOverviewOverride = this._startupOverviewOverride;
        const errors = [];
        try {
            errors.push(...this._runCleanupTasks([
                ['pending dock recreation', () => this._toggleTask?.deactivate()],
                ['startup overview state', () => this._restoreStartupOverview()],
                ['destroy signal', () => this.emit('destroy')],
                ['stock Dash restoration', () => this._restoreDash(true)],
                ['dock deletion', () => this._deleteDocks(true)],
                ['panel corners', () => this._revertPanelCorners()],
                ['selector margin', () => {
                    if (this._oldSelectorMargin !== undefined)
                        this.searchController.margin_bottom = this._oldSelectorMargin;
                }],
                ['file manager client', () => this._fm1Client?.destroy()],
                ['notifications monitor', () => this._notificationsMonitor?.destroy()],
                ['application spread', () => this._appSpread?.destroy()],
                ['application launcher', () => this._appLauncher?.destroy()],
                ['trash integration', () => this._trash?.destroy()],
                ['file manager wrapping', () => Locations.unWrapFileManagerApp()],
                ['removable integration', () => this._removables?.destroy()],
                ['launcher remote model', () => this._remoteModel?.destroy()],
                ['application icon decorator', () => this._appIconsDecorator?.destroy()],
                ['desktop icons integration', () => this._desktopIconsUsableArea?.destroy()],
                ['global signal handler', () => this._signalsHandler?.destroy()],
                ['method injection handler', () => this._methodInjections?.destroy()],
                ['vfunc injection handler', () => this._vfuncInjections?.destroy()],
                ['property injection handler', () => this._propertyInjections?.destroy()],
            ]));
            return errors;
        } finally {
            // Cleanup callbacks can synchronously queue work, and cancellation
            // itself can fail. Deactivation blocks both cases; retry cancellation
            // and startup restoration after every callback has finished.
            errors.push(...this._runCleanupTasks([
                ['pending dock recreation final cancellation', () =>
                    this._toggleTask?.cancel()],
                ['startup overview state final restoration', () =>
                    this._restoreStartupOverview()],
                ['startup overview state deferred restoration', () => {
                    if (!startupOverviewOverride?.active)
                        return;

                    // This callback owns only the RestorableValue and global
                    // Shell state. It never dereferences the manager after the
                    // manager's teardown has released its children.
                    startupOverviewOverride.restoreEventually(callback =>
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                            STARTUP_RESTORATION_RETRY_INTERVAL, () => {
                                callback();
                                return GLib.SOURCE_REMOVE;
                            }), {
                        attempts: STARTUP_RESTORATION_RETRY_ATTEMPTS,
                        onError: (error, attempt) => logError(error,
                            `Restoring startup overview state (deferred attempt ${attempt})`),
                    });
                }],
            ]));
            this._workspaceIsolation = null;
            this._keyboardShortcuts = null;
            this._allDocks = [];
            this._fm1Client = null;
            this._notificationsMonitor = null;
            this._appSpread = null;
            this._appLauncher = null;
            this._trash = null;
            this._removables = null;
            this._iconTheme = null;
            this._remoteModel = null;
            this._appIconsDecorator = null;
            this._settings = null;
            this._appSwitcherSettings = null;
            this._startupOverviewOverride = null;
            this._shellApi = null;
            this._capabilityProbe = null;
            this._onFailClosed = null;
            this._oldDash = null;
            this._desktopIconsUsableArea = null;
            this._signalsHandler = null;
            this._methodInjections = null;
            this._vfuncInjections = null;
            this._propertyInjections = null;
            this._extension = null;
            this._destroying = false;
            this._destroyed = true;

            if (DockManager._singleton === this)
                DockManager._singleton = null;
        }
    }

    /**
     * Adjust Panel corners, remove this when 41 won't be supported anymore
     */
    _adjustPanelCorners() {
        if (!this._hasPanelCorners())
            return;

        const position = Utils.getPosition();
        const isHorizontal = (position === St.Side.TOP) || (position === St.Side.BOTTOM);
        const dockOnPrimary  = this._settings.multiMonitor ||
                             this._preferredMonitorIndex === Main.layoutManager.primaryIndex;

        if (!isHorizontal && dockOnPrimary && this.settings.dockExtended && this.settings.dockFixed) {
            Main.panel._rightCorner.hide();
            Main.panel._leftCorner.hide();
        } else {
            this._revertPanelCorners();
        }
    }

    _revertPanelCorners() {
        if (!this._hasPanelCorners())
            return;

        Main.panel._leftCorner.show();
        Main.panel._rightCorner.show();
    }

    _hasPanelCorners() {
        return !!Main.panel?._rightCorner && !!Main.panel?._leftCorner;
    }
}
Signals.addSignalMethods(DockManager.prototype);
