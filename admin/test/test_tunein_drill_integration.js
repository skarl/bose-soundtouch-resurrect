// Integration test for the TuneIn drill.
//
// The drill is implemented across seven files (tunein-url, tunein-pager,
// tunein-outline, tunein-cache, tunein-sid, views/browse/outline-render,
// views/browse/pager-crawl). Each has a dedicated unit test; this test
// exercises the join end-to-end against a captured fixture pair.
//
// Scenario:
//   1. The label cache is empty for the rows we are about to drill into
//      (cache miss).
//   2. Fetch the page-0 multi-section response for a genre root
//      (`id=g79` — Folk). The page exercises three sections plus a
//      related/pivot block.
//   3. Render the page via outline-render.renderOutline → DOM structure
//      (data-section markers, station/show/drill row classes, pivot
//      chips, cursor URL parked on data-cursor-url).
//   4. Walk the captured cursor with createPager, which canonicalises
//      the cursor URL, fetches page 1 (a flat audio body), classifies
//      every row, and dedupes against the page-0 rows we hand it via
//      `initialIds`.
//   5. Render the new flat rows via renderEntry (the row primitive the
//      Load-more handler appends rows through) — verifying the same
//      pipeline classify → normaliseRow → DOM emits.
//   6. Assert the cache has been seeded with `tunein.label.<token>`
//      entries for every row we rendered.
//
// Run: node --test admin/test
//
// READ-ONLY against production code. This test must not import any
// helper that mutates tunein-* — it composes the public surfaces.

import { test, before, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { doc } from './fixtures/dom-shim.js';

// --- sessionStorage shim (per-test reset) --------------------------------

const ssStore = new Map();
globalThis.sessionStorage = {
  getItem(k)    { return ssStore.has(k) ? ssStore.get(k) : null; },
  setItem(k, v) { ssStore.set(k, String(v)); },
  removeItem(k) { ssStore.delete(k); },
  clear()       { ssStore.clear(); },
};

// Late import — these modules read `sessionStorage` at first use, so the
// shim above must be installed before the import resolves.
const { createPager }     = await import('../app/tunein-pager.js');
const { classifyOutline } = await import('../app/tunein-outline.js');
const { canonicaliseBrowseUrl } = await import('../app/tunein-url.js');
const {
  renderOutline,
  renderEntry,
  _setChildCrumbsForTest,
  _setCurrentPartsForTest,
} = await import('../app/views/browse/outline-render.js');
const { cache } = await import('../app/tunein-cache.js');

// --- helpers -------------------------------------------------------------

function loadFixture(name) {
  const p = path.resolve('admin/test/fixtures/tunein-drill', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Scripted fetcher — returns each fixture in order; records every URL
// it was called with so the test can assert canonicalisation + that no
// extra calls leak out.
function scriptedFetch(...pages) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const next = pages.shift();
    if (next === undefined) {
      throw new Error(`scriptedFetch: extra call (url=${url})`);
    }
    return next;
  };
  fn.calls = calls;
  fn.remaining = () => pages.length;
  return fn;
}

function findAllBy(root, predicate) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1 && predicate(node)) out.push(node);
    for (const c of node.childNodes || []) walk(c);
  }
  walk(root);
  return out;
}

function hasClass(el, cls) {
  return (el.getAttribute && (el.getAttribute('class') || '').split(/\s+/).includes(cls));
}

function findFirstByClass(root, cls) {
  if (!root) return null;
  if (root.nodeType === 1 && hasClass(root, cls)) return root;
  for (const c of root.childNodes || []) {
    if (c && c.nodeType === 1) {
      const found = findFirstByClass(c, cls);
      if (found) return found;
    }
  }
  return null;
}

// The page-0 fixture's row guide_ids the renderer writes labels for. The
// cache assertions read these back after the drill completes.
const PAGE0_GUIDE_IDS = ['s10001', 's10002', 'p20001'];
const PAGE0_PIVOT_TOKENS = ['g80', 'g81'];
const PAGE1_NEW_GUIDE_IDS = ['s10003', 's10004'];  // s10001 re-emits and dedupes

// --- reset between tests -------------------------------------------------

before(() => {
  // The renderer reads two module-locals (childCrumbs, currentParts). The
  // drill simulates the top-level entry point so both are empty.
  _setChildCrumbsForTest([]);
  _setCurrentPartsForTest(null);
});

beforeEach(() => {
  ssStore.clear();
});

// =============================================================
// End-to-end: cache miss → fetch page 0 → render → paginate to page 1
// → classify + render new rows → assert DOM + cache state.
// =============================================================

