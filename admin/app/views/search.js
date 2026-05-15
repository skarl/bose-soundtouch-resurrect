// search — TuneIn search + empty-state landing.
//
// Pill-shaped sticky input at top, debounced 300ms. Search.ashx returns
// a flat list of stations (`s`), shows (`p`), topics (`t`), and artists
// (`m`) interleaved — no section grouping, no pagination. Every row
// flows through `tunein-outline.normaliseRow` so reliability badges,
// genre chips, and two-line subtitles render the same way as in browse.
//
// Empty state shows two stacked sections: "Recently viewed" (from
// state.ui.visitedStations, last 10 entries) and "Popular near you"
// (Browse.ashx?c=local).
//
// "Include podcasts" toggle near the search input — default ON; when
// OFF, the API request adds `filter=s:popular` so the response only
// carries stations (the pre-0.4.2 behaviour). Toggle state persists in
// sessionStorage so the preference survives page reloads.
//
// `unavailable` entries (georestricted hits) are not surfaced as
// playable rows; they sink into a small "Not playable in your region"
// section at the bottom of results.
//
// Render strategy (see admin/PLAN.md § Render strategy):
//   mount() builds the static frame once and returns a `caches` updater
//   that repaints the recently-viewed strip on cache changes.
//
// URL hash persistence: typing rewrites #/search?q=... via
// history.replaceState so back/forward isn't spammed. Entry with
// ?q=... pre-fills and fires.
//
// See admin/PLAN.md § View specs / search and docs/tunein-api.md.

import { html, mount, defineView } from '../dom.js';
import { tuneinSearch, tuneinBrowse } from '../api.js';
import { stationRow, pillInput } from '../components.js';
import { icon } from '../icons.js';
import { classifyOutline, normaliseRow } from '../tunein-outline.js';
import { canonicaliseBrowseUrl, extractDrillKey } from '../tunein-url.js';
import { cache, TTL_LABEL } from '../tunein-cache.js';
import { store as appStore } from '../state.js';
import {
  DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
  searchResultStations,
  popularStations,
} from '../search-derive.js';

// Re-export the extracted derivations so existing callers and the test
// suite keep their import paths.
export { DEBOUNCE_MS, SEARCH_PLACEHOLDER, searchResultStations, popularStations };

// sessionStorage key for the "Include podcasts" toggle. Default ON when
// missing.
export const PODCAST_TOGGLE_KEY = 'search.includePodcasts';

// Partition a Search.ashx body into renderable rows (playable + drill)
// and georestricted rows (the `unavailable` key set, regardless of
// prefix). The TuneIn service surfaces georestricted hits with an
// `unavailable` string; the renderer drops them out of the main row
// list so they can never be tapped to play.
//
// Returns { rows, unavailable }.
export function partitionSearchBody(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  const rows = [];
  const unavailable = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.unavailable === 'string' && entry.unavailable !== '') {
      unavailable.push(entry);
      continue;
    }
    const kind = classifyOutline(entry);
    // Cursor / pivot / tombstone don't render as content rows. Search
    // results don't carry these in practice, but keep the filter so a
    // future API change doesn't surface meta rows as playable.
    if (kind === 'cursor' || kind === 'pivot' || kind === 'tombstone') continue;
    rows.push(entry);
  }
  return { rows, unavailable };
}

// Read the "Include podcasts" toggle from sessionStorage. Returns true
// (the default) when no preference is set. Defensive against missing
// or odd sessionStorage values.
export function readIncludePodcasts() {
  try {
    if (typeof sessionStorage === 'undefined') return true;
    const v = sessionStorage.getItem(PODCAST_TOGGLE_KEY);
    if (v == null) return true;
    return v !== 'false';
  } catch (_err) {
    return true;
  }
}

// Persist the toggle to sessionStorage. Silently ignores quota or
// missing-storage errors — the in-memory state still drives the
// current session.
export function writeIncludePodcasts(value) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(PODCAST_TOGGLE_KEY, value ? 'true' : 'false');
  } catch (_err) {
    /* ignored */
  }
}

