import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

// Run the real launcher methods with a deterministic main loop. Native actors
// and input picking are exercised separately in the headless Shell probe.
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const callbacks = new Map();
let serial = 0;
globalThis.launcherTestLoop = {
    idle_add: (_priority, callback) => {
        callbacks.set(++serial, callback);
        return serial;
    },
    source_remove: id => assert.ok(callbacks.delete(id), 'source must still be owned'),
};
const gi = dataUrl(`
export const AccountsService = {}, Atk = {}, Gio = {}, Meta = {}, Shell = {};
export const St = {Settings: {get: () => ({enable_animations: globalThis.launcherAnimationsEnabled ?? true})}};
export const GObject = {registerClass: klass => klass};
export const GLib = {...globalThis.launcherTestLoop, PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false};
export const Clutter = {
    AnimationMode: {EASE_IN_CUBIC: 1, EASE_OUT_CUBIC: 2},
    ModifierType: {CONTROL_MASK: 1, SHIFT_MASK: 2},
    EventFlags: {FLAG_POINTER_EMULATED: 1},
    ScrollDirection: {UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SMOOTH: 4},
    ScrollSource: {WHEEL: 0, FINGER: 1},
    EVENT_PROPAGATE: false,
    EVENT_STOP: true,
};
`);
const ui = dataUrl(`
export const AppDisplay = {AppIcon: class {}};
export const AppFavorites = {}, Dialog = {}, ModalDialog = {}, PopupMenu = {}, UserWidget = {};
export const DND = {removeDragMonitor() {}};
export const Main = {uiGroup: {set_child_above_sibling() {}}, layoutManager: {
    findMonitorForActor: () => ({x: 0, width: 1000}),
}};
`);
const empty = dataUrl(`
export const ParentalControlsManager = {}, SystemActions = {}, AppDrawers = {}, AppIcons = {}, Utils = {};
export const DeferredTask = class {};
export const WholeSurfaceRedraw = class {};
export const Extension = {gettext: text => text};
`);
let source = await readFile(new URL('../appLauncher.js', import.meta.url), 'utf8');
for (const [path, replacement] of [
    ['./dependencies/gi.js', gi],
    ['./dependencies/shell/ui.js', ui],
    ['./dependencies/shell/misc.js', empty],
    ['./lifecycle.js', empty],
    ['./dockBlur.js', empty],
    ['./imports.js', empty],
    ['./dependencies/shell/extensions/extension.js', empty],
    ['./popupMenuUtils.js', dataUrl('export const close = menu => { menu.isOpen = false; };')],
    ['./appLauncherModel.js', new URL('../appLauncherModel.js', import.meta.url).href],
])
    source = source.replace(`'${path}'`, `'${replacement}'`);
const {AppGridLauncher} = await import(dataUrl(source));

function launcher() {
    const instance = Object.create(AppGridLauncher.prototype);
    Object.assign(instance, {
        _destroyed: false,
        _menu: {actor: {}, isOpen: true},
        _sidebar: {},
        _idleSources: new Set(),
        _dragCloseId: 0,
        _closingForDrag: false,
        _draggingIcon: {_draggable: {_queueUpdateDragHover: () => instance.repicks++}},
        _containsPoint: () => false,
        _setDropHighlight() {},
        _clearDropHighlights() {},
        _flushDeferredDrawers() {},
        _flushDeferredCatalog() {},
        repicks: 0,
        closes: 0,
        close() {
            this.closes++;
            this._menu.isOpen = false;
            this._onOpenStateChanged(false);
        },
    });
    return instance;
}

function dispatch(id) {
    const callback = callbacks.get(id);
    callbacks.delete(id);
    callback();
}

function scrollLauncher(value = 300) {
    const instance = launcher();
    const adjustment = {
        value, lower: 0, upper: 2000, page_size: 1000,
        transition: null,
        ease(target, options) {
            this.transition = {target, ...options};
            if (options.duration === 0) {
                this.value = target;
                this.finish();
            }
        },
        finish() {
            const transition = this.transition;
            this.value = transition.target;
            this.transition = null;
            transition.onComplete();
        },
        remove_transition(name) {
            assert.equal(name, 'value');
            this.transition = null;
        },
    };
    instance._scrollView = {vadjustment: adjustment, height: 1000};
    return {instance, adjustment};
}

