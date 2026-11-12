// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

export const MAX_VISIBLE_RESULTS = 72;
export const QUICK_ACCESS_COUNT = 6;

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;
const BASE_CELL_WIDTH = 80;
const MAX_GRID_WIDTH = 480;
const POPUP_HORIZONTAL_INSET = 32;
const CONTENT_SPACING = 6;
const MIN_SIDEBAR_WIDTH = 72;
const MIN_GRID_WIDTH = 80;
const MIN_POPUP_HEIGHT = 220;
const MAX_POPUP_HEIGHT = 440;
// Floor for the results area once the header and footer have taken their share.
const MIN_GRID_HEIGHT = 160;
// A size dragged by the user is still clamped to the monitor. These leave room
// for the parts of the popup outside the grid and the sidebar: the search entry,
// status line, padding and arrow (138px tall, 50px wide with the default theme).
const RESIZE_VERTICAL_ALLOWANCE = 160;
const RESIZE_HORIZONTAL_ALLOWANCE = 32;
// Narrowest width a drag can produce where the monitor has room for more.
export const MIN_RESIZED_COLUMNS = 3;

// The rim of the popup that resizes it: this far inside its visible edge and a
// little outside it, wider at the corners so that both axes are easy to catch.
const RESIZE_BAND = 8;
const RESIZE_OUTSIDE = 4;
const RESIZE_CORNER = 20;
// Allocation rounding keeps a centred popup within a pixel of its button.
const CENTERED_TOLERANCE = 2;

// St.Side, which this module cannot import.
const Side = Object.freeze({TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3});

/**
 * Preferred sidebar width, in logical pixels.
 *
 * A constant rather than a measurement: the sidebar's allocation is 0 until
 * the popup has been laid out once, so reading it back gave the grid a
 * different width on the first open than on every open after it, and a
 * different width again whenever a long drawer name stretched the rows. The
 * launcher normally sets this on the actor and spends it from the width budget,
 * so both sides of the popup agree before anything is allocated. Very narrow
 * work areas may reduce it to leave one usable result column.
 */
export const SIDEBAR_WIDTH = 144;

/** Breathing room above and below the header's avatar, in logical pixels. */
export const HEADER_PADDING = 8;

/** Height of the popup's footer bar, in CSS pixels. */
export const FOOTER_HEIGHT = 40;

/**
 * Height of the popup's header bar, in CSS pixels.
 *
 * Derived from the avatar rather than hard-coded, because Shell's Avatar sizes
 * itself from `Main.defaultIconSize`: a literal that fits a 64px avatar crops a
 * larger one. Measured before this existed, a 64px avatar in a 56px bar came
 * out 64x56 -- visibly squashed.
 *
 * Deliberately does NOT take a scale factor, even though Avatar multiplies its
 * own size by one. Everything here is CSS pixels, and St already multiplies CSS
 * lengths by the scale factor, so folding the scale in here would apply it
 * twice and produce a bar twice as tall as it should be on a HiDPI display.
 * `iconSize + padding` in CSS pixels renders as `(iconSize + padding) * scale`,
 * against an avatar of `iconSize * scale` -- they track each other at any scale.
 *
 * The launcher sets the result on the actor AND spends it from the height
 * budget, the same contract SIDEBAR_WIDTH has: both sides must agree before
 * anything is allocated, so it cannot be measured back off the bar itself.
 *
 * @param {number} iconSize Main.defaultIconSize
 * @returns {number} header height in CSS pixels
 */
