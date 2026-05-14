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

// --- toggleFavorite optimistic round-trip ---------------------------

function installFetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('toggleFavorite: PUT success → state stays at optimistic value', async () => {
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
    assert.ok(captured, 'PUT issued');
    assert.equal(captured.opts.method, 'PUT');
    assert.match(captured.url, /\/favorites$/);
    const sent = JSON.parse(captured.opts.body);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 's12345');
    assert.equal(store.state.speaker.favorites.length, 1, 'optimistic add persists');
  } finally {
    restore();
  }
});

test('toggleFavorite: PUT structured-error → state rolls back, no leak', async () => {
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

test('toggleFavorite: PUT transport throw → state rolls back, synthetic envelope returned', async () => {
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
    assert.deepEqual(body, [], 'PUT body is the post-remove array');
    assert.deepEqual(store.state.speaker.favorites, [], 'state is empty after the remove');
  } finally {
    restore();
  }
});

test('toggleFavorite: id that doesn\'t match ^[sp]\\d+$ short-circuits without a PUT', async () => {
  store.state.speaker.favorites = [];
  let calls = 0;
  const restore = installFetchStub(async () => { calls++; return { ok: true, json: async () => ({}) }; });
  try {
    const env = await toggleFavorite(store, { id: 'g22', name: 'genre' });
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_ID');
    assert.equal(calls, 0, 'no PUT is fired for an invalid id');
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

test('favoriteHeart: click fires the PUT, optimistic add lands immediately', async () => {
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
    assert.ok(putCall, 'PUT /favorites issued');
    assert.equal(putCall.opts.method, 'PUT');
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
    // Optimistic mutation lands before the PUT resolves.
    assert.equal(store.state.speaker.favorites.length, 1, 'optimistic add');
    await new Promise((r) => setTimeout(r, 5));
    const putCall = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'PUT');
    assert.ok(putCall, 'PUT /favorites issued');
    destroy();
  } finally {
    restore();
  }
});
