// Tests for speaker-xml.js parsers — pure DOM-element → domain mapping.
// REST (api.js#xmlGet) and WS (speaker-state.js#dispatch) both feed an
// already-resolved element to the same parseEl, so a single fixture per
// field is enough to cover both transports.
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

import {
  parseNowPlayingEl,
  parseInfoEl,
  parseVolumeEl,
  parseSourcesEl,
  parseNetworkInfoEl,
  parseSystemTimeoutEl,
  parseBluetoothInfoEl,
  parseBassEl,
  parseBassCapabilitiesEl,
  parseBalanceEl,
  parseBalanceCapabilitiesEl,
  parseDSPMonoStereoEl,
  parseCapabilitiesEl,
  parseRecentsEl,
  parseZoneEl,
  parseListMediaServersEl,
} from '../app/speaker-xml.js';
import { FIELDS } from '../app/speaker-state.js';
import { dispatch } from '../app/ws.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'api');
const WS_FIXTURES = join(HERE, 'fixtures', 'ws');

async function fixture(name) {
  return readFile(join(FIXTURES, name), 'utf8');
}

async function wsFixture(name) {
  return readFile(join(WS_FIXTURES, name), 'utf8');
}

// Locate the first element matching `tag` from a fixture body and return
// it. REST callers (api.js#xmlGet) follow the same getElementsByTagName
// pattern so these tests mirror production behaviour.
function elementFrom(xmlText, tag) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const els = doc.getElementsByTagName(tag);
  return els && els[0] ? els[0] : null;
}

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

// --- parseNowPlayingEl ----------------------------------------------

test('parseNowPlayingEl: TUNEIN stream has expected fields', async () => {
  const np = parseNowPlayingEl(elementFrom(await fixture('now-playing-tunein.xml'), 'nowPlaying'));
  assert.ok(np, 'returns a non-null object');
  assert.equal(np.source, 'TUNEIN');
  assert.equal(np.item.name, 'Example Radio');
  assert.equal(np.item.type, 'stationurl');
  assert.equal(np.track, 'Sweet Dreams');
  assert.equal(np.artist, 'La Bouche');
  assert.ok(np.art.startsWith('http'), 'art is an http URL');
  assert.equal(np.playStatus, 'PLAY_STATE');
});

test('parseNowPlayingEl: STANDBY returns source=STANDBY with empty fields', async () => {
  const np = parseNowPlayingEl(elementFrom(await fixture('now-playing-standby.xml'), 'nowPlaying'));
  assert.ok(np, 'returns a non-null object');
  assert.equal(np.source, 'STANDBY');
  assert.equal(np.track, '');
  assert.equal(np.artist, '');
  assert.equal(np.playStatus, '');
});

test('parseNowPlayingEl: null input returns null', () => {
  assert.equal(parseNowPlayingEl(null), null);
});

test('parseNowPlayingEl: BLUETOOTH source carries connection info', async () => {
  const np = parseNowPlayingEl(elementFrom(await fixture('now-playing-bluetooth.xml'), 'nowPlaying'));
  assert.ok(np);
  assert.equal(np.source, 'BLUETOOTH');
  assert.ok(np.connection, 'connection is set when <connectionStatusInfo> present');
  assert.equal(np.connection.deviceName, "Sven's iPhone");
  assert.equal(np.connection.status, 'CONNECTED');
});

test('parseNowPlayingEl: TUNEIN source has connection=null', async () => {
  const np = parseNowPlayingEl(elementFrom(await fixture('now-playing-tunein.xml'), 'nowPlaying'));
  assert.ok(np);
  assert.equal(np.connection, null);
});

// --- WS dispatch: nowPlayingUpdated ---------------------------------

