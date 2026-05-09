// search — TuneIn search + empty-state landing.
//
// Sticky input at top, debounced 300ms. Results render via
// stationCard(). Empty state shows "Recently viewed" (from
// state.caches.recentlyViewed) and "Popular" (Browse.ashx?c=local via
// the tunein CGI).
//
// Render strategy (see admin/PLAN.md § Render strategy):
//   init() mounts the static frame and a results container; the input
//   handler mutates the results container in place. update() repaints
//   only the recently-viewed strip when state.caches changes.
//
// URL hash persistence: typing rewrites #/search?q=... via
// history.replaceState so back/forward isn't spammed. Entry with
// ?q=... pre-fills and fires.
//
// See admin/PLAN.md § View specs / search.

import { html, mount } from '../dom.js';
import { tuneinSearch, tuneinBrowse } from '../api.js';
import { stationCard } from '../components.js';
import { store } from '../state.js';

const DEBOUNCE_MS = 300;
const STATION_GUIDE_ID = /^s\d+$/;

// Module-scoped refs. Populated by init(), nulled when the view
// element detaches (router calls root.replaceChildren on dispatch,
// so our captured nodes lose isConnected).
let inputEl       = null;
let resultsEl     = null;
let emptyEl       = null;
let recentListEl  = null;
let popularEl     = null;
let unsubscribe   = null;
let debounceTimer = null;
let inFlightToken = 0;

function clearDebounce() {
  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function teardown() {
  clearDebounce();
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  inputEl      = null;
  resultsEl    = null;
  emptyEl      = null;
  recentListEl = null;
  popularEl    = null;
}

// True when our mounted DOM is still in the document. The router
// detaches the previous view by clearing its root before dispatch.
function isMounted() {
  return !!(resultsEl && resultsEl.isConnected);
}

// --- URL hash --------------------------------------------------------

function writeHash(q) {
  const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
  if (location.hash === target) return;
  // replaceState avoids growing the back-stack on every keystroke.
  // Pass null URL would lose the query in some browsers; build the
  // full URL preserving path + search.
  const next = `${location.pathname}${location.search}${target}`;
  history.replaceState(history.state, '', next);
}

// --- search execution ------------------------------------------------

function showSearchPane() {
  if (!emptyEl || !resultsEl) return;
  emptyEl.hidden = true;
  resultsEl.hidden = false;
}

function showEmptyPane() {
  if (!emptyEl || !resultsEl) return;
  resultsEl.hidden = true;
  emptyEl.hidden = false;
}

function setResultsMessage(text, cls) {
  if (!resultsEl) return;
  resultsEl.replaceChildren();
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  resultsEl.appendChild(p);
}

function renderResults(json) {
  if (!resultsEl) return;
  const items = Array.isArray(json && json.body) ? json.body : [];
  const stations = items.filter(
    (e) => e && e.type === 'audio' && typeof e.guide_id === 'string'
      && STATION_GUIDE_ID.test(e.guide_id)
  );
  resultsEl.replaceChildren();
  if (stations.length === 0) {
    setResultsMessage('No matches.', 'search-no-results');
    return;
  }
  for (const e of stations) {
    resultsEl.appendChild(stationCard({
      sid:      e.guide_id,
      name:     e.text,
      art:      e.image,
      location: e.subtext,
      format:   e.bitrate ? `${e.bitrate} kbps` : e.formats,
    }));
  }
}

function runSearch(q) {
  if (!isMounted()) return;
  const token = ++inFlightToken;
  showSearchPane();
  setResultsMessage('Searching...', 'search-loading');
  tuneinSearch(q)
    .then((json) => {
      // Drop stale responses: only the most recent search wins.
      if (token !== inFlightToken || !isMounted()) return;
      renderResults(json);
    })
    .catch((err) => {
      if (token !== inFlightToken || !isMounted()) return;
      setResultsMessage(`Search failed: ${err.message}`, 'search-error');
    });
}

function handleInput(value) {
  const q = value.trim();
  writeHash(q);
  clearDebounce();
  if (!q) {
    // Cancel any pending search response and switch back to empty
    // state (recently-viewed + popular).
    inFlightToken++;
    showEmptyPane();
    return;
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSearch(q);
  }, DEBOUNCE_MS);
}

// --- empty state -----------------------------------------------------

function renderRecentlyViewed(state) {
  if (!recentListEl) return;
  const recents = Array.isArray(state.caches.recentlyViewed)
    ? state.caches.recentlyViewed
    : [];
  recentListEl.replaceChildren();
  if (recents.length === 0) {
    const p = document.createElement('p');
    p.className = 'search-empty-note';
    p.textContent = 'No recent stations.';
    recentListEl.appendChild(p);
    return;
  }
  for (const entry of recents) {
    if (!entry || typeof entry.sid !== 'string') continue;
    recentListEl.appendChild(stationCard({
      sid:  entry.sid,
      name: entry.name || entry.sid,
      art:  entry.art,
    }));
  }
}