const scrollEvent = (direction, {delta = 0, source: scrollSource = 0, flags = 0} = {}) => ({
    get_scroll_direction: () => direction,
    get_scroll_delta: () => [0, delta],
    get_scroll_source: () => scrollSource,
    get_flags: () => flags,
});

test('wheel scrolling animates and retains the native distance for rapid ticks', () => {
    const {instance, adjustment} = scrollLauncher();
    assert.equal(instance._onScroll(scrollEvent(1)), true);
    assert.equal(adjustment.value, 300, 'the first tick must not jump');
    assert.equal(adjustment.transition.duration, 190);
    assert.equal(Math.round(adjustment.transition.target), 400);
    adjustment.value = 330;
    instance._onScroll(scrollEvent(1));
    assert.equal(Math.round(adjustment.transition.target), 500, 'rapid ticks accumulate fully');
    adjustment.finish();
    assert.equal(instance._scrollTarget, null);
});

test('reversing the wheel responds from the current position', () => {
    const {instance, adjustment} = scrollLauncher();
    instance._onScroll(scrollEvent(1));
    adjustment.value = 330;
    instance._onScroll(scrollEvent(0));
    assert.equal(Math.round(adjustment.transition.target), 230);
    assert.ok(adjustment.transition.target < adjustment.value);
});

test('wheel targets clamp at both ends and do not animate at a boundary', () => {
    const {instance, adjustment} = scrollLauncher(950);
    instance._onScroll(scrollEvent(1));
    assert.equal(adjustment.transition.target, 1000);
    adjustment.finish();
    instance._onScroll(scrollEvent(1));
    assert.equal(adjustment.transition, null);
    adjustment.value = 20;
    instance._onScroll(scrollEvent(0));
    assert.equal(adjustment.transition.target, 0);
    adjustment.finish();
    instance._onScroll(scrollEvent(0));
    assert.equal(adjustment.transition, null);
    adjustment.upper = 500;
    instance._onScroll(scrollEvent(1));
    assert.equal(adjustment.value, 0, 'a short result set has no scroll range');
    assert.equal(adjustment.transition, null);
});

test('touchpad input cancels wheel easing and uses the native scrolling path', () => {
    const {instance, adjustment} = scrollLauncher();
    instance._onScroll(scrollEvent(1));
    adjustment.value = 330;
    assert.equal(instance._onScroll(scrollEvent(4, {source: 1, delta: 0.5})), false);
    assert.equal(adjustment.transition, null);
    assert.equal(instance._scrollTarget, null);
    assert.equal(adjustment.value, 330, 'native scrolling still owns the gesture delta');
});

test('high-resolution mouse wheels animate fractional ticks and ignore emulated events', () => {
    const {instance, adjustment} = scrollLauncher();
    assert.equal(instance._onScroll(scrollEvent(4, {delta: 0.25})), true);
    assert.equal(Math.round(adjustment.transition.target), 325);
    const transition = adjustment.transition;
    assert.equal(instance._onScroll(scrollEvent(1, {flags: 1})), false);
    assert.equal(adjustment.transition, transition);
});

test('reduced motion updates immediately without leaving an animation', () => {
    const {instance, adjustment} = scrollLauncher();
    globalThis.launcherAnimationsEnabled = false;
    try {
        instance._onScroll(scrollEvent(1));
        assert.equal(Math.round(adjustment.value), 400);
        assert.equal(adjustment.transition, null);
        assert.equal(instance._scrollTarget, null);
    } finally {
        delete globalThis.launcherAnimationsEnabled;
    }
});

test('closing, touch panning and keyboard focus cannot inherit pending wheel motion', () => {
    const {instance, adjustment} = scrollLauncher();
    instance._onScroll(scrollEvent(1));
    instance._onOpenStateChanged(false);
    assert.equal(adjustment.transition, null);
    assert.equal(instance._scrollTarget, null);
    instance._onScroll(scrollEvent(1));
    instance._onPanUpdate({get_delta: () => ({get_y: () => 25})});
    assert.equal(adjustment.value, 275);
    assert.equal(adjustment.transition, null);
    instance._onScroll(scrollEvent(1));
    instance._visibleButtons = [{get_allocation_box: () => ({y1: 1300, y2: 1400})}];
    instance._selectedIndex = 0;
    instance._ensureSelectionVisible();
    assert.equal(adjustment.value, 400);
    assert.equal(adjustment.transition, null);
});

