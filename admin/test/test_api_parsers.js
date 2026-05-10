// Tests for api.js parsers: parseNowPlayingXml / parseNowPlayingEl.
// Slice 3 will add volume, slice 5 will add sources cases.
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

import { parseNowPlayingXml, parseNowPlayingEl, parseVolumeXml, parseVolumeEl } from '../app/api.js';
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