function renderPopular(json) {
  if (!popularEl) return;
  popularEl.replaceChildren();
  const items = Array.isArray(json && json.body) ? json.body : [];

  // Browse.ashx?c=local commonly nests stations under sections.
  // Walk one level of children so we surface station leaves directly.
  const stations = [];
  const visit = (entry) => {
    if (!entry) return;
    if (Array.isArray(entry.children)) {
      for (const c of entry.children) visit(c);
      return;
    }
    if (entry.type === 'audio'
        && typeof entry.guide_id === 'string'
        && STATION_GUIDE_ID.test(entry.guide_id)) {
      stations.push(entry);
    }
  };
  for (const e of items) visit(e);

  if (stations.length === 0) {
    const p = document.createElement('p');
    p.className = 'search-empty-note';
    p.textContent = 'No popular stations available.';
    popularEl.appendChild(p);
    return;
  }
  for (const e of stations) {
    popularEl.appendChild(stationCard({
      sid:      e.guide_id,
      name:     e.text,
      art:      e.image,
      location: e.subtext,
      format:   e.bitrate ? `${e.bitrate} kbps` : e.formats,
    }));
  }
}

function loadPopular() {
  if (!popularEl) return;
  popularEl.replaceChildren();
  const p = document.createElement('p');
  p.className = 'search-loading';
  p.textContent = 'Loading...';
  popularEl.appendChild(p);
  tuneinBrowse({ c: 'local' })
    .then((json) => {
      if (!isMounted()) return;
      renderPopular(json);
    })
    .catch((err) => {
      if (!isMounted() || !popularEl) return;
      popularEl.replaceChildren();
      const p2 = document.createElement('p');
      p2.className = 'search-error';
      p2.textContent = `Couldn't load popular stations: ${err.message}`;
      popularEl.appendChild(p2);
    });
}

// --- view interface --------------------------------------------------

export default {
  init(root, _store, ctx) {
    // Tear down any leftovers from a prior mount (router doesn't call
    // a teardown hook; this is the cheapest way to stay idempotent).
    teardown();

    const initialQ = (ctx && ctx.query && typeof ctx.query.q === 'string')
      ? ctx.query.q
      : '';

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'search-input';
    input.placeholder = 'Search stations';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Search stations');
    input.value = initialQ;

    const results = document.createElement('div');
    results.className = 'search-results';
    results.setAttribute('aria-live', 'polite');
    results.hidden = true;

    const recentSection = document.createElement('section');
    recentSection.className = 'search-empty-section';
    const recentH = document.createElement('h2');
    recentH.textContent = 'Recently viewed';
    const recentList = document.createElement('div');
    recentList.className = 'search-empty-list';
    recentSection.appendChild(recentH);
    recentSection.appendChild(recentList);

    const popularSection = document.createElement('section');
    popularSection.className = 'search-empty-section';
    const popularH = document.createElement('h2');
    popularH.textContent = 'Popular';
    const popularList = document.createElement('div');
    popularList.className = 'search-empty-list';
    popularSection.appendChild(popularH);
    popularSection.appendChild(popularList);

    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.appendChild(recentSection);
    empty.appendChild(popularSection);

    mount(root, html`
      <section data-view="search">
        <div class="search-bar">
          ${input}
        </div>
        ${empty}
        ${results}
      </section>
    `);

    inputEl      = input;
    resultsEl    = results;
    emptyEl      = empty;
    recentListEl = recentList;
    popularEl    = popularList;

    input.addEventListener('input', (ev) => handleInput(ev.target.value));

    // Subscribe directly: this route doesn't declare `subscribe` in
    // main.js, so the router won't wire update() for us. We unwind
    // ourselves on the next init() (teardown above).
    unsubscribe = store.subscribe('caches', (state, key) => {
      if (!isMounted()) { teardown(); return; }
      if (key === 'caches') renderRecentlyViewed(state);
    });

    // Paint empty-state synchronously from current store; load popular.
    renderRecentlyViewed(store.state);
    loadPopular();

    if (initialQ) {
      // Pre-filled: fire immediately, no debounce — the user already
      // committed by typing it into the URL.
      showSearchPane();
      runSearch(initialQ);
    } else {
      showEmptyPane();
    }
  },

  update(state, changedKey) {
    // Router won't normally call this (no `subscribe` on the route),
    // but the store subscription above invokes the same code path.
    // Keep this exported for future router-managed wiring + tests.
    if (changedKey !== 'caches') return;
    if (!isMounted()) return;
    renderRecentlyViewed(state);
  },
};
