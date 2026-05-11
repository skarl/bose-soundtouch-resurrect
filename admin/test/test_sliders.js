// Tests for app/sliders.js — optimistic-merge state machine.
//
// Covers the interleavings of three event streams that a slider field
// arbitrates: local set() during drag, in-flight POST resolution, and
// WS-derived applyIncoming() arrivals. Tests build controllers via
// makeSliderController() with a fake postFn whose promises the test
// resolves explicitly — no real timers, no live network, no WS.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { store } from '../app/state.js';
import { makeSliderController } from '../app/sliders.js';

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

// Deferred-promise transport: each postFn(level) call appends to
// `calls` and parks until the test calls resolveNext(). Mirrors the
// makeMockPost() helper in test_actions.js.
function makeFakeTransport() {
  const calls = [];
  const pending = [];
  function postFn(level) {
    calls.push(level);
    return new Promise((resolve) => { pending.push(resolve); });
  }
  function resolveNext() {
    const r = pending.shift();
    if (r) r();
  }
  return { postFn, calls, resolveNext };
}

// Seed state.speaker[field] before instantiating a controller — set()
// mutates targetProp on it via store.update().
function seed(field, value) { store.state.speaker[field] = value; }

function buildVolume() {
  seed('volume', { targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const tx = makeFakeTransport();
  const ctl = makeSliderController({ field: 'volume', postFn: tx.postFn, eventTag: 'volume' });
  return { tx, ctl };
}

function buildBass() {
  seed('bass', { targetBass: 0, actualBass: 0 });
  const tx = makeFakeTransport();
  const ctl = makeSliderController({
    field: 'bass', postFn: tx.postFn, eventTag: 'bass', targetProperty: 'targetBass',
  });
  return { tx, ctl };
}

function buildBalance() {
  seed('balance', { targetBalance: 0, actualBalance: 0 });
  const tx = makeFakeTransport();
  const ctl = makeSliderController({
    field: 'balance', postFn: tx.postFn, eventTag: 'balance', targetProperty: 'targetBalance',
  });
  return { tx, ctl };
}

// --- Idle path: set(N) → POST resolves → applyIncoming(N) is a no-op ---

test('idle → set(N) → POST resolves → applyIncoming(N) accepts verbatim and confirms', async () => {
  const { tx, ctl } = buildVolume();

  ctl.set(40);
  await tick();
  assert.equal(tx.calls.length, 1, 'leading POST in flight');
  assert.equal(store.state.speaker.volume.targetVolume, 40, 'target written optimistically');

  tx.resolveNext();
  await tick(); await tick();
  assert.equal(ctl.hasPending(), false, 'drained');

  const state = { speaker: { volume: store.state.speaker.volume } };
  ctl.applyIncoming(state, { targetVolume: 40, actualVolume: 40, muteEnabled: false });
  assert.deepEqual(
    state.speaker.volume,
    { targetVolume: 40, actualVolume: 40, muteEnabled: false },
    'incoming value applied verbatim when no drag is pending',
  );

  // A confirm(40) follow-up is implicit — verify by issuing set(40) and
  // observing that no new POST is queued.
  ctl.set(40);
  await tick();
  assert.equal(tx.calls.length, 1, 'set(N) after applyIncoming(N) is gated by confirm');
});

// --- In-flight POST: applyIncoming(remoteN) does not yank the thumb ---

test('drag in flight → applyIncoming(remote) preserves local target', async () => {
  const { ctl } = buildVolume();

  ctl.set(60);
  await tick();
  assert.equal(ctl.hasPending(), true, 'POST in flight');

  // WS event arrives carrying the speaker's stale view: it still thinks
  // both target and actual are 30. The merge must keep our 60.
  const state = { speaker: { volume: { targetVolume: 60, actualVolume: 60 } } };
  ctl.applyIncoming(state, { targetVolume: 30, actualVolume: 30, muteEnabled: false });

  assert.equal(state.speaker.volume.targetVolume, 60, 'local target preserved');
  assert.equal(state.speaker.volume.actualVolume, 30, 'speaker-owned actualVolume updated');
  assert.equal(state.speaker.volume.muteEnabled, false, 'other speaker-owned fields applied');
});

// --- Drag ends: post resolves, then applyIncoming arrives → accept ---

test('drag ends → POST resolves → applyIncoming(remote) accepted verbatim', async () => {
  const { tx, ctl } = buildVolume();

  ctl.set(70);
  await tick();
  tx.resolveNext();
  await tick(); await tick();
  assert.equal(ctl.hasPending(), false, 'drained');

  const state = { speaker: { volume: { targetVolume: 70, actualVolume: 70 } } };
  ctl.applyIncoming(state, { targetVolume: 70, actualVolume: 70, muteEnabled: true });
  assert.deepEqual(
    state.speaker.volume,
    { targetVolume: 70, actualVolume: 70, muteEnabled: true },
    'incoming value taken whole once drag has settled',
  );
});

// --- Out-of-order WS during in-flight POST: no thumb bounce ---

test('out-of-order WS during in-flight POST: thumb does not bounce', async () => {
  const { tx, ctl } = buildVolume();

  ctl.set(80);
  await tick();

  // Stale WS frame mid-flight (speaker not yet at 80).
  const state = { speaker: { volume: { targetVolume: 80, actualVolume: 80 } } };
  ctl.applyIncoming(state, { targetVolume: 20, actualVolume: 20, muteEnabled: false });
  assert.equal(state.speaker.volume.targetVolume, 80, 'thumb pinned at user target through stale event');

  // POST finishes, no queued trailing edge — drained.
  tx.resolveNext();
  await tick(); await tick();
  assert.equal(ctl.hasPending(), false, 'drained after POST');

  // Authoritative WS frame at the new level arrives — now accepted.
  ctl.applyIncoming(state, { targetVolume: 80, actualVolume: 80, muteEnabled: false });
  assert.deepEqual(
    state.speaker.volume,
    { targetVolume: 80, actualVolume: 80, muteEnabled: false },
    'authoritative event accepted once pending clears',
  );

  // confirm(80) implied by applyIncoming — set(80) is a no-op.
  ctl.set(80);
  await tick();
  assert.equal(tx.calls.length, 1, 'no follow-up POST after confirm');
});

// --- Drag continuing during queued trailing edge ---

test('drag with trailing edge queued: applyIncoming still preserves local target', async () => {
  const { tx, ctl } = buildVolume();

  ctl.set(10);            // leading
  await tick();
  ctl.set(50);            // queued trailing
  assert.equal(ctl.hasPending(), true, 'queued counts as pending');

  // Stale WS frame arrives while trailing edge is queued behind the
  // in-flight POST. Target should still be the queued 50.
  const state = { speaker: { volume: { targetVolume: 50, actualVolume: 50 } } };
  ctl.applyIncoming(state, { targetVolume: 10, actualVolume: 10, muteEnabled: false });
  assert.equal(state.speaker.volume.targetVolume, 50, 'queued target preserved');
  assert.equal(state.speaker.volume.actualVolume, 10, 'actual still reflects speaker view');

  // Drain leading + trailing POSTs.
  tx.resolveNext();
  await tick(); await tick();
  tx.resolveNext();
  await tick(); await tick();
  assert.equal(ctl.hasPending(), false, 'fully drained');
  assert.equal(tx.calls.length, 2, 'leading + trailing reached postFn');
  assert.equal(tx.calls[1], 50, 'trailing carries final user value');
});

// --- applyIncoming with a falsy value is a guard, not a clear ---

test('applyIncoming(null) is a no-op — does not clobber state', () => {
  const { ctl } = buildVolume();
  const before = { targetVolume: 33, actualVolume: 33, muteEnabled: false };
  const state = { speaker: { volume: { ...before } } };
  ctl.applyIncoming(state, null);
  assert.deepEqual(state.speaker.volume, before, 'null incoming leaves state untouched');
});

// --- applyIncoming when state.speaker[field] is null (cold start) ----

test('applyIncoming on cold state (no prior value) accepts verbatim', () => {
  const { ctl } = buildVolume();
  const state = { speaker: { volume: null } };
  ctl.applyIncoming(state, { targetVolume: 5, actualVolume: 5, muteEnabled: false });
  assert.deepEqual(state.speaker.volume, { targetVolume: 5, actualVolume: 5, muteEnabled: false });
});

// --- bass and balance use the same merge contract via targetProperty ---

test('bass: applyIncoming during drag preserves targetBass', async () => {
  const { ctl } = buildBass();
  ctl.set(-3);
  await tick();
  const state = { speaker: { bass: { targetBass: -3, actualBass: -3 } } };
  ctl.applyIncoming(state, { targetBass: 0, actualBass: 0 });
  assert.equal(state.speaker.bass.targetBass, -3, 'targetBass pinned to user value');
  assert.equal(state.speaker.bass.actualBass, 0, 'actualBass updated from speaker');
});

test('balance: applyIncoming when idle accepts verbatim and confirms', async () => {
  const { tx, ctl } = buildBalance();
  const state = { speaker: { balance: null } };
  ctl.applyIncoming(state, { targetBalance: 4, actualBalance: 4 });
  assert.deepEqual(state.speaker.balance, { targetBalance: 4, actualBalance: 4 });

  // confirm(4) is implied — set(4) should not POST.
  seed('balance', { targetBalance: 4, actualBalance: 4 });
  ctl.set(4);
  await tick();
  assert.equal(tx.calls.length, 0, 'set(N) after applyIncoming(N) is gated');
});
