// Tests for the favourites tracer slice (issue #125):
//
//   - app/favorites.js — list helpers (indexOfFavorite, withFavoriteAdded,
//     withFavoriteRemoved), the optimistic toggleFavorite action, and the
//     favoriteHeart() DOM primitive (visibility rule + click round-trip).
//   - station-detail integration — the heart renders next to the station
//     name on `^[sp]\d+$` ids and is hidden otherwise.
//
// Strategy: the dom-shim gives us a working Element/document, fetch is
// the never-resolving default which we override per test with a callable
// stub. We stand up a fresh in-process state with the production store
// (it's a module singleton like the other view tests).
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installFetchNeverResolving } from './fixtures/dom-shim.js';

installFetchNeverResolving();

const {
  isFavoriteId,
  indexOfFavorite,
  withFavoriteAdded,
  withFavoriteRemoved,
  toggleFavorite,
  favoriteHeart,
  filterFavorites,
} = await import('../app/favorites.js');

const { store } = await import('../app/state.js');
const { default: stationView } = await import('../app/views/station.js');
const { _setDeps } = await import('../app/probe.js');

function makeRoot() { return doc.createElement('div'); }

beforeEach(() => {
  store.state.speaker.favorites = null;
  store.state.speaker.presets   = null;
  store.state.caches.probe.clear();
  _setDeps({
    tuneinProbe:   async () => { throw new Error('tuneinProbe not stubbed'); },
    presetsAssign: async () => { throw new Error('presetsAssign not stubbed'); },
    setPresets:    () => {},
  });
});

// --- pure helpers ---------------------------------------------------

test('isFavoriteId: accepts s/p + digits, rejects bare prefix, garbage, non-s/p', () => {
  assert.equal(isFavoriteId('s12345'), true,  's12345 is a valid favourite id');
  assert.equal(isFavoriteId('p99'),    true,  'p99 is a valid favourite id');
  assert.equal(isFavoriteId('s'),      false, 'bare s is rejected');
  assert.equal(isFavoriteId('p'),      false, 'bare p is rejected');
  assert.equal(isFavoriteId('t1'),     false, 't-prefix is rejected (favourites are stations + shows only)');
  assert.equal(isFavoriteId('g22'),    false, 'g-prefix is rejected');
  assert.equal(isFavoriteId(''),       false, 'empty string is rejected');
  assert.equal(isFavoriteId(null),     false, 'null is rejected');
  assert.equal(isFavoriteId('s1a'),    false, 'trailing letters are rejected');
});

test('indexOfFavorite: returns -1 on miss / null list, otherwise the array index', () => {
  assert.equal(indexOfFavorite(null, 's1'), -1);
  assert.equal(indexOfFavorite([], 's1'), -1);
  const list = [{ id: 's1', name: 'A' }, { id: 'p9', name: 'B' }];
  assert.equal(indexOfFavorite(list, 'p9'), 1);
  assert.equal(indexOfFavorite(list, 's2'), -1);
});

test('withFavoriteAdded: appends when missing, no-op when present (returns same reference)', () => {
  const base = [{ id: 's1', name: 'A', art: '', note: '' }];
  const added = withFavoriteAdded(base, { id: 'p9', name: 'B' });
  assert.equal(added.length, 2);
  assert.deepEqual(added[1], { id: 'p9', name: 'B', art: '', note: '' });
  assert.notEqual(added, base, 'returns a new array');

  const same = withFavoriteAdded(base, { id: 's1', name: 'A' });
  assert.equal(same, base, 'no-op returns the original reference for callers');
});

test('withFavoriteRemoved: drops the first match; no-op when missing', () => {
  const base = [{ id: 's1' }, { id: 'p9' }, { id: 's2' }];
  const out = withFavoriteRemoved(base, 'p9');
  assert.deepEqual(out.map((e) => e.id), ['s1', 's2']);

  const same = withFavoriteRemoved(base, 'sNope');
  assert.equal(same, base, 'miss returns the original reference');
});

// --- filterFavorites pure list transform ---------------------------

test('filterFavorites: empty / whitespace query returns the original reference', () => {
  const list = [{ id: 's1', name: 'A', note: '', art: '' }];
  assert.equal(filterFavorites(list, ''), list, 'empty string is identity');
  assert.equal(filterFavorites(list, '   '), list, 'whitespace-only is identity');
  assert.equal(filterFavorites(list, null), list, 'non-string treated as empty');
});

test('filterFavorites: substring match against name', () => {
  const list = [
    { id: 's1', name: 'KEXP Seattle',  note: '', art: '' },
    { id: 's2', name: 'BBC Radio 6',   note: '', art: '' },
    { id: 's3', name: 'Radio Paradise', note: '', art: '' },
  ];
  const out = filterFavorites(list, 'radio');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.id), ['s2', 's3'], 'order preserved');
});

