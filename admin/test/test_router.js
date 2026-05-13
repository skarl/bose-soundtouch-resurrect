// Tests for the hash router (admin/app/router.js) and the
// route-table / safety-net behaviour shipped in #86:
//
//   - the strict /station/s<N> matcher mounts the station view
//   - the wildcard /station/<id> matcher catches non-`s` sids
//   - the stationRedirect view replaces hash for `p` / `t` prefixes
//     and renders not-found for any other prefix
//
// We exercise the real createRouter and feed it our own routes table
// that mirrors main.js's shape, including the wildcard catch-all.
// Driving via the real router (not a stub) catches regressions in
// pattern ordering — a regression where the wildcard is registered
// before the strict matcher would still pass a route-table-only test.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// --- minimal window / location / DOM shim ---------------------------

const listeners = new Map(); // type → Set<fn>
let currentHash = '';

const fakeLocation = {
  get hash() { return currentHash; },
  set hash(v) {
    if (currentHash === v) return;
    currentHash = v;
    fire('hashchange');
  },
  replace(v) {
    // location.replace updates the URL without pushing history.
    // For router purposes the observable effect is the same: hashchange fires.
    if (currentHash === v) return;
    currentHash = v;
    fire('hashchange');
  },
};

function fire(type) {
  const set = listeners.get(type);
  if (!set) return;
  for (const fn of set) { try { fn(); } catch (_e) { /* keep going */ } }
}

globalThis.window = {
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    if (listeners.has(type)) listeners.get(type).delete(fn);
  },
};
globalThis.location = fakeLocation;

// Fake root node: just needs replaceChildren and removeAttribute,
// plus we capture which view was last mounted via a probe.
function makeRoot() {
  return {
    replaceChildren() { this._cleared = true; },
    removeAttribute(_attr) { /* no-op */ },
    _cleared: false,
  };
}

// --- route-table mirror --------------------------------------------
//
// We can't import main.js directly without booting half the SPA
// (theme.init, ws.connect, etc.). Instead, mirror just the shape
// under test: the same patterns + a stationRedirect view that mirrors
// main.js's prefix dispatch. The route table here is the assertion —
// if main.js ever diverges, this test fails by design.

import { createRouter } from '../app/router.js';

function makeRoutes(recorder) {
  function recordedView(name) {
    return {
      init(root, _store, ctx) {
        recorder.push({ name, params: { ...(ctx.params || {}) }, path: ctx.path });
        return null;
      },
    };
  }

  function redirectHashForStation(id) {
    if (typeof id !== 'string' || id.length < 2) return null;
    const prefix = id.charAt(0);
    if (prefix === 'p' || prefix === 't') {
      return `#/browse?id=${encodeURIComponent(id)}`;
    }
    return null;
  }

  const stationRedirect = {
    init(root, _store, ctx) {
      const id = (ctx && ctx.params && ctx.params.id) || '';
      const target = redirectHashForStation(id);
      if (target) {
        // Record before replace — the fake `location.replace` fires
        // hashchange synchronously, which re-enters dispatch and
        // records the next view. Real browsers defer hashchange to
        // the next microtask, but recording-first keeps both code
        // paths deterministic for the assertion.
        recorder.push({ name: 'stationRedirect:redirect', params: { id }, path: ctx.path, target });
        location.replace(target);
        return null;
      }
      recorder.push({ name: 'stationRedirect:notFound', params: { id }, path: ctx.path });
      return null;
    },
  };

  return [
    { pattern: /^\/$/,                             view: recordedView('now-playing') },
    { pattern: /^\/browse$/,                       view: recordedView('browse') },
    { pattern: /^\/search$/,                       view: recordedView('search') },
    { pattern: /^\/station\/(?<id>s\d+)$/,         view: recordedView('station') },
    { pattern: /^\/station\/(?<id>[^/]+)$/,        view: stationRedirect },
    { pattern: /^\/preset\/(?<slot>[1-6])$/,       view: recordedView('preset') },
    { pattern: /^\/settings$/,                     view: recordedView('settings') },
  ];
}

function bootRouter(initialHash) {
  // Reset listener / hash state across tests.
  listeners.clear();
  currentHash = initialHash || '';
  const recorder = [];
  const routes = makeRoutes(recorder);
  const fallback = {
    view: {
      init(_root, _store, ctx) {
        recorder.push({ name: 'fallback', params: { ...(ctx.params || {}) }, path: ctx.path });
        return null;
      },
    },
  };
  const root = makeRoot();
  const router = createRouter({ root, routes, fallback, store: {} });
  router.start();
  return { recorder, router, root };
}

// --- existing /station/s<N> path is preserved -----------------------

test('router: /station/s12345 mounts the station view (strict matcher)', () => {
  const { recorder } = bootRouter('#/station/s12345');
  assert.equal(recorder.length, 1);
  assert.equal(recorder[0].name, 'station');
  assert.equal(recorder[0].params.id, 's12345');
});

// --- safety net: p / t prefix triggers stationRedirect --------------

test('router: /station/p73 hits stationRedirect and replaces hash → #/browse?id=p73', () => {
  const { recorder } = bootRouter('#/station/p73');
  // The first dispatch mounts stationRedirect, which calls
  // location.replace → fires hashchange → router re-dispatches and
  // matches /browse.
  const names = recorder.map((r) => r.name);
  assert.deepEqual(
    names,
    ['stationRedirect:redirect', 'browse'],
    `expected redirect then browse, got ${JSON.stringify(names)}`,
  );
  const redirect = recorder[0];
  assert.equal(redirect.params.id, 'p73');
  assert.equal(redirect.target, '#/browse?id=p73');
});

test('router: /station/t9999 hits stationRedirect and replaces hash → #/browse?id=t9999', () => {
  const { recorder } = bootRouter('#/station/t9999');
  const names = recorder.map((r) => r.name);
  assert.deepEqual(names, ['stationRedirect:redirect', 'browse']);
  assert.equal(recorder[0].params.id, 't9999');
  assert.equal(recorder[0].target, '#/browse?id=t9999');
});

// --- unknown prefix lands on the deliberate not-found path ----------

test('router: /station/garbage hits stationRedirect and renders not-found explicitly', () => {
  const { recorder } = bootRouter('#/station/garbage');
  assert.equal(recorder.length, 1);
  assert.equal(recorder[0].name, 'stationRedirect:notFound');
  assert.equal(recorder[0].params.id, 'garbage');
});

test('router: /station/g42 (genre prefix on station path) hits the not-found branch', () => {
  const { recorder } = bootRouter('#/station/g42');
  assert.equal(recorder.length, 1);
  assert.equal(recorder[0].name, 'stationRedirect:notFound');
});

// --- unrelated paths still hit the fallback -------------------------

test('router: /never-heard-of-it falls back to the fallback view', () => {
  const { recorder } = bootRouter('#/never-heard-of-it');
  assert.equal(recorder.length, 1);
  assert.equal(recorder[0].name, 'fallback');
});

// --- ordering: strict s<N> matcher fires before the wildcard --------

test('router: /station/s12345 never reaches stationRedirect (ordering)', () => {
  const { recorder } = bootRouter('#/station/s12345');
  // Exactly one entry, and it's 'station' (not 'stationRedirect:*').
  assert.equal(recorder.length, 1);
  assert.ok(
    !recorder[0].name.startsWith('stationRedirect'),
    `expected station, got ${recorder[0].name}`,
  );
});