test('nowPlayingUpdated dispatch sets state.speaker.nowPlaying and touches speaker', async () => {
  const xml = await fixture('now-playing-updated-ws.xml');
  const store = makeStore();
  dispatch(xml, store);
  const np = store.state.speaker.nowPlaying;
  assert.ok(np, 'nowPlaying is set');
  assert.equal(np.source, 'TUNEIN');
  assert.equal(np.item.name, 'Example Radio');
  assert.equal(np.playStatus, 'PLAY_STATE');
  assert.ok(store._touched.includes('speaker'), 'speaker key was touched');
});

test('nowPlayingUpdated dispatch: STANDBY sets source=STANDBY', async () => {
  const xml = await fixture('now-playing-standby-ws.xml');
  const store = makeStore();
  dispatch(xml, store);
  const np = store.state.speaker.nowPlaying;
  assert.ok(np, 'nowPlaying is set even for STANDBY');
  assert.equal(np.source, 'STANDBY');
  assert.ok(store._touched.includes('speaker'));
});

// --- parseInfoEl ----------------------------------------------------

test('parseInfoEl: extracts deviceID, name, type, and SCM firmwareVersion', async () => {
  const info = parseInfoEl(elementFrom(await fixture('info.xml'), 'info'));
  assert.ok(info, 'returns a non-null object');
  assert.equal(info.deviceID, '3415139ABD77');
  assert.equal(info.name, 'Bo');
  assert.equal(info.type, 'SoundTouch 10');
  assert.equal(
    info.firmwareVersion,
    '27.0.6.29798 epdbuild hepdswbld04 (Sep 20 2016 12:19:09)',
  );
});

test('parseInfoEl: firmwareVersion comes from the SCM component, not PackagedProduct', () => {
  const xml = '<info deviceID="AA">' +
              '<name>X</name><type>Y</type>' +
              '<components>' +
              '<component><componentCategory>PackagedProduct</componentCategory>' +
              '<softwareVersion>9.9.9</softwareVersion></component>' +
              '<component><componentCategory>SCM</componentCategory>' +
              '<softwareVersion>27.0.6.29798</softwareVersion></component>' +
              '</components></info>';
  const info = parseInfoEl(elementFrom(xml, 'info'));
  assert.ok(info);
  assert.equal(info.firmwareVersion, '27.0.6.29798');
});

test('parseInfoEl: no SCM component → firmwareVersion is empty', () => {
  const xml = '<info deviceID="AA"><name>X</name><type>Y</type>' +
              '<components><component>' +
              '<componentCategory>PackagedProduct</componentCategory>' +
              '<softwareVersion>9.9.9</softwareVersion>' +
              '</component></components></info>';
  const info = parseInfoEl(elementFrom(xml, 'info'));
  assert.ok(info);
  assert.equal(info.firmwareVersion, '');
});

test('parseInfoEl: missing <components> → firmwareVersion empty, other fields populated', () => {
  const xml = '<info deviceID="BB"><name>N</name><type>T</type></info>';
  const info = parseInfoEl(elementFrom(xml, 'info'));
  assert.ok(info);
  assert.equal(info.deviceID, 'BB');
  assert.equal(info.name, 'N');
  assert.equal(info.type, 'T');
  assert.equal(info.firmwareVersion, '');
});

test('parseInfoEl: null input returns null', () => {
  assert.equal(parseInfoEl(null), null);
});

// --- parseVolumeEl --------------------------------------------------

test('parseVolumeEl: normal volume returns expected fields', async () => {
  const vol = parseVolumeEl(elementFrom(await fixture('volume.xml'), 'volume'));
  assert.ok(vol, 'returns a non-null object');
  assert.equal(vol.targetVolume, 32);
  assert.equal(vol.actualVolume, 32);
  assert.equal(vol.muteEnabled, false);
});

test('parseVolumeEl: muted volume sets muteEnabled=true', async () => {
  const vol = parseVolumeEl(elementFrom(await fixture('volume-muted.xml'), 'volume'));
  assert.ok(vol, 'returns a non-null object');
  assert.equal(vol.targetVolume, 20);
  assert.equal(vol.actualVolume, 20);
  assert.equal(vol.muteEnabled, true);
});

