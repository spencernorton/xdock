import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {
    MAX_DRAWER_NAME_LENGTH,
    MAX_VISIBLE_RESULTS,
    QUICK_ACCESS_COUNT,
    SIDEBAR_WIDTH,
    computeGridLayout,
    computeHeaderHeight,
    fillQuickAccess,
    filterCatalog,
    getGridPosition,
    isUserDrawer,
    moveSelection,
    normalizeSearchText,
    planAdjacentDrawerReorder,
    resolveDrawerApps,
    trailingCellCount,
    validateDrawerName,
} from '../appLauncherModel.js';

import {
    usesPopupMenuParameterObject,
} from '../popupMenuVersion.js';

function entry(name, metadata = '') {
    return {
        name,
        searchText: normalizeSearchText([name, metadata]),
    };
}

assert.equal(normalizeSearchText(['Déjà Vu', '  Editor  ']), 'deja vu editor');

const catalog = [
    entry('Firefox', 'Web Browser Mozilla'),
    entry('Files', 'Nautilus file manager'),
    entry('Visual Studio Code', 'Editor development'),
];

assert.deepEqual(filterCatalog(catalog, 'fire').items.map(item => item.name), ['Firefox']);
assert.deepEqual(filterCatalog(catalog, 'visual editor').items.map(item => item.name),
    ['Visual Studio Code']);
assert.equal(filterCatalog(catalog, 'missing').total, 0);

const largeCatalog = Array.from({length: MAX_VISIBLE_RESULTS + 8},
    (_, i) => entry(`Application ${i}`));
const capped = filterCatalog(largeCatalog, '');
assert.equal(capped.items.length, MAX_VISIBLE_RESULTS);
assert.equal(capped.total, largeCatalog.length);
assert.equal(capped.truncated, true);

assert.deepEqual(computeGridLayout({
    // Mutter has already converted a 1920x1080 mode at 2x to this logical
    // work area. The launcher must not divide it by resource scale again.
    workAreaWidth: 960,
    workAreaHeight: 540,
    textScale: 1,
}), {
    columns: 7,
    width: 728,
    sidebarWidth: 0,
    gridHeight: 356,
    iconSize: 48,
});

// The popup is one size regardless of how many apps are showing. `gridHeight`
// is applied as a height, not a max-height; a layout that still returns
// `maxHeight` is the shrink-to-fit behaviour that made the popup jump on every
// keystroke that changed the result count.
const fixedHeight = computeGridLayout({workAreaWidth: 1920, workAreaHeight: 1080});
assert.equal(fixedHeight.maxHeight, undefined,
    'maxHeight implies the popup resizes with its content');
assert.ok(fixedHeight.gridHeight > 0);
// Nothing in the layout takes a result count, which is what keeps it constant.
assert.equal(computeGridLayout.length, 1);

// Chrome (the header bar, and later the footer) is spent FROM the popup's
// height budget rather than added on top of it, so gaining a bar must not make
// the popup taller. Asserted across screen sizes because the obvious
// implementation -- subtract before the clamp -- is silently a no-op on any
// monitor tall enough for MAX_POPUP_HEIGHT to bind, which is most of them.
for (const [width, height] of [[2560, 1440], [1920, 1030], [1366, 700], [800, 480]]) {
    const bare = computeGridLayout({workAreaWidth: width, workAreaHeight: height});
    const withChrome = computeGridLayout({
        workAreaWidth: width,
        workAreaHeight: height,
        chromeHeight: 56,
    });
    assert.equal(withChrome.gridHeight + 56, bare.gridHeight,
        `chrome must come out of the grid at ${width}x${height}, not add to the popup`);
}

// The header must fit the avatar it contains. Shell's Avatar sizes itself as
// Main.defaultIconSize * scaleFactor, so a literal that fits 64px squashes a
// HiDPI avatar -- measured at scale 1 a 64px avatar in a 56px bar came out
// 64x56.
assert.ok(computeHeaderHeight(64) > 64, 'header must fit a 64px avatar');
assert.ok(computeHeaderHeight(128) > 128, 'header must fit a larger avatar');
// Takes NO scale factor on purpose. These are CSS pixels and St already
// multiplies CSS lengths by the scale factor, so folding scale in here would
// apply it twice and double the bar's height on a HiDPI display.
assert.equal(computeHeaderHeight.length, 1,
    'header height is scale-free: St scales the CSS length itself');
