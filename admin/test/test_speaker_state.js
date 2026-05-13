// Tests for app/speaker-state.js — field registry, reconcile(), dispatch().
//
// Run: node --test admin/test
//
// Tests stub fetch by replacing the global `fetch` so xmlGet(field) sees
// canned XML bodies; the presets exception (custom fetcher) is stubbed
// by overwriting `entry.fetcher` directly. DOMParser is injected the
// same way test_ws_dispatch.js does.

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
//
// Canned XML bodies per FIELDS path. xmlGet(field) parses these via
// DOMParser → first <field.tag> → field.parseEl, so the resulting
// state shape matches what production renders for the same fixtures.
// `presets` is special-cased: it's the documented JSON exception and is
// stubbed by overriding `entry.fetcher` directly.

const FAKE_PRESETS = { ok: true, data: [{ slot: 1, source: 'TUNEIN', type: 'stationurl', location: '/v1/s1', itemName: 'R1', art: '' }] };

const XML_BODIES = {
  '/cgi-bin/api/v1/speaker/info':
    '<info deviceID="TEST"><name>Bo</name><type>SoundTouch 10</type>' +
    '<components><component><componentCategory>SCM</componentCategory>' +
    '<softwareVersion>27</softwareVersion></component></components></info>',
  '/cgi-bin/api/v1/speaker/now_playing':
    '<nowPlaying source="TUNEIN" sourceAccount="">' +
    '<ContentItem source="TUNEIN" type="stationurl" location="/v1/s1">' +
    '<itemName>R1</itemName></ContentItem>' +
    '<track></track><artist></artist><art></art><playStatus>PLAY_STATE</playStatus>' +
    '</nowPlaying>',
  '/cgi-bin/api/v1/speaker/volume':
    '<volume><targetvolume>32</targetvolume><actualvolume>32</actualvolume>' +
    '<muteenabled>false</muteenabled></volume>',
  '/cgi-bin/api/v1/speaker/sources':
    '<sources deviceID="TEST">' +
    '<sourceItem source="TUNEIN" sourceAccount="" status="READY" isLocal="false">TuneIn</sourceItem>' +
    '</sources>',
  '/cgi-bin/api/v1/speaker/bass':
    '<bass><targetbass>0</targetbass><actualbass>0</actualbass></bass>',
  '/cgi-bin/api/v1/speaker/balance':
    '<balance><targetbalance>0</targetbalance><actualbalance>0</actualbalance></balance>',
  '/cgi-bin/api/v1/speaker/DSPMonoStereo':
    '<DSPMonoStereo><mono enabled="false"/></DSPMonoStereo>',
  '/cgi-bin/api/v1/speaker/getZone': '<zone/>',
  '/cgi-bin/api/v1/speaker/bluetoothInfo':
    '<BluetoothInfo BluetoothMACAddress="0CB2B709F837"/>',
  '/cgi-bin/api/v1/speaker/networkInfo':
    '<networkInfo><interfaces>' +
    '<interface type="WIFI_INTERFACE" name="wlan0" macAddress="0CB2B709F837"' +
    ' ipAddress="192.168.178.36" ssid="WLAN-Oben" frequencyKHz="5240000"' +
    ' state="NETWORK_WIFI_CONNECTED" signal="GOOD_SIGNAL" mode="STATION"/>' +
    '</interfaces></networkInfo>',
  '/cgi-bin/api/v1/speaker/recents': '<recents/>',
  '/cgi-bin/api/v1/speaker/systemtimeout':
    '<systemtimeout><enabled>false</enabled><minutes>0</minutes></systemtimeout>',
};

// Install a global fetch stub that resolves to canned XML for known
// paths and rejects with a controllable error for paths in `errors`.
// Returns a restorer. `bodies` overrides XML_BODIES for one test.
function installFetchStub({ bodies = {}, errors = {} } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = typeof url === 'string' ? url : String(url);
    if (path in errors) throw errors[path];
    const body = (path in bodies) ? bodies[path] : XML_BODIES[path];
    if (body == null) throw new Error(`unmocked fetch: ${path}`);
    return {
      ok: true,
      status: 200,
      text: async () => body,
    };
  };
  return () => { globalThis.fetch = original; };
}

// Override `entry.fetcher` (presets exception) for the duration of fn.
function withFetcher(name, fetcher, fn) {
  const entry = FIELDS.find((f) => f.name === name);
  const original = entry.fetcher;
  entry.fetcher = fetcher;
  const restore = () => { entry.fetcher = original; };
  const result = fn();
  if (result && typeof result.then === 'function') {
    return result.finally(restore);
  }
  restore();
  return result;
}

