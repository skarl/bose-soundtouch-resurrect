// Unit tests for app/io-ledger.js.
//
// Run with: node --test admin/test
//
// Timer tests use real setTimeout so they're a few ms slow but need no
// fake-clock machinery. withinMs is set to a small value (50ms) so the
// wall-clock waits stay under 100ms total.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { recordOutgoing, wasRecentOutgoing } from '../app/io-ledger.js';

test('recordOutgoing then wasRecentOutgoing → true', () => {
  recordOutgoing('preset', 3);
  assert.equal(wasRecentOutgoing('preset', 3), true);
});

test('wasRecentOutgoing with different detail → false', () => {
  recordOutgoing('preset', 3);
  assert.equal(wasRecentOutgoing('preset', 4), false);
});

test('wasRecentOutgoing before any record → false', () => {
  assert.equal(wasRecentOutgoing('transport', 99), false);
});

test('recordOutgoing without detail, wasRecentOutgoing without detail → true', () => {
  recordOutgoing('volume');
  assert.equal(wasRecentOutgoing('volume'), true);
});

test('recordOutgoing without detail, wasRecentOutgoing with detail → false', () => {
  recordOutgoing('source');
  assert.equal(wasRecentOutgoing('source', 'something'), false);
});

test('recordOutgoing with detail, wasRecentOutgoing without detail → true (prefix match)', () => {
  // watchSpeakerButtons calls wasRecentOutgoing('preset') without a slot detail, but
  // recordOutgoing('preset', slot) writes per-slot keys like 'preset:3'.
  recordOutgoing('preset', 5);
  assert.equal(wasRecentOutgoing('preset'), true, 'prefix match: preset:5 matches wasRecentOutgoing("preset")');
});

test('wasRecentOutgoing respects withinMs window', async () => {
  recordOutgoing('preset', 7);
  assert.equal(wasRecentOutgoing('preset', 7, 50), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(wasRecentOutgoing('preset', 7, 50), false);
});
