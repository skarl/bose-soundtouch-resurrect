// Tests for app/speaker-state.js — field registry, reconcile(), dispatch().
//
// Run: node --test admin/test
//
// Fetchers in FIELDS are stubbed by temporarily replacing the fetcher
// function on each entry, so tests run without a live speaker.
// DOMParser is injected the same way test_ws_dispatch.js does.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --- DOMParser injection (same pattern as test_ws_dispatch.js) -------

import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';
globalThis.DOMParser = class extends XmldomDOMParser {
  constructor() { super({ onError: () => {} }); }
};

// Import after DOMParser is in place.
import { FIELDS, reconcile, dispatch, setVolumeConfirmFn } from '../app/speaker-state.js';

// --- Fixtures --------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WS_FIX = join(HERE, 'fixtures', 'ws');

async function wsFixture(name) { return readFile(join(WS_FIX, name), 'utf8'); }

// --- Store factory ---------------------------------------------------

function makeStore() {
  const state = {
    speaker: { info: null, nowPlaying: null, presets: null, volume: null, sources: null },
    ws: { connected: false, lastEvent: null },
    caches: {},
    ui: {},
  };
  const touched = [];
  return {
    state,
    touch(key) { touched.push(key); },
    _touched: touched,
  };
}

// --- Stubbed field values --------------------------------------------

const FAKE_INFO      = { deviceID: 'TEST', name: 'Bo', type: 'SoundTouch 10', firmwareVersion: '27' };
const FAKE_NOW_PLAY  = { source: 'TUNEIN', item: { name: 'R1', location: '/v1/s1', type: 'stationurl' }, playStatus: 'PLAY_STATE', track: '', artist: '', art: '' };
const FAKE_PRESETS   = { ok: true, data: [{ slot: 1, source: 'TUNEIN', type: 'stationurl', location: '/v1/s1', itemName: 'R1', art: '' }] };
const FAKE_VOLUME    = { targetVolume: 32, actualVolume: 32, muteEnabled: false };
const FAKE_SOURCES   = [{ source: 'TUNEIN', sourceAccount: '', status: 'READY', isLocal: false, displayName: 'TuneIn' }];

// Replace the fetcher on a FIELDS entry for the duration of a test.
function withFetchers(overrides, fn) {
  // overrides: { name: fetcherFn, ... }
  const originals = {};
  for (const entry of FIELDS) {
    if (entry.name in overrides) {
      originals[entry.name] = entry.fetcher;
      entry.fetcher = overrides[entry.name];
    }
  }
  const restore = () => {
    for (const entry of FIELDS) {
      if (entry.name in originals) entry.fetcher = originals[entry.name];
    }
  };
  // fn may be async
  const result = fn();
  if (result && typeof result.then === 'function') {
    return result.finally(restore);
  }
  restore();
  return result;
}

// All-resolved fetchers (used as a base).
const ALL_RESOLVED = {
  info:       async () => FAKE_INFO,
  nowPlaying: async () => FAKE_NOW_PLAY,
  presets:    async () => FAKE_PRESETS,
  volume:     async () => FAKE_VOLUME,
  sources:    async () => FAKE_SOURCES,
};

// --- Tests -----------------------------------------------------------

test('reconcile: all fulfilled → single store.touch("speaker")', () =>
  withFetchers(ALL_RESOLVED, async () => {
    const store = makeStore();
    await reconcile(store);

    assert.equal(store._touched.length, 1, 'touch called exactly once');
    assert.equal(store._touched[0], 'speaker');
    assert.deepEqual(store.state.speaker.info, FAKE_INFO);
    assert.deepEqual(store.state.speaker.nowPlaying, FAKE_NOW_PLAY);
    assert.ok(Array.isArray(store.state.speaker.presets), 'presets applied');
    assert.deepEqual(store.state.speaker.volume, FAKE_VOLUME);
    assert.deepEqual(store.state.speaker.sources, FAKE_SOURCES);
  }),
);

