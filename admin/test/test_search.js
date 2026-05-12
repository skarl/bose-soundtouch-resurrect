// Tests for app/views/search.js — pure helpers (partitionSearchBody,
// popularStations, searchRow) plus the empty-state pipeline backed by
// state.caches.recentlyViewed.
//
// The view's mount() uses the html`...` template tag which leans on
// real DOMParser/Template internals that xmldom doesn't ship; we test
// the extracted pure helpers, the search-row dispatch, the
// tuneinSearch URL composition, and the recently-viewed cache contract
// rather than mounting the whole view.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation } from '@xmldom/xmldom';

// --- DOM shim (lifted from test_browse.js) --------------------------
//
// searchRow builds real <a>/<span> nodes and reads classList, so we
// need the same Element prototype patches the other view tests use.

const doc = new DOMImplementation().createDocument(null, null, null);
if (!doc.querySelector) doc.querySelector = () => null;
if (!doc.documentElement) {
  const html = doc.createElement('html');
  doc.appendChild(html);
}
if (!doc.documentElement.dataset) doc.documentElement.dataset = {};
globalThis.document = doc;

const _sample = doc.createElement('span');
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
  ElementProto.addEventListener = function (type, fn) {
    const map = this.__listeners__ || (this.__listeners__ = new Map());
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  ElementProto.removeEventListener = function (type, fn) {
    const map = this.__listeners__;
    if (map && map.has(type)) map.get(type).delete(fn);
  };
}

if (!Object.getOwnPropertyDescriptor(ElementProto, 'className')) {
  Object.defineProperty(ElementProto, 'className', {
    get() { return this.getAttribute('class') || ''; },
    set(v) { this.setAttribute('class', String(v == null ? '' : v)); },
  });
}
for (const attr of ['href', 'src', 'alt', 'id']) {
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

// sessionStorage shim so PODCAST_TOGGLE_KEY reads / writes don't throw
// in node --test.
if (typeof globalThis.sessionStorage === 'undefined') {
  const m = new Map();
  globalThis.sessionStorage = {
    getItem(k)      { return m.has(k) ? m.get(k) : null; },
    setItem(k, v)   { m.set(k, String(v)); },
    removeItem(k)   { m.delete(k); },
    clear()         { m.clear(); },
  };
}

const {
  partitionSearchBody,
  popularStations,
  searchRow,
  readIncludePodcasts,
  writeIncludePodcasts,
  PODCAST_TOGGLE_KEY,
  DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
} = await import('../app/views/search.js');

function classOf(el) { return el.getAttribute('class') || ''; }

function findFirstByClass(root, cls) {
  if (!root) return null;
  if (classOf(root).split(/\s+/).includes(cls)) return root;
  for (let i = 0; i < (root.childNodes || []).length; i++) {
    const n = root.childNodes[i];
    if (n && n.nodeType === 1) {
      const found = findFirstByClass(n, cls);
      if (found) return found;
    }
  }
  return null;
}

function findAllByClass(root, cls) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1 && classOf(node).split(/\s+/).includes(cls)) {
      out.push(node);
    }
    for (const c of node.childNodes || []) walk(c);
  }
  walk(root);
  return out;
}

// --- partitionSearchBody --------------------------------------------

test('partitionSearchBody: keeps mixed-prefix entries; sinks unavailable to its own bucket', () => {
  const out = partitionSearchBody({
    body: [
      { type: 'audio', guide_id: 's12345', text: 'KEXP' },
      { type: 'link',  guide_id: 'p38913', text: 'Show', item: 'show' },
      { type: 'link',  guide_id: 't22222', text: 'Topic', item: 'topic' },
      { type: 'link',  guide_id: 'm33333', text: 'Artist',
        URL: 'http://opml.radiotime.com/Browse.ashx?id=m33333' },
      { type: 'audio', guide_id: 's99999', text: 'Geo-blocked',
        unavailable: 'Not available in your region' },
    ],
  });
  assert.deepEqual(out.rows.map((e) => e.guide_id), ['s12345', 'p38913', 't22222', 'm33333']);
  assert.deepEqual(out.unavailable.map((e) => e.guide_id), ['s99999']);
});

test('partitionSearchBody: empty / malformed body returns empty buckets', () => {
  assert.deepEqual(partitionSearchBody(null), { rows: [], unavailable: [] });
  assert.deepEqual(partitionSearchBody({}), { rows: [], unavailable: [] });
  assert.deepEqual(partitionSearchBody({ body: 'oops' }), { rows: [], unavailable: [] });
});

// --- popularStations (Browse.ashx?c=local) --------------------------

test('popularStations: walks one level into nested sections', () => {
  const out = popularStations({
    body: [
      {
        text: 'Local section',
        children: [
          { type: 'audio', guide_id: 's1', text: 'A' },
          { type: 'audio', guide_id: 's2', text: 'B' },
          { type: 'link',  guide_id: 's3', text: 'wrong type' },
        ],
      },
      { type: 'audio', guide_id: 's4', text: 'top-level station' },
    ],
  });
  assert.deepEqual(out.map((e) => e.guide_id), ['s1', 's2', 's4']);
});

