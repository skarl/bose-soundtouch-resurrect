// search — TuneIn search + empty-state landing.
//
// Pill-shaped sticky input at top, debounced 300ms. Results render via
// stationRow() — the shared station list row. Empty state shows two
// stacked sections: "Recently viewed" (from state.caches.recentlyViewed,
// last 10 entries) and "Popular near you" (Browse.ashx?c=local).
//
// Render strategy (see admin/PLAN.md § Render strategy):
//   mount() builds the static frame once and returns a `caches` updater
//   that repaints the recently-viewed strip on cache changes.
//
// URL hash persistence: typing rewrites #/search?q=... via
// history.replaceState so back/forward isn't spammed. Entry with
// ?q=... pre-fills and fires.
//
// See admin/PLAN.md § View specs / search.

import { html, mount, defineView } from '../dom.js';
import { tuneinSearch, tuneinBrowse } from '../api.js';
import { stationRow } from '../components.js';
import { icon } from '../icons.js';

export const DEBOUNCE_MS = 300;
export const SEARCH_PLACEHOLDER = 'Search TuneIn — try "jazz", "bbc", "ffh"';
const STATION_GUIDE_ID = /^s\d+$/;

// Pull station leaves out of a TuneIn Search.ashx body — flat filter.
export function searchResultStations(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  return items.filter(
    (e) => e && e.type === 'audio' && typeof e.guide_id === 'string'
      && STATION_GUIDE_ID.test(e.guide_id)
  );
}

// Pull station leaves out of a Browse.ashx?c=local body — recurses one
// level so nested sections surface their leaves directly.
export function popularStations(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  const out = [];
  const visit = (entry) => {
    if (!entry) return;
    if (Array.isArray(entry.children)) {
      for (const c of entry.children) visit(c);
      return;
    }
    if (entry.type === 'audio'
        && typeof entry.guide_id === 'string'
        && STATION_GUIDE_ID.test(entry.guide_id)) {
      out.push(entry);
    }
  };
  for (const e of items) visit(e);
  return out;
}

// Build a card containing N station rows; mark the last with .is-last so
// CSS can drop its border.
function stationRowCard(entries, mapper) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const row = stationRow(mapper(entries[i]));
    if (i === entries.length - 1) row.classList.add('is-last');
    card.appendChild(row);
  }
  return card;
}