// Nonsense inputs fall back rather than producing a zero-height bar.
assert.ok(computeHeaderHeight(undefined) > 0);
assert.ok(computeHeaderHeight(0) > 0);

// The floor stops a very short work area squeezing the results to nothing; the
// popup is allowed to grow instead, because a launcher with no room for icons
// is worse than a tall one.
const squeezed = computeGridLayout({
    workAreaWidth: 800,
    workAreaHeight: 320,
    chromeHeight: 400,
});
assert.ok(squeezed.gridHeight >= 160,
    'the results area keeps a usable floor no matter how tall the chrome is');

const largeTextLayout = computeGridLayout({
    workAreaWidth: 1366,
    workAreaHeight: 768,
    textScale: 1.8,
});
assert.equal(largeTextLayout.columns, 4);
assert.equal(largeTextLayout.iconSize, 40);
assert.ok(largeTextLayout.width <= 1334);

// Drawers: `translate` separates folders a user made from folders a distro
// ships. On a stock Ubuntu session System/Utilities/YaST/Pardus are all
// translate=true with a .directory name, while user folders are translate=false
// with a plain name. Listing only the latter is what keeps distro folders out
// of the sidebar and unreachable by delete().
assert.equal(isUserDrawer({translate: false, categories: []}), true);
assert.equal(isUserDrawer({translate: true, categories: []}), false);
// Category-driven folders are computed by Shell from desktop-file categories;
// half-supporting them would show or hide the wrong apps.
assert.equal(isUserDrawer({translate: false, categories: ['Utility']}), false);
assert.equal(isUserDrawer({}), false);

// Membership is apps minus exclusions, order preserved, duplicates collapsed.
assert.deepEqual(resolveDrawerApps({apps: ['a.desktop', 'b.desktop']}),
    ['a.desktop', 'b.desktop']);
assert.deepEqual(resolveDrawerApps({
    apps: ['a.desktop', 'b.desktop', 'a.desktop'],
    excludedApps: ['b.desktop'],
}), ['a.desktop']);
assert.deepEqual(resolveDrawerApps({}), []);

// An id can sit in BOTH apps and excluded-apps -- the Shell's app grid leaves
// that state -- and the exclusion wins. DrawerStore.addApp() must therefore
// clear the exclusion rather than returning early on apps.includes() alone,
// which silently left the app hidden after a drop.
assert.deepEqual(resolveDrawerApps({
    apps: ['a.desktop'],
    excludedApps: ['a.desktop'],
}), [], 'exclusion must win while it is present');
assert.deepEqual(resolveDrawerApps({
    apps: ['a.desktop'],
    excludedApps: [],
}), ['a.desktop'], 'clearing the exclusion must reveal the already-filed app');

// Names are compared case-insensitively: "Games" and "games" are
// indistinguishable in the sidebar and would silently create a second folder.
assert.equal(validateDrawerName('  Media  ', ['Games']).name, 'Media');
assert.equal(validateDrawerName('games', ['Games']).reason, 'duplicate');
assert.equal(validateDrawerName('   ', []).reason, 'empty');
assert.equal(validateDrawerName('x'.repeat(MAX_DRAWER_NAME_LENGTH + 1), []).reason,
    'too-long');

// The sidebar shares the popup's width budget; without subtracting it the
// popup overflows the work area on small screens. Measured at a width where
// the sidebar actually bites -- at 960 the 800px target cap dominates and both
// layouts land on the same 7 columns, so that input proves nothing.
const narrow = {workAreaWidth: 700, workAreaHeight: 540, textScale: 1};
const withSidebar = computeGridLayout({...narrow, sidebarWidth: SIDEBAR_WIDTH});
const withoutSidebar = computeGridLayout(narrow);
assert.ok(withSidebar.width < withoutSidebar.width,
    'sidebar width must come out of the grid budget');