test('filterFavorites: case-insensitive', () => {
  const list = [{ id: 's1', name: 'KEXP', note: '', art: '' }];
  assert.equal(filterFavorites(list, 'kexp').length, 1);
  assert.equal(filterFavorites(list, 'KEXP').length, 1);
  assert.equal(filterFavorites(list, 'KeXp').length, 1);
});

test('filterFavorites: diacritic-insensitive on both sides', () => {
  const list = [
    { id: 's1', name: 'Café del Mar', note: '', art: '' },
    { id: 's2', name: 'Über Radio',   note: '', art: '' },
  ];
  // Plain ASCII needle matches the accented haystack.
  assert.equal(filterFavorites(list, 'cafe')[0].id, 's1');
  assert.equal(filterFavorites(list, 'uber')[0].id, 's2');
  // Accented needle still matches the same row.
  assert.equal(filterFavorites(list, 'CAFÉ')[0].id, 's1');
});

test('filterFavorites: matches against note and id, not just name', () => {
  const list = [
    { id: 's12345', name: 'Mystery', note: '',         art: '' },
    { id: 'p99',    name: 'Show',    note: 'live mix', art: '' },
  ];
  assert.equal(filterFavorites(list, '12345')[0].id, 's12345', 'id substring matches');
  assert.equal(filterFavorites(list, 'live')[0].id, 'p99',     'note substring matches');
});

test('filterFavorites: zero matches → empty array, not the original', () => {
  const list = [{ id: 's1', name: 'A', note: '', art: '' }];
  const out = filterFavorites(list, 'zzznope');
  assert.notEqual(out, list);
  assert.equal(out.length, 0);
});

test('filterFavorites: null / non-array list collapses to []', () => {
  assert.deepEqual(filterFavorites(null, 'x'), []);
  assert.deepEqual(filterFavorites(undefined, 'x'), []);
});

// --- toggleFavorite optimistic round-trip ---------------------------

function installFetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('toggleFavorite: POST success → state stays at optimistic value', async () => {
  store.state.speaker.favorites = [];
  let captured = null;
  const restore = installFetchStub(async (url, opts) => {
    captured = { url: String(url), opts };
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 's12345', name: 'R1', art: '', note: '' }] }),
    };
  });
  try {
    const env = await toggleFavorite(store, { id: 's12345', name: 'R1' });
    assert.equal(env.ok, true);
    assert.ok(captured, 'POST issued');
    assert.equal(captured.opts.method, 'POST');
    assert.match(captured.url, /\/favorites$/);
    const sent = JSON.parse(captured.opts.body);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 's12345');
    assert.equal(store.state.speaker.favorites.length, 1, 'optimistic add persists');
  } finally {
    restore();
  }
});

test('toggleFavorite: POST structured-error → state rolls back, no leak', async () => {
  store.state.speaker.favorites = [];
  const restore = installFetchStub(async () => ({
    ok: true, status: 400,
    json: async () => ({ ok: false, error: { code: 'INVALID_ID', message: 'bad' } }),
  }));
  try {
    const env = await toggleFavorite(store, { id: 's12345', name: 'R1' });
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ID');
    assert.deepEqual(store.state.speaker.favorites, [], 'rolled back to the snapshot');
  } finally {
    restore();
  }
});

test('toggleFavorite: POST transport throw → state rolls back, synthetic envelope returned', async () => {
  store.state.speaker.favorites = [{ id: 's1', name: 'A', art: '', note: '' }];
  const restore = installFetchStub(async () => { throw new Error('boom'); });
  try {
    const env = await toggleFavorite(store, { id: 's1', name: 'A' });
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'TRANSPORT');
    assert.equal(store.state.speaker.favorites.length, 1, 'rollback restores the prior entry');
    assert.equal(store.state.speaker.favorites[0].id, 's1');
  } finally {
    restore();
  }
});

test('toggleFavorite: remove path — present id flips to absent on success', async () => {
  store.state.speaker.favorites = [{ id: 's7', name: 'Seven', art: '', note: '' }];
  let body = null;
  const restore = installFetchStub(async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
  });
  try {
    const env = await toggleFavorite(store, { id: 's7', name: 'Seven' });
    assert.equal(env.ok, true);
    assert.deepEqual(body, [], 'POST body is the post-remove array');
    assert.deepEqual(store.state.speaker.favorites, [], 'state is empty after the remove');
  } finally {
    restore();
  }
});