export default defineView({
  mount(root, store, ctx, env) {
    const initialQ = (ctx && ctx.query && typeof ctx.query.q === 'string')
      ? ctx.query.q
      : '';

    // --- input wrapper: leading glyph + input + clear-X + pending dot --
    const wrap = document.createElement('div');
    wrap.className = 'search-input-wrap';

    const leading = document.createElement('span');
    leading.className = 'search-input-icon';
    leading.appendChild(icon('search', 14));

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'search-input';
    input.placeholder = SEARCH_PLACEHOLDER;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Search stations');
    input.value = initialQ;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'search-clear';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.appendChild(icon('x', 12));
    clearBtn.hidden = !initialQ;

    const pending = document.createElement('span');
    pending.className = 'search-pending';
    pending.setAttribute('aria-hidden', 'true');
    pending.hidden = true;

    wrap.appendChild(leading);
    wrap.appendChild(input);
    wrap.appendChild(clearBtn);
    wrap.appendChild(pending);

    // --- results container ---------------------------------------------
    const resultsEl = document.createElement('div');
    resultsEl.className = 'search-results';
    resultsEl.setAttribute('aria-live', 'polite');
    resultsEl.hidden = true;

    // --- empty state: Recently viewed + Popular sections ---------------
    const emptyEl = document.createElement('div');
    emptyEl.className = 'search-empty';

    const recentSection = document.createElement('section');
    recentSection.className = 'search-empty-section';
    const recentH = document.createElement('h2');
    recentH.className = 'section-h section-h--inline';
    const recentTitle = document.createElement('span');
    recentTitle.className = 'section-h__title';
    recentTitle.appendChild(icon('clock', 11));
    const recentLabel = document.createElement('span');
    recentLabel.textContent = 'Recently viewed';
    recentTitle.appendChild(recentLabel);
    recentH.appendChild(recentTitle);
    const recentListEl = document.createElement('div');
    recentListEl.className = 'search-empty-list';
    recentSection.appendChild(recentH);
    recentSection.appendChild(recentListEl);

    const popularSection = document.createElement('section');
    popularSection.className = 'search-empty-section';
    const popularH = document.createElement('h2');
    popularH.className = 'section-h section-h--inline';
    const popularTitle = document.createElement('span');
    popularTitle.className = 'section-h__title';
    popularTitle.appendChild(icon('zap', 11));
    const popularLabel = document.createElement('span');
    popularLabel.textContent = 'Popular near you';
    popularTitle.appendChild(popularLabel);
    popularH.appendChild(popularTitle);
    const popularEl = document.createElement('div');
    popularEl.className = 'search-empty-list';
    popularSection.appendChild(popularH);
    popularSection.appendChild(popularEl);

    emptyEl.appendChild(recentSection);
    emptyEl.appendChild(popularSection);

    mount(root, html`
      <section data-view="search">
        <div class="search-bar">
          ${wrap}
        </div>
        ${emptyEl}
        ${resultsEl}
      </section>
    `);

    let debounceTimer = null;
    let inFlightToken = 0;

    function clearDebounce() {
      if (debounceTimer != null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }
    env.onCleanup(clearDebounce);

    function isMounted() {
      return !!resultsEl.isConnected;
    }

    function writeHash(q) {
      const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
      if (location.hash === target) return;
      // replaceState avoids growing the back-stack on every keystroke.
      const next = `${location.pathname}${location.search}${target}`;
      history.replaceState(history.state, '', next);
    }

    function showSearchPane() {
      emptyEl.hidden = true;
      resultsEl.hidden = false;
    }

    function showEmptyPane() {
      resultsEl.hidden = true;
      emptyEl.hidden = false;
    }

    function setResultsMessage(text, cls) {
      resultsEl.replaceChildren();
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      resultsEl.appendChild(p);
    }

    function renderResults(json, q) {
      const stations = searchResultStations(json);
      resultsEl.replaceChildren();
      // Header line: "N results" + endpoint hint right-aligned.
      const header = document.createElement('div');
      header.className = 'section-h section-h--inline';
      const left = document.createElement('span');
      left.className = 'section-h__title';
      left.textContent = `${stations.length.toLocaleString()} ${stations.length === 1 ? 'result' : 'results'}`;
      const right = document.createElement('span');
      right.className = 'section-h__meta';
      right.textContent = `/api/v1/tunein/search?q=${q}`;
      header.appendChild(left);
      header.appendChild(right);
      resultsEl.appendChild(header);

      if (stations.length === 0) {
        setResultsMessageInline('No matches.', 'search-no-results');
        return;
      }
      resultsEl.appendChild(stationRowCard(stations, (e) => ({
        sid:      e.guide_id,
        name:     e.text,
        art:      e.image,
        location: e.subtext,
        bitrate:  e.bitrate,
        codec:    e.formats,
      })));
    }

    function setResultsMessageInline(text, cls) {
      const p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      resultsEl.appendChild(p);
    }

    function runSearch(q) {
      if (!isMounted()) return;
      const token = ++inFlightToken;
      showSearchPane();
      pending.hidden = false;
      setResultsMessage('Searching...', 'search-loading');
      tuneinSearch(q)
        .then((json) => {
          if (token !== inFlightToken || !isMounted()) return;
          pending.hidden = true;
          renderResults(json, q);
        })
        .catch((err) => {
          if (token !== inFlightToken || !isMounted()) return;
          pending.hidden = true;
          setResultsMessage(`Search failed: ${err.message}`, 'search-error');
        });
    }

    function handleInput(value) {
      const q = value.trim();
      writeHash(q);
      clearDebounce();
      clearBtn.hidden = q.length === 0;
      if (!q) {
        inFlightToken++;
        pending.hidden = true;
        showEmptyPane();
        return;
      }
      pending.hidden = false;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        runSearch(q);
      }, DEBOUNCE_MS);
    }

    function renderRecentlyViewed(state) {
      const recents = Array.isArray(state.caches.recentlyViewed)
        ? state.caches.recentlyViewed
        : [];
      recentListEl.replaceChildren();
      if (recents.length === 0) {
        recentSection.hidden = true;
        return;
      }
      recentSection.hidden = false;
      const slice = recents.slice(0, 10).filter((e) => e && typeof e.sid === 'string');
      recentListEl.appendChild(stationRowCard(slice, (entry) => ({
        sid:  entry.sid,
        name: entry.name || entry.sid,
        art:  entry.art,
      })));
    }

    function renderPopular(json) {
      popularEl.replaceChildren();
      const stations = popularStations(json);
      if (stations.length === 0) {
        const p = document.createElement('p');
        p.className = 'search-empty-note';
        p.textContent = 'No popular stations available.';
        popularEl.appendChild(p);
        return;
      }
      popularEl.appendChild(stationRowCard(stations, (e) => ({
        sid:      e.guide_id,
        name:     e.text,
        art:      e.image,
        location: e.subtext,
        bitrate:  e.bitrate,
        codec:    e.formats,
      })));
    }

    function loadPopular() {
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
          if (!isMounted()) return;
          popularEl.replaceChildren();
          const p2 = document.createElement('p');
          p2.className = 'search-error';
          p2.textContent = `Couldn't load popular stations: ${err.message}`;
          popularEl.appendChild(p2);
        });
    }

    input.addEventListener('input', (ev) => handleInput(ev.target.value));
    clearBtn.addEventListener('click', () => {
      input.value = '';
      handleInput('');
      input.focus();
    });

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

    return {
      caches(state) {
        if (!isMounted()) return;
        renderRecentlyViewed(state);
      },
    };
  },
});