assert.ok(withSidebar.columns < withoutSidebar.columns);
// Total popup width must still fit the work area once the sidebar, popup
// padding and the inter-column gap are added.
assert.ok(withSidebar.width + withSidebar.sidebarWidth + 32 + 6 <=
    narrow.workAreaWidth);
// A sidebar cannot starve the grid below one usable column.
assert.equal(computeGridLayout({...narrow, sidebarWidth: 10000}).columns, 1);

// The old 208px grid floor plus a fixed 160px sidebar overflowed narrow
// portrait/fractional-scale work areas before popup padding was counted.
for (const workAreaWidth of [240, 320, 360]) {
    const layout = computeGridLayout({
        workAreaWidth,
        workAreaHeight: 640,
        sidebarWidth: SIDEBAR_WIDTH,
    });
    assert.equal(layout.columns, 1);
    assert.ok(layout.width > 0);
    assert.ok(layout.width + layout.sidebarWidth + 32 + 6 <= workAreaWidth,
        `launcher must fit a ${workAreaWidth}px logical work area`);
}

// Large text used to consume the nominal 208px grid cell first, collapsing the
// 240px drawer sidebar to zero and making every drawer unreachable. Keep both
// navigation regions usable inside the exact same physical width budget.
const narrowLargeText = computeGridLayout({
    workAreaWidth: 240,
    workAreaHeight: 640,
    textScale: 2,
    sidebarWidth: SIDEBAR_WIDTH,
});
assert.equal(narrowLargeText.columns, 1);
assert.ok(narrowLargeText.sidebarWidth >= 72,
    '240px at 2x text scale must retain a navigable drawer sidebar');
assert.ok(narrowLargeText.width >= 80,
    '240px at 2x text scale must retain a usable application column');
assert.ok(narrowLargeText.width + narrowLargeText.sidebarWidth + 32 + 6 <= 240);

const quickCatalog = Array.from({length: 8}, (_, index) => ({
    id: `app-${index}`,
    name: `Application ${index}`,
}));
assert.deepEqual(fillQuickAccess(quickCatalog,
    [quickCatalog[3], quickCatalog[1]], QUICK_ACCESS_COUNT).map(item => item.id),
['app-3', 'app-1', 'app-0', 'app-2', 'app-4', 'app-5'],
'partial usage history must be topped up to six without changing usage order');
assert.deepEqual(fillQuickAccess(quickCatalog,
    [quickCatalog[1], quickCatalog[1], quickCatalog[2]], 3).map(item => item.id),
['app-1', 'app-2', 'app-0'], 'usage and fallback duplicates must collapse');
assert.deepEqual(fillQuickAccess(quickCatalog.slice(0, 2), [], QUICK_ACCESS_COUNT),
quickCatalog.slice(0, 2), 'a genuinely small catalog may remain under six');
assert.deepEqual(fillQuickAccess(quickCatalog, quickCatalog, 0), [],
    'a zero-sized quick-access request stays empty');

assert.deepEqual(planAdjacentDrawerReorder(['a', 'b', 'c'], 'b', -1), {
    beforeId: 'a',
    targetIndex: 0,
});
assert.deepEqual(planAdjacentDrawerReorder(['a', 'b', 'c'], 'b', 1), {
    beforeId: null,
    targetIndex: 2,
});
assert.equal(planAdjacentDrawerReorder(['a', 'b', 'c'], 'a', -1), null);
assert.equal(planAdjacentDrawerReorder(['a', 'b', 'c'], 'c', 1), null);

assert.deepEqual(getGridPosition(0, 4), {column: 0, row: 0});
assert.deepEqual(getGridPosition(4, 4), {column: 0, row: 1});
assert.deepEqual(getGridPosition(0, 4, true), {column: 3, row: 0});
assert.deepEqual(getGridPosition(1, 4, true), {column: 2, row: 0});

