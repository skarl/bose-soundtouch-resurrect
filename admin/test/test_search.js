// Tests for app/views/search.js — pure helpers (searchResultStations,
// popularStations) plus the empty-state pipeline backed by
// state.caches.recentlyViewed.
//
// The view's mount() uses the html`...` template tag which leans on
// real DOMParser/Template internals that xmldom doesn't ship; we test
// the extracted pure helpers and the recently-viewed cache contract
// rather than mounting the whole view.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// --- DOM-ish shim required by app/state.js --------------------------
//
// state.js imports cleanly without a document, but addRecentlyViewed
// just touches store.state. No DOM needed for the cache tests.

const {
  searchResultStations,
  popularStations,
  DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
} = await import('../app/views/search.js');

// --- searchResultStations -------------------------------------------

test('searchResultStations: keeps only audio entries with valid sNNN guide_id', () => {
  const out = searchResultStations({
    body: [
      { type: 'audio', guide_id: 's12345', text: 'KEXP' },
      { type: 'audio', guide_id: 'g22',    text: 'Genre — not a station' },
      { type: 'link',  guide_id: 's55555', text: 'Wrong type' },
      { type: 'audio',                       text: 'Missing id' },
      { type: 'audio', guide_id: 's77',    text: 'Radio Paradise' },
    ],
  });
  assert.deepEqual(out.map((e) => e.guide_id), ['s12345', 's77']);
});

test('searchResultStations: empty / malformed body returns []', () => {
  assert.deepEqual(searchResultStations(null), []);
  assert.deepEqual(searchResultStations({}), []);
  assert.deepEqual(searchResultStations({ body: 'oops' }), []);
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
