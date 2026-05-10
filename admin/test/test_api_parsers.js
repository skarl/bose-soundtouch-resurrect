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
