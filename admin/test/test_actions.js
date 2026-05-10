// Tests for app/actions/* — speaker-action surface.
//
// Covers:
//   - ledger: record then wasRecent within / outside window, with / without detail
//   - one-shot record-then-POST attribution
//   - slider factory: queue + coalesce under fast set(), hasPending flips,
//     confirm flips the internal "speaker is already at this level" gate
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { recordOutgoing, wasRecent } from '../app/actions/ledger.js';
import { makeSliderController } from '../app/actions/sliders.js';

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

// --- ledger ----------------------------------------------------------

test('ledger: record + wasRecent within window with detail', () => {
  recordOutgoing('preset', 3);
  assert.equal(wasRecent('preset', 3), true);
});

test('ledger: wasRecent with mismatched detail → false', () => {
  recordOutgoing('preset', 3);
  assert.equal(wasRecent('preset', 4), false);
});

test('ledger: wasRecent before any record → false', () => {
  assert.equal(wasRecent('transport', 99), false);
});

test('ledger: record without detail, wasRecent without detail → true', () => {
  recordOutgoing('volume');
  assert.equal(wasRecent('volume'), true);
});

test('ledger: record without detail, wasRecent with detail → false', () => {
  recordOutgoing('source');
  assert.equal(wasRecent('source', 'something'), false);
});

test('ledger: record with detail, wasRecent without detail → true (prefix match)', () => {
  recordOutgoing('preset', 5);
  assert.equal(wasRecent('preset'), true);
});

test('ledger: wasRecent respects withinMs window', async () => {
  recordOutgoing('preset', 7);
  assert.equal(wasRecent('preset', 7, 50), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(wasRecent('preset', 7, 50), false);
});

// --- slider factory --------------------------------------------------

function makeMockPost() {
  const calls = [];
  const resolvers = [];
  function postFn(level) {
    calls.push(level);
    return new Promise((resolve) => { resolvers.push(resolve); });
  }
  function resolveNext() {
    const r = resolvers.shift();
    if (r) r();
  }
  return { postFn, calls, resolveNext };
}

// makeSliderController reads/writes store.state.speaker[field].targetVolume,
// so each test seeds that field on the imported singleton store before
// instantiating its controller. The controllers under test are
// per-test instances built via the factory directly.
import { store } from '../app/state.js';
function seed(field, value) {
  store.state.speaker[field] = value;
}

test('slider: queue + coalesce — only leading and trailing reach postFn', async () => {
  const { postFn, calls, resolveNext } = makeMockPost();
  seed('volume', { targetVolume: 10, actualVolume: 10, muteEnabled: false });
  const ctl = makeSliderController({ field: 'volume', postFn, eventTag: 'volume' });

  ctl.set(20);
  await tick();
  assert.equal(calls.length, 1, 'leading POST in flight');

  ctl.set(25);
  ctl.set(30);

  resolveNext();
  await tick();
  await tick();

  assert.equal(calls[0], 20, 'leading is 20');
  assert.equal(calls[1], 30, 'trailing is 30 — 25 dropped');
  assert.equal(calls.length, 2);

  resolveNext();
  await tick();
});

test('slider: hasPending flips during in-flight + queued, false again after drain', async () => {
  const { postFn, resolveNext } = makeMockPost();
  seed('volume', { targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const ctl = makeSliderController({ field: 'volume', postFn, eventTag: 'volume' });

  assert.equal(ctl.hasPending(), false, 'idle');

  ctl.set(40);
  await tick();
  assert.equal(ctl.hasPending(), true, 'in-flight after set');

  ctl.set(50);
  assert.equal(ctl.hasPending(), true, 'still pending with queued');

  resolveNext(); await tick(); await tick();
  resolveNext(); await tick(); await tick();

  assert.equal(ctl.hasPending(), false, 'drained');
});

test('slider: confirm(N) suppresses immediately following set(N)', async () => {
  const { postFn, calls } = makeMockPost();
  seed('volume', { targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const ctl = makeSliderController({ field: 'volume', postFn, eventTag: 'volume' });

  ctl.confirm(40);
  ctl.set(40);
  await tick();
  assert.equal(calls.length, 0, 'set(N) after confirm(N) is a no-op');
});

test('slider: confirm(N) does not suppress set(M) for M ≠ N', async () => {
  const { postFn, calls, resolveNext } = makeMockPost();
  seed('volume', { targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const ctl = makeSliderController({ field: 'volume', postFn, eventTag: 'volume' });

  ctl.confirm(40);
  ctl.set(50);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 50);

  resolveNext();
  await tick();
});

test('slider: set() also stamps the ledger so wasRecent(eventTag) is true', async () => {
  const { postFn, resolveNext } = makeMockPost();
  seed('volume', { targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const ctl = makeSliderController({ field: 'volume', postFn, eventTag: 'volume' });

  ctl.set(60);
  await tick();
  assert.equal(wasRecent('volume', null, 1000), true,
    'one-shot: a slider POST records its outgoing kind');

  resolveNext();
  await tick();
});