test('toggleFavorite: id that doesn\'t match ^[sp]\\d+$ short-circuits without a POST', async () => {
  store.state.speaker.favorites = [];
  let calls = 0;
  const restore = installFetchStub(async () => { calls++; return { ok: true, json: async () => ({}) }; });
  try {
    const env = await toggleFavorite(store, { id: 'g22', name: 'genre' });
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ID');
    assert.equal(calls, 0, 'no POST is fired for an invalid id');
    assert.equal(store.state.speaker.favorites.length, 0);
  } finally {
    restore();
  }
});

// --- favoriteHeart visibility + click ------------------------------

test('favoriteHeart: hidden when getEntry().id is missing or non-station/show', () => {
  store.state.speaker.favorites = [];
  let id = 'g42';
  const btn = favoriteHeart({
    getEntry: () => ({ id, name: 'genre' }),
    store,
  });
  assert.equal(btn.hidden, true, 'genre id → heart hidden');
  // Switch to a station id and repaint — the heart should appear.
  id = 's12345';
  btn.repaint();
  assert.equal(btn.hidden, false, 'station id → heart shown');
  // And back to absent.
  id = '';
  btn.repaint();
  assert.equal(btn.hidden, true, 'empty id → heart hidden');
  btn.unsubscribe();
});

test('favoriteHeart: outlines on miss, fills on hit, re-paints on store change', () => {
  store.state.speaker.favorites = [];
  const btn = favoriteHeart({
    getEntry: () => ({ id: 's12345', name: 'R1' }),
    store,
  });
  assert.equal(btn.classList.contains('is-empty'), true,  'not a favourite → is-empty');
  assert.equal(btn.classList.contains('is-filled'), false);

  store.state.speaker.favorites = [{ id: 's12345', name: 'R1', art: '', note: '' }];
  store.touch('speaker');

  assert.equal(btn.classList.contains('is-filled'), true,  'after add → is-filled');
  assert.equal(btn.classList.contains('is-empty'),  false);
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  btn.unsubscribe();
});

test('favoriteHeart: click fires the POST, optimistic add lands immediately', async () => {
  store.state.speaker.favorites = [];
  const calls = [];
  const restore = installFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 's12345', name: 'R1', art: '', note: '' }] }),
    };
  });
  try {
    const btn = favoriteHeart({
      getEntry: () => ({ id: 's12345', name: 'R1' }),
      store,
    });
    btn.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    // Allow the toggle's microtask + the await to settle.
    await new Promise((r) => setTimeout(r, 5));
    const putCall = calls.find((c) => /\/favorites$/.test(c.url));
    assert.ok(putCall, 'POST /favorites issued');
    assert.equal(putCall.opts.method, 'POST');
    assert.equal(store.state.speaker.favorites.length, 1);
    assert.equal(store.state.speaker.favorites[0].id, 's12345');
    assert.equal(btn.classList.contains('is-filled'), true, 'heart paints filled after toggle');
    btn.unsubscribe();
  } finally {
    restore();
  }
});

// --- station-detail integration ------------------------------------

async function mountStation(root, sid) {
  // Seed the probe cache so the view's mount doesn't hang on
  // tuneinProbe. The heart visibility rule fires synchronously off the
  // sid, so we don't need probe to land before asserting.
  store.state.caches.probe.set(sid, {
    sid,
    verdict: { kind: 'playable', streams: [] },
    tuneinJson: {},
    expires: Date.now() + 600000,
  });
  const destroy = stationView.init(root, store, { params: { id: sid } });
  await new Promise((r) => setTimeout(r, 5));
  return destroy;
}

test('station-detail: heart mounts next to the station name on s-ids', async () => {
  store.state.speaker.favorites = [];
  const root = makeRoot();
  const destroy = await mountStation(root, 's12345');
  try {
    const heart = root.querySelector('.fav-heart');
    assert.ok(heart, 'heart present on s-id station-detail');
    assert.equal(heart.hidden, false, 'heart visible on s-id');
    // Must be inside the name row, not somewhere arbitrary.
    const nameRow = root.querySelector('.station-name-row');
    assert.ok(nameRow, 'name row wrapper present');
    let inside = false;
    for (const child of nameRow.childNodes || []) {
      if (child === heart) { inside = true; break; }
    }
    assert.equal(inside, true, 'heart is a child of the name row');
  } finally {
    destroy();
  }
});

