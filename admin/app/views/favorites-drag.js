// favorites-drag — pointer-events-based row reorder for the favourites
// tab (#128). Wires one drag-handle per row; the controller owns the
// in-flight drag state for the whole list.
//
// Why this lives in its own module:
//   - views/favorites.js already owns CRUD + focus-flash; the drag
//     surface is its own concern with its own pointer lifecycle.
//   - Splitting keeps the test surface focused: the splice math lives
//     in app/favorites.js (pure), the DOM choreography lives here, and
//     the integration test in test_favorites_drag.js drives both
//     through synthetic pointer events.
//
// Lifecycle, per drag:
//
//   pointerdown on .station-row__drag
//     → setPointerCapture(pointerId)
//     → snapshot fromIdx + a ghost (semi-transparent fixed clone)
//     → mount a drop indicator (a thin <div>) into the list container
//     → install pointermove / pointerup / pointercancel + Escape
//   pointermove
//     → move the ghost to follow pointer Y
//     → compute the target gap from row rects + pointer Y
//     → reposition the drop indicator
//   pointerup
//     → spliceReorder(list, from, gap) → next
//     → if next !== list, call onDrop(next, prev); else no-op
//     → tear down ghost + indicator
//   pointercancel | Escape
//     → tear down ghost + indicator; no POST
//
// Listeners are added on the handle for pointerdown only; the rest of
// the lifecycle attaches to the document so the drag survives the
// pointer leaving the handle. setPointerCapture would do most of this
// itself in production browsers, but JSDOM / xmldom don't honour it,
// and document-scoped listeners are the same code path either way.
//
// Tests stub `row.getBoundingClientRect()` on each rendered row so the
// gap-mapping math has something to chew on; production code uses the
// real DOM rect.

import { spliceReorder } from '../favorites.js';

function indexOfRow(rows, row) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === row) return i;
  }
  return -1;
}

// Map a pointer Y to the gap index ∈ [0..rows.length]. Each row votes
// for "before me" or "after me" based on its midline; the first row
// whose midline beats the pointer wins. Falls back to "last gap" if the
// pointer is below every midline.
function gapFromPointer(rows, pointerY) {
  for (let i = 0; i < rows.length; i++) {
    const rect = typeof rows[i].getBoundingClientRect === 'function'
      ? rows[i].getBoundingClientRect()
      : null;
    if (!rect) continue;
    const mid = rect.top + rect.height / 2;
    if (pointerY < mid) return i;
  }
  return rows.length;
}

function buildGhost(sourceRow) {
  // Cheap clone: a div that mirrors the source's visible class list and
  // copies its textual signature. We don't need a pixel-perfect copy —
  // a translucent silhouette that follows the pointer is enough to read
  // as "this row is in flight". Falling back to cloneNode when the
  // host supports it keeps the ghost faithful in real browsers; the
  // text-only path keeps the DOM shim happy in tests.
  const ghost = document.createElement('div');
  ghost.className = 'favorites-drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  if (typeof sourceRow.cloneNode === 'function') {
    try {
      const clone = sourceRow.cloneNode(true);
      // Strip ids / dataset hooks from the clone so duplicate-id rules
      // and event handlers don't fight the live row.
      if (clone && clone.removeAttribute) clone.removeAttribute('data-fav-id');
      ghost.appendChild(clone);
    } catch (_err) {
      const text = document.createElement('span');
      text.textContent = sourceRow.textContent || '';
      ghost.appendChild(text);
    }
  } else {
    const text = document.createElement('span');
    text.textContent = sourceRow.textContent || '';
    ghost.appendChild(text);
  }
  return ghost;
}

function positionGhost(ghost, x, y) {
  if (!ghost || !ghost.style) return;
  // Cursor coordinates — must stay inline. position:fixed +
  // pointer-events:none live on .favorites-drag-ghost in style.css.
  ghost.style.setProperty('left', `${x}px`);
  ghost.style.setProperty('top',  `${y}px`);
}

function buildIndicator() {
  const ind = document.createElement('div');
  ind.className = 'favorites-drag-indicator';
  ind.setAttribute('aria-hidden', 'true');
  return ind;
}

// Move the indicator into the list at the slot matching `gap`. Inserts
// before the row at `gap` when one exists; appends when `gap` is past
// the end. The indicator is always re-parented even when its position
// hasn't changed — cheap, and avoids a "did it move?" diff.
function placeIndicator(listEl, indicator, rows, gap) {
  if (!indicator || !listEl) return;
  if (indicator.parentNode) indicator.parentNode.removeChild(indicator);
  const before = gap < rows.length ? rows[gap] : null;
  if (before && before.parentNode === listEl) {
    listEl.insertBefore(indicator, before);
  } else {
    listEl.appendChild(indicator);
  }
}