// Run fn with a fetch stub installed + the presets fetcher overridden.
function withStubs({ bodies = {}, errors = {}, presets = async () => FAKE_PRESETS } = {}, fn) {
  const restoreFetch   = installFetchStub({ bodies, errors });
  const entry          = FIELDS.find((f) => f.name === 'presets');
  const originalPreset = entry.fetcher;
  entry.fetcher = presets;
  const restore = () => {
    entry.fetcher = originalPreset;
    restoreFetch();
  };
  const result = fn();
  if (result && typeof result.then === 'function') {
    return result.finally(restore);
  }
  restore();
  return result;
}

// --- Tests -----------------------------------------------------------

test('reconcile: all fulfilled → single store.touch("speaker")', () =>
  withStubs({}, async () => {
    const store = makeStore();
    await reconcile(store);

    assert.equal(store._touched.length, 1, 'touch called exactly once');
    assert.equal(store._touched[0], 'speaker');
    assert.ok(store.state.speaker.info, 'info set');
    assert.equal(store.state.speaker.info.deviceID, 'TEST');
    assert.ok(store.state.speaker.nowPlaying, 'nowPlaying set');
    assert.equal(store.state.speaker.nowPlaying.source, 'TUNEIN');
    assert.ok(Array.isArray(store.state.speaker.presets), 'presets applied');
    assert.ok(store.state.speaker.volume, 'volume set');
    assert.equal(store.state.speaker.volume.targetVolume, 32);
    assert.ok(Array.isArray(store.state.speaker.sources), 'sources set');
    assert.ok(store.state.speaker.network, 'network set');
    assert.equal(store.state.speaker.network.ssid, 'WLAN-Oben');
    assert.ok(store.state.speaker.bluetooth, 'bluetooth set');
    assert.equal(store.state.speaker.bluetooth.macAddress, '0CB2B709F837');
  }),
);

test('network: registry entry wires connectionStateUpdated as a hint-only event', () => {
  const entry = FIELDS.find((f) => f.name === 'network');
  assert.ok(entry, 'network entry exists in FIELDS');
  assert.equal(typeof entry.path, 'string', 'network has a REST path');
  assert.equal(typeof entry.tag, 'string', 'network has a response tag');
  assert.equal(typeof entry.parseEl, 'function', 'network has a parseEl');
  // #94: the Wi-Fi flap event carries no inline payload, so dispatch
  // falls through to xmlGet via the row's path/tag/parseEl.
  assert.equal(entry.eventTag, 'connectionStateUpdated');
});

test('reconcile: network fetcher rejection leaves speaker.network=null, others still apply', () =>
  withStubs({
    errors: { '/cgi-bin/api/v1/speaker/networkInfo': new Error('network unreachable') },
  }, async () => {
    const store = makeStore();
    await assert.doesNotReject(() => reconcile(store));
    assert.equal(store.state.speaker.network, null, 'network stays null on rejection');
    assert.ok(store.state.speaker.info, 'other fields still applied');
    assert.equal(store._touched.length, 1, 'single touch');
  }),
);

test('reconcile: partial rejection — other fields still apply, no throw', () =>
  withStubs({
    errors: {
      '/cgi-bin/api/v1/speaker/now_playing': new Error('network error'),
      '/cgi-bin/api/v1/speaker/volume':      new Error('timeout'),
    },
  }, async () => {
    const store = makeStore();
    await assert.doesNotReject(() => reconcile(store));
    assert.ok(store.state.speaker.info, 'info set');
    assert.ok(Array.isArray(store.state.speaker.sources), 'sources set');
    assert.equal(store.state.speaker.nowPlaying, null, 'nowPlaying stays null on rejection');
    assert.equal(store.state.speaker.volume, null, 'volume stays null on rejection');
    assert.equal(store._touched.length, 1, 'touch still called once');
  }),
);