// Compose the drill hash for a row whose `URL` is an OPML Browse URL.
// Mirrors browse.js's drillHashFor pipeline: canonicalise the URL,
// extract drill keys, encode them as a #/browse?... hash. Returns null
// when the URL can't be parsed into drill keys — caller falls back to
// the bare guide_id form.
//
// Multi-filter (#106): `extractDrillKey` returns `filters: string[]`
// when the URL's filter is comma-separated. Emit the joined wire form
// `filter=l109,g22` on the hash. Falls back to the legacy single-
// string `parts.filter` when callers still hold the old shape.
function drillHashForUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return null;
  try {
    const canonical = canonicaliseBrowseUrl(rawUrl);
    const parts = extractDrillKey(canonical);
    if (!parts.id && !parts.c) return null;
    const qs = new URLSearchParams();
    if (parts.id) qs.set('id', parts.id);
    if (parts.c)  qs.set('c', parts.c);
    const filterStr = Array.isArray(parts.filters)
      ? parts.filters.filter((s) => typeof s === 'string' && s !== '').join(',')
      : (typeof parts.filter === 'string' ? parts.filter : '');
    if (filterStr) qs.set('filter', filterStr);
    if (parts.pivot)  qs.set('pivot', parts.pivot);
    if (parts.offset) qs.set('offset', parts.offset);
    return `#/browse?${qs.toString()}`;
  } catch (_err) {
    return null;
  }
}

// Build a single search result row. Dispatches by the entry's
// classification so each row gets the right shape:
//
//   station / topic (s, t prefix) → stationRow, which auto-attaches a
//     Play icon for playable sids. Row body drills to #/station/<sid>.
//   show (p prefix)               → stationRow with overridden href so
//     the body drills via #/browse?id=p<NN>; Play icon stays (p is
//     playable). The Play CGI resolves p<NN> through Tune.ashx the
//     same as s<NN>.
//   drill (m artist + any other) → a station-row-shaped element with
//     no Play, routed via the canonicalised URL.
//
// Other classifications (cursor / pivot / tombstone) are filtered
// upstream by partitionSearchBody — they never reach this helper in
// practice.
export function searchRow(entry) {
  const norm = normaliseRow(entry);
  const kind = classifyOutline(entry);
  const sid = norm.id || (entry && entry.guide_id) || '';

  // Issue #105: prime the label cache from the search row's text so
  // tapping into the row's show / station / topic / artist drill paints
  // the breadcrumb current-segment instantly on first visit. Keyed by
  // the row's sid (the same crumb token a subsequent #/browse drill or
  // station-detail view would read). Skips when sid or label is empty.
  if (sid && typeof norm.primary === 'string' && norm.primary.trim() !== '') {
    cache.set(`tunein.label.${sid}`, norm.primary.trim(), TTL_LABEL);
  }

  // station / topic / show share the stationRow shape — art + meta +
  // optional badges/chips. station and topic drill to #/station/<sid>
  // (stationRow's default); show overrides the href so the body
  // navigates into the show's browse-drill.
  if (kind === 'station' || kind === 'topic' || kind === 'show') {
    const row = stationRow({
      sid,
      name:     norm.primary,
      art:      norm.image,
      location: norm.secondary,
      bitrate:  entry && entry.bitrate,
      codec:    entry && entry.formats,
      tertiary: norm.tertiary,
      badges:   norm.badges,
      chips:    norm.chips,
      // Heart on s / p sids; topics keep the chevron (favoriteHeart's
      // visibility gate rejects t-prefix). Capture rule per #126:
      // {id, name, art, note: ''} from search-row data.
      favorite: {
        store: appStore,
        getEntry: () => ({
          id:   sid,
          name: norm.primary || '',
          art:  norm.image || '',
          note: '',
        }),
      },
    });
    if (kind === 'show') {
      const drillHash = drillHashForUrl(entry && entry.URL)
        || (sid ? `#/browse?id=${encodeURIComponent(sid)}` : '#');
      row.setAttribute('href', drillHash);
    }
    row.setAttribute('data-prefix', sid ? sid.charAt(0) : '');
    // #88: stash the outline on the row so the inline Play handler can
    // mine the topic's `sid=p<N>` parent for the now-playing skip
    // classifier. Other call sites (browse-topics) tag the row the
    // same way — see admin/app/views/browse.js renderTopicsCard.
    row._outline = entry;
    return row;
  }

  // Everything else — `drill` (m artist or any leftover link row).
  // Use stationRow's visual layout for parity with the other rows but
  // route the body through the canonicalised Browse URL and omit the
  // Play icon. The simplest path: hand-craft a row that matches
  // station-row's CSS class so the layout doesn't fork.
  return drillSearchRow(entry, norm);
}

