// Per-field contract tests.
//
// For every FIELDS row with {path, tag, parseEl}, drive a fixture XML
// body through xmlGet -> parseEl -> applyEntry via reconcileField, then
// assert the resulting state.speaker[name] shape. The custom-fetcher row
// (presets) is exercised separately: stub the row's fetcher with a
// fixture JSON envelope and assert the apply() side-effect.
//
// The point of going through reconcileField (not parseEl in isolation) is
// to lock in the end-to-end seam every speaker field crosses: a single
// REST round-trip, a single applyEntry call, a single store.touch.
// test_speaker_xml.js already covers parseEl-in-isolation; this file
// covers the FIELDS-registry contract for the dispatch/reconcile path.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DOMParser as XmldomDOMParser } from '@xmldom/xmldom';
globalThis.DOMParser = class extends XmldomDOMParser {
  constructor() { super({ onError: () => {} }); }
};

import { FIELDS, reconcileField } from '../app/speaker-state.js';

const HERE     = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'api');

async function fixture(name) {
  return readFile(join(FIXTURES, name), 'utf8');
}

// One representative fixture per FIELDS row. The XML body must wrap the
// row's `tag` so xmlGet's first-descendant lookup resolves cleanly.
const FIXTURE_FOR_FIELD = {
  info:          'info.xml',
  nowPlaying:    'now-playing-tunein.xml',
  volume:        'volume.xml',
  sources:       'sources.xml',
  bass:          'bass.xml',
  balance:       'balance.xml',
  dspMonoStereo: 'dsp-mono-stereo.xml',
  zone:          'zone-master.xml',
  bluetooth:     'bluetooth-info-empty.xml',
  network:       'network-info.xml',
  recents:       'recents.xml',
  systemTimeout: 'systemtimeout.xml',
};

// Per-row contract: minimal assertions on the applied state shape.
// Each entry returns nothing — assertion throws on failure.
const CONTRACT_FOR_FIELD = {
  info(state) {
    const v = state.speaker.info;
    assert.ok(v, 'info applied');
    assert.equal(typeof v.deviceID, 'string');
    assert.equal(typeof v.name, 'string');
    assert.equal(typeof v.type, 'string');
    assert.equal(typeof v.firmwareVersion, 'string');
  },
  nowPlaying(state) {
    const v = state.speaker.nowPlaying;
    assert.ok(v, 'nowPlaying applied');
    assert.equal(typeof v.source, 'string');
    assert.ok(v.item && typeof v.item === 'object', 'nowPlaying.item is an object');
    assert.equal(typeof v.playStatus, 'string');
  },
  volume(state) {
    const v = state.speaker.volume;
    assert.ok(v, 'volume applied');
    assert.equal(typeof v.targetVolume, 'number');
    assert.equal(typeof v.actualVolume, 'number');
    assert.equal(typeof v.muteEnabled, 'boolean');
  },
  sources(state) {
    const v = state.speaker.sources;
    assert.ok(Array.isArray(v), 'sources is an array');
    assert.ok(v.length > 0, 'sources non-empty for the canonical fixture');
    const first = v[0];
    assert.equal(typeof first.source, 'string');
    assert.equal(typeof first.status, 'string');
    assert.equal(typeof first.isLocal, 'boolean');
  },
  bass(state) {
    const v = state.speaker.bass;
    assert.ok(v, 'bass applied');
    assert.equal(typeof v.targetBass, 'number');
    assert.equal(typeof v.actualBass, 'number');
  },
  balance(state) {
    const v = state.speaker.balance;
    assert.ok(v, 'balance applied');
    assert.equal(typeof v.targetBalance, 'number');
    assert.equal(typeof v.actualBalance, 'number');
  },
  dspMonoStereo(state) {
    const v = state.speaker.dspMonoStereo;
    assert.ok(v, 'dspMonoStereo applied');
    assert.ok(v.mode === 'mono' || v.mode === 'stereo', 'mode is mono|stereo');
  },
  zone(state) {
    const v = state.speaker.zone;
    assert.ok(v, 'zone applied');
    assert.equal(typeof v.master, 'string');
    assert.equal(typeof v.isMaster, 'boolean');
    assert.ok(Array.isArray(v.members));
  },
  bluetooth(state) {
    const v = state.speaker.bluetooth;
    assert.ok(v, 'bluetooth applied');
    assert.equal(typeof v.macAddress, 'string');
  },
  network(state) {
    const v = state.speaker.network;
    assert.ok(v, 'network applied');
    assert.equal(typeof v.macAddress, 'string');
    assert.equal(typeof v.ssid, 'string');
    assert.equal(typeof v.ipAddress, 'string');
  },
  recents(state) {
    const v = state.speaker.recents;
    assert.ok(Array.isArray(v), 'recents is an array');
  },
  systemTimeout(state) {
    const v = state.speaker.systemTimeout;
    assert.ok(v, 'systemTimeout applied');
    assert.equal(typeof v.enabled, 'boolean');
    assert.equal(typeof v.minutes, 'number');
  },
};

function makeStore() {
  const state = { speaker: {}, ws: {}, caches: {}, ui: {} };
  const touched = [];
  return {
    state,
    touch(key) { touched.push(key); },
    _touched: touched,
  };
}

// Install a fetch stub keyed by absolute path; returns a restorer.
function installFetchStub(bodyByPath) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = typeof url === 'string' ? url : String(url);
    const body = bodyByPath[path];
    if (body == null) throw new Error(`unmocked fetch: ${path}`);
    return { ok: true, status: 200, text: async () => body };
  };
  return () => { globalThis.fetch = original; };
}

