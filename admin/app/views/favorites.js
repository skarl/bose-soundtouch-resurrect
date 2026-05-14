// favorites — #/favorites top-level tab.
//
// Tracer-slice rendering: plain row list, no CRUD affordances.
// - row primitives come from `components.stationRow` so the visual
//   matches search results / browse drill rows.
// - the heart on each row (#126) and the pencil/trash/drag affordances
//   (#127/#128/#129) are deliberately NOT here — this slice only proves
//   the loop end-to-end.
//
// The empty-state banner mirrors the search empty state's tone: a short
// hint pointing the user at the station-detail heart, which is where
// the only writer in this slice lives.
//
// Visibility refetch: the favourites array is fetched on app boot via
// reconcile() and again on every `visibilitychange → 'visible'` so a
// second tab that mutated the list flows back into this one.

import { html, mount, defineView } from '../dom.js';
import { stationRow } from '../components.js';
import { reconcileField } from '../speaker-state.js';
import { parseSid } from '../tunein-sid.js';

function buildEmptyState() {
  const wrap = document.createElement('section');
  wrap.className = 'favorites-empty';
  const head = document.createElement('h2');
  head.textContent = 'No favourites yet';
  const body = document.createElement('p');
  body.textContent = 'Tap the heart on a station to add it here.';
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

function buildList(entries) {
  const list = document.createElement('div');
  list.className = 'favorites-list station-list';
  list.setAttribute('role', 'list');
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    // Drill href is computed by stationRow via parseSid; we feed it
    // the bare id and let the row primitive route the click.
    const row = stationRow({
      sid:  entry.id,
      name: entry.name || entry.id,
      art:  entry.art || '',
    });
    row.classList.add('favorites-row');
    // Annotate the row with the detail-href explicitly so it's easy to
    // assert on in tests without re-deriving it.
    const dest = parseSid(entry.id).detailHref;
    if (dest) row.setAttribute('data-detail-href', dest);
    list.appendChild(row);
  }
  return list;
}

// Deep-link focus (#129). The Now-Playing favourites grid sets
// `#/favorites?focus=<id>` on long-press; the router decodes the query
// string and passes it through `ctx.query`. We honour it once at mount
// (and once after the initial render lands data) by scrolling the
// matching row into view and applying `.is-focused` for a brief flash.
// Deliberately scoped to mount-time so #127's CRUD edits to the row
// renderer below stay disjoint. Edit-mode is never auto-entered — a
// long-press from Now Playing must not accidentally open the editor.
const FOCUS_FLASH_MS = 1600;

function applyFocus(body, focusId) {
  if (!body || typeof focusId !== 'string' || !focusId) return false;
  const rows = body.querySelectorAll('.favorites-row');
  for (const row of rows) {
    const sid = row.dataset && row.dataset.sid;
    if (sid !== focusId) continue;
    row.classList.add('is-focused');
    if (typeof row.scrollIntoView === 'function') {
      try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (_err) { /* JSDOM / xmldom — no-op */ }
    }
    setTimeout(() => row.classList.remove('is-focused'), FOCUS_FLASH_MS);
    return true;
  }
  return false;
}

export default defineView({
  mount(root, store, ctx, env) {
    mount(root, html`
      <section class="favorites" data-view="favorites">
        <header class="favorites-header">
          <h1>Favourites</h1>
        </header>
        <div class="favorites-body"></div>
      </section>
    `);
    const body = root.querySelector('.favorites-body');

    // Deep-link target id, taken from `?focus=<id>` and honoured once
    // after the first render that contains a matching row. Cleared after
    // a successful match so subsequent re-renders don't keep re-flashing.
    let pendingFocusId = ctx && ctx.query && typeof ctx.query.focus === 'string'
      ? ctx.query.focus
      : '';

    function render() {
      const list = (store.state.speaker && store.state.speaker.favorites) || null;
      // null = unfetched. Show the empty state immediately so a slow
      // GET doesn't leave the body blank; reconcile-on-mount will land
      // shortly and re-render with the real list.
      const entries = Array.isArray(list) ? list : [];
      if (!body) return;
      if (entries.length === 0) {
        body.replaceChildren(buildEmptyState());
      } else {
        body.replaceChildren(buildList(entries));
        if (pendingFocusId && applyFocus(body, pendingFocusId)) {
          pendingFocusId = '';
        }
      }
    }

    render();

    // Fetch on mount if we haven't yet (speaker-state's reconcile fires
    // at boot, but a deep-link to #/favorites before reconcile lands
    // shouldn't show a phantom empty state any longer than necessary).
    if (!Array.isArray(store.state.speaker.favorites)) {
      reconcileField(store, 'favorites').catch(() => { /* surfaced via store subscription */ });
    }

    // Visibility refetch — mirrors the now-playing pattern. Detaches
    // via env.onCleanup so we don't leak across route transitions.
    function onVisibilityChange() {
      if (typeof document === 'undefined') return;
      if (document.hidden) return;
      reconcileField(store, 'favorites').catch(() => {});
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      env.onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    }

    return {
      speaker() { render(); },
    };
  },
});
