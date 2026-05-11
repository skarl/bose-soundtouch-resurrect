// Tests for speaker-xml.js parsers — pure XML→domain mapping.
// Each parseXxxXml/parseXxxEl pair is fixture-driven and shared by both
// the REST fetchers in api.js and the WS dispatch path in speaker-state.js.
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
  parseNowPlayingXml, parseNowPlayingEl,
  parseInfoXml, parseInfoEl,
  parseVolumeXml, parseVolumeEl,
  parseSourcesXml, parseSourcesEl,
  parseNetworkInfoXml, parseNetworkInfoEl,
  parseSystemTimeoutXml, parseSystemTimeoutEl,
  parseBluetoothInfoXml, parseBluetoothInfoEl,
  parseBassXml, parseBassEl,
  parseBassCapabilitiesXml, parseBassCapabilitiesEl,
  parseBalanceXml, parseBalanceEl,
  parseBalanceCapabilitiesXml, parseBalanceCapabilitiesEl,
  parseDSPMonoStereoXml, parseDSPMonoStereoEl,
  parseCapabilitiesXml, parseCapabilitiesEl,
  parseRecentsXml, parseRecentsEl,
  parseZoneXml, parseZoneEl,
  parseListMediaServersXml, parseListMediaServersEl,
} from '../app/speaker-xml.js';
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

// --- parseNowPlayingXml (REST path) ---------------------------------

test('parseNowPlayingXml: TUNEIN stream has expected fields', async () => {
  const xml = await fixture('now-playing-tunein.xml');
  const np = parseNowPlayingXml(xml);
  assert.ok(np, 'returns a non-null object');
  assert.equal(np.source, 'TUNEIN');
  assert.equal(np.item.name, 'Example Radio');
  assert.equal(np.item.type, 'stationurl');
  assert.equal(np.track, 'Sweet Dreams');
  assert.equal(np.artist, 'La Bouche');
  assert.ok(np.art.startsWith('http'), 'art is an http URL');
  assert.equal(np.playStatus, 'PLAY_STATE');
});

test('parseNowPlayingXml: STANDBY returns source=STANDBY with empty fields', async () => {
  const xml = await fixture('now-playing-standby.xml');
  const np = parseNowPlayingXml(xml);
  assert.ok(np, 'returns a non-null object');
  assert.equal(np.source, 'STANDBY');
  assert.equal(np.track, '');
  assert.equal(np.artist, '');
  assert.equal(np.playStatus, '');
});

test('parseNowPlayingXml: empty string returns null', () => {
  assert.equal(parseNowPlayingXml(''), null);
});

test('parseNowPlayingXml: non-nowPlaying XML returns null', () => {
  assert.equal(parseNowPlayingXml('<volume>42</volume>'), null);
});

// --- parseNowPlayingEl (DOM element path, used by WS) ---------------

