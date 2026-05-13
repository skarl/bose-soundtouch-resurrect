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

// =============================================================
// Browse-view integration: mountLoadMoreButtons against a DOM.
// =============================================================
//
// The integration exercises end-to-end Load-more without going through
// the SPA router: build the Folk section card via renderOutline, mount
// Load-more buttons with an injected fetcher, click, verify rows grow
// and no guide_id repeats in the DOM.

import { DOMImplementation } from '@xmldom/xmldom';

// --- DOM shim (mirrors test_browse.js) -------------------------------

const _doc = new DOMImplementation().createDocument(null, null, null);
if (!_doc.querySelector) _doc.querySelector = () => null;
if (!_doc.documentElement) {
  const htmlEl = _doc.createElement('html');
  _doc.appendChild(htmlEl);
}
if (!_doc.documentElement.dataset) _doc.documentElement.dataset = {};
globalThis.document = _doc;

const _sample = _doc.createElement('span');
const ElementProto = Object.getPrototypeOf(_sample);

if (!ElementProto.classList) {
  Object.defineProperty(ElementProto, 'classList', {
    get() {
      const el = this;
      return {
        add(...names) {
          const cur = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
          for (const n of names) if (!cur.includes(n)) cur.push(n);
          el.setAttribute('class', cur.join(' '));
        },
        remove(...names) {
          const cur = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
          el.setAttribute('class', cur.filter((c) => !names.includes(c)).join(' '));
        },
        contains(name) {
          return (el.getAttribute('class') || '').split(/\s+/).includes(name);
        },
        toggle(name, force) {
          const has = this.contains(name);
          const want = force == null ? !has : !!force;
          if (want && !has) this.add(name);
          else if (!want && has) this.remove(name);
          return want;
        },
      };
    },
  });
}

if (!ElementProto.addEventListener) {
  // Per-element listener map. Synchronous click dispatch — the click
  // handler is async, so we await microtasks separately in each test.
  ElementProto.addEventListener = function (type, fn) {
    this.__handlers = this.__handlers || {};
    (this.__handlers[type] = this.__handlers[type] || []).push(fn);
  };
  ElementProto.removeEventListener = function (type, fn) {
    if (!this.__handlers || !this.__handlers[type]) return;
    this.__handlers[type] = this.__handlers[type].filter((h) => h !== fn);
  };
  ElementProto.click = function () {
    const fns = (this.__handlers && this.__handlers.click) || [];
    for (const fn of fns) fn({ target: this });
  };
}

if (!Object.getOwnPropertyDescriptor(ElementProto, 'className')) {
  Object.defineProperty(ElementProto, 'className', {
    get() { return this.getAttribute('class') || ''; },
    set(v) { this.setAttribute('class', String(v == null ? '' : v)); },
  });
}
for (const attr of ['href', 'src', 'alt']) {
  if (!Object.getOwnPropertyDescriptor(ElementProto, attr)) {
    Object.defineProperty(ElementProto, attr, {
      get() { return this.getAttribute(attr) || ''; },
      set(v) { this.setAttribute(attr, String(v == null ? '' : v)); },
    });
  }
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'dataset')) {
  Object.defineProperty(ElementProto, 'dataset', {
    get() {
      const el = this;
      return new Proxy({}, {
        get(_t, key) {
          if (typeof key !== 'string') return undefined;
          const attr = 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          const v = el.getAttribute(attr);
          return v == null ? undefined : v;
        },
        set(_t, key, value) {
          if (typeof key !== 'string') return true;
          const attr = 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          el.setAttribute(attr, String(value));
          return true;
        },
      });
    },
  });
}

// --- imports (post DOM-shim) ----------------------------------------

const { renderOutline, mountLoadMoreButtons } = await import('../app/views/browse.js');

// --- helpers --------------------------------------------------------

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

