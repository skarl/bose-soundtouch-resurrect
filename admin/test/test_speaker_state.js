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
import { FIELDS, reconcile, dispatch } from '../app/speaker-state.js';
import * as actions from '../app/actions/index.js';

// --- Fixtures --------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WS_FIX = join(HERE, 'fixtures', 'ws');

async function wsFixture(name) { return readFile(join(WS_FIX, name), 'utf8'); }

// --- Store factory ---------------------------------------------------

function makeStore() {
  const state = {
    speaker: {
      info: null, nowPlaying: null, presets: null, volume: null, sources: null,
      network: null, bluetooth: null,
      bass: null, balance: null, dspMonoStereo: null,
    },
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
const FAKE_NETWORK   = { macAddress: '0CB2B709F837', ipAddress: '192.168.178.36', ssid: 'WLAN-Oben', signal: 'GOOD_SIGNAL', frequencyKHz: 5240000, name: 'wlan0', type: 'WIFI_INTERFACE', state: 'NETWORK_WIFI_CONNECTED', mode: 'STATION' };
const FAKE_BLUETOOTH = { paired: [{ name: 'Phone', mac: 'AA:BB:CC:DD:EE:FF' }] };

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
  network:    async () => FAKE_NETWORK,
  bluetooth:  async () => FAKE_BLUETOOTH,
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
    assert.deepEqual(store.state.speaker.network, FAKE_NETWORK);
    assert.deepEqual(store.state.speaker.bluetooth, FAKE_BLUETOOTH);
  }),
);

test('network: registry entry is fetch-only (no eventTag) and the fetcher applies via reconcile', () => {
  const entry = FIELDS.find((f) => f.name === 'network');
  assert.ok(entry, 'network entry exists in FIELDS');
  assert.equal(typeof entry.fetcher, 'function', 'network has a real fetcher');
  assert.equal(entry.eventTag, undefined, 'no WS eventTag — connectionStateUpdated is wired separately');
  assert.equal(entry.parseInline, undefined, 'no inline parser without an eventTag');
});