test('popularStations: empty body returns []', () => {
  assert.deepEqual(popularStations({ body: [] }), []);
});

// --- searchRow dispatch (per-prefix Play presence) ------------------

test('searchRow: s-prefix station gets a Play icon and #/station/<sid> drill', () => {
  const node = searchRow({
    type: 'audio', guide_id: 's11111', text: 'Folk Alley',
    subtext: 'Kent, OH', bitrate: 192, formats: 'mp3',
    item: 'station',
  });
  assert.equal(node.tagName, 'a');
  assert.equal(node.getAttribute('href'), '#/station/s11111');
  assert.equal(node.getAttribute('data-prefix'), 's');
  const play = findFirstByClass(node, 'station-row__play');
  assert.ok(play, 's-prefix row carries a Play icon');
});

test('searchRow: p-prefix show gets a Play icon and drills via #/browse?id=p<NN>', () => {
  const node = searchRow({
    type: 'link', guide_id: 'p38913', text: 'Folk Alley Sessions',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=p38913',
    item: 'show',
  });
  assert.equal(node.getAttribute('data-prefix'), 'p');
  const href = node.getAttribute('href');
  assert.match(href, /^#\/browse\?/, `show drills via #/browse; got: ${href}`);
  assert.match(href, /id=p38913/);
  const play = findFirstByClass(node, 'station-row__play');
  assert.ok(play, 'p-prefix show row carries a Play icon');
});

test('searchRow: t-prefix topic gets a Play icon', () => {
  const node = searchRow({
    type: 'link', guide_id: 't22222', text: 'Topic',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=t22222',
    item: 'topic',
  });
  assert.equal(node.getAttribute('data-prefix'), 't');
  const play = findFirstByClass(node, 'station-row__play');
  assert.ok(play, 't-prefix row carries a Play icon');
});

test('searchRow: m-prefix artist is drill-only — no Play icon, chevron only', () => {
  const node = searchRow({
    type: 'link', guide_id: 'm33333', text: 'Joan Baez',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=m33333',
  });
  assert.equal(node.getAttribute('data-prefix'), 'm');
  assert.equal(findFirstByClass(node, 'station-row__play'), null,
    'artist row has no Play icon');
  const chev = findFirstByClass(node, 'station-row__chev');
  assert.ok(chev, 'artist row still has a chevron');
  const href = node.getAttribute('href');
  assert.match(href, /^#\/browse\?/, `artist drills via #/browse; got: ${href}`);
});

// --- mixed-prefix fixture: end-to-end DOM render --------------------

test('search: mixed-prefix fixture renders Play on s/p/t, none on m; data-prefix varies', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const json = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/search-folk-mixed.tunein.json'), 'utf8'),
  );

  const { rows, unavailable } = partitionSearchBody(json);

  // Four playable rows (s, p, t, m); one georestricted (s99999).
  assert.deepEqual(rows.map((e) => e.guide_id), ['s11111', 'p38913', 't22222', 'm33333']);
  assert.deepEqual(unavailable.map((e) => e.guide_id), ['s99999']);

  // Render every row through searchRow and inspect each one.
  const card = doc.createElement('div');
  for (const entry of rows) card.appendChild(searchRow(entry));

  const builtRows = findAllByClass(card, 'station-row');
  assert.equal(builtRows.length, 4);

  // Multiple data-prefix values are present — the acceptance criterion
  // for "Include podcasts ON".
  const prefixes = builtRows.map((r) => r.getAttribute('data-prefix'));
  assert.deepEqual(prefixes, ['s', 'p', 't', 'm']);
  const uniquePrefixes = new Set(prefixes);
  assert.ok(uniquePrefixes.size > 1,
    `expected >1 distinct data-prefix values, got: ${[...uniquePrefixes].join(', ')}`);

  // Play icon presence by prefix.
  const playByPrefix = {};
  for (const r of builtRows) {
    const prefix = r.getAttribute('data-prefix');
    playByPrefix[prefix] = !!findFirstByClass(r, 'station-row__play');
  }
  assert.equal(playByPrefix.s, true,  's row has Play icon');
  assert.equal(playByPrefix.p, true,  'p row (show) has Play icon');
  assert.equal(playByPrefix.t, true,  't row (topic) has Play icon');
  assert.equal(playByPrefix.m, false, 'm row (artist) has NO Play icon');
});

// --- tuneinSearch URL composition (api.js contract) -----------------