test('TuneIn drill: cache miss → fetch page 0 → paginate → classify → render', async () => {
  // --- 1. Cache miss baseline --------------------------------------------
  //
  // The cache is empty (sessionStorage cleared in beforeEach). Every label
  // key the drill is about to write is absent.
  for (const gid of PAGE0_GUIDE_IDS) {
    assert.equal(cache.get(`tunein.label.${gid}`), undefined,
      `pre-drill cache miss for ${gid}`);
  }
  for (const tok of PAGE0_PIVOT_TOKENS) {
    assert.equal(cache.get(`tunein.label.${tok}`), undefined,
      `pre-drill cache miss for pivot token ${tok}`);
  }

  // --- 2. Fetch page 0 ----------------------------------------------------
  //
  // The drill entry-point URL is the canonical genre root for Folk.
  // The fetcher is mocked: a cache-miss browse path would hand this URL
  // through canonicaliseBrowseUrl in production (api.js does that at the
  // wire seam); here we simulate the post-canonical fetch directly.
  const entryUrl = 'http://opml.radiotime.com/Browse.ashx?id=g79&render=json';
  const page0 = loadFixture('g79-page0.tunein.json');
  const page1 = loadFixture('g79-page1.tunein.json');

  // First "fetch": page-0 outline. The drill's outer integration would
  // call api.tuneinBrowse(entryUrl); for this test we resolve it directly.
  const drillFetch = scriptedFetch(page0, page1);
  const json0 = await drillFetch(entryUrl);
  assert.equal(json0, page0, 'page 0 returned from the fetcher');

  // --- 3. Render page 0 ---------------------------------------------------
  //
  // renderOutline emits one .browse-section per top-level entry that has
  // .children; tombstones / empty bodies short-circuit. The Folk page has
  // three sections (stations, shows, related) so we expect three
  // [data-section] cards.
  const body = doc.createElement('div');
  const visibleCount = renderOutline(body, json0);

  // Two stations + one show row count as "visible" rows in the drill UI.
  // The pivots / cursor are meta and don't increment the count.
  assert.equal(visibleCount, 3,
    'page-0 visible-row count = 2 stations + 1 show; pivots/cursors excluded');

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  const sectionKeys = sections.map((s) => s.getAttribute('data-section'));
  assert.deepEqual(
    sectionKeys.sort(),
    ['related', 'shows', 'stations'].sort(),
    'three sections rendered (stations, shows, related)',
  );

  // The stations section captured a cursor — it should park its URL on
  // data-cursor-url so the Load-more wiring can find it.
  const stationsSection = sections.find((s) => s.getAttribute('data-section') === 'stations');
  const cursorUrl = stationsSection.getAttribute('data-cursor-url');
  assert.ok(cursorUrl, 'stations section parked the cursor URL');
  assert.match(cursorUrl, /offset=2/, 'cursor URL carries the offset');
  assert.match(cursorUrl, /id=g79/, 'cursor URL carries the parent id');

  // The shows section has no cursor → no data-cursor-url.
  const showsSection = sections.find((s) => s.getAttribute('data-section') === 'shows');
  assert.equal(showsSection.getAttribute('data-cursor-url'), null,
    'shows section has no cursor — no data-cursor-url attribute');

  // Station rows in the stations section.
  const stationRowsP0 = findAllBy(stationsSection,
    (el) => hasClass(el, 'station-row'));
  assert.equal(stationRowsP0.length, 2, 'two .station-row entries in page-0 stations');
  const sidsP0 = stationRowsP0.map((el) => el.getAttribute('data-sid'));
  assert.deepEqual(sidsP0.sort(), ['s10001', 's10002']);

  // Show row in the shows section — uses .station-row layout but drills
  // (anchor href goes to #/browse).
  const showRows = findAllBy(showsSection, (el) => hasClass(el, 'station-row'));
  assert.equal(showRows.length, 1, 'one show row in page-0 shows');
  const showHref = showRows[0].getAttribute('href');
  assert.match(showHref, /^#\/browse\?/, 'show row drills via the browse hash');
  assert.match(showHref, /id=p20001/, 'show row drill target is p20001');

  // The related section's pivots render as chips, not rows.
  const relatedSection = sections.find((s) => s.getAttribute('data-section') === 'related');
  const pivots = findAllBy(relatedSection,
    (el) => el.getAttribute('data-chip-kind') === 'pivot');
  assert.equal(pivots.length, 2, 'two pivot chips rendered in related');
  const pivotTexts = pivots.map((p) => (p.textContent || '').trim());
  assert.deepEqual(pivotTexts.sort(), ['Bluegrass', 'Country']);

  // --- 4. Paginate the stations section -----------------------------------
  //
  // The pager seam: take the cursor URL the renderer parked, hand it to
  // createPager along with a fetcher and the page-0 guide_ids (so the
  // re-rank that re-emits s10001 on page 1 is deduped).
  const pager = createPager(cursorUrl, {
    fetch: drillFetch,                 // shares the scripted fetcher
    section: 'stations',
    initialIds: sidsP0,                // seed the dedup set
  });

  assert.equal(pager.exhausted, false, 'pager is alive');
  const r = await pager.loadMore();
  assert.equal(r.exhausted, true,
    'page-1 has no further cursor → pager hits the short-page terminator');
  assert.equal(r.added, 2,
    'page-1 contributed 3 audio rows; s10001 dedupes against page 0 → 2 net new');
  assert.equal(pager.rows.length, 2);
  const sidsP1 = pager.rows.map((row) => row.guide_id).sort();
  assert.deepEqual(sidsP1, PAGE1_NEW_GUIDE_IDS.slice().sort(),
    'the deduped page-1 rows are the two fresh ones');

  // The pager canonicalised the cursor URL — render=json must be present
  // on the URL actually fetched (the API never emits cursors with it).
  assert.equal(drillFetch.calls.length, 2,
    'exactly two fetches happened (page 0 + page 1)');
  const cursorFetchUrl = drillFetch.calls[1];
  assert.match(cursorFetchUrl, /render=json/,
    'cursor follow URL carries render=json (canonicalised at the seam)');
  assert.equal(cursorFetchUrl, canonicaliseBrowseUrl(cursorUrl),
    'pager fetch URL == canonicaliseBrowseUrl(cursorUrl)');

  // --- 5. Classify + render the page-1 rows ------------------------------
  //
  // Each new row classifies as 'station' and renders into a .station-row.
  // The Load-more handler appends these into the existing section's card
  // — here we drive the same code path (renderEntry) directly so the test
  // covers the classify → renderEntry seam.
  const stationCard = findFirstByClass(stationsSection, 'browse-card');
  assert.ok(stationCard, 'stations section has a browse-card from page-0 render');
  for (const row of pager.rows) {
    assert.equal(classifyOutline(row), 'station',
      `page-1 row ${row.guide_id} classifies as station`);
    const node = renderEntry(row);
    assert.ok(hasClass(node, 'station-row'),
      `page-1 row ${row.guide_id} renders into .station-row`);
    stationCard.appendChild(node);
  }

  // After append: stations section now carries all four unique sids
  // (2 from page 0 + 2 net new from page 1 after dedup).
  const allSids = findAllBy(stationsSection,
    (el) => el.getAttribute('data-sid') != null)
    .map((el) => el.getAttribute('data-sid'));
  const uniqSids = new Set(allSids);
  assert.equal(allSids.length, uniqSids.size,
    'no duplicate guide_ids across the full stations section');
  assert.equal(allSids.length, 4,
    'two page-0 + two net-new page-1 = four station rows total');
  for (const expected of ['s10001', 's10002', 's10003', 's10004']) {
    assert.ok(uniqSids.has(expected), `expected sid ${expected} present`);
  }

  // --- 6. Cache state assertions -----------------------------------------
  //
  // renderEntry calls primeLabelForEntry for every row it emits. After
  // the drill the cache holds the label for every visible row (stations,
  // shows, pivots) plus the page-1 rows we just appended.
  assert.equal(cache.get('tunein.label.s10001'), 'Folk Alley',
    'page-0 station s10001 cached its label');
  assert.equal(cache.get('tunein.label.s10002'), 'Celtic Music Radio',
    'page-0 station s10002 cached its label');
  assert.equal(cache.get('tunein.label.p20001'), 'The Folk Show',
    'page-0 show p20001 cached its label');

  // Pivot chips prime under their bare token (the URL anchor — they are
  // plain drill chips, not filter-bearing ones).
  assert.equal(cache.get('tunein.label.g80'), 'Country',
    'pivot chip Country cached its label under tunein.label.g80');
  assert.equal(cache.get('tunein.label.g81'), 'Bluegrass',
    'pivot chip Bluegrass cached its label under tunein.label.g81');

  // The page-1 rows we appended also primed their labels. Page-1 row
  // URLs carry the parent's `filter=s` (the cursor-emitted filter; see
  // tunein-url § 7.2), so the cache token folds the filter into the key:
  // `tunein.label.<id>:<filter>`. That's the correct multi-filter
  // composition rule from outline-render.crumbTokenForParts (#106).
  assert.equal(cache.get('tunein.label.s10003:s'), 'Radio Folk Forever',
    'page-1 station s10003 cached its label under the filter-bearing token');
  assert.equal(cache.get('tunein.label.s10004:s'), 'Sligo Folk Radio',
    'page-1 station s10004 cached its label under the filter-bearing token');

  // No leak: a guide_id we never rendered has no cache entry.
  assert.equal(cache.get('tunein.label.s99999'), undefined,
    'rows that never rendered have no cache entry (no leak)');

  // No extra fetches occurred. The scripted fetcher would have thrown on
  // a third call.
  assert.equal(drillFetch.remaining(), 0, 'fetcher fully drained');
});
