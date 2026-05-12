// Tests for app/tunein-cache.js — TTL-aware sessionStorage cache.
// Runs under `node --test admin/test`.
//
// Each test instantiates its own cache via createCache({clock, storage})
// so the time source and storage backend stay test-scoped. The default
// export `cache` is also exercised once to assert it wires through to
// the global sessionStorage shim.

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

// --- mock storage (sessionStorage-compatible Map wrapper) ------------

function makeMockStorage(seed) {
  const m = new Map(seed || []);
  return {
    getItem(key)        { return m.has(key) ? m.get(key) : null; },
    setItem(key, value) { m.set(key, String(value)); },
    removeItem(key)     { m.delete(key); },
    clear()             { m.clear(); },
    // Inspection helpers for assertions — not part of the
    // sessionStorage contract but handy for tests.
    _size() { return m.size; },
    _raw(key) { return m.get(key); },
  };
}

// --- global sessionStorage shim for the default-export test ---------

const ssStore = new Map();
globalThis.sessionStorage = {
  getItem(key)        { return ssStore.has(key) ? ssStore.get(key) : null; },
  setItem(key, value) { ssStore.set(key, String(value)); },
  removeItem(key)     { ssStore.delete(key); },
  clear()             { ssStore.clear(); },
};

const {
  createCache,
  cache,
  TTL_DRILL_HEAD,
  TTL_DRILL_TAIL,
  TTL_STREAM,
  TTL_LABEL,
} = await import('../app/tunein-cache.js');

beforeEach(() => {
  ssStore.clear();
});

// --- TTL constants ---------------------------------------------------

test('TTL constants match the issue spec', () => {
  assert.equal(TTL_DRILL_HEAD, 15 * 60_000,           'TTL_DRILL_HEAD = 15 min');
  assert.equal(TTL_DRILL_TAIL, 24 * 60 * 60_000,      'TTL_DRILL_TAIL = 24 h');
  assert.equal(TTL_STREAM,     5 * 60_000,            'TTL_STREAM     = 5 min');
  assert.equal(TTL_LABEL,      24 * 60 * 60_000,      'TTL_LABEL      = 24 h');
});

// --- hit / miss ------------------------------------------------------

test('get returns undefined when the key is missing (miss)', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  assert.equal(c.get('nope'), undefined);
});

test('set then get within ttl returns the stored value (hit)', () => {
  let t = 1_000;
  const store = makeMockStorage();
  const c = createCache({ clock: () => t, storage: store });
  c.set('k', 'hello', 5_000);
  // Same instant → trivially within ttl.
  assert.equal(c.get('k'), 'hello');
  // Advance partway through the ttl window — still a hit.
  t += 4_999;
  assert.equal(c.get('k'), 'hello');
});

test('get returns objects and arrays as JSON round-trips', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  c.set('obj', { a: 1, b: ['x', 'y'] }, TTL_LABEL);
  c.set('arr', [1, 2, 3], TTL_LABEL);
  assert.deepEqual(c.get('obj'), { a: 1, b: ['x', 'y'] });
  assert.deepEqual(c.get('arr'), [1, 2, 3]);
});

// --- expiry (mocked clock) ------------------------------------------

test('get auto-expires the entry once ttl has elapsed', () => {
  let t = 0;
  const store = makeMockStorage();
  const c = createCache({ clock: () => t, storage: store });
  c.set('k', 'v', 1_000);
  t = 999;
  assert.equal(c.get('k'), 'v', 'still valid one ms before ttl');
  t = 1_001;
  assert.equal(c.get('k'), undefined, 'undefined after ttl elapsed');
});

test('expired entries are removed from the backing storage on read', () => {
  let t = 0;
  const store = makeMockStorage();
  const c = createCache({ clock: () => t, storage: store });
  c.set('k', 'v', 100);
  assert.equal(store._size(), 1, 'envelope written');
  t = 200;
  c.get('k');
  assert.equal(store._size(), 0, 'expired envelope evicted on get');
});

test('set with zero or negative ttl is a no-op (never cached)', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  c.set('k', 'v', 0);
  c.set('k', 'v', -100);
  assert.equal(c.get('k'), undefined);
  assert.equal(store._size(), 0);
});