test('tuneinSearch: default request has no filter param, only query', async () => {
  const { tuneinSearch } = await import('../app/api.js');
  const realFetch = globalThis.fetch;
  let captured = '';
  globalThis.fetch = async (url) => {
    captured = url;
    return { ok: true, status: 200, json: async () => ({ body: [] }) };
  };
  try {
    await tuneinSearch('folk');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(captured, /\/cgi-bin\/api\/v1\/tunein\/search\?/);
  assert.match(captured, /query=folk/);
  assert.doesNotMatch(captured, /filter=/, `default request must not carry a filter param; got: ${captured}`);
  assert.doesNotMatch(captured, /type=station/, `default request must not carry type=station; got: ${captured}`);
});

test('tuneinSearch: opts.stationsOnly = true adds filter=s:popular', async () => {
  const { tuneinSearch } = await import('../app/api.js');
  const realFetch = globalThis.fetch;
  let captured = '';
  globalThis.fetch = async (url) => {
    captured = url;
    return { ok: true, status: 200, json: async () => ({ body: [] }) };
  };
  try {
    await tuneinSearch('folk', { stationsOnly: true });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(captured, /query=folk/);
  // URLSearchParams encodes ':' as '%3A'.
  assert.match(captured, /filter=s%3Apopular/,
    `stationsOnly request must carry filter=s:popular; got: ${captured}`);
});

// --- "Include podcasts" toggle persistence --------------------------

test('readIncludePodcasts: default ON when sessionStorage has no preference', () => {
  sessionStorage.removeItem(PODCAST_TOGGLE_KEY);
  assert.equal(readIncludePodcasts(), true);
});

test('writeIncludePodcasts / readIncludePodcasts: round-trip through sessionStorage', () => {
  writeIncludePodcasts(false);
  assert.equal(sessionStorage.getItem(PODCAST_TOGGLE_KEY), 'false');
  assert.equal(readIncludePodcasts(), false);
  writeIncludePodcasts(true);
  assert.equal(sessionStorage.getItem(PODCAST_TOGGLE_KEY), 'true');
  assert.equal(readIncludePodcasts(), true);
});

// --- search debounce window -----------------------------------------

test('search: debounce window is 300ms (preserves the v0.3 contract)', () => {
  // A regression guard: if someone tightens the debounce by accident,
  // we want the test to flag it instead of silently spamming TuneIn.
  assert.equal(DEBOUNCE_MS, 300);
});

test('search: placeholder hints at TuneIn + 3 example queries', () => {
  // Polish-pass spec: nudge users with concrete query examples.
  assert.match(SEARCH_PLACEHOLDER, /TuneIn/);
  assert.match(SEARCH_PLACEHOLDER, /jazz/);
  assert.match(SEARCH_PLACEHOLDER, /bbc/);
  assert.match(SEARCH_PLACEHOLDER, /ffh/);
});

// --- search input wrap: pill-shape + leading icon (CSS contract) ---
//
// The polish pass moved the search input into a bordered wrapper so the
// magnifier glyph sits inside the field. The contract is the visible
// .search-input-wrap class with a 38px pill-style row.
test('search css: .search-input-wrap exists and the input is borderless', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const css = fs.readFileSync(path.resolve('admin/style.css'), 'utf8');
  const wrapRule = css.match(/^\.search-input-wrap\s*\{([^}]+)\}/m);
  assert.ok(wrapRule, 'found .search-input-wrap rule');
  assert.match(wrapRule[1], /\bheight:\s*38px\b/);
  assert.match(wrapRule[1], /\bborder:\s*1px solid\b/);

  const inputRule = css.match(/^\.search-input\s*\{([^}]+)\}/m);
  assert.ok(inputRule, 'found .search-input rule');
  assert.match(inputRule[1], /\bborder:\s*0\b/);
});

// --- recently-viewed cache: cap at 10, dedupe by sid, latest-first --
//
// state.js exposes the cache + the addRecentlyViewed mutator; the
// search view's empty state reads it. No DOM needed for these.

test('addRecentlyViewed: dedupe by sid, latest-first ordering', async () => {
  const { store, addRecentlyViewed } = await import('../app/state.js');
  store.state.caches.recentlyViewed = [];

  addRecentlyViewed({ sid: 's1', name: 'A' });
  addRecentlyViewed({ sid: 's2', name: 'B' });
  addRecentlyViewed({ sid: 's1', name: 'A again' });

  const list = store.state.caches.recentlyViewed;
  assert.equal(list.length, 2, 'sid dedupe collapses repeats');
  assert.equal(list[0].sid, 's1');
  assert.equal(list[0].name, 'A again', 'newer entry wins');
  assert.equal(list[1].sid, 's2');
});

test('addRecentlyViewed: caps the list at 10 entries', async () => {
  const { store, addRecentlyViewed } = await import('../app/state.js');
  store.state.caches.recentlyViewed = [];

  for (let i = 0; i < 15; i++) {
    addRecentlyViewed({ sid: `s${i}`, name: `Station ${i}` });
  }

  const list = store.state.caches.recentlyViewed;
  assert.equal(list.length, 10);
  // Latest first → s14 down to s5.
  assert.equal(list[0].sid, 's14');
  assert.equal(list[9].sid, 's5');
});

test('addRecentlyViewed: rejects entries missing sid or name', async () => {
  const { store, addRecentlyViewed } = await import('../app/state.js');
  store.state.caches.recentlyViewed = [];

  addRecentlyViewed({ sid: '', name: 'no sid' });
  addRecentlyViewed({ sid: 's1', name: '' });
  addRecentlyViewed({ sid: 's1' });

  assert.equal(store.state.caches.recentlyViewed.length, 0);
});