// drillSearchRow — visual parity with stationRow, but the href routes
// to a Browse drill (artist landing page in the m case) and there's
// no Play icon. We bypass components.stationRow because that helper
// auto-decides Play presence by sid prefix, and we want to be
// explicit about "this row has no Play".
function drillSearchRow(entry, norm) {
  const sid = norm.id || (entry && entry.guide_id) || '';
  const drillHash = drillHashForUrl(entry && entry.URL)
    || (sid ? `#/browse?id=${encodeURIComponent(sid)}` : '#');

  const row = document.createElement('a');
  row.className = 'station-row';
  row.setAttribute('href', drillHash);
  if (sid) row.dataset.sid = sid;
  row.setAttribute('data-prefix', sid ? sid.charAt(0) : '');

  const art = document.createElement('span');
  art.className = 'station-art';
  art.setAttribute('style', 'width:40px;height:40px');
  if (norm.image) {
    const img = document.createElement('img');
    img.className = 'station-art__img';
    img.setAttribute('loading', 'lazy');
    img.setAttribute('src', norm.image);
    img.setAttribute('alt', norm.primary || sid || '');
    art.appendChild(img);
  }
  row.appendChild(art);

  const body = document.createElement('span');
  body.className = 'station-row__body';
  const nameEl = document.createElement('span');
  nameEl.className = 'station-row__name';
  nameEl.textContent = norm.primary || sid || '';
  body.appendChild(nameEl);
  if (norm.secondary) {
    const meta = document.createElement('span');
    meta.className = 'station-row__meta';
    const loc = document.createElement('span');
    loc.className = 'station-row__loc';
    loc.textContent = norm.secondary;
    meta.appendChild(loc);
    body.appendChild(meta);
  }
  row.appendChild(body);

  const chev = document.createElement('span');
  chev.className = 'station-row__chev';
  chev.appendChild(icon('arrow', 14));
  row.appendChild(chev);
  return row;
}

// Build a card containing N search-result rows; mark the last with
// `.is-last` so CSS can drop its border.
function searchRowCard(entries) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const row = searchRow(entries[i]);
    if (i === entries.length - 1) row.classList.add('is-last');
    card.appendChild(row);
  }
  return card;
}

// Build a card of station rows for the empty-state lists (recently
// viewed + popular). These are station-only callers — they don't need
// the drill-or-play dispatch, so they keep using stationRow directly.
function stationOnlyRowCard(entries, mapper) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const row = stationRow(mapper(entries[i]));
    if (i === entries.length - 1) row.classList.add('is-last');
    card.appendChild(row);
  }
  return card;
}

// Build a small "Not playable in your region" section for georestricted
// hits. Renders disabled rows — visual parity with browse's
// tombstone label but inside a labelled card so the user understands
// why the entries didn't surface as playable.
function unavailableSection(entries) {
  const section = document.createElement('section');
  section.className = 'search-unavailable';

  const h = document.createElement('h2');
  h.className = 'section-h section-h--inline';
  const title = document.createElement('span');
  title.className = 'section-h__title';
  title.textContent = 'Not playable in your region';
  h.appendChild(title);
  section.appendChild(h);

  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const row = document.createElement('span');
    row.className = 'station-row is-disabled';
    if (i === entries.length - 1) row.classList.add('is-last');
    if (entries[i] && typeof entries[i].guide_id === 'string') {
      row.dataset.sid = entries[i].guide_id;
    }

    const art = document.createElement('span');
    art.className = 'station-art';
    art.setAttribute('style', 'width:40px;height:40px');
    if (entries[i] && typeof entries[i].image === 'string' && entries[i].image) {
      const img = document.createElement('img');
      img.className = 'station-art__img';
      img.setAttribute('loading', 'lazy');
      img.setAttribute('src', entries[i].image);
      img.setAttribute('alt', entries[i].text || '');
      art.appendChild(img);
    }
    row.appendChild(art);

    const body = document.createElement('span');
    body.className = 'station-row__body';
    const nameEl = document.createElement('span');
    nameEl.className = 'station-row__name';
    nameEl.textContent = (entries[i] && entries[i].text) || (entries[i] && entries[i].guide_id) || '';
    body.appendChild(nameEl);
    const meta = document.createElement('span');
    meta.className = 'station-row__meta';
    const loc = document.createElement('span');
    loc.className = 'station-row__loc';
    loc.textContent = (entries[i] && entries[i].unavailable) || 'Not available';
    meta.appendChild(loc);
    body.appendChild(meta);
    row.appendChild(body);
    card.appendChild(row);
  }
  section.appendChild(card);
  return section;
}