function findFirstByClass(root, cls) {
  function walk(node) {
    if (!node) return null;
    if (node.nodeType === 1) {
      const c = (node.getAttribute && node.getAttribute('class')) || '';
      if (c.split(/\s+/).includes(cls)) return node;
    }
    for (const ch of node.childNodes || []) {
      const f = walk(ch);
      if (f) return f;
    }
    return null;
  }
  return walk(root);
}

// Drain enough microtasks for the click handler's awaits to settle.
// The handler is async with two awaits (the loadMore + the render),
// so three flushes covers it.
async function drain() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// --- mount + click integration --------------------------------------

test('mountLoadMoreButtons: clicking Load-more grows rows and dedupes by guide_id', async () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const body = _doc.createElement('div');
  renderOutline(body, folk);

  const page1 = loadFixture('c100000948-page1.tunein.json');
  const page2 = loadFixture('c100000948-page2.tunein.json');
  const tomb  = loadFixture('c424724-l117-tombstone.tunein.json');

  // Two Load-more buttons exist (stations + shows). Each pager gets a
  // turn via the shared scripted fetcher. Order in this test: we only
  // click the stations button, so the script feeds stations.
  const fetcher = scriptedFetch(page1, page2, tomb);
  mountLoadMoreButtons(body, { fetcher });

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  const stationsSection = sections.find((s) => s.getAttribute('data-section') === 'stations');
  assert.ok(stationsSection);
  const stationsBtn = findFirstByClass(stationsSection, 'browse-load-more');
  assert.ok(stationsBtn, 'stations section has a Load-more button');
  assert.equal(stationsBtn.getAttribute('data-state'), 'idle');

  // Snapshot BEFORE: row count + no-dupe baseline.
  const sidsBefore = findAllBy(stationsSection, (el) => el.getAttribute('data-sid') != null)
    .map((el) => el.getAttribute('data-sid'));
  assert.ok(sidsBefore.length >= 20, 'stations section already had ~23 page-0 rows');
  assert.equal(sidsBefore.length, new Set(sidsBefore).size);

  // Click 1 — appends page1 rows.
  stationsBtn.click();
  await drain();
  const sidsAfter1 = findAllBy(stationsSection, (el) => el.getAttribute('data-sid') != null)
    .map((el) => el.getAttribute('data-sid'));
  assert.ok(sidsAfter1.length > sidsBefore.length,
    `expected rows to grow after click 1; before=${sidsBefore.length}, after=${sidsAfter1.length}`);
  assert.equal(sidsAfter1.length, new Set(sidsAfter1).size, 'no duplicate guide_ids after click 1');

  // Click 2 — appends page2 rows. Page 2 re-emits s54615 and s150125
  // from page 1 + 3 fresh rows. Dedup drops the two collisions.
  stationsBtn.click();
  await drain();
  const sidsAfter2 = findAllBy(stationsSection, (el) => el.getAttribute('data-sid') != null)
    .map((el) => el.getAttribute('data-sid'));
  assert.equal(sidsAfter2.length, sidsAfter1.length + 3,
    'page 2 added exactly 3 net new rows (two re-ranks deduped)');
  assert.equal(sidsAfter2.length, new Set(sidsAfter2).size, 'no duplicate guide_ids after click 2');

  // Click 3 — tombstone terminates the walk; button removes itself.
  stationsBtn.click();
  await drain();
  assert.equal(findFirstByClass(stationsSection, 'browse-load-more'), null,
    'tombstone terminator removes the Load-more button');
});

test('mountLoadMoreButtons: sections without a cursor get no button', async () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const body = _doc.createElement('div');
  renderOutline(body, folk);

  mountLoadMoreButtons(body, { fetcher: async () => ({}) });

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  const local = sections.find((s) => s.getAttribute('data-section') === 'local');
  assert.ok(local);
  assert.equal(findFirstByClass(local, 'browse-load-more'), null,
    'local section has no cursor; no button is mounted');
});