test('parseVolumeEl: null input returns null', () => {
  assert.equal(parseVolumeEl(null), null);
});

// --- WS dispatch: volumeUpdated -------------------------------------

test('volumeUpdated dispatch sets state.speaker.volume and touches speaker', async () => {
  const xml = await wsFixture('volume-updated.xml');
  const store = makeStore();
  dispatch(xml, store);
  const vol = store.state.speaker.volume;
  assert.ok(vol, 'volume is set');
  assert.equal(vol.targetVolume, 32);
  assert.equal(vol.actualVolume, 32);
  assert.equal(vol.muteEnabled, false);
  assert.ok(store._touched.includes('speaker'), 'speaker key was touched');
});

// --- parseSourcesEl -------------------------------------------------

test('parseSourcesEl: returns 4-element array with correct fields', async () => {
  const sources = parseSourcesEl(elementFrom(await fixture('sources.xml'), 'sources'));
  assert.ok(Array.isArray(sources), 'returns an array');
  assert.equal(sources.length, 4);

  const tunein = sources[0];
  assert.equal(tunein.source, 'TUNEIN');
  assert.equal(tunein.sourceAccount, '');
  assert.equal(tunein.status, 'READY');
  assert.equal(tunein.isLocal, false, 'isLocal is boolean false');
  assert.equal(tunein.displayName, 'TuneIn');

  const aux = sources[1];
  assert.equal(aux.source, 'AUX');
  assert.equal(aux.sourceAccount, 'AUX');
  assert.equal(aux.status, 'READY');
  assert.equal(aux.isLocal, true, 'isLocal is boolean true');
  assert.equal(aux.displayName, 'AUX');

  const bt = sources[2];
  assert.equal(bt.source, 'BLUETOOTH');
  assert.equal(bt.status, 'UNAVAILABLE');
  assert.equal(bt.isLocal, true);
  assert.equal(bt.displayName, 'Bluetooth');

  const spotify = sources[3];
  assert.equal(spotify.source, 'SPOTIFY');
  assert.equal(spotify.sourceAccount, 'account-1');
  assert.equal(spotify.isLocal, false);
});

test('parseSourcesEl: no-sources <sources/> returns empty array', () => {
  const sources = parseSourcesEl(elementFrom('<sources deviceID="test"/>', 'sources'));
  assert.ok(Array.isArray(sources), 'returns an array');
  assert.equal(sources.length, 0);
});

test('parseSourcesEl: null input returns null', () => {
  assert.equal(parseSourcesEl(null), null);
});

// --- parseNetworkInfoEl ---------------------------------------------

test('parseNetworkInfoEl: connected interface — fields populated, MAC normalised', async () => {
  const net = parseNetworkInfoEl(elementFrom(await fixture('network-info.xml'), 'networkInfo'));
  assert.ok(net, 'returns a non-null object');
  assert.equal(net.ssid, 'WLAN-Oben');
  assert.equal(net.ipAddress, '192.168.178.36');
  assert.equal(net.macAddress, '0CB2B709F837');
  assert.equal(net.signal, 'GOOD_SIGNAL');
  assert.equal(net.frequencyKHz, 5240000);
  assert.equal(net.state, 'NETWORK_WIFI_CONNECTED');
  assert.equal(net.name, 'wlan0');
  assert.equal(net.mode, 'STATION');
});

test('parseNetworkInfoEl: picks the first connected interface, not the disconnected wlan1', async () => {
  const net = parseNetworkInfoEl(elementFrom(await fixture('network-info.xml'), 'networkInfo'));
  // wlan0 has the IP, wlan1 doesn't.
  assert.equal(net.name, 'wlan0');
  assert.equal(net.macAddress, '0CB2B709F837');
});

