// Tests for app/row-internals.js — the shared row helpers hoisted out
// of components.js + show-hero.js (issue #137). Coverage focuses on
// buildFavoriteHeart's eligibility gate and the default-getEntry
// fallback shape; the cosmetic helpers (separator dot, genre chip,
// browseUrlToHash) are exercised end-to-end by the existing browse +
// favourites suites that consume them through stationRow / showHero.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import './fixtures/dom-shim.js';

const { store } = await import('../app/state.js');
const { buildFavoriteHeart } = await import('../app/row-internals.js');

beforeEach(() => {
  store.state.speaker.favorites = [];
});

test('buildFavoriteHeart: returns null when sid fails isFavoriteId', () => {
  // t-prefix (topic) is not in the `^[sp]\d+$` favouritable grammar.
  assert.equal(
    buildFavoriteHeart({ sid: 't12345', name: 'Topic', favorite: { store } }),
    null,
    't-prefix is not favouritable',
  );
  // m-prefix (artist) — also out of grammar.
  assert.equal(
    buildFavoriteHeart({ sid: 'm99', favorite: { store } }),
    null,
    'm-prefix is not favouritable',
  );
  // Non-string sid.
  assert.equal(
    buildFavoriteHeart({ sid: undefined, favorite: { store } }),
    null,
    'undefined sid is not favouritable',
  );
});

test('buildFavoriteHeart: returns null when no favorite handle is wired', () => {
  assert.equal(
    buildFavoriteHeart({ sid: 's12345', name: 'KEXP' }),
    null,
    'eligible sid + no favorite handle → null (caller falls back to chevron)',
  );
  assert.equal(
    buildFavoriteHeart({ sid: 's12345', name: 'KEXP', favorite: {} }),
    null,
    'favorite handle without store → null',
  );
});

test('buildFavoriteHeart: returns a heart node when sid + store are eligible', () => {
  const heart = buildFavoriteHeart({
    sid: 's12345', name: 'KEXP', art: 'http://example/kexp.png',
    favorite: { store },
  });
  assert.ok(heart, 'heart node returned');
  assert.equal((heart.getAttribute('class') || '').includes('fav-heart'), true,
    'heart has the fav-heart class');
  assert.equal(heart.hidden, false, 'heart visible on a favouritable id');
});

test('buildFavoriteHeart: default getEntry yields {id, name||sid, art||"", note:""}', async () => {
  // Stub fetch so the heart's click handler can complete its toggle
  // and we can read back the entry shape that was POSTed.
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 's12345', name: 'KEXP', art: 'http://example/kexp.png', note: '' }] }),
    };
  };
  try {
    const heart = buildFavoriteHeart({
      sid: 's12345', name: 'KEXP', art: 'http://example/kexp.png',
      favorite: { store },
    });
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 5));
    const post = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(post, 'POST /favorites issued');
    const body = JSON.parse(post.opts.body);
    assert.deepEqual(body[0], {
      id: 's12345', name: 'KEXP', art: 'http://example/kexp.png', note: '',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildFavoriteHeart: default getEntry falls back to sid when name is missing', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 's999', name: 's999', art: '', note: '' }] }),
    };
  };
  try {
    // No name, no art — defaults should fill in.
    const heart = buildFavoriteHeart({ sid: 's999', favorite: { store } });
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 5));
    const post = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(post, 'POST /favorites issued');
    const body = JSON.parse(post.opts.body);
    assert.deepEqual(body[0], {
      id: 's999', name: 's999', art: '', note: '',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildFavoriteHeart: explicit getEntry override wins over the defaults', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 's12345', name: 'Live Title', art: 'http://example/live.png', note: 'live note' }] }),
    };
  };
  try {
    const heart = buildFavoriteHeart({
      sid: 's12345', name: 'Static Name', art: 'http://example/static.png',
      favorite: {
        store,
        getEntry: () => ({
          id: 's12345',
          name: 'Live Title',
          art: 'http://example/live.png',
          note: 'live note',
        }),
      },
    });
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 5));
    const post = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(post, 'POST /favorites issued');
    const body = JSON.parse(post.opts.body);
    assert.deepEqual(body[0], {
      id: 's12345', name: 'Live Title', art: 'http://example/live.png', note: 'live note',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
