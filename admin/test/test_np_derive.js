// Tests for app/np-derive.js — pure derivations for the now-playing
// view + mini-player (#108 extraction). Every exported helper gets at
// least one positive case + one defensive/empty case.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  pickTrackLine,
  pickMetaLine,
  humaniseSourceKey,
} from '../app/np-derive.js';

// --- pickTrackLine --------------------------------------------------

test('pickTrackLine: joins artist + track with em-dash when both distinct', () => {
  const np = { artist: 'Miles Davis', track: 'So What' };
  assert.equal(pickTrackLine(np, 'KEXP'), 'Miles Davis – So What');
});

test('pickTrackLine: drops artist when it matches station (case-insensitive)', () => {
  const np = { artist: 'KEXP', track: 'Live Stream' };
  assert.equal(pickTrackLine(np, 'kexp'), 'Live Stream');
});

test('pickTrackLine: drops track when it matches station (case-insensitive)', () => {
  const np = { artist: 'Coltrane', track: 'KEXP' };
  assert.equal(pickTrackLine(np, 'KEXP'), 'Coltrane');
});

test('pickTrackLine: drops track when it duplicates artist', () => {
  const np = { artist: 'Same', track: 'same' };
  assert.equal(pickTrackLine(np, 'Station'), 'Same');
});

test('pickTrackLine: returns "" for null np', () => {
  assert.equal(pickTrackLine(null, 'KEXP'), '');
  assert.equal(pickTrackLine(undefined, 'KEXP'), '');
});

test('pickTrackLine: returns "" when both fields collapse against the station', () => {
  const np = { artist: 'KEXP', track: 'KEXP' };
  assert.equal(pickTrackLine(np, 'KEXP'), '');
});

test('pickTrackLine: trims whitespace from artist/track', () => {
  const np = { artist: '  Miles  ', track: '  So What  ' };
  assert.equal(pickTrackLine(np, 'KEXP'), 'Miles – So What');
});

test('pickTrackLine: missing stationName falls through (no spurious dedupe)', () => {
  const np = { artist: 'A', track: 'B' };
  assert.equal(pickTrackLine(np, ''), 'A – B');
  assert.equal(pickTrackLine(np, undefined), 'A – B');
});

test('pickTrackLine: tolerates non-string track/artist', () => {
  const np = { artist: 42, track: null };
  assert.equal(pickTrackLine(np, 'Station'), '');
});

// --- pickMetaLine ---------------------------------------------------

test('pickMetaLine: joins source + item.type with " · "', () => {
  const np = { source: 'TUNEIN', item: { type: 'stationurl' } };
  assert.equal(pickMetaLine(np), 'TUNEIN · stationurl');
});

test('pickMetaLine: emits just the source when item.type missing', () => {
  assert.equal(pickMetaLine({ source: 'TUNEIN', item: {} }), 'TUNEIN');
  assert.equal(pickMetaLine({ source: 'TUNEIN' }), 'TUNEIN');
});

test('pickMetaLine: emits just the type when source missing', () => {
  assert.equal(pickMetaLine({ item: { type: 'track' } }), 'track');
});

test('pickMetaLine: STANDBY source is suppressed entirely', () => {
  assert.equal(pickMetaLine({ source: 'STANDBY' }), '');
  assert.equal(pickMetaLine({ source: 'STANDBY', item: { type: 'idle' } }), 'idle');
});

test('pickMetaLine: returns "" for null np', () => {
  assert.equal(pickMetaLine(null), '');
  assert.equal(pickMetaLine(undefined), '');
});

test('pickMetaLine: empty everything yields ""', () => {
  assert.equal(pickMetaLine({}), '');
});

// --- humaniseSourceKey ----------------------------------------------

test('humaniseSourceKey: title-cases UPPER_SNAKE keys', () => {
  assert.equal(humaniseSourceKey('LOCAL_INTERNET_RADIO'), 'Local Internet Radio');
  assert.equal(humaniseSourceKey('TUNEIN'), 'Tunein');
  assert.equal(humaniseSourceKey('BLUETOOTH'), 'Bluetooth');
});

test('humaniseSourceKey: single-word lowercase input round-trips title-cased', () => {
  assert.equal(humaniseSourceKey('aux'), 'Aux');
});

test('humaniseSourceKey: handles null / undefined / empty', () => {
  assert.equal(humaniseSourceKey(null), '');
  assert.equal(humaniseSourceKey(undefined), '');
  assert.equal(humaniseSourceKey(''), '');
});

test('humaniseSourceKey: tolerates non-string input', () => {
  assert.equal(humaniseSourceKey(42), '42');
});
