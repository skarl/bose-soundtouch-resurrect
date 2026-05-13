// tunein-pager — per-section deep cursor walker for TuneIn Browse.
//
// Sections of a Browse response that are paginable carry a `next*`
// outline (e.g. `nextStations`, `nextShows`, `nextEpisodes`). The URL
// on that outline points at the next page; following it returns a
// flat outline list plus, if there's more, another `next*` cursor.
// This module walks that chain on demand.
//
// Public surface:
//
//   createPager(initialUrl, opts) → {
//     rows:       array of accumulated outline rows (chronological,
//                 deduped),
//     loadMore(): async () → Promise<{ added, exhausted }>,
//     get exhausted(): boolean — true once the chain reports a
//                 terminator OR the page cap has been reached,
//     get status(): { section, scanned, sectionCap, exhausted } —
//                 the most recent status event,
//     dispose():  cancel-flag for the integration layer; idempotent.
//   }
//
// opts:
//   fetch       — async (url) → JSON. The cgi-bin/api/v1/tunein proxy
//                 forwards verbatim to opml.radiotime.com; callers in
//                 admin SPA pass admin/app/api.js' tuneinBrowse-style
//                 fetcher. Tests pass a hand-rolled mock.
//   pageCap     — hard ceiling on cursor follows (default 50). When the
//                 cap is hit the pager is exhausted regardless of
//                 whether the API still emits cursors.
//   dedupKey    — property to dedup by (default "guide_id"). Adjacent
//                 pages routinely share entries due to mid-crawl
//                 re-ranking (4-32% page-0 churn observed within
//                 20 minutes), so dedup is mandatory.
//   initialIds  — optional iterable of dedup-key values already rendered
//                 outside the pager (i.e. the section's page-0 children).
//                 Seeded into the dedup Set so a re-rank that promotes
//                 a page-0 row onto page 1 doesn't double it.
//   section     — optional label for status events (e.g. "stations").
//   onStatus    — optional (status) → void — fired after each loadMore
//                 with the post-fetch snapshot. The most recent value
//                 is also readable via `status`.
//
// Terminator detection — three independent shapes, any of which halts
// the walk:
//
//   1. body:[] — the response carries no outline rows at all.
//   2. Tombstone — a single text-only entry with the canonical
//      "No stations or shows available" message. Detected via
//      classifyOutline.
//   3. Short page — the response carries no further `next*` cursor.
//      The API never emits a partial page that still has more rows
//      behind it without a cursor, so a missing cursor is a strict
//      terminator. (A page that returns the same cursor URL it was
//      fetched from is treated as a terminator too — a runaway loop
//      guard.)
//
// `render=json` re-append — the API does not preserve `render=json`
// across cursor emissions, so we canonicalise every cursor URL with
// `tunein-url.canonicaliseBrowseUrl` before fetching. That function
// strips magic params and re-appends `render=json` (§ 6.1, § 7.4).

import {
  classifyOutline,
  extractCursor,
} from './tunein-outline.js';
import { canonicaliseBrowseUrl } from './tunein-url.js';

const DEFAULT_PAGE_CAP = 50;
const DEFAULT_DEDUP_KEY = 'guide_id';

// Pull the playable / drill / show outlines out of a Browse response.
// Cursors and pivots are meta — they drive the walk but never count
// as rows the user sees. Tombstones aren't rows either.
function visibleRows(json, dedupKey) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  const out = [];
  for (const e of items) {
    const t = classifyOutline(e);
    if (t === 'cursor' || t === 'pivot' || t === 'tombstone') continue;
    // The dedup key is usually `guide_id` but is left configurable in
    // case a future caller wants `URL` or similar.
    if (e && typeof e === 'object') out.push(e);
    void dedupKey;  // referenced below in walk(); silence eslint.
  }
  return out;
}

// Is this response the empty-body terminator?
function isEmptyBody(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  return items.length === 0;
}

// Is this response the tombstone terminator?
function isTombstone(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  if (items.length !== 1) return false;
  return classifyOutline(items[0]) === 'tombstone';
}

// Locate the cursor child at the top level of a flat-paginated
// response. Cursors live as siblings of the playable rows on the
// follow pages, not inside a `.children` array. Walk the top-level
// outline list and return the first `next*` entry.
function topLevelCursor(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  for (const e of items) {
    if (classifyOutline(e) === 'cursor') {
      return {
        url: typeof e.URL === 'string' ? e.URL : '',
        key: typeof e.key === 'string' ? e.key : '',
      };
    }
  }
  // Some sections nest the cursor inside a single-section wrapper on
  // the follow page; recover by recursing into a single section that
  // has children. extractCursor handles that shape via .children.
  if (items.length === 1 && Array.isArray(items[0].children)) {
    return extractCursor(items[0]);
  }
  return null;
}