// A short row still occupies every column, or the homogeneous grid gives its
// few tiles the whole popup width.
assert.equal(trailingCellCount(1, 6), 5);
assert.equal(trailingCellCount(5, 6), 1);
assert.equal(trailingCellCount(6, 6), 0);
assert.equal(trailingCellCount(7, 6), 5);
assert.equal(trailingCellCount(0, 6), 0);
assert.equal(trailingCellCount(1, 0), 0);

assert.equal(moveSelection(0, 10, 4, 'left'), 0);
assert.equal(moveSelection(0, 10, 4, 'right'), 1);
assert.equal(moveSelection(0, 10, 4, 'left', true), 1);
assert.equal(moveSelection(3, 10, 4, 'right'), 3);
assert.equal(moveSelection(5, 10, 4, 'up'), 1);
assert.equal(moveSelection(1, 10, 4, 'up'), -1);
assert.equal(moveSelection(5, 10, 4, 'down'), 9);
assert.equal(moveSelection(5, 10, 4, 'home'), 0);
assert.equal(moveSelection(5, 10, 4, 'end'), 9);

assert.equal(usesPopupMenuParameterObject('50.1'), false);
assert.equal(usesPopupMenuParameterObject('51.alpha'), true);
assert.equal(usesPopupMenuParameterObject('development'), false);
assert.equal(usesPopupMenuParameterObject('development', true), true);

// St.ScrollView rejects arbitrary St.Widget children at runtime. Keep a
// source-level contract test because Node cannot load GNOME's St typelib.
const [launcherSource, stylesheetSource] = await Promise.all([
    readFile(new URL('../appLauncher.js', import.meta.url), 'utf8'),
    readFile(new URL('../_stylesheet.scss', import.meta.url), 'utf8'),
]);
assert.match(launcherSource,
    /menu\.actor\.add_style_class_name\('xdock-app-grid-launcher'\)/);
assert.match(launcherSource,
    /'system-lock-screen-symbolic', C_\('action', 'Lock Screen'\)/);
assert.match(launcherSource,
    /_runSystemAction\(\(\) => systemActions\.activateLockScreen\(\)\)/);
