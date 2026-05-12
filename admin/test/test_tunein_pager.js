// Tests for admin/app/tunein-pager.js — the per-section cursor walker.
//
// The pager is a pure async state machine: given a starting cursor URL
// and a mock `fetch`, it walks `nextStations`/`nextShows` chains until
// one of three terminators trips or the page cap is hit. Dedup by
// guide_id is mandatory because mid-crawl re-ranking really does
// duplicate rows across adjacent pages (4-32% page-0 churn observed).
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { createPager } from '../app/tunein-pager.js';

// --- fixtures + helpers ---------------------------------------------

function loadFixture(name) {
  const p = path.resolve('admin/test/fixtures/api', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Build a `fetch` mock that returns each fixture in order. Every call
// records its URL so tests can assert canonicalisation.
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

// Build a synthetic flat page with `count` audio rows and an optional
// next cursor URL. guide_ids are taken from `ids` (so dedup overlaps
// can be constructed).
function makePage(ids, cursorUrl) {
  const body = ids.map((id) => ({
    element: 'outline',
    type:    'audio',
    text:    `Station ${id}`,
    guide_id: id,
    URL:     `http://opml.radiotime.com/Tune.ashx?id=${id}`,
    item:    'station',
  }));
  if (cursorUrl) {
    body.push({
      element: 'outline',
      type:    'link',
      text:    'More Stations',
      URL:     cursorUrl,
      key:     'nextStations',
    });
  }
  return { head: { title: 'X', status: '200' }, body };
}

// --- multi-page accumulation ----------------------------------------

test('createPager: accumulates rows across 3 pages', async () => {
  const page1 = makePage(['s1', 's2', 's3'], 'http://opml.radiotime.com/Browse.ashx?offset=3&id=cX&filter=s');
  const page2 = makePage(['s4', 's5', 's6'], 'http://opml.radiotime.com/Browse.ashx?offset=6&id=cX&filter=s');
  const page3 = makePage(['s7', 's8'], null); // short page — no cursor
  const fetch = scriptedFetch(page1, page2, page3);

  const pager = createPager(
    'http://opml.radiotime.com/Browse.ashx?offset=0&id=cX&filter=s',
    { fetch },
  );

  const r1 = await pager.loadMore();
  assert.equal(r1.added, 3);
  assert.equal(r1.exhausted, false);
  assert.equal(pager.rows.length, 3);

  const r2 = await pager.loadMore();
  assert.equal(r2.added, 3);
  assert.equal(r2.exhausted, false);
  assert.equal(pager.rows.length, 6);

  const r3 = await pager.loadMore();
  assert.equal(r3.added, 2);
  assert.equal(r3.exhausted, true, 'short page (no cursor) is a terminator');
  assert.equal(pager.rows.length, 8);

  // Further calls are no-ops.
  const r4 = await pager.loadMore();
  assert.equal(r4.added, 0);
  assert.equal(r4.exhausted, true);
  assert.equal(fetch.remaining(), 0, 'no extra fetches after exhaustion');
});

// --- dedup by guide_id ----------------------------------------------

test('createPager: dedups rows that repeat across pages (real-shaped fixture)', async () => {
  // page1 fixture has guide_ids s54615 and s150125 at the tail.
  // page2 fixture re-emits those two ids at the top, simulating
  // mid-crawl re-rank, then adds three fresh ones. Dedup must drop
  // the two collisions.
  const page1 = loadFixture('c100000948-page1.tunein.json');
  const page2 = loadFixture('c100000948-page2.tunein.json');
  const fetch = scriptedFetch(page1, page2);

  const pager = createPager(
    'http://opml.radiotime.com/Browse.ashx?offset=26&id=c100000948&filter=s',
    { fetch },
  );

  await pager.loadMore();
  const page1Count = pager.rows.length;
  assert.ok(page1Count >= 20, 'page 1 brought in at least 20 stations');
  assert.ok(pager.rows.some((r) => r.guide_id === 's54615'));
  assert.ok(pager.rows.some((r) => r.guide_id === 's150125'));

  await pager.loadMore();
  // Page 2 contributes 5 audio rows; 2 collide → 3 net new.
  assert.equal(pager.rows.length, page1Count + 3,
    'two re-ranked duplicates were dropped');

  // No guide_id appears twice in the accumulated row list.
  const ids = pager.rows.map((r) => r.guide_id);
  const uniq = new Set(ids);
  assert.equal(ids.length, uniq.size, 'dedup-by-guide_id holds across the merged list');

  // The fresh page-2 rows survived.
  assert.ok(pager.rows.some((r) => r.guide_id === 's900001'));
  assert.ok(pager.rows.some((r) => r.guide_id === 's900003'));
});

test('createPager: seeds the dedup set from initialIds (rows the section already rendered)', async () => {
  // Section's page-0 children rendered "s100" already; cursor page
  // re-emits s100 at position 1. The pager should drop it.
  const page1 = makePage(['s100', 's101', 's102'], null);
  const fetch = scriptedFetch(page1);

  const pager = createPager('http://example/cursor', {
    fetch,
    initialIds: ['s100'],
  });

  const r = await pager.loadMore();
  assert.equal(r.added, 2, 's100 was already seen via initialIds');
  assert.deepEqual(pager.rows.map((x) => x.guide_id), ['s101', 's102']);
});

// --- terminator shape #1: empty body --------------------------------

test('createPager: empty body halts the walk and reports exhausted', async () => {
  const empty = { head: { title: 'X', status: '200' }, body: [] };
  const fetch = scriptedFetch(empty);

  const pager = createPager('http://example/cursor', { fetch });
  const r = await pager.loadMore();
  assert.equal(r.added, 0);
  assert.equal(r.exhausted, true);
  assert.equal(pager.exhausted, true);
});

// --- terminator shape #2: tombstone outline -------------------------

test('createPager: tombstone outline halts the walk', async () => {
  const tomb = loadFixture('c424724-l117-tombstone.tunein.json');
  const fetch = scriptedFetch(tomb);

  const pager = createPager('http://example/cursor', { fetch });
  const r = await pager.loadMore();
  assert.equal(r.added, 0);
  assert.equal(r.exhausted, true);
  assert.equal(pager.exhausted, true);
});

// --- terminator shape #3: short page (no further cursor) -----------

test('createPager: page without a next-cursor halts the walk and keeps its rows', async () => {
  // Note: "short" in the spec means "no further cursor came back".
  // The API never emits a partial page that still has more rows
  // queued without a cursor.
  const short = makePage(['s1', 's2'], null);
  const fetch = scriptedFetch(short);

  const pager = createPager('http://example/cursor', { fetch });
  const r = await pager.loadMore();
  assert.equal(r.added, 2);
  assert.equal(r.exhausted, true, 'absence of next* cursor terminates');
  assert.equal(pager.rows.length, 2, 'rows from the short page are kept');
});

// --- 50-page cap (overridable) --------------------------------------

test('createPager: pageCap halts traversal even if the API keeps emitting cursors', async () => {
  // Each page keeps emitting a fresh cursor URL forever. Cap to 3.
  let n = 0;
  const fetch = async (_url) => {
    n += 1;
    return makePage([`s${n}_1`, `s${n}_2`], `http://example/p${n + 1}?id=cX`);
  };

  const pager = createPager('http://example/p1?id=cX', { fetch, pageCap: 3 });
  await pager.loadMore();
  await pager.loadMore();
  await pager.loadMore();
  // Three follows happened; the API would emit a cursor for page 4
  // but the cap stops us.
  assert.equal(n, 3, 'pageCap=3 produced exactly three fetches');
  assert.equal(pager.exhausted, true);

  const r4 = await pager.loadMore();
  assert.equal(r4.added, 0);
  assert.equal(r4.exhausted, true);
  assert.equal(n, 3, 'no extra fetches after the cap');
  // Status surface mirrors the cap.
  assert.equal(pager.status.sectionCap, 3);
  assert.equal(pager.status.scanned, 3);
  assert.equal(pager.status.exhausted, true);
});

test('createPager: default pageCap is 50', async () => {
  const pager = createPager('http://example/p1', { fetch: async () => makePage([], null) });
  assert.equal(pager.status.sectionCap, 50);
});

// --- render=json re-append on cursor URLs ---------------------------

test('createPager: re-appends render=json to a bare cursor URL', async () => {
  const fetch = scriptedFetch(makePage(['s1'], null));
  const pager = createPager(
    // The API emits cursors without render=json (§ 6.1).
    'http://opml.radiotime.com/Browse.ashx?offset=26&id=c100000948&filter=s',
    { fetch },
  );

  await pager.loadMore();
  assert.equal(fetch.calls.length, 1);
  const url = fetch.calls[0];
  assert.match(url, /render=json/, `expected canonicalised URL with render=json, got: ${url}`);
  // canonicaliseBrowseUrl returns a scheme-less Browse.ashx?...
  // string (it strips host); just assert the drill-keys remain.
  assert.match(url, /id=c100000948/);
  assert.match(url, /filter=s/);
  assert.match(url, /offset=26/);
});

test('createPager: canonicalises the cursor URL on each follow (not only the first)', async () => {
  const page1 = makePage(['s1'], 'http://opml.radiotime.com/Browse.ashx?offset=2&id=cX&filter=s');
  const page2 = makePage(['s2'], null);
  const fetch = scriptedFetch(page1, page2);

  const pager = createPager(
    'http://opml.radiotime.com/Browse.ashx?offset=0&id=cX&filter=s',
    { fetch },
  );
  await pager.loadMore();
  await pager.loadMore();
  assert.equal(fetch.calls.length, 2);
  for (const u of fetch.calls) {
    assert.match(u, /render=json/, `cursor follow must re-append render=json: ${u}`);
  }
});

// --- status events --------------------------------------------------

test('createPager: emits status events with {section, scanned, sectionCap, exhausted}', async () => {
  const page1 = makePage(['s1'], 'http://example/p2');
  const page2 = makePage(['s2'], null);
  const fetch = scriptedFetch(page1, page2);

  const log = [];
  const pager = createPager('http://example/p1', {
    fetch,
    section: 'stations',
    pageCap: 10,
    onStatus: (s) => log.push({ ...s }),
  });

  await pager.loadMore();
  await pager.loadMore();

  assert.equal(log.length, 2);
  assert.deepEqual(log[0], { section: 'stations', scanned: 1, sectionCap: 10, exhausted: false });
  assert.deepEqual(log[1], { section: 'stations', scanned: 2, sectionCap: 10, exhausted: true });
  // The live status surface mirrors the last event.
  assert.deepEqual(pager.status, log[1]);
});

// --- defensive shapes ------------------------------------------------

test('createPager: empty initial URL means exhausted from the start', async () => {
  const fetch = scriptedFetch();
  const pager = createPager('', { fetch });
  assert.equal(pager.exhausted, true);
  const r = await pager.loadMore();
  assert.equal(r.added, 0);
  assert.equal(r.exhausted, true);
});

test('createPager: loop guard — API echoing back our own cursor URL halts the walk', async () => {
  const SAME = 'http://opml.radiotime.com/Browse.ashx?offset=0&id=cX&filter=s';
  const looped = makePage(['s1'], SAME);
  const fetch = scriptedFetch(looped);
  const pager = createPager(SAME, { fetch });
  const r = await pager.loadMore();
  assert.equal(r.exhausted, true, 'echoed cursor halts the walk to avoid an infinite crawl');
  assert.equal(pager.rows.length, 1);
});

test('createPager: dispose() prevents further fetches', async () => {
  const page1 = makePage(['s1'], 'http://example/p2');
  const fetch = scriptedFetch(page1);
  const pager = createPager('http://example/p1', { fetch });
  await pager.loadMore();
  assert.equal(pager.rows.length, 1);
  pager.dispose();
  const r = await pager.loadMore();
  assert.equal(r.added, 0);
  assert.equal(r.exhausted, true);
});

test('createPager: throws when fetch option is missing', () => {
  assert.throws(() => createPager('http://example/p1', {}),
    /fetch is required/);
});