test('parseNetworkInfoEl: disconnected speaker — falls back to first interface, ssid/ip empty', async () => {
  const net = parseNetworkInfoEl(elementFrom(await fixture('network-info-disconnected.xml'), 'networkInfo'));
  assert.ok(net, 'returns a non-null object');
  assert.equal(net.macAddress, '0CB2B709F837');
  assert.equal(net.ipAddress, '');
  assert.equal(net.ssid, '');
  assert.equal(net.signal, '');
  assert.equal(net.frequencyKHz, null);
});

test('parseNetworkInfoEl: <networkInfo/> with no interfaces returns null', () => {
  assert.equal(parseNetworkInfoEl(elementFrom('<networkInfo/>', 'networkInfo')), null);
});

test('parseNetworkInfoEl: null input returns null', () => {
  assert.equal(parseNetworkInfoEl(null), null);
});

// --- parseSystemTimeoutEl -------------------------------------------

test('parseSystemTimeoutEl: enabled=true with minutes', async () => {
  const t = parseSystemTimeoutEl(elementFrom(await fixture('systemtimeout.xml'), 'systemtimeout'));
  assert.ok(t, 'returns a non-null object');
  assert.equal(t.enabled, true);
  assert.equal(t.minutes, 20);
});

test('parseSystemTimeoutEl: enabled=false / minutes=0 (Never)', async () => {
  const t = parseSystemTimeoutEl(elementFrom(await fixture('systemtimeout-off.xml'), 'systemtimeout'));
  assert.ok(t, 'returns a non-null object');
  assert.equal(t.enabled, false);
  assert.equal(t.minutes, 0);
});

test('parseSystemTimeoutEl: null input returns null', () => {
  assert.equal(parseSystemTimeoutEl(null), null);
});

// --- parseBluetoothInfoEl -------------------------------------------
// Bo's firmware exposes only the speaker's own MAC; <pairedList> never
// materialises in practice (verified with iPhone actively paired). The
// parser now reads only BluetoothMACAddress and ignores any speculative
// children so a stray <pairedList> in the wild is silently tolerated.

test('parseBluetoothInfoEl: speaker MAC attribute populates macAddress', async () => {
  const bt = parseBluetoothInfoEl(elementFrom(await fixture('bluetooth-info-empty.xml'), 'BluetoothInfo'));
  assert.ok(bt, 'returns a non-null object');
  assert.equal(bt.macAddress, '0CB2B709F837');
  assert.equal(bt.paired, undefined, 'paired list is no longer surfaced');
});

test('parseBluetoothInfoEl: bare <BluetoothInfo/> returns macAddress=""', () => {
  const bt = parseBluetoothInfoEl(elementFrom('<BluetoothInfo/>', 'BluetoothInfo'));
  assert.ok(bt);
  assert.equal(bt.macAddress, '');
});

test('parseBluetoothInfoEl: speculative <pairedList> is ignored', () => {
  const xml = '<BluetoothInfo BluetoothMACAddress="AABBCCDDEEFF">' +
              '<pairedList><pairedDevice mac="11:22:33:44:55:66">Phone</pairedDevice></pairedList>' +
              '</BluetoothInfo>';
  const bt = parseBluetoothInfoEl(elementFrom(xml, 'BluetoothInfo'));
  assert.ok(bt);
  assert.equal(bt.macAddress, 'AABBCCDDEEFF');
  assert.equal(bt.paired, undefined, 'pairedList shape is intentionally not parsed');
});

test('parseBluetoothInfoEl: null input returns null', () => {
  assert.equal(parseBluetoothInfoEl(null), null);
});

// --- parseBassEl ----------------------------------------------------

test('parseBassEl: returns expected fields', async () => {
  const bass = parseBassEl(elementFrom(await fixture('bass.xml'), 'bass'));
  assert.ok(bass, 'returns a non-null object');
  assert.equal(bass.targetBass, -3);
  assert.equal(bass.actualBass, -3);
});