export default defineView({
  mount(root, store, ctx, env) {
    const initialQ = (ctx && ctx.query && typeof ctx.query.q === 'string')
      ? ctx.query.q
      : '';

    // --- input wrapper: leading glyph + input + clear-X + pending dot --
    const { wrap, input } = pillInput({
      placeholder:  SEARCH_PLACEHOLDER,
      ariaLabel:    'Search stations',
      initialValue: initialQ,
      onInput:      (value) => handleInput(value),
    });

    const pending = document.createElement('span');
    pending.className = 'search-pending';
    pending.setAttribute('aria-hidden', 'true');
    pending.hidden = true;
    wrap.appendChild(pending);

    // --- "Include podcasts" toggle (default ON; sessionStorage) -------
    let includePodcasts = readIncludePodcasts();
    const toggleWrap = document.createElement('label');
    toggleWrap.className = 'search-include-podcasts';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.className = 'search-include-podcasts__input';
    toggleInput.checked = includePodcasts;
    toggleInput.setAttribute('aria-label', 'Include podcasts in search results');
    const toggleLabel = document.createElement('span');
    toggleLabel.className = 'search-include-podcasts__label';
    toggleLabel.textContent = 'Include podcasts';
    toggleWrap.appendChild(toggleInput);
    toggleWrap.appendChild(toggleLabel);

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
          ${toggleWrap}
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
      const { rows, unavailable } = partitionSearchBody(json);
      resultsEl.replaceChildren();

      // Header line: "N results" + endpoint hint right-aligned.
      const header = document.createElement('div');
      header.className = 'section-h section-h--inline';
      const left = document.createElement('span');
      left.className = 'section-h__title';
      left.textContent = `${rows.length.toLocaleString()} ${rows.length === 1 ? 'result' : 'results'}`;
      const right = document.createElement('span');
      right.className = 'section-h__meta';
      right.textContent = `/api/v1/tunein/search?q=${q}`;
      header.appendChild(left);
      header.appendChild(right);
      resultsEl.appendChild(header);

      if (rows.length === 0 && unavailable.length === 0) {
        setResultsMessageInline('No matches.', 'search-no-results');
        return;
      }
      if (rows.length > 0) {
        resultsEl.appendChild(searchRowCard(rows));
      }
      if (unavailable.length > 0) {
        resultsEl.appendChild(unavailableSection(unavailable));
      }
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
      // includePodcasts ON  → no upstream filter (everything)
      // includePodcasts OFF → filter=s:popular (stations only)
      const searchOpts = includePodcasts ? undefined : { stationsOnly: true };
      tuneinSearch(q, searchOpts)
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
      const recents = Array.isArray(state.ui?.visitedStations)
        ? state.ui.visitedStations
        : [];
      recentListEl.replaceChildren();
      if (recents.length === 0) {
        recentSection.hidden = true;
        return;
      }
      recentSection.hidden = false;
      const slice = recents.slice(0, 10).filter((e) => e && typeof e.sid === 'string');
      recentListEl.appendChild(stationOnlyRowCard(slice, (entry) => ({
        sid:  entry.sid,
        name: entry.name || entry.sid,
        art:  entry.art,
        // Recently-viewed rows capture {id, name, art, note: ''} from
        // the row's own data — same shape as the search-result rows.
        favorite: {
          store: appStore,
          getEntry: () => ({
            id:   entry.sid,
            name: entry.name || entry.sid,
            art:  entry.art || '',
            note: '',
          }),
        },
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
      popularEl.appendChild(stationOnlyRowCard(stations, (e) => ({
        sid:      e.guide_id,
        name:     e.text,
        art:      e.image,
        location: e.subtext,
        bitrate:  e.bitrate,
        codec:    e.formats,
        // Popular rows capture from the Browse.ashx?c=local row data.
        favorite: {
          store: appStore,
          getEntry: () => ({
            id:   e.guide_id || '',
            name: e.text || '',
            art:  e.image || '',
            note: '',
          }),
        },
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

    // Toggle change re-runs the active search with the new filter.
    toggleInput.addEventListener('change', () => {
      includePodcasts = !!toggleInput.checked;
      writeIncludePodcasts(includePodcasts);
      const q = (typeof input.value === 'string' ? input.value : '').trim();
      if (q) runSearch(q);
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
      ui(state) {
        if (!isMounted()) return;
        renderRecentlyViewed(state);
      },
    };
  },
});
