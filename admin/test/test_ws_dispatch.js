// Tests for app/ws.js dispatch() — top-level XML routing only.
// Per-field mutation tests live in test_speaker_state.js.
//
// Run locally:
//   node --test admin/test
//

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

test('<updates> envelope routes child tags to speakerDispatch without throwing', async () => {
  // sourcesUpdated is hint-only and triggers an async fetch; we just assert
  // no synchronous throw from the envelope routing.
  const xml = await fixture('sources-updated.xml');
  const store = makeStore();
  assert.doesNotThrow(() => dispatch(xml, store));
});

test('presetsUpdated envelope does not throw', async () => {
  const xml = await fixture('presets-updated.xml');
  const store = makeStore();
  assert.doesNotThrow(() => dispatch(xml, store));
});

test('nowSelectionUpdated does not throw', async () => {
  const xml = await fixture('now-selection-updated.xml');
  const store = makeStore();
  assert.doesNotThrow(() => dispatch(xml, store));
});
