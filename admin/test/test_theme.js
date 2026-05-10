// Tests for app/theme.js — palette cycle order, legacy localStorage
// migration, and auto-resolution against the OS prefers-color-scheme.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Stub the browser environment before importing theme.js. The module
// runs a synchronous "apply on first import" block that touches
// `document` and `localStorage`; those need to exist (or be absent in a
// well-defined way) before the import resolves.

const storage = (() => {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
    _dump: () => ({ ...store }),
  };
})();

let mqMatches = false;
const mqListeners = new Set();
const matchMedia = (q) => ({
  media: q,
  matches: mqMatches,
  addEventListener: (_t, fn) => mqListeners.add(fn),
  removeEventListener: (_t, fn) => mqListeners.delete(fn),
  addListener: (fn) => mqListeners.add(fn),
  removeListener: (fn) => mqListeners.delete(fn),
});

globalThis.localStorage = storage;
globalThis.document = { documentElement: { dataset: {} } };
globalThis.window = { matchMedia };

const theme = await import('../app/theme.js');
const { CYCLE, LEGACY_MIGRATION, STORAGE_KEY } = theme._internals;

function reset(rawPref, osDark = false) {
  storage.clear();
  if (rawPref != null) storage.setItem(STORAGE_KEY, rawPref);
  mqMatches = osDark;
  mqListeners.clear();
  globalThis.document.documentElement.dataset = {};
}

// --- cycle order ----------------------------------------------------

test('cycle is auto → graphite → cream → terminal → auto', () => {
  assert.deepEqual(CYCLE, ['auto', 'graphite', 'cream', 'terminal']);
});

test('toggle walks the 4-way cycle and wraps to auto', () => {
  reset(null, false);
  theme.init();
  assert.equal(theme.current().preference, 'auto');

  theme.toggle();
  assert.equal(theme.current().preference, 'graphite');

  theme.toggle();
  assert.equal(theme.current().preference, 'cream');

  theme.toggle();
  assert.equal(theme.current().preference, 'terminal');

  theme.toggle();
  assert.equal(theme.current().preference, 'auto');
});

test('toggle persists each step to localStorage', () => {
  reset(null, false);
  theme.init();
  theme.toggle();
  assert.equal(storage.getItem(STORAGE_KEY), 'graphite');
  theme.toggle();
  assert.equal(storage.getItem(STORAGE_KEY), 'cream');
  theme.toggle();
  assert.equal(storage.getItem(STORAGE_KEY), 'terminal');
});

// --- legacy migration ----------------------------------------------

test('migration table maps light → graphite, dark → terminal', () => {
  assert.equal(LEGACY_MIGRATION.light, 'graphite');
  assert.equal(LEGACY_MIGRATION.dark,  'terminal');
});

test('init() rewrites legacy "light" to "graphite" in storage', () => {
  reset('light', false);
  theme.init();
  assert.equal(theme.current().preference, 'graphite');
  assert.equal(storage.getItem(STORAGE_KEY), 'graphite');
});

test('init() rewrites legacy "dark" to "terminal" in storage', () => {
  reset('dark', true);
  theme.init();
  assert.equal(theme.current().preference, 'terminal');
  assert.equal(storage.getItem(STORAGE_KEY), 'terminal');
});

test('init() leaves a valid value alone', () => {
  reset('cream', false);
  theme.init();
  assert.equal(theme.current().preference, 'cream');
  assert.equal(storage.getItem(STORAGE_KEY), 'cream');
});

test('init() falls back to auto on garbage value', () => {
  reset('not-a-real-theme', false);
  theme.init();
  assert.equal(theme.current().preference, 'auto');
});

test('migrateStoredPref returns auto for null', () => {
  assert.equal(theme.migrateStoredPref(null), 'auto');
});

// --- auto resolution ------------------------------------------------

test('auto resolves to graphite when OS prefers light', () => {
  reset(null, false);
  theme.init();
  assert.equal(theme.current().resolved, 'graphite');
  assert.equal(globalThis.document.documentElement.dataset.theme, 'graphite');
});

test('auto resolves to terminal when OS prefers dark', () => {
  reset(null, true);
  theme.init();
  assert.equal(theme.current().resolved, 'terminal');
  assert.equal(globalThis.document.documentElement.dataset.theme, 'terminal');
});

test('explicit graphite resolves to graphite even when OS is dark', () => {
  reset('graphite', true);
  theme.init();
  assert.equal(theme.current().resolved, 'graphite');
});

test('cream is never the resolved value of auto', () => {
  reset(null, false);
  theme.init();
  assert.notEqual(theme.current().resolved, 'cream');
  reset(null, true);
  theme.init();
  assert.notEqual(theme.current().resolved, 'cream');
});

test('cream is reachable as an explicit pref', () => {
  reset('cream', true);
  theme.init();
  assert.equal(theme.current().resolved, 'cream');
});

test('resolve() of explicit values is identity for valid palettes', () => {
  assert.equal(theme.resolve('graphite'), 'graphite');
  assert.equal(theme.resolve('cream'),    'cream');
  assert.equal(theme.resolve('terminal'), 'terminal');
});

test('OS theme flip propagates while pref is auto', () => {
  reset(null, false);
  theme.init();
  assert.equal(theme.current().resolved, 'graphite');

  for (const fn of mqListeners) fn({ matches: true });
  assert.equal(globalThis.document.documentElement.dataset.theme, 'terminal');

  for (const fn of mqListeners) fn({ matches: false });
  assert.equal(globalThis.document.documentElement.dataset.theme, 'graphite');
});

test('OS theme flip is ignored when pref is explicit', () => {
  reset('cream', false);
  theme.init();
  assert.equal(mqListeners.size, 0);
});
