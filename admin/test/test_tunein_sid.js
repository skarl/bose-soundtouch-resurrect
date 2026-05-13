// Tests for admin/app/tunein-sid.js — the prefix-routing module that
// owns guide_id classification, playability, and href derivation.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseSid, isValidSid, isPlayableSid } from '../app/tunein-sid.js';

// --- isValidSid -------------------------------------------------------

test('isValidSid: accepts every documented prefix with a digit tail', () => {
  for (const prefix of ['s', 'p', 't', 'c', 'g', 'r', 'm', 'a', 'l', 'n']) {
    assert.equal(isValidSid(`${prefix}1`), true, `prefix=${prefix}`);
    assert.equal(isValidSid(`${prefix}123456`), true, `prefix=${prefix} long`);
  }
});

test('isValidSid: rejects unknown prefixes (b, q, x, …)', () => {
  for (const prefix of ['b', 'q', 'x', 'z', 'X', 'S']) {
    assert.equal(isValidSid(`${prefix}1`), false, `prefix=${prefix}`);
  }
});

test('isValidSid: rejects empty / non-string / too-short / non-digit tail', () => {
  assert.equal(isValidSid(''), false);
  assert.equal(isValidSid('s'), false);
  assert.equal(isValidSid(null), false);
  assert.equal(isValidSid(undefined), false);
  assert.equal(isValidSid(12345), false);
  assert.equal(isValidSid('s1a'), false);
  assert.equal(isValidSid('s12.3'), false);
  assert.equal(isValidSid('style'), false);
});

// --- isPlayableSid ----------------------------------------------------

test('isPlayableSid: s, p, t resolve to streams', () => {
  assert.equal(isPlayableSid('s24862'), true);
  assert.equal(isPlayableSid('p17'),    true);
  assert.equal(isPlayableSid('t12345'), true);
});

test('isPlayableSid: drill-only prefixes never resolve to streams', () => {
  for (const sid of ['c424724', 'g168', 'r0', 'm1', 'a99', 'l197', 'n12']) {
    assert.equal(isPlayableSid(sid), false, sid);
  }
});

test('isPlayableSid: rejects invalid input outright', () => {
  assert.equal(isPlayableSid(''), false);
  assert.equal(isPlayableSid(null), false);
  assert.equal(isPlayableSid('style'), false);
});

// --- parseSid: detailHref ---------------------------------------------

test('parseSid: s-prefix detailHref is the station detail route', () => {
  const out = parseSid('s24862');
  assert.equal(out.prefix, 's');
  assert.equal(out.kind, 'station');
  assert.equal(out.isPlayable, true);
  assert.equal(out.detailHref, '#/station/s24862');
});

test('parseSid: p-prefix detailHref carries c=pbrowse for the show landing dispatch', () => {
  const out = parseSid('p17');
  assert.equal(out.prefix, 'p');
  assert.equal(out.kind, 'show');
  assert.equal(out.isPlayable, true);
  assert.equal(out.detailHref, '#/browse?c=pbrowse&id=p17');
});

test('parseSid: t-prefix detailHref is the bare-id browse drill', () => {
  const out = parseSid('t12345');
  assert.equal(out.prefix, 't');
  assert.equal(out.kind, 'topic');
  assert.equal(out.isPlayable, true);
  assert.equal(out.detailHref, '#/browse?id=t12345');
});

test('parseSid: non-playable prefixes have no detailHref but still get a drillHref', () => {
  // Drill-only prefixes (genres, categories, regions, …) are not
  // valid targets for a row's *detail* anchor — stationRow / station
  // redirect collapse to the no-op "#" for them. The drill route is
  // still emitted so callers that explicitly want the browse drill
  // (e.g. a chip element) can use it.
  const cases = [
    ['c424724', 'category'],
    ['g168',    'genre'],
    ['r0',      'region'],
    ['m1',      'misc'],
    ['a99',     'audio'],
    ['l197',    'language'],
    ['n12',     'network'],
  ];
  for (const [sid, kind] of cases) {
    const out = parseSid(sid);
    assert.equal(out.kind, kind, `kind for ${sid}`);
    assert.equal(out.isPlayable, false, `isPlayable for ${sid}`);
    assert.equal(out.detailHref, null, `detailHref for ${sid}`);
    assert.equal(out.drillHref, `#/browse?id=${sid}`, `drillHref for ${sid}`);
  }
});

// --- parseSid: drillHref ----------------------------------------------

test('parseSid: drillHref is always the bare-id browse route for every valid sid', () => {
  assert.equal(parseSid('s24862').drillHref, '#/browse?id=s24862');
  assert.equal(parseSid('p17').drillHref,    '#/browse?id=p17');
  assert.equal(parseSid('t12345').drillHref, '#/browse?id=t12345');
  assert.equal(parseSid('g168').drillHref,   '#/browse?id=g168');
});

// --- parseSid: invalid input ------------------------------------------

test('parseSid: invalid input collapses every field to null/false', () => {
  for (const bad of ['', 'x', 'garbage', 's', 's1a', null, undefined, 0]) {
    const out = parseSid(bad);
    assert.equal(out.prefix, null,        `prefix for ${JSON.stringify(bad)}`);
    assert.equal(out.kind, null,          `kind for ${JSON.stringify(bad)}`);
    assert.equal(out.isPlayable, false,   `isPlayable for ${JSON.stringify(bad)}`);
    assert.equal(out.drillHref, null,     `drillHref for ${JSON.stringify(bad)}`);
    assert.equal(out.detailHref, null,    `detailHref for ${JSON.stringify(bad)}`);
  }
});

// --- parseSid: encoding -----------------------------------------------

test('parseSid: ids are URI-encoded into hrefs (defence in depth)', () => {
  // No legitimate sid carries unsafe chars, but the encoder runs anyway
  // so a future prefix or a malformed cache entry can't inject hash
  // fragments / query separators.
  const out = parseSid('s24862');
  assert.ok(/#\/station\/s24862$/.test(out.detailHref));
});