test('parseBassEl: null input returns null', () => {
  assert.equal(parseBassEl(null), null);
});

// --- parseBassCapabilitiesEl ----------------------------------------

test('parseBassCapabilitiesEl: returns min/max/default', async () => {
  const caps = parseBassCapabilitiesEl(elementFrom(await fixture('bass-capabilities.xml'), 'bassCapabilities'));
  assert.ok(caps);
  assert.equal(caps.bassMin, -9);
  assert.equal(caps.bassMax, 0);
  assert.equal(caps.bassDefault, 0);
});

test('parseBassCapabilitiesEl: null input returns null', () => {
  assert.equal(parseBassCapabilitiesEl(null), null);
});

// --- WS dispatch: bassUpdated ---------------------------------------

test('bassUpdated dispatch sets state.speaker.bass and touches speaker', async () => {
  const xml = await wsFixture('bass-updated.xml');
  const store = makeStore();
  dispatch(xml, store);
  const bass = store.state.speaker.bass;
  assert.ok(bass, 'bass is set');
  assert.equal(bass.targetBass, -3);
  assert.equal(bass.actualBass, -3);
  assert.ok(store._touched.includes('speaker'), 'speaker key was touched');
});

// --- parseBalanceEl -------------------------------------------------

test('parseBalanceEl: returns expected fields', async () => {
  const balance = parseBalanceEl(elementFrom(await fixture('balance.xml'), 'balance'));
  assert.ok(balance);
  assert.equal(balance.targetBalance, 2);
  assert.equal(balance.actualBalance, 2);
});

test('parseBalanceEl: null input returns null', () => {
  assert.equal(parseBalanceEl(null), null);
});

// --- parseBalanceCapabilitiesEl -------------------------------------

test('parseBalanceCapabilitiesEl: returns min/max/default', async () => {
  const caps = parseBalanceCapabilitiesEl(elementFrom(await fixture('balance-capabilities.xml'), 'balanceCapabilities'));
  assert.ok(caps);
  assert.equal(caps.balanceMin, -7);
  assert.equal(caps.balanceMax, 7);
  assert.equal(caps.balanceDefault, 0);
});

test('parseBalanceCapabilitiesEl: null input returns null', () => {
  assert.equal(parseBalanceCapabilitiesEl(null), null);
});

// --- WS dispatch: balanceUpdated ------------------------------------

test('balanceUpdated dispatch sets state.speaker.balance and touches speaker', async () => {
  const xml = await wsFixture('balance-updated.xml');
  const store = makeStore();
  dispatch(xml, store);
  const balance = store.state.speaker.balance;
  assert.ok(balance, 'balance is set');
  assert.equal(balance.targetBalance, 2);
  assert.equal(balance.actualBalance, 2);
  assert.ok(store._touched.includes('speaker'));
});

// --- parseDSPMonoStereoEl -------------------------------------------

test('parseDSPMonoStereoEl: stereo (mono enabled=false) → mode=stereo', async () => {
  const dsp = parseDSPMonoStereoEl(elementFrom(await fixture('dsp-mono-stereo.xml'), 'DSPMonoStereo'));
  assert.ok(dsp);
  assert.equal(dsp.mode, 'stereo');
});

test('parseDSPMonoStereoEl: mono (mono enabled=true) → mode=mono', async () => {
  const dsp = parseDSPMonoStereoEl(elementFrom(await fixture('dsp-mono-stereo-mono.xml'), 'DSPMonoStereo'));
  assert.ok(dsp);
  assert.equal(dsp.mode, 'mono');
});

test('parseDSPMonoStereoEl: null input returns null', () => {
  assert.equal(parseDSPMonoStereoEl(null), null);
});

// --- parseCapabilitiesEl --------------------------------------------

