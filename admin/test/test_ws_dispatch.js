// Tests for app/ws.js dispatch() — feed XML strings through the parser
// and assert state mutations on a fake store, no live speaker required.
//
// Run locally:
//   node --test admin/test
//
// See admin/PLAN.md § Testing strategy.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// @xmldom/xmldom provides a spec-compliant DOMParser without dragging
// in a full DOM. ws.js calls `new DOMParser().parseFromString(text, …)`
// and checks for `typeof DOMParser`, so we inject it into globalThis
// before importing ws.js. The onError handler is a no-op so the
// "malformed XML does not throw" test doesn't print xmldom warnings.
import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';
globalThis.DOMParser = class extends XmldomDOMParser {
  constructor() { super({ onError: () => {} }); }
};

import { dispatch } from '../app/ws.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'ws');

function makeStore(initial = {}) {
  const state = {
    ws:      { connected: false, mode: 'offline', lastEvent: null },
    speaker: { info: null, nowPlaying: null, presets: null, volume: null, sources: null },
    ...initial,
  };
  const touched = [];
  return {
    state,
    touch(key) { touched.push(key); },
    _touched: touched,
  };
}

async function fixture(name) {
  return readFile(join(FIXTURES, name), 'utf8');
}

test('hello frame sets connected=true and mode="ws"', async () => {
  const xml = await fixture('hello-soundtouchsdkinfo.xml');
  const store = makeStore();
  dispatch(xml, store);
  assert.equal(store.state.ws.connected, true);
  assert.equal(store.state.ws.mode, 'ws');
  assert.ok(store._touched.includes('ws'));
});

test('userActivityUpdate sets lastEvent and does not throw', async () => {
  const xml = await fixture('user-activity-update.xml');
  const store = makeStore();
  const before = Date.now();
  dispatch(xml, store);
  assert.ok(store.state.ws.lastEvent >= before, 'lastEvent should be a timestamp');
  assert.ok(store._touched.includes('ws'));
});

test('empty <updates> envelope does not throw', async () => {
  const xml = await fixture('updates-empty.xml');
  const store = makeStore();
  assert.doesNotThrow(() => dispatch(xml, store));
});

test('empty string input does not throw', () => {
  const store = makeStore();
  assert.doesNotThrow(() => dispatch('', store));
});

test('malformed XML does not throw', () => {
  const store = makeStore();
  assert.doesNotThrow(() => dispatch('<not valid xml', store));
});

test('sourcesUpdated hint-only event does not throw and triggers refetch (async)', async () => {
  // The hint-only <sourcesUpdated/> has no inline sources list.
  // dispatch() fires getSources() async; we just assert no synchronous throw.
  const xml = await fixture('sources-updated.xml');
  const store = makeStore();
  assert.doesNotThrow(() => dispatch(xml, store));
});