// installFavoriteDrag — wire one drag handle. Called per row.
//
//   handle      — the .station-row__drag span
//   row         — the .station-row--crud element (used as source + rect)
//   listEl      — the .favorites-list container (parent of all rows)
//   getList     — () → current favourites array (pulled from store at
//                  pointerdown so a mid-flight reconcile doesn't strand
//                  the drag against a stale snapshot)
//   getFromIdx  — () → index of this row's entry in the live list at
//                  pointerdown. Resolved on every pointerdown so list
//                  mutations between renders don't desync.
//   onDrop      — (next, prev) → void. Called once per successful drop
//                  when the list actually changed. The caller fires the
//                  POST.
//   onCleanup   — defineView env.onCleanup, so the handle's pointerdown
//                  listener is removed when the view unmounts.
//
// Returns nothing; side-effects only.
export function installFavoriteDrag({
  handle, row, listEl, getList, getFromIdx, onDrop, onCleanup,
}) {
  if (!handle || !row || !listEl) return;

  // Per-drag state. Reset to nulls between drags so a stale ghost from
  // one drag can't survive into the next.
  let active        = false;
  let pointerId     = null;
  let fromIdx       = -1;
  let snapshotList  = null;
  let ghost         = null;
  let indicator     = null;
  let rowsCache     = [];
  let currentGap    = -1;

  function rowList() {
    // Re-read on every move — the DOM is the source of truth for which
    // rows are currently rendered (replaceChildren during a render
    // would otherwise leave the cache pointing at detached nodes).
    return Array.from(listEl.querySelectorAll('.station-row--crud'));
  }

  function teardown() {
    if (!active) return;
    active = false;
    try {
      if (pointerId != null && typeof handle.releasePointerCapture === 'function') {
        handle.releasePointerCapture(pointerId);
      }
    } catch (_err) { /* not all hosts implement it */ }
    pointerId = null;
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
    ghost = null;
    indicator = null;
    row.classList.remove('is-dragging');
    if (listEl.classList) listEl.classList.remove('is-drag-active');
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('pointermove',   onPointerMove);
      document.removeEventListener('pointerup',     onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('keydown',       onKeyDown);
    }
    snapshotList = null;
    rowsCache = [];
    fromIdx = -1;
    currentGap = -1;
  }

  function onPointerDown(evt) {
    if (evt && evt.button !== undefined && evt.button !== 0) return;
    if (active) return;
    // aria-disabled on the handle is the kill-switch for the filter
    // tab (#135) — drag against a filtered subset is semantically
    // ambiguous, so the view marks the handle and we bail before any
    // ghost / indicator gets mounted.
    if (handle.getAttribute && handle.getAttribute('aria-disabled') === 'true') return;
    const list = typeof getList === 'function' ? getList() : null;
    const idx  = typeof getFromIdx === 'function' ? getFromIdx() : -1;
    if (!Array.isArray(list) || list.length < 2) return;
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return;

    active = true;
    snapshotList = list.slice();
    fromIdx = idx;
    pointerId = evt && evt.pointerId != null ? evt.pointerId : null;

    try {
      if (pointerId != null && typeof handle.setPointerCapture === 'function') {
        handle.setPointerCapture(pointerId);
      }
    } catch (_err) { /* not all hosts implement it */ }

    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();

    row.classList.add('is-dragging');
    if (listEl.classList) listEl.classList.add('is-drag-active');

    rowsCache = rowList();

    ghost = buildGhost(row);
    document.body.appendChild(ghost);
    const px = evt && typeof evt.clientX === 'number' ? evt.clientX : 0;
    const py = evt && typeof evt.clientY === 'number' ? evt.clientY : 0;
    positionGhost(ghost, px, py);

    indicator = buildIndicator();
    // Render the indicator at the source's own position first so the
    // initial visual reads as "this row is picked up, drop slot is
    // where it currently sits".
    currentGap = fromIdx;
    placeIndicator(listEl, indicator, rowsCache, currentGap);

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('pointermove',   onPointerMove);
      document.addEventListener('pointerup',     onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
      document.addEventListener('keydown',       onKeyDown);
    }
  }

  function onPointerMove(evt) {
    if (!active) return;
    if (pointerId != null && evt && evt.pointerId != null && evt.pointerId !== pointerId) return;
    const px = evt && typeof evt.clientX === 'number' ? evt.clientX : 0;
    const py = evt && typeof evt.clientY === 'number' ? evt.clientY : 0;
    positionGhost(ghost, px, py);
    // Recompute against the current DOM, not the snapshot — the
    // indicator could be sitting between rows that were re-rendered.
    rowsCache = rowList().filter((r) => r !== indicator && r !== ghost);
    const gap = gapFromPointer(rowsCache, py);
    if (gap !== currentGap) {
      currentGap = gap;
      placeIndicator(listEl, indicator, rowsCache, gap);
    }
  }

  function onPointerUp(evt) {
    if (!active) return;
    if (pointerId != null && evt && evt.pointerId != null && evt.pointerId !== pointerId) return;
    const prev = snapshotList || [];
    const gap  = currentGap >= 0 ? currentGap : fromIdx;
    const next = spliceReorder(prev, fromIdx, gap);
    teardown();
    // Identity check: spliceReorder returns the same array reference
    // when the drop is a no-op (same gap or off-by-one at source).
    if (next !== prev && typeof onDrop === 'function') {
      onDrop(next, prev);
    }
  }

  function onPointerCancel(evt) {
    if (!active) return;
    if (pointerId != null && evt && evt.pointerId != null && evt.pointerId !== pointerId) return;
    teardown();
  }

  function onKeyDown(evt) {
    if (!active) return;
    if (evt && evt.key === 'Escape') {
      if (typeof evt.preventDefault === 'function') evt.preventDefault();
      teardown();
    }
  }

  handle.addEventListener('pointerdown', onPointerDown);
  if (typeof onCleanup === 'function') {
    onCleanup(() => {
      handle.removeEventListener('pointerdown', onPointerDown);
      teardown();
    });
  }
}