test('parseCapabilitiesEl: surfaces deviceID, dspMonoStereo, and named capabilities', async () => {
  const caps = parseCapabilitiesEl(elementFrom(await fixture('capabilities.xml'), 'capabilities'));
  assert.ok(caps, 'returns a non-null object');
  assert.equal(caps.deviceID, '3415139ABD77');
  assert.equal(caps.dspMonoStereo, false, 'available="false" → false');
  assert.equal(caps.lrStereoCapable, true);
  assert.equal(caps.bcoresetCapable, false);
  assert.equal(caps.disablePowerSaving, true);
  assert.equal(caps.lightswitch, false);
  assert.equal(caps.clockDisplay, false);
  assert.ok(Array.isArray(caps.capabilities));
  assert.equal(caps.capabilities.length, 2);
  assert.equal(caps.capabilities[0].name, 'systemtimeout');
  assert.equal(caps.capabilities[0].url, '/systemtimeout');
});

test('parseCapabilitiesEl: null input returns null', () => {
  assert.equal(parseCapabilitiesEl(null), null);
});

// --- parseRecentsEl -------------------------------------------------

test('parseRecentsEl: returns array with TUNEIN + SPOTIFY entries', async () => {
  const recents = parseRecentsEl(elementFrom(await fixture('recents.xml'), 'recents'));
  assert.ok(Array.isArray(recents), 'returns an array');
  assert.equal(recents.length, 5);

  const first = recents[0];
  assert.equal(first.source, 'TUNEIN');
  assert.equal(first.type, 'stationurl');
  assert.equal(first.location, '/v1/playback/station/s10637');
  assert.equal(first.utcTime, 1778423423);
  assert.equal(first.itemName, '', 'bare contentItem has no itemName');

  const named = recents[1];
  assert.equal(named.source, 'TUNEIN');
  assert.equal(named.itemName, '95.5 Charivari');

  const arted = recents[2];
  assert.equal(arted.itemName, 'Antenne Bayern');
  assert.ok(arted.containerArt.startsWith('https://'), 'containerArt URL captured');

  const spotify = recents[3];
  assert.equal(spotify.source, 'SPOTIFY');
  assert.equal(spotify.type, 'tracklisturl');
  assert.equal(spotify.itemName, 'two of us');
  assert.ok(spotify.sourceAccount.length > 0);
});

test('parseRecentsEl: empty <recents/> returns []', async () => {
  const recents = parseRecentsEl(elementFrom(await fixture('recents-empty.xml'), 'recents'));
  assert.ok(Array.isArray(recents));
  assert.equal(recents.length, 0);
});

test('parseRecentsEl: null input returns null', () => {
  assert.equal(parseRecentsEl(null), null);
});

// --- WS dispatch: recentsUpdated ------------------------------------

test('recentsUpdated dispatch sets state.speaker.recents and touches speaker', async () => {
  const xml = await wsFixture('recents-updated.xml');
  const store = makeStore();
  dispatch(xml, store);
  const recents = store.state.speaker.recents;
  assert.ok(Array.isArray(recents), 'recents is an array');
  assert.equal(recents.length, 2);
  assert.equal(recents[0].source, 'TUNEIN');
  assert.equal(recents[1].itemName, '95.5 Charivari');
  assert.ok(store._touched.includes('speaker'), 'speaker key was touched');
});

// --- parseZoneEl ----------------------------------------------------

test('parseZoneEl: standalone <zone/> → empty members, no master', async () => {
  const zone = parseZoneEl(elementFrom(await fixture('zone-standalone.xml'), 'zone'));
  assert.ok(zone, 'returns a non-null object');
  assert.equal(zone.master, '');
  assert.equal(zone.masterIpAddress, '');
  assert.equal(zone.isMaster, false);
  assert.ok(Array.isArray(zone.members));
  assert.equal(zone.members.length, 0);
});