test('reconcile: network fetcher rejection leaves speaker.network=null, others still apply', () =>
  withFetchers({
    ...ALL_RESOLVED,
    network: async () => { throw new Error('network unreachable'); },
  }, async () => {
    const store = makeStore();
    await assert.doesNotReject(() => reconcile(store));
    assert.equal(store.state.speaker.network, null, 'network stays null on rejection');
    assert.deepEqual(store.state.speaker.info, FAKE_INFO, 'other fields still applied');
    assert.equal(store._touched.length, 1, 'single touch');
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

test('dispatch: volumeUpdated → afterApply confirms actions slider with actualVolume', async () => {
  const xml = await wsFixture('volume-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0];

  const store = makeStore();
  await dispatch(child, store);

  // confirm(32) was forwarded to the volume slider — a follow-up
  // setVolume(32) is then a no-op (no POST queued, hasPending stays false).
  // setVolume reads/writes the singleton store from state.js, so seed it there.
  const { store: realStore } = await import('../app/state.js');
  realStore.state.speaker.volume = { targetVolume: 32, actualVolume: 32, muteEnabled: false };
  actions.setVolume(32);
  assert.equal(actions.hasPending('volume'), false,
    'confirm(32) gates a set(32) — no in-flight POST');
});

test('reconcile: bluetooth fetcher result is applied to state.speaker.bluetooth', () =>
  withFetchers({ ...ALL_RESOLVED, bluetooth: async () => FAKE_BLUETOOTH }, async () => {
    const store = makeStore();
    await reconcile(store);
    assert.deepEqual(store.state.speaker.bluetooth, FAKE_BLUETOOTH);
  }),
);

test('reconcile: bluetooth fetcher rejection — bluetooth stays null, others apply', () =>
  withFetchers({
    ...ALL_RESOLVED,
    bluetooth: async () => { throw new Error('network error'); },
  }, async () => {
    const store = makeStore();
    await assert.doesNotReject(() => reconcile(store));
    assert.equal(store.state.speaker.bluetooth, null, 'bluetooth stays null');
    assert.deepEqual(store.state.speaker.info, FAKE_INFO);
  }),
);

test('registry: bluetooth field exists with a fetcher and no eventTag (fetch-only)', () => {
  const bt = FIELDS.find((f) => f.name === 'bluetooth');
  assert.ok(bt, 'bluetooth entry present');
  assert.equal(typeof bt.fetcher, 'function', 'bluetooth has a fetcher');
  assert.equal(bt.eventTag, undefined, 'bluetooth is fetch-only — no WS event');
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

// --- bass / balance WS dispatch -------------------------------------

test('dispatch: inline payload (bassUpdated) → field applied, single touch', async () => {
  const xml = await wsFixture('bass-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0]; // <bassUpdated>

  const store = makeStore();
  await dispatch(child, store);

  assert.equal(store._touched.length, 1, 'touch called exactly once');
  assert.equal(store._touched[0], 'speaker');
  const bass = store.state.speaker.bass;
  assert.ok(bass, 'bass set');
  assert.equal(bass.targetBass, -3);
  assert.equal(bass.actualBass, -3);
});

test('dispatch: bassUpdated → afterApply confirms bass slider with actualBass', async () => {
  const xml = await wsFixture('bass-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0];

  const store = makeStore();
  await dispatch(child, store);

  // confirm(-3) was forwarded — a follow-up setBass(-3) is then a no-op.
  const { store: realStore } = await import('../app/state.js');
  realStore.state.speaker.bass = { targetBass: -3, actualBass: -3 };
  actions.setBass(-3);
  assert.equal(actions.hasPending('bass'), false,
    'confirm(-3) gates a setBass(-3) — no in-flight POST');
});

test('dispatch: inline payload (balanceUpdated) → field applied, single touch', async () => {
  const xml = await wsFixture('balance-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0]; // <balanceUpdated>

  const store = makeStore();
  await dispatch(child, store);

  assert.equal(store._touched.length, 1, 'touch called exactly once');
  assert.equal(store._touched[0], 'speaker');
  const balance = store.state.speaker.balance;
  assert.ok(balance, 'balance set');
  assert.equal(balance.targetBalance, 2);
  assert.equal(balance.actualBalance, 2);
});

test('dispatch: balanceUpdated → afterApply confirms balance slider with actualBalance', async () => {
  const xml = await wsFixture('balance-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0];

  const store = makeStore();
  await dispatch(child, store);

  const { store: realStore } = await import('../app/state.js');
  realStore.state.speaker.balance = { targetBalance: 2, actualBalance: 2 };
  actions.setBalance(2);
  assert.equal(actions.hasPending('balance'), false,
    'confirm(2) gates a setBalance(2) — no in-flight POST');
});

// --- recents WS dispatch --------------------------------------------

test('dispatch: inline payload (recentsUpdated) → field applied, single touch', async () => {
  const xml = await wsFixture('recents-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0]; // <recentsUpdated>

  const store = makeStore();
  await dispatch(child, store);

  assert.equal(store._touched.length, 1, 'touch called exactly once');
  assert.equal(store._touched[0], 'speaker');
  const recents = store.state.speaker.recents;
  assert.ok(Array.isArray(recents), 'recents is an array');
  assert.equal(recents.length, 2);
  assert.equal(recents[0].source, 'TUNEIN');
  assert.equal(recents[1].itemName, '95.5 Charivari');
});

test('registry: recents field has fetcher + eventTag + parseInline', () => {
  const entry = FIELDS.find((f) => f.name === 'recents');
  assert.ok(entry, 'recents entry exists in FIELDS');
  assert.equal(typeof entry.fetcher, 'function');
  assert.equal(entry.eventTag, 'recentsUpdated');
  assert.equal(typeof entry.parseInline, 'function');
});