export function createPager(initialUrl, opts) {
  const o = opts || {};
  const fetch = typeof o.fetch === 'function' ? o.fetch : null;
  if (!fetch) {
    throw new Error('createPager: opts.fetch is required');
  }
  const pageCap   = Number.isFinite(o.pageCap) && o.pageCap > 0
    ? Math.floor(o.pageCap)
    : DEFAULT_PAGE_CAP;
  const dedupKey  = typeof o.dedupKey === 'string' && o.dedupKey
    ? o.dedupKey
    : DEFAULT_DEDUP_KEY;
  const section   = typeof o.section === 'string' ? o.section : '';
  const onStatus  = typeof o.onStatus === 'function' ? o.onStatus : null;

  const seen = new Set();
  if (o.initialIds && typeof o.initialIds[Symbol.iterator] === 'function') {
    for (const id of o.initialIds) {
      if (typeof id === 'string' && id !== '') seen.add(id);
    }
  }

  const state = {
    rows: [],
    pagesFetched: 0,
    cursorUrl: typeof initialUrl === 'string' && initialUrl !== ''
      ? initialUrl
      : '',
    exhausted: false,
    disposed: false,
    status: { section, scanned: 0, sectionCap: pageCap, exhausted: false },
    inflight: null,
  };

  // If we were never handed a cursor URL there's nothing to walk —
  // mark exhausted up front so the integration code can decide not to
  // mount the Load-more button.
  if (state.cursorUrl === '') {
    state.exhausted = true;
    state.status = {
      section,
      scanned: state.pagesFetched,
      sectionCap: pageCap,
      exhausted: true,
    };
  }

  function emitStatus() {
    state.status = {
      section,
      scanned: state.pagesFetched,
      sectionCap: pageCap,
      exhausted: state.exhausted,
    };
    if (onStatus) {
      try { onStatus(state.status); }
      catch (_err) { /* listener errors are non-fatal */ }
    }
  }

  async function loadMore() {
    if (state.disposed)  return { added: 0, exhausted: true };
    if (state.exhausted) return { added: 0, exhausted: true };
    if (state.inflight)  return state.inflight;

    // Cap check — exhausted by policy even if the API still has a
    // cursor for us. This is the safety belt against runaway crawls.
    if (state.pagesFetched >= pageCap) {
      state.exhausted = true;
      emitStatus();
      return { added: 0, exhausted: true };
    }

    const urlBefore = state.cursorUrl;
    let fetchUrl;
    try {
      fetchUrl = canonicaliseBrowseUrl(urlBefore);
    } catch (err) {
      // Canonicalisation rejected the URL (colon-form filter, etc).
      // Treat as terminator — we have no safe URL to walk into.
      state.exhausted = true;
      emitStatus();
      throw err;
    }

    const p = (async () => {
      const json = await fetch(fetchUrl);
      state.pagesFetched += 1;

      // Three terminator shapes. Empty body and tombstone are hard
      // stops with no rows. Missing-cursor is the "short page"
      // terminator — we still keep whatever rows came back on this
      // page, just don't try to walk further.
      if (isEmptyBody(json) || isTombstone(json)) {
        state.exhausted = true;
        state.cursorUrl = '';
        emitStatus();
        return { added: 0, exhausted: true };
      }

      const rows = visibleRows(json, dedupKey);
      let added = 0;
      for (const r of rows) {
        const id = r && typeof r[dedupKey] === 'string' ? r[dedupKey] : '';
        // Rows without a dedup key are kept (they can't collide) but
        // count toward the added total.
        if (id === '') {
          state.rows.push(r);
          added += 1;
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        state.rows.push(r);
        added += 1;
      }

      const next = topLevelCursor(json);
      if (!next || !next.url) {
        // Short-page terminator.
        state.exhausted = true;
        state.cursorUrl = '';
      } else if (next.url === urlBefore) {
        // Loop guard — the API echoed back our own cursor URL.
        state.exhausted = true;
        state.cursorUrl = '';
      } else {
        state.cursorUrl = next.url;
      }

      // Hit the cap on this fetch? Mark exhausted so the next call is
      // a no-op even if a cursor came back.
      if (state.pagesFetched >= pageCap) {
        state.exhausted = true;
      }

      emitStatus();
      return { added, exhausted: state.exhausted };
    })();

    state.inflight = p;
    try {
      return await p;
    } finally {
      state.inflight = null;
    }
  }

  return {
    get rows()      { return state.rows; },
    get exhausted() { return state.exhausted; },
    get status()    { return state.status; },
    get pagesFetched() { return state.pagesFetched; },
    loadMore,
    dispose() { state.disposed = true; state.exhausted = true; },
  };
}