test('set with a non-finite ttl is a no-op', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  c.set('k', 'v', NaN);
  c.set('k', 'v', Infinity);
  c.set('k', 'v', 'not-a-number');
  assert.equal(c.get('k'), undefined);
});

// --- invalidate ------------------------------------------------------

test('invalidate removes the entry immediately', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  c.set('k', 'v', TTL_LABEL);
  assert.equal(c.get('k'), 'v');
  c.invalidate('k');
  assert.equal(c.get('k'), undefined);
  assert.equal(store._size(), 0);
});

test('invalidate on a missing key does not throw', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  assert.doesNotThrow(() => c.invalidate('nope'));
});

// --- sessionStorage round-trip --------------------------------------

test('set writes a {ts, ttl, value} JSON envelope to the backing storage', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 1_234, storage: store });
  c.set('tunein.label.s12345', 'Radio Paradise', TTL_LABEL);
  const raw = store._raw('tunein.label.s12345');
  assert.ok(raw, 'envelope present in storage');
  const env = JSON.parse(raw);
  assert.equal(env.ts, 1_234);
  assert.equal(env.ttl, TTL_LABEL);
  assert.equal(env.value, 'Radio Paradise');
});

test('a corrupt envelope is dropped on read and treated as a miss', () => {
  const store = makeMockStorage();
  store.setItem('k', 'not-json');
  const c = createCache({ clock: () => 0, storage: store });
  assert.equal(c.get('k'), undefined);
  assert.equal(store._size(), 0, 'corrupt envelope evicted');
});

test('an envelope without ts/ttl is dropped on read', () => {
  const store = makeMockStorage();
  store.setItem('k', JSON.stringify({ value: 'orphan' }));
  const c = createCache({ clock: () => 0, storage: store });
  assert.equal(c.get('k'), undefined);
  assert.equal(store._size(), 0);
});

test('default-export cache uses the runtime sessionStorage', () => {
  // Default cache wires to globalThis.sessionStorage (our test shim);
  // a write should land in ssStore and survive a re-import in this test.
  cache.set('default.export', 'visible', TTL_LABEL);
  assert.equal(cache.get('default.export'), 'visible');
  // Round-trip through the raw shim confirms the storage backend.
  const raw = sessionStorage.getItem('default.export');
  assert.ok(raw, 'default cache wrote to global sessionStorage');
  const env = JSON.parse(raw);
  assert.equal(env.value, 'visible');
  assert.equal(env.ttl, TTL_LABEL);
});

test('default-export cache invalidate clears the runtime sessionStorage key', () => {
  cache.set('default.invalidate', 'x', TTL_LABEL);
  assert.equal(cache.get('default.invalidate'), 'x');
  cache.invalidate('default.invalidate');
  assert.equal(cache.get('default.invalidate'), undefined);
  assert.equal(sessionStorage.getItem('default.invalidate'), null);
});

// --- defensive: empty / non-string keys -----------------------------

test('set with empty string key is a no-op', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  c.set('', 'v', TTL_LABEL);
  assert.equal(store._size(), 0);
});

test('set with non-string key is a no-op', () => {
  const store = makeMockStorage();
  const c = createCache({ clock: () => 0, storage: store });
  c.set(null, 'v', TTL_LABEL);
  c.set(undefined, 'v', TTL_LABEL);
  c.set(123, 'v', TTL_LABEL);
  assert.equal(store._size(), 0);
});

// --- storage unavailable fails closed --------------------------------

test('cache with no storage backend silently no-ops on writes and returns undefined on reads', () => {
  const c = createCache({ clock: () => 0, storage: null });
  c.set('k', 'v', TTL_LABEL);
  assert.equal(c.get('k'), undefined);
  assert.doesNotThrow(() => c.invalidate('k'));
});

test('cache backed by a throwing storage swallows errors and fails closed', () => {
  const blowUp = {
    getItem()    { throw new Error('boom'); },
    setItem()    { throw new Error('boom'); },
    removeItem() { throw new Error('boom'); },
  };
  const c = createCache({ clock: () => 0, storage: blowUp });
  assert.doesNotThrow(() => c.set('k', 'v', TTL_LABEL));
  assert.equal(c.get('k'), undefined);
  assert.doesNotThrow(() => c.invalidate('k'));
});