test('mountLoadMoreButtons: pageCap override removes the button after the cap is hit', async () => {
  // Build a synthetic section the integration can drive directly.
  const body = _doc.createElement('div');
  const section = _doc.createElement('section');
  section.setAttribute('data-section', 'stations');
  section.setAttribute('class', 'browse-section');
  section.setAttribute('data-cursor-url',
    'http://opml.radiotime.com/Browse.ashx?offset=0&id=cX&filter=s');
  const card = _doc.createElement('div');
  card.setAttribute('class', 'browse-card');
  section.appendChild(card);
  const footer = _doc.createElement('div');
  footer.setAttribute('class', 'browse-section__footer');
  section.appendChild(footer);
  body.appendChild(section);

  // Fetcher emits a fresh cursor every time — would loop forever
  // without the cap.
  let n = 0;
  const fetcher = async (_url) => {
    n += 1;
    return makePage([`s${n}_a`, `s${n}_b`], `http://example/p${n + 1}?id=cX`);
  };

  mountLoadMoreButtons(body, { fetcher, pageCap: 2 });

  let btn = findFirstByClass(section, 'browse-load-more');
  assert.ok(btn);

  btn.click();
  await drain();
  btn = findFirstByClass(section, 'browse-load-more');
  assert.ok(btn, 'button still present after click 1');

  btn.click();
  await drain();
  btn = findFirstByClass(section, 'browse-load-more');
  assert.equal(btn, null, 'pageCap exhaustion removes the button on click 2');
  assert.equal(n, 2, 'exactly 2 fetches happened (cap halted the third)');
});

test('mountLoadMoreButtons: cursor-only section (no page-0 rows) lazily creates a card on first click', async () => {
  // Verified live on Bo: Top 40 & Pop's "stations" section has zero
  // visible rows on page 0 — its only child is the nextStations
  // cursor. renderSection skips creating the .browse-card in that
  // case (no visibleChildren). The pager must still be able to
  // append page-1 rows somewhere, so appendNewRows creates the card
  // lazily on first click.

  // Build a minimal cursor-only section the way renderSection would.
  const body = _doc.createElement('div');
  const section = _doc.createElement('section');
  section.setAttribute('data-section', 'stations');
  section.setAttribute('class', 'browse-section');
  section.setAttribute('data-cursor-url',
    'http://opml.radiotime.com/Browse.ashx?offset=0&id=c57943&filter=s');
  const h = _doc.createElement('h2');
  section.appendChild(h);
  const footer = _doc.createElement('div');
  footer.setAttribute('class', 'browse-section__footer');
  section.appendChild(footer);
  body.appendChild(section);

  const page1 = makePage(['s1', 's2', 's3'], null);
  const fetcher = scriptedFetch(page1);
  mountLoadMoreButtons(body, { fetcher });

  // No .browse-card exists yet.
  assert.equal(findFirstByClass(section, 'browse-card'), null);

  const btn = findFirstByClass(section, 'browse-load-more');
  assert.ok(btn);

  btn.click();
  await drain();

  // After click: card was created and three rows appended.
  const card = findFirstByClass(section, 'browse-card');
  assert.ok(card, 'card was lazily created on first Load-more click');
  const sids = findAllBy(section, (el) => el.getAttribute('data-sid') != null)
    .map((el) => el.getAttribute('data-sid'));
  assert.deepEqual(sids.sort(), ['s1', 's2', 's3']);
});

test('browse css: .browse-load-more is a pill-shaped button matching the pivot chips', async () => {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  const css = fs.readFileSync(pathMod.resolve('admin/style.css'), 'utf8');
  const rule = css.match(/^\.browse-load-more\s*\{([^}]+)\}/m);
  assert.ok(rule, 'found .browse-load-more rule');
  assert.match(rule[1], /\bborder-radius:\s*999px\b/);
  assert.match(rule[1], /\bborder:\s*1px\s+solid\s+var\(--border\)/);
});