test('parseNowPlayingEl: parses a DOM element directly', async () => {
  const xml = await fixture('now-playing-tunein.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('nowPlaying');
  const np = parseNowPlayingEl(els && els[0]);
  assert.ok(np, 'returns a non-null object');
  assert.equal(np.source, 'TUNEIN');
  assert.equal(np.item.name, 'Example Radio');
  assert.equal(np.playStatus, 'PLAY_STATE');
});

test('parseNowPlayingEl: null input returns null', () => {
  assert.equal(parseNowPlayingEl(null), null);
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

// --- parseInfoXml ---------------------------------------------------

test('parseInfoXml: extracts deviceID, name, type, and SCM firmwareVersion', async () => {
  const xml = await fixture('info.xml');
  const info = parseInfoXml(xml);
  assert.ok(info, 'returns a non-null object');
  assert.equal(info.deviceID, '3415139ABD77');
  assert.equal(info.name, 'Bo');
  assert.equal(info.type, 'SoundTouch 10');
  assert.equal(
    info.firmwareVersion,
    '27.0.6.29798 epdbuild hepdswbld04 (Sep 20 2016 12:19:09)',
  );
});

test('parseInfoXml: firmwareVersion comes from the SCM component, not PackagedProduct', async () => {
  const xml = '<info deviceID="AA">' +
              '<name>X</name><type>Y</type>' +
              '<components>' +
              '<component><componentCategory>PackagedProduct</componentCategory>' +
              '<softwareVersion>9.9.9</softwareVersion></component>' +
              '<component><componentCategory>SCM</componentCategory>' +
              '<softwareVersion>27.0.6.29798</softwareVersion></component>' +
              '</components></info>';
  const info = parseInfoXml(xml);
  assert.ok(info);
  assert.equal(info.firmwareVersion, '27.0.6.29798');
});

test('parseInfoXml: no SCM component → firmwareVersion is empty', () => {
  const xml = '<info deviceID="AA"><name>X</name><type>Y</type>' +
              '<components><component>' +
              '<componentCategory>PackagedProduct</componentCategory>' +
              '<softwareVersion>9.9.9</softwareVersion>' +
              '</component></components></info>';
  const info = parseInfoXml(xml);
  assert.ok(info);
  assert.equal(info.firmwareVersion, '');
});

test('parseInfoXml: missing <components> → firmwareVersion empty, other fields populated', () => {
  const xml = '<info deviceID="BB"><name>N</name><type>T</type></info>';
  const info = parseInfoXml(xml);
  assert.ok(info);
  assert.equal(info.deviceID, 'BB');
  assert.equal(info.name, 'N');
  assert.equal(info.type, 'T');
  assert.equal(info.firmwareVersion, '');
});

test('parseInfoXml: empty string returns null', () => {
  assert.equal(parseInfoXml(''), null);
});

test('parseInfoXml: non-info XML returns null', () => {
  assert.equal(parseInfoXml('<volume>0</volume>'), null);
});

test('parseInfoEl: null input returns null', () => {
  assert.equal(parseInfoEl(null), null);
});

test('parseInfoEl: parses a DOM element directly', async () => {
  const xml = await fixture('info.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('info');
  const info = parseInfoEl(els && els[0]);
  assert.ok(info);
  assert.equal(info.deviceID, '3415139ABD77');
  assert.equal(info.name, 'Bo');
  assert.equal(info.type, 'SoundTouch 10');
  assert.ok(info.firmwareVersion.startsWith('27.0.6.29798'));
});

// --- parseVolumeXml -------------------------------------------------

test('parseVolumeXml: normal volume returns expected fields', async () => {
  const xml = await fixture('volume.xml');
  const vol = parseVolumeXml(xml);
  assert.ok(vol, 'returns a non-null object');
  assert.equal(vol.targetVolume, 32);
  assert.equal(vol.actualVolume, 32);
  assert.equal(vol.muteEnabled, false);
});

test('parseVolumeXml: muted volume sets muteEnabled=true', async () => {
  const xml = await fixture('volume-muted.xml');
  const vol = parseVolumeXml(xml);
  assert.ok(vol, 'returns a non-null object');
  assert.equal(vol.targetVolume, 20);
  assert.equal(vol.actualVolume, 20);
  assert.equal(vol.muteEnabled, true);
});

test('parseVolumeXml: empty string returns null', () => {
  assert.equal(parseVolumeXml(''), null);
});

test('parseVolumeXml: non-volume XML returns null', () => {
  assert.equal(parseVolumeXml('<nowPlaying source="STANDBY"/>'), null);
});

test('parseVolumeEl: null input returns null', () => {
  assert.equal(parseVolumeEl(null), null);
});

test('parseVolumeEl: parses a DOM element directly', async () => {
  const xml = await fixture('volume.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('volume');
  const vol = parseVolumeEl(els && els[0]);
  assert.ok(vol, 'returns a non-null object');
  assert.equal(vol.targetVolume, 32);
  assert.equal(vol.actualVolume, 32);
  assert.equal(vol.muteEnabled, false);
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

// --- parseSourcesXml ------------------------------------------------

test('parseSourcesXml: returns 4-element array with correct fields', async () => {
  const xml = await fixture('sources.xml');
  const sources = parseSourcesXml(xml);
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

test('parseSourcesXml: empty string returns null', () => {
  assert.equal(parseSourcesXml(''), null);
});

test('parseSourcesXml: no-sources <sources/> returns empty array', () => {
  const sources = parseSourcesXml('<sources deviceID="test"/>');
  assert.ok(Array.isArray(sources), 'returns an array');
  assert.equal(sources.length, 0);
});

// --- parseSourcesEl (DOM element path) ------------------------------

test('parseSourcesEl: parses a DOM element directly', async () => {
  const xml = await fixture('sources.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('sources');
  const sources = parseSourcesEl(els && els[0]);
  assert.ok(Array.isArray(sources), 'returns an array');
  assert.equal(sources.length, 4);
  assert.equal(sources[0].source, 'TUNEIN');
  assert.equal(sources[0].isLocal, false);
});

test('parseSourcesEl: null input returns null', () => {
  assert.equal(parseSourcesEl(null), null);
});

// --- parseNetworkInfoXml -------------------------------------------

test('parseNetworkInfoXml: connected interface — fields populated, MAC normalised', async () => {
  const xml = await fixture('network-info.xml');
  const net = parseNetworkInfoXml(xml);
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

test('parseNetworkInfoXml: picks the first connected interface, not the disconnected wlan1', async () => {
  const xml = await fixture('network-info.xml');
  const net = parseNetworkInfoXml(xml);
  // wlan0 has the IP, wlan1 doesn't.
  assert.equal(net.name, 'wlan0');
  assert.equal(net.macAddress, '0CB2B709F837');
});

test('parseNetworkInfoXml: disconnected speaker — falls back to first interface, ssid/ip empty', async () => {
  const xml = await fixture('network-info-disconnected.xml');
  const net = parseNetworkInfoXml(xml);
  assert.ok(net, 'returns a non-null object');
  assert.equal(net.macAddress, '0CB2B709F837');
  assert.equal(net.ipAddress, '');
  assert.equal(net.ssid, '');
  assert.equal(net.signal, '');
  assert.equal(net.frequencyKHz, null);
});

test('parseNetworkInfoXml: empty string returns null', () => {
  assert.equal(parseNetworkInfoXml(''), null);
});

test('parseNetworkInfoXml: non-networkInfo XML returns null', () => {
  assert.equal(parseNetworkInfoXml('<volume>42</volume>'), null);
});

test('parseNetworkInfoXml: <networkInfo/> with no interfaces returns null', () => {
  assert.equal(parseNetworkInfoXml('<networkInfo/>'), null);
});

test('parseNetworkInfoEl: parses a DOM element directly', async () => {
  const xml = await fixture('network-info.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('networkInfo');
  const net = parseNetworkInfoEl(els && els[0]);
  assert.ok(net, 'returns a non-null object');
  assert.equal(net.ssid, 'WLAN-Oben');
  assert.equal(net.ipAddress, '192.168.178.36');
});

test('parseNetworkInfoEl: null input returns null', () => {
  assert.equal(parseNetworkInfoEl(null), null);
});

// --- parseSystemTimeoutXml ------------------------------------------

test('parseSystemTimeoutXml: enabled=true with minutes', async () => {
  const xml = await fixture('systemtimeout.xml');
  const t = parseSystemTimeoutXml(xml);
  assert.ok(t, 'returns a non-null object');
  assert.equal(t.enabled, true);
  assert.equal(t.minutes, 20);
});

test('parseSystemTimeoutXml: enabled=false / minutes=0 (Never)', async () => {
  const xml = await fixture('systemtimeout-off.xml');
  const t = parseSystemTimeoutXml(xml);
  assert.ok(t, 'returns a non-null object');
  assert.equal(t.enabled, false);
  assert.equal(t.minutes, 0);
});

test('parseSystemTimeoutXml: empty string returns null', () => {
  assert.equal(parseSystemTimeoutXml(''), null);
});

test('parseSystemTimeoutXml: non-systemtimeout XML returns null', () => {
  assert.equal(parseSystemTimeoutXml('<volume>0</volume>'), null);
});

test('parseSystemTimeoutEl: null input returns null', () => {
  assert.equal(parseSystemTimeoutEl(null), null);
});

test('parseSystemTimeoutEl: parses a DOM element directly', async () => {
  const xml = await fixture('systemtimeout.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('systemtimeout');
  const t = parseSystemTimeoutEl(els && els[0]);
  assert.ok(t, 'returns a non-null object');
  assert.equal(t.enabled, true);
  assert.equal(t.minutes, 20);
});

// --- parseBluetoothInfoXml ------------------------------------------
// Bo's firmware exposes only the speaker's own MAC; <pairedList> never
// materialises in practice (verified with iPhone actively paired). The
// parser now reads only BluetoothMACAddress and ignores any speculative
// children so a stray <pairedList> in the wild is silently tolerated.

test('parseBluetoothInfoXml: speaker MAC attribute populates macAddress', async () => {
  const xml = await fixture('bluetooth-info-empty.xml');
  const bt = parseBluetoothInfoXml(xml);
  assert.ok(bt, 'returns a non-null object');
  assert.equal(bt.macAddress, '0CB2B709F837');
  assert.equal(bt.paired, undefined, 'paired list is no longer surfaced');
});

test('parseBluetoothInfoXml: bare <BluetoothInfo/> returns macAddress=""', () => {
  const bt = parseBluetoothInfoXml('<BluetoothInfo/>');
  assert.ok(bt);
  assert.equal(bt.macAddress, '');
});

test('parseBluetoothInfoXml: speculative <pairedList> is ignored', () => {
  const xml = '<BluetoothInfo BluetoothMACAddress="AABBCCDDEEFF">' +
              '<pairedList><pairedDevice mac="11:22:33:44:55:66">Phone</pairedDevice></pairedList>' +
              '</BluetoothInfo>';
  const bt = parseBluetoothInfoXml(xml);
  assert.ok(bt);
  assert.equal(bt.macAddress, 'AABBCCDDEEFF');
  assert.equal(bt.paired, undefined, 'pairedList shape is intentionally not parsed');
});

test('parseBluetoothInfoXml: empty string returns null', () => {
  assert.equal(parseBluetoothInfoXml(''), null);
});

test('parseBluetoothInfoXml: non-bluetooth XML returns null', () => {
  assert.equal(parseBluetoothInfoXml('<volume>42</volume>'), null);
});

test('parseBluetoothInfoEl: null input returns null', () => {
  assert.equal(parseBluetoothInfoEl(null), null);
});

test('parseBluetoothInfoEl: parses a DOM element directly', async () => {
  const xml = await fixture('bluetooth-info-empty.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('BluetoothInfo');
  const bt = parseBluetoothInfoEl(els && els[0]);
  assert.ok(bt);
  assert.equal(bt.macAddress, '0CB2B709F837');
});

// --- parseNowPlayingXml: connection (BT) ---------------------------

test('parseNowPlayingXml: BLUETOOTH source carries connection info', async () => {
  const xml = await fixture('now-playing-bluetooth.xml');
  const np = parseNowPlayingXml(xml);
  assert.ok(np);
  assert.equal(np.source, 'BLUETOOTH');
  assert.ok(np.connection, 'connection is set when <connectionStatusInfo> present');
  assert.equal(np.connection.deviceName, "Sven's iPhone");
  assert.equal(np.connection.status, 'CONNECTED');
});

test('parseNowPlayingXml: TUNEIN source has connection=null', async () => {
  const xml = await fixture('now-playing-tunein.xml');
  const np = parseNowPlayingXml(xml);
  assert.ok(np);
  assert.equal(np.connection, null);
});

// --- parseBassXml ---------------------------------------------------

test('parseBassXml: returns expected fields', async () => {
  const xml = await fixture('bass.xml');
  const bass = parseBassXml(xml);
  assert.ok(bass, 'returns a non-null object');
  assert.equal(bass.targetBass, -3);
  assert.equal(bass.actualBass, -3);
});

test('parseBassXml: empty string returns null', () => {
  assert.equal(parseBassXml(''), null);
});

test('parseBassXml: non-bass XML returns null', () => {
  assert.equal(parseBassXml('<volume>0</volume>'), null);
});

test('parseBassEl: null input returns null', () => {
  assert.equal(parseBassEl(null), null);
});

test('parseBassEl: parses a DOM element directly', async () => {
  const xml = await fixture('bass.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('bass');
  const bass = parseBassEl(els && els[0]);
  assert.ok(bass);
  assert.equal(bass.targetBass, -3);
  assert.equal(bass.actualBass, -3);
});

// --- parseBassCapabilitiesXml ---------------------------------------

test('parseBassCapabilitiesXml: returns min/max/default', async () => {
  const xml = await fixture('bass-capabilities.xml');
  const caps = parseBassCapabilitiesXml(xml);
  assert.ok(caps);
  assert.equal(caps.bassMin, -9);
  assert.equal(caps.bassMax, 0);
  assert.equal(caps.bassDefault, 0);
});

test('parseBassCapabilitiesEl: parses a DOM element directly', async () => {
  const xml = await fixture('bass-capabilities.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('bassCapabilities');
  const caps = parseBassCapabilitiesEl(els && els[0]);
  assert.ok(caps);
  assert.equal(caps.bassMin, -9);
  assert.equal(caps.bassMax, 0);
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

// --- parseBalanceXml ------------------------------------------------

test('parseBalanceXml: returns expected fields', async () => {
  const xml = await fixture('balance.xml');
  const balance = parseBalanceXml(xml);
  assert.ok(balance);
  assert.equal(balance.targetBalance, 2);
  assert.equal(balance.actualBalance, 2);
});

test('parseBalanceXml: empty string returns null', () => {
  assert.equal(parseBalanceXml(''), null);
});

test('parseBalanceXml: non-balance XML returns null', () => {
  assert.equal(parseBalanceXml('<volume>0</volume>'), null);
});

test('parseBalanceEl: null input returns null', () => {
  assert.equal(parseBalanceEl(null), null);
});

test('parseBalanceEl: parses a DOM element directly', async () => {
  const xml = await fixture('balance.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('balance');
  const balance = parseBalanceEl(els && els[0]);
  assert.ok(balance);
  assert.equal(balance.targetBalance, 2);
});

// --- parseBalanceCapabilitiesXml ------------------------------------

test('parseBalanceCapabilitiesXml: returns min/max/default', async () => {
  const xml = await fixture('balance-capabilities.xml');
  const caps = parseBalanceCapabilitiesXml(xml);
  assert.ok(caps);
  assert.equal(caps.balanceMin, -7);
  assert.equal(caps.balanceMax, 7);
  assert.equal(caps.balanceDefault, 0);
});

test('parseBalanceCapabilitiesEl: parses a DOM element directly', async () => {
  const xml = await fixture('balance-capabilities.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('balanceCapabilities');
  const caps = parseBalanceCapabilitiesEl(els && els[0]);
  assert.ok(caps);
  assert.equal(caps.balanceMin, -7);
  assert.equal(caps.balanceMax, 7);
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

// --- parseDSPMonoStereoXml ------------------------------------------

test('parseDSPMonoStereoXml: stereo (mono enabled=false) → mode=stereo', async () => {
  const xml = await fixture('dsp-mono-stereo.xml');
  const dsp = parseDSPMonoStereoXml(xml);
  assert.ok(dsp);
  assert.equal(dsp.mode, 'stereo');
});

test('parseDSPMonoStereoXml: mono (mono enabled=true) → mode=mono', async () => {
  const xml = await fixture('dsp-mono-stereo-mono.xml');
  const dsp = parseDSPMonoStereoXml(xml);
  assert.ok(dsp);
  assert.equal(dsp.mode, 'mono');
});

test('parseDSPMonoStereoEl: null input returns null', () => {
  assert.equal(parseDSPMonoStereoEl(null), null);
});

test('parseDSPMonoStereoEl: parses a DOM element directly', async () => {
  const xml = await fixture('dsp-mono-stereo.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('DSPMonoStereo');
  const dsp = parseDSPMonoStereoEl(els && els[0]);
  assert.ok(dsp);
  assert.equal(dsp.mode, 'stereo');
});

// --- parseCapabilitiesXml -------------------------------------------

test('parseCapabilitiesXml: surfaces deviceID, dspMonoStereo, and named capabilities', async () => {
  const xml = await fixture('capabilities.xml');
  const caps = parseCapabilitiesXml(xml);
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

test('parseCapabilitiesXml: empty string returns null', () => {
  assert.equal(parseCapabilitiesXml(''), null);
});

test('parseCapabilitiesXml: non-capabilities XML returns null', () => {
  assert.equal(parseCapabilitiesXml('<volume>0</volume>'), null);
});

test('parseCapabilitiesEl: null input returns null', () => {
  assert.equal(parseCapabilitiesEl(null), null);
});

test('parseCapabilitiesEl: parses a DOM element directly', async () => {
  const xml = await fixture('capabilities.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('capabilities');
  const caps = parseCapabilitiesEl(els && els[0]);
  assert.ok(caps);
  assert.equal(caps.deviceID, '3415139ABD77');
  assert.equal(caps.lrStereoCapable, true);
});

// --- parseRecentsXml ------------------------------------------------

test('parseRecentsXml: returns array with TUNEIN + SPOTIFY entries', async () => {
  const xml = await fixture('recents.xml');
  const recents = parseRecentsXml(xml);
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

test('parseRecentsXml: empty <recents/> returns []', async () => {
  const xml = await fixture('recents-empty.xml');
  const recents = parseRecentsXml(xml);
  assert.ok(Array.isArray(recents));
  assert.equal(recents.length, 0);
});

test('parseRecentsXml: empty string returns null', () => {
  assert.equal(parseRecentsXml(''), null);
});

test('parseRecentsXml: non-recents XML returns null', () => {
  assert.equal(parseRecentsXml('<volume>0</volume>'), null);
});

test('parseRecentsEl: null input returns null', () => {
  assert.equal(parseRecentsEl(null), null);
});

test('parseRecentsEl: parses a DOM element directly', async () => {
  const xml = await fixture('recents.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('recents');
  const recents = parseRecentsEl(els && els[0]);
  assert.ok(Array.isArray(recents));
  assert.equal(recents.length, 5);
  assert.equal(recents[1].itemName, '95.5 Charivari');
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

// --- parseZoneXml --------------------------------------------------

test('parseZoneXml: standalone <zone/> → empty members, no master', async () => {
  const xml = await fixture('zone-standalone.xml');
  const zone = parseZoneXml(xml);
  assert.ok(zone, 'returns a non-null object');
  assert.equal(zone.master, '');
  assert.equal(zone.masterIpAddress, '');
  assert.equal(zone.isMaster, false);
  assert.ok(Array.isArray(zone.members));
  assert.equal(zone.members.length, 0);
});

test('parseZoneXml: master shape — isMaster=true, members populated', async () => {
  const xml = await fixture('zone-master.xml');
  const zone = parseZoneXml(xml);
  assert.ok(zone);
  assert.equal(zone.master, '3415139ABD77');
  assert.equal(zone.masterIpAddress, '');
  assert.equal(zone.isMaster, true, 'no senderIPAddress → master view');
  assert.equal(zone.members.length, 2);
  assert.equal(zone.members[0].deviceID, '689E19D55555');
  assert.equal(zone.members[0].ipAddress, '192.168.178.40');
  assert.equal(zone.members[0].role, 'LEFT');
});

test('parseZoneXml: member shape — senderIPAddress set, isMaster=false', async () => {
  const xml = await fixture('zone-member.xml');
  const zone = parseZoneXml(xml);
  assert.ok(zone);
  assert.equal(zone.master, '689E19D55555');
  assert.equal(zone.masterIpAddress, '192.168.178.40');
  assert.equal(zone.isMaster, false, 'senderIPAddress → slave view');
  assert.equal(zone.members.length, 2);
});

test('parseZoneXml: empty string returns null', () => {
  assert.equal(parseZoneXml(''), null);
});

test('parseZoneXml: non-zone XML returns null', () => {
  assert.equal(parseZoneXml('<volume>0</volume>'), null);
});

test('parseZoneEl: null input returns null', () => {
  assert.equal(parseZoneEl(null), null);
});

test('parseZoneEl: parses a DOM element directly', async () => {
  const xml = await fixture('zone-master.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('zone');
  const zone = parseZoneEl(els && els[0]);
  assert.ok(zone);
  assert.equal(zone.master, '3415139ABD77');
  assert.equal(zone.members.length, 2);
});

// --- parseListMediaServersXml --------------------------------------

test('parseListMediaServersXml: standalone (only DLNA peers, no Bose) returns []', async () => {
  const xml = await fixture('list-media-servers.xml');
  const peers = parseListMediaServersXml(xml);
  assert.ok(Array.isArray(peers));
  assert.equal(peers.length, 0, 'AVM FRITZ!Box entries are filtered out');
});

test('parseListMediaServersXml: keeps Bose-marked entries with mac/ip/name', async () => {
  const xml = await fixture('list-media-servers-with-bose.xml');
  const peers = parseListMediaServersXml(xml);
  assert.ok(Array.isArray(peers));
  assert.equal(peers.length, 1);
  assert.equal(peers[0].mac, '689E19D55555');
  assert.equal(peers[0].ip, '192.168.178.40');
  assert.equal(peers[0].name, 'Kitchen');
  assert.equal(peers[0].model, 'SoundTouch 20');
});

test('parseListMediaServersXml: empty string returns null', () => {
  assert.equal(parseListMediaServersXml(''), null);
});

test('parseListMediaServersEl: null input returns null', () => {
  assert.equal(parseListMediaServersEl(null), null);
});