test('reconcile: partial rejection — other fields still apply, no throw', () =>
  withFetchers({
    ...ALL_RESOLVED,
    nowPlaying: async () => { throw new Error('network error'); },
    volume:     async () => { throw new Error('timeout'); },
  }, async () => {
    const store = makeStore();
    await assert.doesNotReject(() => reconcile(store));
    assert.deepEqual(store.state.speaker.info, FAKE_INFO, 'info set');
    assert.deepEqual(store.state.speaker.sources, FAKE_SOURCES, 'sources set');
    assert.equal(store.state.speaker.nowPlaying, null, 'nowPlaying stays null on rejection');
    assert.equal(store.state.speaker.volume, null, 'volume stays null on rejection');
    assert.equal(store._touched.length, 1, 'touch still called once');
  }),
);

test('reconcile: null/undefined fetcher result → field skipped', () =>
  withFetchers({
    ...ALL_RESOLVED,
    info:   async () => null,
    volume: async () => undefined,
  }, async () => {
    const store = makeStore();
    await reconcile(store);
    assert.equal(store.state.speaker.info, null, 'null result skipped');
    assert.equal(store.state.speaker.volume, null, 'undefined result skipped');
    assert.deepEqual(store.state.speaker.nowPlaying, FAKE_NOW_PLAY, 'others still applied');
    assert.equal(store._touched.length, 1, 'touch still called once');
  }),
);

test('dispatch: inline payload (volumeUpdated) → field applied, single touch', async () => {
  const xml = await wsFixture('volume-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0]; // <volumeUpdated>

  const store = makeStore();
  // dispatch is async (hint-only fallback path), but volumeUpdated has inline data.
  await dispatch(child, store);

  assert.equal(store._touched.length, 1, 'touch called exactly once');
  assert.equal(store._touched[0], 'speaker');
  const vol = store.state.speaker.volume;
  assert.ok(vol, 'volume set');
  assert.equal(vol.targetVolume, 32);
  assert.equal(vol.actualVolume, 32);
  assert.equal(vol.muteEnabled, false);
});

test('dispatch: hint-only event (presetsUpdated) → falls back to fetcher and applies', () =>
  withFetchers({ presets: async () => FAKE_PRESETS }, async () => {
    const xml = await wsFixture('presets-updated.xml');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const child = doc.documentElement.children[0]; // <presetsUpdated/>

    const store = makeStore();
    await dispatch(child, store);

    assert.ok(Array.isArray(store.state.speaker.presets), 'presets set via fetcher fallback');
    assert.equal(store.state.speaker.presets.length, 1);
    assert.equal(store._touched.length, 1, 'single touch');
  }),
);

test('dispatch: unknown tag → no-op', async () => {
  const doc = new DOMParser().parseFromString('<unknownEvent/>', 'application/xml');
  const child = doc.documentElement;
  const store = makeStore();
  await dispatch(child, store);
  assert.equal(store._touched.length, 0, 'no touch for unknown tag');
  assert.equal(store.state.speaker.volume, null, 'state unchanged');
});

test('dispatch: volumeUpdated with confirmFn registered → afterApply receives actualVolume', async () => {
  const xml = await wsFixture('volume-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0];

  let received = null;
  setVolumeConfirmFn((av) => { received = av; });

  const store = makeStore();
  await dispatch(child, store);

  assert.equal(received, 32, 'confirmFn called with actualVolume');

  setVolumeConfirmFn(null);
});

test('registry sanity: every entry with eventTag has parseInline and a fetcher', () => {
  for (const entry of FIELDS) {
    if (!entry.eventTag) continue; // info has no WS event — skip
    assert.ok(
      typeof entry.parseInline === 'function',
      `${entry.name} with eventTag must declare parseInline`,
    );
    assert.ok(
      typeof entry.fetcher === 'function',
      `${entry.name} with eventTag must have a fetcher for hint-only fallback`,
    );
  }
});