assert.match(launcherSource,
    /bind_property\([\s\S]*'can-lock-screen'[\s\S]*lockButton[\s\S]*'visible'/);
assert.match(launcherSource, /const grid = new St\.Viewport\(/);
assert.match(launcherSource, /child: grid,/);
assert.match(launcherSource, /orientation: Clutter\.Orientation\.VERTICAL/);
assert.doesNotMatch(launcherSource,
    /Utils\.addActor\(this\._scrollView, this\._grid\)/);
assert.match(launcherSource, /new Clutter\.PanGesture\(\)/);
assert.match(launcherSource, /accessible_role: Atk\.Role\.GROUPING/);
assert.match(launcherSource, /accessible_role: Atk\.Role\.LIST_ITEM/);
assert.match(launcherSource, /add_accessible_state\(Atk\.StateType\.SELECTED\)/);
assert.match(launcherSource, /remove_accessible_state\(Atk\.StateType\.SELECTED\)/);
assert.match(launcherSource, /'monitors-changed'/);
assert.match(launcherSource, /'workareas-changed'/);

// The three layout signals share one owned compositor-later task. Directly
// rendering from each signal would repeat a full actor/layout pass for one
// Mutter transaction and could race teardown.
assert.match(launcherSource,
    /new DeferredTask\([\s\S]*Meta\.LaterType\.BEFORE_REDRAW[\s\S]*Utils\.laterRemove/);
const layoutChangedBody = launcherSource.slice(
    launcherSource.indexOf('    _onLayoutChanged()'),
    launcherSource.indexOf('    _applyLayoutChange()'));
assert.match(layoutChangedBody, /this\._layoutTask\.schedule\(/);
assert.doesNotMatch(layoutChangedBody, /_applyResponsiveLayout\(/);
assert.match(launcherSource, /pending layout callback[\s\S]*_layoutTask\?\.cancel\(\)/);

// All launcher idles go through one owned registry; raw idle_add may appear
// only inside that helper, and destroy cancels what has not dispatched.
assert.equal([...launcherSource.matchAll(/GLib\.idle_add\(/g)].length, 1);
assert.match(launcherSource, /_idleSources = new Set\(\)/);
assert.match(launcherSource, /idle sources[\s\S]*_cancelIdleSources\(\)/);
for (const operation of [
    'drag close',
    'system action',
    'drawer name focus',
    'keyboard drawer reorder',
])
    assert.match(launcherSource, new RegExp(`_queueIdle\\('${operation}'`));

// Custom launcher transitions explicitly collapse under reduced motion while
// leaving slow-down-factor scaling to Actor.ease(), which applies it once.
assert.match(launcherSource,
    /function launcherAnimationDuration\(duration\)[\s\S]*animationsEnabled\(\) \? duration : 0/);
assert.ok([...launcherSource.matchAll(/duration: launcherAnimationDuration\(/g)].length >= 5);
assert.doesNotMatch(launcherSource,
    /duration: (?:DRAG_PICKUP_DURATION|DRAG_SETTLE_DURATION|HOVER_LABEL_(?:SHOW|HIDE)_TIME)/);

// Design-token contract: compact controls 8px, dock 18px, launcher menu 20px,
// and a 2px system-accent focus ring.
assert.match(stylesheetSource, /\$norvi_compact_radius: 8px/);
assert.match(stylesheetSource, /\$norvi_dock_radius: 18px/);
assert.match(stylesheetSource, /\$norvi_menu_radius: 20px/);
assert.match(stylesheetSource, /\$norvi_focus_ring_width: 2px/);
assert.match(stylesheetSource,
    /box-shadow: inset 0 0 0 \$norvi_focus_ring_width -st-accent-color/);

// PopupMenuManager consumes Escape during capture. The launcher's observer
// must be connected first so it can request focus restoration before the
// manager closes the menu and stops propagation.
const escapeObserverIndex = launcherSource.indexOf("'captured-event'");
const menuManagerRegistrationIndex = launcherSource.indexOf('menuManager.addMenu(menu)');
assert.notEqual(escapeObserverIndex, -1);
assert.notEqual(menuManagerRegistrationIndex, -1);
assert.ok(escapeObserverIndex < menuManagerRegistrationIndex,
    'Escape observer must be connected before PopupMenuManager.addMenu()');

// Results must derive from Shell's AppIcon. Dash.getAppFromSource() resolves a
// drag source with `source instanceof AppDisplay.AppIcon ? source.app : null`,
// so any other actor can never be dropped on the dock.
assert.match(launcherSource, /class LauncherAppIcon extends AppDisplay\.AppIcon/);
assert.match(launcherSource, /isDraggable: true/);

// ...but NOT from DockAppIcon, whose activate() dispatches on
// settings.clickAction and would minimise/cycle a running app on click.
assert.doesNotMatch(launcherSource, /extends\s+AppIcons\.Dock\w*AppIcon/);
assert.doesNotMatch(launcherSource, /AppIcons\.makeAppIcon\(/);

// Main.pushModal/popModal is a LIFO stack. The launcher pushes first and the
// result's context menu pushes on top, so the launcher must refuse to close
// while that inner menu is open or the grabs unwind out of order.
const closeBody = launcherSource.slice(
    launcherSource.indexOf('    close({restoreFocus'),
    launcherSource.indexOf('    onIconMenuStateChanged('));
assert.notEqual(closeBody.length, 0);
assert.match(closeBody, /if \(this\._iconMenuOpen\)/);
assert.match(closeBody, /_closeRequestedWhileIconMenuOpen = \{restoreFocus, animate\}/,
    'a close requested under an open context menu must be deferred, not dropped');

// Escape belongs to the innermost grab: it must not request launcher focus
// restoration while a context menu is up.
const escapeGuard = launcherSource.slice(escapeObserverIndex,
    launcherSource.indexOf('menuManager.addMenu(menu)'));
assert.match(escapeGuard, /!this\._iconMenuOpen/);

// "Pin to Dock" fires AppFavorites::changed synchronously from the open menu.
// Re-rendering there would destroy the menu's own source icon.
const invalidateBody = launcherSource.slice(
    launcherSource.indexOf('    _invalidateCatalog()'),
    launcherSource.indexOf('    _refreshCatalog()'));
assert.match(invalidateBody, /this\._iconMenuOpen \|\| this\._draggingIcon/);
assert.match(invalidateBody, /_deferredCatalogRender = true/);

// AppViewItem._onDestroy() calls Main.overview.endItemDrag(), so a pool sweep
// must never destroy the live drag source or an open menu's source.
assert.match(launcherSource,
    /_isButtonBusy\(button\) \{\s*return button === this\._activeIconMenuIcon \|\| button === this\._draggingIcon;/);
assert.match(launcherSource, /!visibleIds\.has\(id\) && !this\._isButtonBusy\(button\)/);

// Dragging must close the launcher (releasing its grab) without destroying the
// drag source; close() must not be the destroying variant.
const dragBeginBody = launcherSource.slice(
    launcherSource.indexOf('    onDragBegin(icon)'),
    launcherSource.indexOf('    onDragEnd('));
assert.match(dragBeginBody, /this\.close\(\{animate: false\}\)/);
assert.doesNotMatch(dragBeginBody, /_destroyMenu\(\)/);

// Captions under icons were ellipsised past readability at grid density, so
// results carry no label at all and the name is shown on hover instead.
assert.match(launcherSource, /showLabel: false/);
assert.match(launcherSource, /_showHoverLabel\(/);
// Kept alongside showLabel:false. AppViewItem's hover handler re-wraps an
// ellipsised title, changing item height and relayouting the homogeneous grid.
assert.match(launcherSource, /expandTitleOnHover: false/);

// The hover label lives in Main.uiGroup, not inside the ScrollView, or it is
// clipped at the popup's edge and cannot sit above the top row.
const hoverLabelBlock = launcherSource.slice(
    launcherSource.indexOf('hoverLabel = new St.Label('),
    launcherSource.indexOf('// Commit only the complete actor graph'));
assert.match(hoverLabelBlock, /Utils\.addActor\(Main\.uiGroup, hoverLabel\)/);

// A drag must leave a visible ghost, not collapse the source to nothing:
// AppViewItem's default is scale 0.5 / opacity 0, which reads as deletion.
assert.ok(/DRAG_SOURCE_GHOST_OPACITY = (\d+)/.exec(launcherSource)?.[1] > 0,
    'the drag source ghost must stay partially visible');

// DockAppIconMenu reads a surface off its source actor that is defined on
// DockAbstractAppIcon, which LauncherAppIcon deliberately does not extend.
// Derive the contract from the menu's own source so a new sourceActor.* use
// cannot silently break right-click again.
const appIconsSource = await readFile(new URL('../appIcons.js', import.meta.url), 'utf8');
const menuStart = appIconsSource.indexOf('class DockAppIconMenu extends');
const menuEnd = appIconsSource.indexOf('export function getInterestingWindows');
assert.ok(menuStart > 0 && menuEnd > menuStart);
const menuBody = appIconsSource.slice(menuStart, menuEnd);

const launcherIconBody = launcherSource.slice(
    launcherSource.indexOf('class LauncherAppIcon extends'),
    launcherSource.indexOf('export class AppGridLauncher'));
assert.ok(launcherIconBody.length > 0);

// Supplied by Shell's AppIcon/AppViewItem itself, so not required locally.
const inheritedFromAppIcon = new Set(['name', 'animateLaunch', 'app']);
const required = new Set(
    [...menuBody.matchAll(/sourceActor(?:\?)?\.([a-zA-Z_][a-zA-Z0-9_]*)/g)]
        .map(match => match[1])
        .filter(member => !inheritedFromAppIcon.has(member)));
assert.ok(required.has('getInterestingWindows'),
    'contract extraction failed - check the DockAppIconMenu source markers');
for (const member of required) {
    // Anchor on a class-body definition, not a call site: `this.foo()` inside
    // another method must not count as implementing foo.
    assert.match(launcherIconBody, new RegExp(`^ {4}(?:get )?${member}\\s*\\(`, 'm'),
        `LauncherAppIcon must implement ${member}() for DockAppIconMenu`);
}

// The drag monitor must return CONTINUE: dnd.js _updateDragHover() returns
// early on any other result, which would stop handleDragOver ever reaching the
// drawer row under the pointer.
const monitorBlock = launcherSource.slice(
    launcherSource.indexOf('_installDragMonitor()'),
    launcherSource.indexOf('_removeDragMonitor()'));
assert.match(monitorBlock, /DragMotionResult\.CONTINUE/);

// Closing from inside dragMotion tears actors down while dnd.js holds a destroy
// handler on the picked target, so the close is deferred to an idle callback.
const dragMotionBlock = launcherSource.slice(
    launcherSource.indexOf('_onDragMotion(event)'),
    launcherSource.indexOf('onDragEnd(icon)'));
assert.match(dragMotionBlock, /_queueIdle\('drag close'/);
// The close must sit INSIDE the idle callback, not before it.
assert.ok(dragMotionBlock.indexOf("_queueIdle('drag close'") <
    dragMotionBlock.indexOf('this.close({animate: false})'),
    'the launcher close must be deferred to the idle callback, not run inline');

// Graphene.Rect exposes origin/size as fields in GJS; the method forms throw.
assert.doesNotMatch(launcherSource, /get_transformed_extents\(\)\.get_(origin|size)\(\)/);

// The other half of drag-to-file. DockAppIconMenu._rebuildMenu() runs inside
// popup() and discards every item, so the launcher's entry must be appended
// after popup(), not when the menu is first constructed.
const popupBody = launcherSource.slice(
    launcherSource.indexOf('    popupMenu() {'),
    launcherSource.indexOf('    showLabel() {}'));
assert.ok(popupBody.indexOf('this._menu.popup()') <
    popupBody.indexOf('appendDrawerMenuItem'),
    'the drawer menu item must be appended after popup() rebuilds the menu');

// Removal only offered while a drawer is the active filter: an app can belong
// to several drawers, so outside that context there is no unambiguous target.
const appendBody = launcherSource.slice(
    launcherSource.indexOf('    appendDrawerMenuItem(menu, icon) {'),
    launcherSource.indexOf('    _removeAppFromDrawer('));
assert.match(appendBody, /const id = this\._activeDrawerId;/);
// The guard is a STRING test, not a truthiness test. Quick access is null and
// All Apps is a Symbol; both are views rather than folders, and a Symbol is
// truthy, so `!id` alone would let "Remove from All Apps" through.
assert.match(appendBody, /typeof id !== 'string'/);

// Left at the leftmost column is a dead key in moveSelection, so it hands
// focus to the sidebar, which was otherwise reachable only by Tab.
const keyBody = launcherSource.slice(
    launcherSource.indexOf('    _onButtonKeyPress(button, event) {'),
    launcherSource.indexOf('    _focusDrawerRow() {'));
assert.match(keyBody, /direction === this\._towardSidebarDirection\(\)/);

// The sidebar is the content box's first child, so it renders left under LTR
// and RIGHT under RTL (measured in a nested Shell: x=25 vs x=771). Both the key
// that enters it and the key that leaves it must mirror, or RTL users walk the
// wrong way. Neither direction may be hardcoded.
assert.match(launcherSource,
    /_towardSidebarDirection\(\) \{\s*return this\._rtl \? 'right' : 'left';/);
assert.match(launcherSource,
    /_backToGridKey\(\) \{\s*return this\._rtl \? Clutter\.KEY_Left : Clutter\.KEY_Right;/);
const rowKeyBody = launcherSource.slice(
    launcherSource.indexOf('    _onDrawerRowKeyPress(row, event) {'),
    launcherSource.indexOf('    _showHoverLabel(icon) {'));
assert.doesNotMatch(rowKeyBody, /symbol === Clutter\.KEY_Right/,
    'the return-to-grid key must be mirrored, not hardcoded to Right');

console.log(`appLauncherModel and runtime contracts: passed (menu contract: ${
    [...required].sort().join(', ')})`);