test('station-detail: heart click toggles the favourite optimistically', async () => {
  store.state.speaker.favorites = [];
  const root = makeRoot();
  const calls = [];
  const restore = installFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (/\/favorites$/.test(String(url))) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, data: [{ id: 's12345', name: 's12345', art: '', note: '' }] }),
      };
    }
    // Anything else (tuneinStation describe etc.) — never resolves.
    return new Promise(() => {});
  });
  try {
    const destroy = await mountStation(root, 's12345');
    const heart = root.querySelector('.fav-heart');
    assert.ok(heart, 'heart mounted');
    // Click — fires the optimistic toggle.
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    // Optimistic mutation lands before the POST resolves.
    assert.equal(store.state.speaker.favorites.length, 1, 'optimistic add');
    await new Promise((r) => setTimeout(r, 5));
    const putCall = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(putCall, 'POST /favorites issued');
    destroy();
  } finally {
    restore();
  }
});

// --- favourites tab `?focus=<id>` mount handler (#129) --------------

const { default: favoritesView } = await import('../app/views/favorites.js');

test('favourites view: ?focus=<id> flashes the matching row on mount', async () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One',   art: '', note: '' },
    { id: 's2', name: 'Two',   art: '', note: '' },
    { id: 'p3', name: 'Three', art: '', note: '' },
  ];
  const root = makeRoot();
  const destroy = favoritesView.init(root, store, { query: { focus: 's2' } });
  try {
    const rows = root.querySelectorAll('.station-row--crud');
    assert.equal(rows.length, 3, 'three rows rendered');
    const target = rows.find((r) => r.dataset.favId === 's2');
    assert.ok(target, 'row for s2 present');
    assert.equal(target.classList.contains('is-focused'), true,
      'matching row gets the is-focused flash class on mount');
    // The two siblings stay un-flashed.
    for (const r of rows) {
      if (r === target) continue;
      assert.equal(r.classList.contains('is-focused'), false,
        `non-target row ${r.dataset.favId} must not flash`);
    }
  } finally {
    destroy();
  }
});

test('favourites view: ?focus with no match → nothing flashes, no throw', () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
  ];
  const root = makeRoot();
  const destroy = favoritesView.init(root, store, { query: { focus: 'sNope' } });
  try {
    const rows = root.querySelectorAll('.station-row--crud');
    for (const r of rows) {
      assert.equal(r.classList.contains('is-focused'), false,
        'no row should flash when ?focus does not match');
    }
  } finally {
    destroy();
  }
});

test('favourites view: mount without ?focus → no row flashes', () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
  ];
  const root = makeRoot();
  const destroy = favoritesView.init(root, store, {});
  try {
    const rows = root.querySelectorAll('.station-row--crud');
    for (const r of rows) {
      assert.equal(r.classList.contains('is-focused'), false,
        'mount without focus must leave rows untouched');
    }
  } finally {
    destroy();
  }
});

test('favourites view: ?focus on unfetched list applies after the list lands', () => {
  // Empty state first — the favourite to focus hasn't loaded yet.
  store.state.speaker.favorites = [];
  const root = makeRoot();
  const destroy = favoritesView.init(root, store, { query: { focus: 's42' } });
  try {
    assert.equal(root.querySelectorAll('.station-row--crud').length, 0,
      'empty state — no rows to flash yet');
    // Now the reconcile lands.
    store.update('speaker', (s) => {
      s.speaker.favorites = [
        { id: 's7',  name: 'Seven',   art: '', note: '' },
        { id: 's42', name: 'Magic',   art: '', note: '' },
      ];
    });
    const rows = root.querySelectorAll('.station-row--crud');
    assert.equal(rows.length, 2, 'rows rendered after the update');
    const target = rows.find((r) => r.dataset.favId === 's42');
    assert.ok(target, 'row for s42 present');
    assert.equal(target.classList.contains('is-focused'), true,
      'pending focus applies once the matching row lands');
  } finally {
    destroy();
  }
});

test('favourites view: ?focus applies once — re-render after flash does not re-flash', () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
  ];
  const root = makeRoot();
  const destroy = favoritesView.init(root, store, { query: { focus: 's1' } });
  try {
    const initialRow = root.querySelector('.station-row--crud');
    assert.equal(initialRow.classList.contains('is-focused'), true,
      'first paint flashes the target row');
    // Manually drop the flash class to simulate the post-timeout state,
    // then trigger another render via a benign store change.
    initialRow.classList.remove('is-focused');
    store.update('speaker', (s) => {
      s.speaker.favorites = [
        { id: 's1', name: 'One',   art: '', note: '' },
        { id: 's2', name: 'Two',   art: '', note: '' },
      ];
    });
    const rows = root.querySelectorAll('.station-row--crud');
    for (const r of rows) {
      assert.equal(r.classList.contains('is-focused'), false,
        `subsequent renders must not re-apply the flash (${r.dataset.favId})`);
    }
  } finally {
    destroy();
  }
});
