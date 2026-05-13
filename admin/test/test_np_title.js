// Tests for admin/app/np-title.js — the shared title helper called
// by the shell mini-player + the now-playing view. The two callers
// used to derive the same value with subtly different guards (#97).
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { renderNowPlayingTitle } from '../app/np-title.js';

test('renderNowPlayingTitle: prefers item.name over track', () => {
  const np = { item: { name: 'Fresh Air' }, track: 'NPR' };
  assert.equal(renderNowPlayingTitle(np), 'Fresh Air');
});

test('renderNowPlayingTitle: falls back to track when item.name is missing', () => {
  const np = { item: { location: '/v1/x' }, track: 'Live News' };
  assert.equal(renderNowPlayingTitle(np), 'Live News');
});

test('renderNowPlayingTitle: empty item.name falls through to track', () => {
  // Defensive against firmware payloads that include the field but
  // leave it empty — fall-through preserves the painted title row.
  const np = { item: { name: '' }, track: 'Live News' };
  assert.equal(renderNowPlayingTitle(np), 'Live News');
});

test('renderNowPlayingTitle: returns "" when both are missing', () => {
  assert.equal(renderNowPlayingTitle({ item: {} }), '');
  assert.equal(renderNowPlayingTitle({}), '');
});

test('renderNowPlayingTitle: tolerates null / undefined / missing item', () => {
  assert.equal(renderNowPlayingTitle(null), '');
  assert.equal(renderNowPlayingTitle(undefined), '');
  assert.equal(renderNowPlayingTitle({ track: 'X' }), 'X');
});