export function computeHeaderHeight(iconSize) {
    const size = Number.isFinite(iconSize) && iconSize > 0 ? iconSize : 64;
    return size + HEADER_PADDING * 2;
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Normalize user-visible application metadata for accent-insensitive matching.
 *
 * @param {string|string[]} value text or text fragments to normalize
 * @returns {string} normalized, lower-case search text
 */
export function normalizeSearchText(value) {
    const text = Array.isArray(value) ? value.filter(Boolean).join(' ') : value ?? '';
    return text.toLocaleLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Return matching catalog entries in their existing (favorites/name) order.
 * Filtering never enumerates Shell applications or sorts results, and the
 * returned actor workload is explicitly capped.
 *
 * @param {object[]} catalog cached launcher catalog
 * @param {string} query user query
 * @param {number} limit maximum number of rendered entries
 * @returns {{items: object[], total: number, truncated: boolean}}
 */
export function filterCatalog(catalog, query, limit = MAX_VISIBLE_RESULTS) {
    const terms = normalizeSearchText(query).split(' ').filter(Boolean);
    const items = [];
    let total = 0;

    for (const entry of catalog) {
        if (!terms.every(term => entry.searchText.includes(term)))
            continue;

        total++;
        if (items.length < limit)
            items.push(entry);
    }

    return {
        items,
        total,
        truncated: total > items.length,
    };
}

/**
 * Fill the quick-access landing row from usage-ranked entries, then from the
 * catalog's favourites/name order. AppUsage is history, not an inventory, so a
 * lightly used account commonly supplies only one or two eligible entries.
 *
 * Both inputs may contain duplicates; the result never does. Entries already
 * resolved through the catalog retain usage order, while the top-up remains
 * subject to the catalog's visibility and parental-control filtering.
 *
 * @param {object[]} catalog complete filtered launcher catalog
 * @param {object[]} ranked usage-ranked entries already resolved through catalog
 * @param {number} limit maximum quick-access entries
 * @returns {object[]} bounded unique quick-access entries
 */
export function fillQuickAccess(catalog, ranked, limit = QUICK_ACCESS_COUNT) {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (safeLimit === 0)
        return [];

    const result = [];
    const seen = new Set();

    for (const entry of [...ranked, ...catalog]) {
        if (!entry?.id || seen.has(entry.id))
            continue;
        seen.add(entry.id);
        result.push(entry);
        if (result.length === safeLimit)
            break;
    }

    return result;
}

/**
 * Plan one keyboard move of a drawer in its visible order.
 *
 * DrawerStore.reorder() inserts before an id, so moving down uses the item
 * after the target (or null at the end), while moving up uses the target itself.
 *
 * @param {string[]} order visible drawer ids
 * @param {string} id drawer to move
 * @param {-1|1} direction -1 for up, 1 for down
 * @returns {{beforeId: string|null, targetIndex: number}|null} store operation
 */
export function planAdjacentDrawerReorder(order, id, direction) {
    if (direction !== -1 && direction !== 1)
        return null;

    const from = order.indexOf(id);
    const targetIndex = from + direction;
    if (from < 0 || targetIndex < 0 || targetIndex >= order.length)
        return null;

    return {
        beforeId: direction < 0 ? order[targetIndex] : order[targetIndex + 1] ?? null,
        targetIndex,
    };
}

/**
 * Compute a launcher layout in logical stage coordinates. Mutter's monitor
 * work areas and St actor allocations share this coordinate space; resource
 * scale belongs to rasterization and must not shrink the available layout a
 * second time. Large-text users get fewer, wider columns, while small work
 * areas remain usable rather than overflowing.
 *
 * @param {object} params layout inputs
 * @param {number} params.workAreaWidth logical monitor work-area width
 * @param {number} params.workAreaHeight logical monitor work-area height
 * @param {number} params.textScale desktop text scale
 * @param {number} params.sidebarWidth width the drawer sidebar takes from the budget
 * @param {number} params.chromeHeight height of the header and footer bars
 * @param {number} params.columns columns the user resized to, or 0 for the default
 * @param {number} params.gridHeight results height the user resized to, or 0
 * @returns {{columns: number, width: number, sidebarWidth: number,
 *   gridHeight: number, iconSize: number, cellWidth: number}}
 */
export function computeGridLayout({
    workAreaWidth,
    workAreaHeight,
    textScale = 1,
    sidebarWidth = 0,
    chromeHeight = 0,
    columns: resizedColumns = 0,
    gridHeight: resizedHeight = 0,
}) {
    const logicalWidth = Number.isFinite(workAreaWidth) && workAreaWidth > 0
        ? workAreaWidth
        : 240;
    const logicalHeight = Number.isFinite(workAreaHeight) && workAreaHeight > 0
        ? Math.max(320, workAreaHeight)
        : 320;
    const safeTextScale = clamp(Number.isFinite(textScale) ? textScale : 1, 0.8, 2);
    // The drawer sidebar shares the popup's width budget. Preserve a navigable
    // label/focus target even when a 2x text scale makes one nominal grid cell
    // wider than the whole popup. The grid may contract below its nominal cell
    // width (its 40px compact icon still fits), while very small work areas can
    // relinquish the sidebar only after reserving MIN_GRID_WIDTH.
    const requestedSidebar = Math.max(0,
        Number.isFinite(sidebarWidth) ? sidebarWidth : 0);
    const spacing = requestedSidebar > 0 ? CONTENT_SPACING : 0;
    const contentBudget = Math.max(1,
        logicalWidth - POPUP_HORIZONTAL_INSET - spacing);
    const cellWidth = Math.round(BASE_CELL_WIDTH * safeTextScale);
    const minimumSidebar = requestedSidebar > 0
        ? Math.min(requestedSidebar, MIN_SIDEBAR_WIDTH,
            Math.max(0, contentBudget - MIN_GRID_WIDTH))
        : 0;
    const effectiveSidebar = Math.min(requestedSidebar,
        Math.max(minimumSidebar, contentBudget - cellWidth));
    const availableWidth = Math.max(1, contentBudget - effectiveSidebar);
    // Keep the launcher a compact dock popover rather than a second overview.
    // Reduce the surface, not the desktop's text or pointer target sizes.
    const targetWidth = Math.min(availableWidth, MAX_GRID_WIDTH);
    // A dragged width is whole columns, so a tile is the same size at any
    // width. It is the user's choice of surface, so only the monitor bounds it.
    const fitColumns = Math.max(MIN_COLUMNS,
        Math.floor((availableWidth - RESIZE_HORIZONTAL_ALLOWANCE) / cellWidth));
    const columns = isPositive(resizedColumns)
        ? clamp(Math.round(resizedColumns), Math.min(MIN_RESIZED_COLUMNS, fitColumns), fitColumns)
        : clamp(Math.floor(targetWidth / cellWidth), MIN_COLUMNS, MAX_COLUMNS);
    const width = Math.min(availableWidth, columns * cellWidth);
    // A fixed height, NOT a ceiling. Applied as max-height the popup grew and
    // shrank with the result count, so it jumped on every keystroke that
    // changed how many apps matched. Nothing here takes a result count, which
    // is the property that keeps the popup one size.
    //
    // The header and footer bars come out of the SAME budget rather than being
    // added on top of it, so gaining them does not make the popup taller.
    //
    // The clamp is applied to the WHOLE popup's budget and the chrome is taken
    // out of the result -- not the other way round. Subtracting first is wrong
    // and silently does nothing on any tall monitor: 66% of a 1440px work area
    // is 950, so clamping 950-56 back down to MAX_POPUP_HEIGHT returned the
    // same 680 as before and the popup simply grew by the height of the bar.
    // Measured that way: 813px -> 870px.
    //
    // MIN_GRID_HEIGHT is the floor. Below it the popup does grow rather than
    // squeeze the grid to nothing, which is the right trade on a very short
    // work area -- a launcher with no room for icons is worse than a tall one.
    const chrome = Math.max(0, Number.isFinite(chromeHeight) ? chromeHeight : 0);
    const budget = clamp(Math.floor(logicalHeight * 0.66),
        MIN_POPUP_HEIGHT, MAX_POPUP_HEIGHT);
    // A dragged height is still a fixed height: it replaces the default, it
    // does not follow the results.
    const gridHeight = isPositive(resizedHeight)
        ? clamp(Math.round(resizedHeight), MIN_GRID_HEIGHT,
            Math.max(MIN_GRID_HEIGHT, logicalHeight - chrome - RESIZE_VERTICAL_ALLOWANCE))
        : Math.max(MIN_GRID_HEIGHT, budget - chrome);
    const iconSize = logicalWidth < 560 || safeTextScale >= 1.5 ? 40 : 48;

    return {
        columns,
        width,
        sidebarWidth: effectiveSidebar,
        gridHeight,
        iconSize,
        cellWidth,
    };
}

function isPositive(value) {
    return Number.isFinite(value) && value > 0;
}

/**
 * Which edge of the launcher a point would drag: any edge except the one
 * whose arrow points at the dock, and the corners between them.
 *
 * @param {{x: number, y: number}} point stage position
 * @param {{x: number, y: number, width: number, height: number}} rect the
 *   popup's visible surface, in stage coordinates
 * @param {number} arrowSide St.Side the arrow points from
 * @returns {{x: number, y: number}|null} -1 for the left or top edge, 1 for
 *   the right or bottom edge, 0 for neither; null when no edge is under it
 */
export function findResizeEdge(point, rect, arrowSide) {
    const {x, y} = point;
    if (x < rect.x - RESIZE_OUTSIDE || x > rect.x + rect.width + RESIZE_OUTSIDE ||
        y < rect.y - RESIZE_OUTSIDE || y > rect.y + rect.height + RESIZE_OUTSIDE)
        return null;

    const near = (start, end, reach) => {
        if (start <= reach)
            return -1;
        return end <= reach ? 1 : 0;
    };
    const left = x - rect.x;
    const right = rect.x + rect.width - x;
    const top = y - rect.y;
    const bottom = rect.y + rect.height - y;
    let edgeX = near(left, right, RESIZE_BAND);
    let edgeY = near(top, bottom, RESIZE_BAND);
    if (edgeX && !edgeY)
        edgeY = near(top, bottom, RESIZE_CORNER);
    else if (edgeY && !edgeX)
        edgeX = near(left, right, RESIZE_CORNER);

    // The arrow's edge stays against the dock.
    if (arrowSide === Side.TOP && edgeY < 0 || arrowSide === Side.BOTTOM && edgeY > 0)
        edgeY = 0;
    if (arrowSide === Side.LEFT && edgeX < 0 || arrowSide === Side.RIGHT && edgeX > 0)
        edgeX = 0;
    return edgeX || edgeY ? {x: edgeX, y: edgeY} : null;
}

/**
 * The size a drag asks for, before computeGridLayout() fits it to the monitor:
 * the size that puts the dragged edge where the pointer holds it.
 *
 * Measured from the popup as it is now rather than from where the drag began,
 * because how an edge responds to a new size depends on where the popup sits.
 * Away from the dock only the dragged edge moves. Along the dock the popup is
 * centred on its button, so both edges move and the size changes by twice the
 * pointer's travel -- until the popup meets the screen edge and is pushed
 * along, after which only the free side moves again.
 *
 * @param {object} params drag state
 * @param {{x: number, y: number}} params.edge from findResizeEdge()
 * @param {number} params.arrowSide St.Side the arrow points from
 * @param {{x: number, y: number}} params.target where the dragged edge belongs
 * @param {{x: number, y: number, width: number, height: number}} params.surface
 *   the popup's visible surface now
 * @param {{x: number, y: number}} params.sourceCenter centre of its dock button
 * @param {{columns: number, gridWidth: number, gridHeight: number}} params.size
 *   the grid's current size
 * @param {number} params.cellWidth width of one result column
 * @returns {{columns: number, gridHeight: number}} requested size
 */
export function planLauncherResize({edge, arrowSide, target, surface, sourceCenter, size, cellWidth}) {
    const alongX = arrowSide === Side.TOP || arrowSide === Side.BOTTOM;
    let {columns, gridHeight} = size;
    if (edge.x) {
        const width = spanTo(edge.x, target.x, surface.x, surface.width,
            alongX ? sourceCenter.x : null);
        columns = Math.max(1, Math.round((width - surface.width + size.gridWidth) / cellWidth));
    }
    if (edge.y) {
        const height = spanTo(edge.y, target.y, surface.y, surface.height,
            alongX ? null : sourceCenter.y);
        gridHeight = Math.max(1, Math.round(height - surface.height + size.gridHeight));
    }
    return {columns, gridHeight};
}

// How long the popup must be along one axis to put its edge on the `direction`
// side (-1 start, 1 end) at `target`. `center` is the button the popup is
// centred on along this axis, or null where the opposite edge is held by the dock.
function spanTo(direction, target, start, length, center) {
    const end = start + length;
    const opposite = direction > 0 ? start : end;
    if (center === null)
        return direction * (target - opposite);

    const shift = start + length / 2 - center;
    if (Math.abs(shift) <= CENTERED_TOLERANCE)
        return 2 * direction * (target - center);
    // Pushed along by the screen edge behind the dragged side: that side is
    // held there, while the dragged edge moves alone -- unless the new length
    // is short enough for the popup to centre on its button again.
    if (Math.sign(shift) === direction) {
        const held = direction * (target - opposite);
        const centredOpposite = center - direction * held / 2;
        return direction * (opposite - centredOpposite) > 0
            ? held : 2 * direction * (target - center);
    }
    // The dragged side itself is at the screen edge. It cannot go further out;
    // drawn back in, the popup recentres on its button.
    const edgeNow = direction > 0 ? end : start;
    if (direction * (target - edgeNow) >= 0)
        return length;
    return 2 * direction * (target - center);
}

export const MAX_DRAWER_NAME_LENGTH = 40;

/**
 * Decide whether an app-folder belongs in the launcher's drawer sidebar.
 *
 * `translate` is the discriminator between folders a user made and folders a
 * distribution ships: user folders carry a plain name and `translate=false`,
 * while `System`, `Utilities`, `YaST` and `Pardus` carry a `.directory` file
 * name and `translate=true`. Listing only untranslated folders keeps distro
 * folders out of the sidebar, which in turn means the launcher never has to
 * resolve `.directory` names, and can never delete a folder it did not create.
 *
 * Folders driven by `categories` rather than an explicit `apps` list are also
 * skipped: their membership is computed by Shell from desktop-file categories,
 * and half-supporting that would show or hide the wrong apps.
 *
 * @param {object} folder folder settings snapshot
 * @param {boolean} folder.translate whether the name is a .directory reference
 * @param {string[]} folder.categories desktop categories driving membership
 * @returns {boolean} whether the launcher should offer it as a drawer
 */
export function isUserDrawer({translate, categories = []} = {}) {
    return translate === false && categories.length === 0;
}

/**
 * Resolve a drawer's membership: its explicit apps minus its exclusions.
 *
 * Order is preserved and duplicates are dropped, so a drawer that lists the
 * same desktop id twice renders one result.
 *
 * @param {object} folder folder settings snapshot
 * @param {string[]} folder.apps explicitly filed desktop ids
 * @param {string[]} folder.excludedApps desktop ids removed from the folder
 * @returns {string[]} desktop ids belonging to the drawer
 */
export function resolveDrawerApps({apps = [], excludedApps = []} = {}) {
    const excluded = new Set(excludedApps);
    const seen = new Set();

    return apps.filter(id => {
        if (excluded.has(id) || seen.has(id))
            return false;
        seen.add(id);
        return true;
    });
}

/**
 * Validate a user-supplied drawer name.
 *
 * Names are compared case-insensitively against existing drawers because two
 * drawers called "Games" and "games" are indistinguishable in the sidebar and
 * would silently create a second folder.
 *
 * @param {string} name proposed name
 * @param {string[]} existingNames names already in use
 * @returns {{ok: boolean, name?: string, reason?: string}} validated name
 */
export function validateDrawerName(name, existingNames = []) {
    const trimmed = (name ?? '').trim();

    if (!trimmed)
        return {ok: false, reason: 'empty'};
    if (trimmed.length > MAX_DRAWER_NAME_LENGTH)
        return {ok: false, reason: 'too-long'};

    const folded = trimmed.toLocaleLowerCase();
    if (existingNames.some(existing => existing.trim().toLocaleLowerCase() === folded))
        return {ok: false, reason: 'duplicate'};

    return {ok: true, name: trimmed};
}

/**
 * Map a row-major result index to the physical Clutter.GridLayout cell used
 * on screen. GridLayout's explicit column attachments are physical, so RTL
 * rows must be mirrored to keep keyboard movement aligned with what users see.
 *
 * @param {number} index result index
 * @param {number} columns grid column count
 * @param {boolean} rtl whether the grid is right-to-left
 * @returns {{column: number, row: number}} physical grid position
 */
export function getGridPosition(index, columns, rtl = false) {
    const safeColumns = Math.max(1, columns);
    const logicalColumn = index % safeColumns;

    return {
        column: rtl ? safeColumns - logicalColumn - 1 : logicalColumn,
        row: Math.floor(index / safeColumns),
    };
}

/**
 * How many cells past the last result are needed to finish its row.
 *
 * Clutter.GridLayout only creates the columns something is attached to, so a
 * homogeneous grid holding fewer results than one full row splits the whole
 * width between them -- a drawer with a single app got one row-wide tile
 * instead of a cell-wide one. Occupying the trailing cells keeps the column
 * count fixed, and so keeps a tile the same size at every result count.
 *
 * @param {number} count number of results attached to the grid
 * @param {number} columns grid column count
 * @returns {number} number of filler cells to attach after the last result
 */
export function trailingCellCount(count, columns) {
    const safeColumns = Math.max(1, columns);
    const safeCount = Math.max(0, count);

    // An empty grid stays empty: there is no partial row to finish.
    return (safeColumns - safeCount % safeColumns) % safeColumns;
}

/**
 * Move a row-major grid selection. A return value of -1 asks the caller to
 * return focus to the search entry (Up from the first row).
 *
 * @param {number} index current index
 * @param {number} count result count
 * @param {number} columns grid column count
 * @param {'left'|'right'|'up'|'down'|'home'|'end'} direction movement
 * @param {boolean} rtl whether horizontal visual direction is RTL
 * @returns {number} next selected index, or -1 for the search entry
 */
export function moveSelection(index, count, columns, direction, rtl = false) {
    if (count <= 0)
        return -1;

    const safeColumns = Math.max(1, columns);
    const current = clamp(index, 0, count - 1);
    const row = Math.floor(current / safeColumns);
    const rowStart = row * safeColumns;
    const rowEnd = Math.min(rowStart + safeColumns - 1, count - 1);

    if (direction === 'home')
        return 0;
    if (direction === 'end')
        return count - 1;
    if (direction === 'up')
        return current < safeColumns ? -1 : current - safeColumns;
    if (direction === 'down')
        return Math.min(current + safeColumns, count - 1);

    const visualDelta = direction === 'left' ? -1 : 1;
    const logicalDelta = rtl ? -visualDelta : visualDelta;
    return clamp(current + logicalDelta, rowStart, rowEnd);
}