test('a cancelled drag cannot close the popup later', () => {
    const instance = launcher();
    instance._onDragMotion({x: 0, y: 0});
    const id = instance._dragCloseId;
    assert.ok(callbacks.has(id));
    instance.onDragEnd(instance._draggingIcon);
    assert.equal(callbacks.has(id), false);
    assert.equal(instance._idleSources.size, 0);
    assert.equal(instance.closes, 0);
    assert.equal(instance.isOpen, true);
});

test('handoff closes once and picks the stationary pointer again', () => {
    const instance = launcher();
    instance._onDragMotion({x: 0, y: 0});
    instance._onDragMotion({x: 0, y: 0});
    assert.equal(instance._idleSources.size, 1);
    dispatch(instance._dragCloseId);
    assert.equal(instance.closes, 1);
    assert.equal(instance.repicks, 1);
    assert.equal(instance._dragCloseId, 0);
    assert.equal(instance._idleSources.size, 0);
});

test('a callback from an old drag cannot close a replacement menu', () => {
    const instance = launcher();
    instance._onDragMotion({x: 0, y: 0});
    instance._menu = {actor: {}, isOpen: true};
    dispatch(instance._dragCloseId);
    assert.equal(instance.closes, 0);
    assert.equal(instance.repicks, 0);
});

test('drawer reordering outside the popup does not close it', () => {
    const instance = launcher();
    instance._draggingIcon = null;
    instance._onDragMotion({x: 0, y: 0});
    assert.equal(instance._idleSources.size, 0);
    assert.equal(instance.isOpen, true);
});

test('a late drag-end from another source cannot end the current drag', () => {
    const instance = launcher();
    const icon = instance._draggingIcon;
    instance._onDragMotion({x: 0, y: 0});
    instance.onDragEnd({});
    assert.equal(instance._draggingIcon, icon);
    assert.ok(callbacks.has(instance._dragCloseId));
    instance.onDragEnd(icon);
});

function label() {
    return {
        visible: true, opacity: 255, transitions: 0,
        remove_all_transitions() { this.transitions++; },
        hide() { this.visible = false; },
        ease({onComplete}) { onComplete?.(); },
    };
}

test('native close hides the external label and clears its source', () => {
    const instance = launcher();
    instance._hoverLabel = label();
    instance._hoverLabelIcon = {};
    instance._onOpenStateChanged(false);
    assert.equal(instance._hoverLabel.visible, false);
    assert.equal(instance._hoverLabel.opacity, 0);
    assert.equal(instance._hoverLabelIcon, null);
});

test('late leave from the previous icon cannot hide the current label', () => {
    const instance = launcher();
    instance._hoverLabel = label();
    instance._hoverLabelIcon = {};
    instance._hideHoverLabel({source: {}});
    assert.equal(instance._hoverLabel.visible, true);
    assert.equal(instance._hoverLabel.transitions, 0);
    instance._hideHoverLabel({animate: false, source: instance._hoverLabelIcon});
    assert.equal(instance._hoverLabel.visible, false);
});

test('tooltip position uses the new caption size rather than old allocation', () => {
    const instance = launcher();
    instance._hoverLabel = {
        ...label(), set_text() {}, show() {},
        get_preferred_size: () => [10, 10, 200, 30],
        set_position(x, y) { this.position = [x, y]; },
    };
    const icon = {
        mapped: true, _app: {get_name: () => 'A longer application name'},
        get_transformed_position: () => [300, 200],
        get_transformed_size: () => [48, 48],
    };
    instance._draggingIcon = null;
    instance._showHoverLabel(icon);
    assert.deepEqual(instance._hoverLabel.position, [224, 162]);
    assert.equal(instance._hoverLabelIcon, icon);
});
