// search — TuneIn search + empty-state landing.
//
// Sticky input at top, debounced 300ms. Results render via
// resultCard() — the shared visual station card. Empty state shows two
// columns: "Recently viewed" (from state.caches.recentlyViewed, last
// 10 entries) and "Popular" (Browse.ashx?c=local via the tunein CGI).
// CSS grid in style.css collapses the two columns into a single stack
// on narrow viewports.
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
import { resultCard } from '../components.js';

export const DEBOUNCE_MS = 300;
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

export default defineView({
  mount(root, store, ctx, env) {
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

    const resultsEl = document.createElement('div');
    resultsEl.className = 'search-results';
    resultsEl.setAttribute('aria-live', 'polite');
    resultsEl.hidden = true;

    const recentSection = document.createElement('section');
    recentSection.className = 'search-empty-section';
    const recentH = document.createElement('h2');
    recentH.textContent = 'Recently viewed';
    const recentListEl = document.createElement('div');
    recentListEl.className = 'search-empty-list';
    recentSection.appendChild(recentH);
    recentSection.appendChild(recentListEl);

    const popularSection = document.createElement('section');
    popularSection.className = 'search-empty-section';
    const popularH = document.createElement('h2');
    popularH.textContent = 'Popular';
    const popularEl = document.createElement('div');
    popularEl.className = 'search-empty-list';
    popularSection.appendChild(popularH);
    popularSection.appendChild(popularEl);

    const emptyEl = document.createElement('div');
    emptyEl.className = 'search-empty';
    emptyEl.appendChild(recentSection);
    emptyEl.appendChild(popularSection);

    mount(root, html`
      <section data-view="search">
        <div class="search-bar">
          ${input}
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

    function renderResults(json) {
      const stations = searchResultStations(json);
      resultsEl.replaceChildren();
      if (stations.length === 0) {
        setResultsMessage('No matches.', 'search-no-results');
        return;
      }
      for (const e of stations) {
        resultsEl.appendChild(resultCard({
          sid:      e.guide_id,
          name:     e.text,
          art:      e.image,
          location: e.subtext,
          genre:    e.genre_name || e.genre || '',
          bitrate:  e.bitrate,
          codec:    e.formats,
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
        inFlightToken++;
        showEmptyPane();
        return;
      }
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
        const p = document.createElement('p');
        p.className = 'search-empty-note';
        p.textContent = 'Browse to see recently viewed stations.';
        recentListEl.appendChild(p);
        return;
      }
      for (const entry of recents.slice(0, 10)) {
        if (!entry || typeof entry.sid !== 'string') continue;
        recentListEl.appendChild(resultCard({
          sid:  entry.sid,
          name: entry.name || entry.sid,
          art:  entry.art,
        }));
      }
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
      for (const e of stations) {
        popularEl.appendChild(resultCard({
          sid:      e.guide_id,
          name:     e.text,
          art:      e.image,
          location: e.subtext,
          genre:    e.genre_name || e.genre || '',
          bitrate:  e.bitrate,
          codec:    e.formats,
        }));
      }
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