test('parseZoneEl: master shape — isMaster=true, members populated', async () => {
  const zone = parseZoneEl(elementFrom(await fixture('zone-master.xml'), 'zone'));
  assert.ok(zone);
  assert.equal(zone.master, '3415139ABD77');
  assert.equal(zone.masterIpAddress, '');
  assert.equal(zone.isMaster, true, 'no senderIPAddress → master view');
  assert.equal(zone.members.length, 2);
  assert.equal(zone.members[0].deviceID, '689E19D55555');
  assert.equal(zone.members[0].ipAddress, '192.168.178.40');
  assert.equal(zone.members[0].role, 'LEFT');
});

test('parseZoneEl: member shape — senderIPAddress set, isMaster=false', async () => {
  const zone = parseZoneEl(elementFrom(await fixture('zone-member.xml'), 'zone'));
  assert.ok(zone);
  assert.equal(zone.master, '689E19D55555');
  assert.equal(zone.masterIpAddress, '192.168.178.40');
  assert.equal(zone.isMaster, false, 'senderIPAddress → slave view');
  assert.equal(zone.members.length, 2);
});

test('parseZoneEl: null input returns null', () => {
  assert.equal(parseZoneEl(null), null);
});

// --- parseListMediaServersEl ----------------------------------------

test('parseListMediaServersEl: standalone (only DLNA peers, no Bose) returns []', async () => {
  const peers = parseListMediaServersEl(elementFrom(await fixture('list-media-servers.xml'), 'ListMediaServersResponse'));
  assert.ok(Array.isArray(peers));
  assert.equal(peers.length, 0, 'AVM FRITZ!Box entries are filtered out');
});

test('parseListMediaServersEl: keeps Bose-marked entries with mac/ip/name', async () => {
  const peers = parseListMediaServersEl(elementFrom(await fixture('list-media-servers-with-bose.xml'), 'ListMediaServersResponse'));
  assert.ok(Array.isArray(peers));
  assert.equal(peers.length, 1);
  assert.equal(peers[0].mac, '689E19D55555');
  assert.equal(peers[0].ip, '192.168.178.40');
  assert.equal(peers[0].name, 'Kitchen');
  assert.equal(peers[0].model, 'SoundTouch 20');
});

test('parseListMediaServersEl: null input returns null', () => {
  assert.equal(parseListMediaServersEl(null), null);
});

// --- Parametric coverage: every FIELDS row has a fixture ------------
//
// One row in FIELDS is a deliberate exception (see speaker-state.js):
//   presets — JSON envelope; no path/tag/parseEl triple.
// Every other row is asserted to have a backing api fixture and a
// non-null parseEl result, so dropping or renaming a fixture without
// updating the registry trips a test.

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

for (const row of FIELDS) {
  if (!row.path && !row.tag && !row.parseEl) {
    // Documented exception (presets).
    test(`FIELDS row '${row.name}' is a custom-fetcher exception`, () => {
      assert.equal(typeof row.fetcher, 'function',
        `exception rows must declare a fetcher (row: ${row.name})`);
    });
    continue;
  }

  test(`FIELDS row '${row.name}' has {path, tag, parseEl} and fixture coverage`, async () => {
    assert.equal(typeof row.path, 'string',  `${row.name}.path is a string`);
    assert.equal(typeof row.tag, 'string',   `${row.name}.tag is a string`);
    assert.equal(typeof row.parseEl, 'function', `${row.name}.parseEl is a function`);

    const fixtureName = FIXTURE_FOR_FIELD[row.name];
    assert.ok(fixtureName,
      `no fixture mapped for '${row.name}' — add one to FIXTURE_FOR_FIELD`);

    const xml = await fixture(fixtureName);
    const el  = elementFrom(xml, row.tag);
    assert.ok(el, `fixture ${fixtureName} contains <${row.tag}>`);

    const value = row.parseEl(el);
    assert.notEqual(value, null,
      `${row.name}.parseEl returned non-null for fixture ${fixtureName}`);
  });
}
