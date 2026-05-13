// Tests for app/station-verdict.js — pure derivations for the station
// detail view (#108 extraction). Fixture-driven: every exported helper
// gets at least one positive case + one defensive/empty case.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  pickArt,
  bestStream,
  buildMetaText,
  fmtCodec,
  fmtReliability,
} from '../app/station-verdict.js';

// --- pickArt --------------------------------------------------------

test('pickArt: prefers logo over image when both present', () => {
  assert.equal(
    pickArt({ logo: 'http://x/logo.png', image: 'http://x/img.png' }),
    'http://x/logo.png',
  );
});

test('pickArt: falls back to image when logo is absent', () => {
  assert.equal(pickArt({ image: 'http://x/img.png' }), 'http://x/img.png');
});

test('pickArt: returns "" when neither field is present', () => {
  assert.equal(pickArt({ name: 'no art here' }), '');
});

test('pickArt: returns "" for null / non-object / non-string url', () => {
  assert.equal(pickArt(null), '');
  assert.equal(pickArt(undefined), '');
  assert.equal(pickArt('not an object'), '');
  assert.equal(pickArt({ logo: 42 }), '');
});

// --- buildMetaText --------------------------------------------------

test('buildMetaText: joins location . language . genre_name with " . "', () => {
  assert.equal(
    buildMetaText({ location: 'Berlin', language: 'German', genre_name: 'Jazz' }),
    'Berlin . German . Jazz',
  );
});

test('buildMetaText: emits "FREQ BAND" when both frequency + band present', () => {
  assert.equal(
    buildMetaText({ location: 'Seattle', frequency: '90.3', band: 'FM' }),
    'Seattle . 90.3 FM',
  );
});

test('buildMetaText: emits bare frequency when band is missing', () => {
  assert.equal(
    buildMetaText({ frequency: '90.3' }),
    '90.3',
  );
});

test('buildMetaText: skips empty fields so dots don\'t orphan', () => {
  assert.equal(buildMetaText({ location: 'Berlin', language: '' }), 'Berlin');
  assert.equal(buildMetaText({}), '');
});

test('buildMetaText: returns "" for null / non-object', () => {
  assert.equal(buildMetaText(null), '');
  assert.equal(buildMetaText(undefined), '');
  assert.equal(buildMetaText('oops'), '');
});

// --- bestStream -----------------------------------------------------

test('bestStream: picks the highest-bitrate stream', () => {
  const streams = [
    { streamUrl: 'a', bitrate: 64 },
    { streamUrl: 'b', bitrate: 192 },
    { streamUrl: 'c', bitrate: 128 },
  ];
  assert.equal(bestStream(streams).streamUrl, 'b');
});

test('bestStream: handles string bitrates (Number-coerces)', () => {
  const streams = [
    { streamUrl: 'a', bitrate: '64' },
    { streamUrl: 'b', bitrate: '192' },
  ];
  assert.equal(bestStream(streams).streamUrl, 'b');
});

test('bestStream: missing bitrate treated as -1 (lowest)', () => {
  const streams = [
    { streamUrl: 'a' },
    { streamUrl: 'b', bitrate: 32 },
  ];
  assert.equal(bestStream(streams).streamUrl, 'b');
});

test('bestStream: returns null for empty / non-array', () => {
  assert.equal(bestStream([]), null);
  assert.equal(bestStream(null), null);
  assert.equal(bestStream(undefined), null);
  assert.equal(bestStream('nope'), null);
});

test('bestStream: keeps the first stream as default when all scores tie', () => {
  const streams = [
    { streamUrl: 'a', bitrate: 128 },
    { streamUrl: 'b', bitrate: 128 },
  ];
  assert.equal(bestStream(streams).streamUrl, 'a');
});

// --- fmtCodec -------------------------------------------------------

test('fmtCodec: uppercases media_type', () => {
  assert.equal(fmtCodec({ media_type: 'aac' }), 'AAC');
});

test('fmtCodec: falls back to formats when media_type absent', () => {
  assert.equal(fmtCodec({ formats: 'mp3' }), 'MP3');
});

test('fmtCodec: returns "" for null / missing codec', () => {
  assert.equal(fmtCodec(null), '');
  assert.equal(fmtCodec({}), '');
});

test('fmtCodec: tolerates non-string codec', () => {
  assert.equal(fmtCodec({ media_type: 42 }), '');
});

// --- fmtReliability -------------------------------------------------

test('fmtReliability: returns "NN%" for positive numeric reliability', () => {
  assert.equal(fmtReliability({ reliability: 99 }), '99%');
  assert.equal(fmtReliability({ reliability: '95' }), '95%');
});

test('fmtReliability: returns "" for zero / negative / missing / non-numeric', () => {
  assert.equal(fmtReliability({ reliability: 0 }), '');
  assert.equal(fmtReliability({ reliability: -1 }), '');
  assert.equal(fmtReliability({}), '');
  assert.equal(fmtReliability(null), '');
  assert.equal(fmtReliability({ reliability: 'high' }), '');
});
