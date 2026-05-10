// Tests for api.js parsers: parseNowPlayingXml / parseNowPlayingEl / parseSourcesXml.
// Slice 3 will add volume cases.
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
  parseVolumeXml, parseVolumeEl,
  parseSourcesXml, parseSourcesEl,
  parseNetworkInfoXml, parseNetworkInfoEl,
  parseSystemTimeoutXml, parseSystemTimeoutEl,
  parseLowPowerStandbyXml, parseLowPowerStandbyEl,
  parseBluetoothInfoXml, parseBluetoothInfoEl,
} from '../app/api.js';
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

// --- parseLowPowerStandbyXml ----------------------------------------

test('parseLowPowerStandbyXml: enabled=true', async () => {
  const xml = await fixture('lowPowerStandby.xml');
  const lps = parseLowPowerStandbyXml(xml);
  assert.ok(lps, 'returns a non-null object');
  assert.equal(lps.enabled, true);
});

test('parseLowPowerStandbyXml: enabled=false', async () => {
  const xml = await fixture('lowPowerStandby-off.xml');
  const lps = parseLowPowerStandbyXml(xml);
  assert.ok(lps, 'returns a non-null object');
  assert.equal(lps.enabled, false);
});

test('parseLowPowerStandbyXml: empty string returns null', () => {
  assert.equal(parseLowPowerStandbyXml(''), null);
});

test('parseLowPowerStandbyXml: non-lowPowerStandby XML returns null', () => {
  assert.equal(parseLowPowerStandbyXml('<volume>0</volume>'), null);
});

test('parseLowPowerStandbyEl: null input returns null', () => {
  assert.equal(parseLowPowerStandbyEl(null), null);
});

test('parseLowPowerStandbyEl: parses a DOM element directly', async () => {
  const xml = await fixture('lowPowerStandby.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('lowPowerStandby');
  const lps = parseLowPowerStandbyEl(els && els[0]);
  assert.ok(lps, 'returns a non-null object');
  assert.equal(lps.enabled, true);
});

// --- parseBluetoothInfoXml ------------------------------------------

test('parseBluetoothInfoXml: empty pairedList returns paired=[]', async () => {
  const xml = await fixture('bluetooth-info-empty.xml');
  const bt = parseBluetoothInfoXml(xml);
  assert.ok(bt, 'returns a non-null object');
  assert.ok(Array.isArray(bt.paired), 'paired is an array');
  assert.equal(bt.paired.length, 0);
});

test('parseBluetoothInfoXml: populated returns name+mac per device', async () => {
  const xml = await fixture('bluetooth-info-populated.xml');
  const bt = parseBluetoothInfoXml(xml);
  assert.ok(bt);
  assert.equal(bt.paired.length, 2);
  assert.equal(bt.paired[0].name, "Sven's Phone");
  assert.equal(bt.paired[0].mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(bt.paired[1].name, 'MacBook Pro');
  assert.equal(bt.paired[1].mac, '11:22:33:44:55:66');
});

test('parseBluetoothInfoXml: bare <BluetoothInfo/> returns paired=[]', () => {
  const bt = parseBluetoothInfoXml('<BluetoothInfo/>');
  assert.ok(bt);
  assert.equal(bt.paired.length, 0);
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
  const xml = await fixture('bluetooth-info-populated.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const els = doc.getElementsByTagName('BluetoothInfo');
  const bt = parseBluetoothInfoEl(els && els[0]);
  assert.ok(bt);
  assert.equal(bt.paired.length, 2);
  assert.equal(bt.paired[0].mac, 'AA:BB:CC:DD:EE:FF');
});