// Override an entry's fetcher for the duration of fn (presets exception).
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

// --- Parametric XML-row contract ------------------------------------

const XML_ROWS = FIELDS.filter(
  (f) => typeof f.path === 'string' &&
         typeof f.tag === 'string' &&
         typeof f.parseEl === 'function',
);

// Track which rows we cover so a new field shows up as a coverage gap.
const COVERED = new Set();

for (const row of XML_ROWS) {
  test(`field contract: '${row.name}' — fixture XML drives parseEl → applyEntry → state.speaker.${row.name}`, async () => {
    const fixtureName = FIXTURE_FOR_FIELD[row.name];
    assert.ok(fixtureName, `no fixture mapped for '${row.name}' — add to FIXTURE_FOR_FIELD`);

    const contract = CONTRACT_FOR_FIELD[row.name];
    assert.equal(typeof contract, 'function',
      `no contract for '${row.name}' — add to CONTRACT_FOR_FIELD`);

    const body = await fixture(fixtureName);
    const url  = `/cgi-bin/api/v1${row.path}`;
    const restore = installFetchStub({ [url]: body });
    try {
      const store = makeStore();
      await reconcileField(store, row.name);
      assert.equal(store._touched.length, 1, 'touch called exactly once on success');
      assert.equal(store._touched[0], 'speaker');
      contract(store.state);
      COVERED.add(row.name);
    } finally {
      restore();
    }
  });
}

// Guard: assert FIXTURE_FOR_FIELD covers every XML row (and only XML
// rows). Drift trips the guard — either add a fixture for a new field
// or remove an obsolete entry.
test('FIXTURE_FOR_FIELD matches the XML rows in FIELDS', () => {
  const xmlNames = XML_ROWS.map((r) => r.name).sort();
  const mapped   = Object.keys(FIXTURE_FOR_FIELD).sort();
  assert.deepEqual(mapped, xmlNames,
    'FIXTURE_FOR_FIELD must list exactly the XML rows in FIELDS');
});

// Guard: at the end of the run, every XML row reported a covered contract.
// The "parametric" tests above register a row only on a successful
// run, so a registry-vs-fixture skew shows up here as a missing entry.
test('every XML FIELDS row exercised a contract', () => {
  const xmlNames = XML_ROWS.map((r) => r.name).sort();
  const covered  = Array.from(COVERED).sort();
  assert.deepEqual(covered, xmlNames,
    'all XML FIELDS rows must run a contract test');
});

// --- Custom-fetcher row: presets ------------------------------------

test('field contract: presets — JSON envelope drives apply → state.speaker.presets', () =>
  withFetcher('presets', async () => ({
    ok: true,
    data: [
      { slot: 1, source: 'TUNEIN', type: 'stationurl', location: '/v1/s1', itemName: 'R1', art: '' },
      { slot: 2, source: 'TUNEIN', type: 'stationurl', location: '/v1/s2', itemName: 'R2', art: '' },
    ],
  }), async () => {
    const store = makeStore();
    await reconcileField(store, 'presets');

    const v = store.state.speaker.presets;
    assert.ok(Array.isArray(v), 'presets is an array');
    assert.equal(v.length, 2);
    assert.equal(v[0].slot, 1);
    assert.equal(v[0].itemName, 'R1');
    assert.equal(v[1].slot, 2);
    assert.equal(store._touched.length, 1, 'single touch');
  }),
);

test('field contract: presets — envelope with ok:false leaves presets unset', () =>
  withFetcher('presets', async () => ({ ok: false, data: null }), async () => {
    const store = makeStore();
    store.state.speaker.presets = null;
    await reconcileField(store, 'presets');

    // apply() guards on env.ok && Array.isArray(env.data); a non-ok
    // envelope is a no-op on state, but the envelope itself is a
    // non-null value, so reconcileField does call store.touch.
    assert.equal(store.state.speaker.presets, null);
  }),
);

// --- reconcileField behaviour --------------------------------------

test('reconcileField: unknown field name → no-op (no fetch, no touch)', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(url); throw new Error('should not fetch'); };
  try {
    const store = makeStore();
    await reconcileField(store, 'nonexistentField');
    assert.equal(calls.length, 0, 'no fetch attempted for unknown field');
    assert.equal(store._touched.length, 0, 'no touch for unknown field');
  } finally {
    globalThis.fetch = original;
  }
});

test('reconcileField: fetcher rejection → swallowed, no touch, state unchanged', async () => {
  const restore = installFetchStub({}); // any path → unmocked → throws
  try {
    const store = makeStore();
    store.state.speaker.info = 'sentinel';
    await assert.doesNotReject(() => reconcileField(store, 'info'));
    assert.equal(store.state.speaker.info, 'sentinel', 'state untouched on rejection');
    assert.equal(store._touched.length, 0, 'no touch on rejection');
  } finally {
    restore();
  }
});

test('reconcileField: null fetcher payload → no apply, no touch', () =>
  withFetcher('presets', async () => null, async () => {
    const store = makeStore();
    store.state.speaker.presets = 'sentinel';
    await reconcileField(store, 'presets');
    assert.equal(store.state.speaker.presets, 'sentinel', 'state untouched on null payload');
    assert.equal(store._touched.length, 0, 'no touch on null payload');
  }),
);