test('reconcile: null/undefined fetcher result → field skipped', () =>
  withStubs({
    // <info/> with no inner children: parseInfoEl still returns an object,
    // so we need a path that resolves to a body with no <info> root tag.
    bodies: {
      '/cgi-bin/api/v1/speaker/info':   '<other/>',
      '/cgi-bin/api/v1/speaker/volume': '<other/>',
    },
  }, async () => {
    const store = makeStore();
    await reconcile(store);
    assert.equal(store.state.speaker.info, null, 'no <info> tag → null skipped');
    assert.equal(store.state.speaker.volume, null, 'no <volume> tag → null skipped');
    assert.ok(store.state.speaker.nowPlaying, 'others still applied');
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
  withFetcher('presets', async () => FAKE_PRESETS, async () => {
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

test('dispatch: <connectionStateUpdated/> → network refetched via xmlGet (#94)', () =>
  withStubs({}, async () => {
    // The firmware emits this on every Wi-Fi link transition. The
    // envelope has no inline <networkInfo> child, so parseInline
    // returns null and dispatch falls through to xmlGet via the
    // network row's path/tag/parseEl. Without this wiring the
    // Settings → Network panel held stale SSID / IP / signal until a
    // WS reconnect happened to refetch on its own.
    const doc = new DOMParser().parseFromString('<connectionStateUpdated/>', 'application/xml');
    const child = doc.documentElement;

    const store = makeStore();
    await dispatch(child, store);

    assert.ok(store.state.speaker.network, 'network refetched from event');
    assert.equal(store.state.speaker.network.ssid, 'WLAN-Oben');
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
  withStubs({}, async () => {
    const store = makeStore();
    await reconcile(store);
    assert.ok(store.state.speaker.bluetooth);
    assert.equal(store.state.speaker.bluetooth.macAddress, '0CB2B709F837');
  }),
);

test('reconcile: bluetooth fetcher rejection — bluetooth stays null, others apply', () =>
  withStubs({
    errors: { '/cgi-bin/api/v1/speaker/bluetoothInfo': new Error('network error') },
  }, async () => {
    const store = makeStore();
    await assert.doesNotReject(() => reconcile(store));
    assert.equal(store.state.speaker.bluetooth, null, 'bluetooth stays null');
    assert.ok(store.state.speaker.info);
  }),
);

test('registry: bluetooth field exists with path/tag/parseEl and no eventTag (fetch-only)', () => {
  const bt = FIELDS.find((f) => f.name === 'bluetooth');
  assert.ok(bt, 'bluetooth entry present');
  assert.equal(typeof bt.path, 'string', 'bluetooth has a path');
  assert.equal(typeof bt.parseEl, 'function', 'bluetooth has a parseEl');
  assert.equal(bt.eventTag, undefined, 'bluetooth is fetch-only — no WS event');
});

test('registry sanity: every XML row carries {path, tag, parseEl}; exception rows declare a fetcher', () => {
  for (const entry of FIELDS) {
    const isXmlRow =
      typeof entry.path === 'string' &&
      typeof entry.tag === 'string' &&
      typeof entry.parseEl === 'function';
    if (!isXmlRow) {
      // Documented exception: must have a custom fetcher.
      assert.equal(
        typeof entry.fetcher, 'function',
        `${entry.name} is not an XML row, so it must declare a custom fetcher`,
      );
    }
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

test('registry: recents field has path + tag + parseEl + eventTag', () => {
  const entry = FIELDS.find((f) => f.name === 'recents');
  assert.ok(entry, 'recents entry exists in FIELDS');
  assert.equal(typeof entry.path, 'string');
  assert.equal(entry.tag, 'recents');
  assert.equal(typeof entry.parseEl, 'function');
  assert.equal(entry.eventTag, 'recentsUpdated');
});

// --- zone WS dispatch ----------------------------------------------

test('dispatch: inline payload (zoneUpdated) → field applied, single touch', async () => {
  const xml = await wsFixture('zone-updated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const child = doc.documentElement.children[0]; // <zoneUpdated>

  const store = makeStore();
  await dispatch(child, store);

  assert.equal(store._touched.length, 1, 'touch called exactly once');
  assert.equal(store._touched[0], 'speaker');
  const zone = store.state.speaker.zone;
  assert.ok(zone, 'zone is set');
  assert.equal(zone.master, '3415139ABD77');
  assert.equal(zone.isMaster, true);
  assert.equal(zone.members.length, 1);
  assert.equal(zone.members[0].deviceID, '689E19D55555');
});

test('registry: zone field has path + tag + parseEl + eventTag', () => {
  const entry = FIELDS.find((f) => f.name === 'zone');
  assert.ok(entry, 'zone entry exists in FIELDS');
  assert.equal(typeof entry.path, 'string');
  assert.equal(entry.tag, 'zone');
  assert.equal(typeof entry.parseEl, 'function');
  assert.equal(entry.eventTag, 'zoneUpdated');
});
