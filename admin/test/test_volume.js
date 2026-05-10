// Tests for the volume controller in app/volume.js.
//
// Uses a controllable promise — the test holds a resolve handle so it
// can decide exactly when each in-flight POST completes, making the
// sequence deterministic without timers.
//
// Run locally:
//   node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { makeVolumeController } from '../app/volume.js';

// Build a recording mock postVolume.
// returns { postFn, calls, resolveNext }
function makeMock() {
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

// Wait a microtask turn so promise chains (.then/.finally) can flush.
function tick() { return new Promise((resolve) => setImmediate(resolve)); }

// Minimal fake store that tracks update calls and provides state.
function makeStore(volumeState) {
  let touched = 0;
  const state = { speaker: { volume: volumeState } };
  return {
    state,
    update(key, mutator) {
      mutator(state);
      touched++;
    },
    get touchCount() { return touched; },
  };
}

test('throttle/coalesce: rapid set calls → only leading and trailing reach postVolume', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const fakeStore = makeStore({ targetVolume: 10, actualVolume: 10, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: postFn, postKey: () => {} });

  ctrl.set(20);
  await tick();
  assert.equal(calls.length, 1, 'leading POST started');

  ctrl.set(25);
  ctrl.set(30);

  resolveNext();
  await tick();
  await tick();

  assert.equal(calls[0], 20, 'leading call is 20');
  assert.equal(calls[1], 30, 'trailing call is 30 — 25 dropped');
  assert.equal(calls.length, 2, 'exactly 2 postVolume calls');

  resolveNext();
  await tick();
});

test('confirmation gate suppress: confirm(N) then set(N) → no postVolume', async () => {
  const { postFn, calls } = makeMock();
  const fakeStore = makeStore({ targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: postFn, postKey: () => {} });

  ctrl.confirm(40);
  ctrl.set(40);
  await tick();
  assert.equal(calls.length, 0, 'POST suppressed after confirm matches level');
});

test('confirmation gate fires: confirm(N) then set(M) → postVolume(M)', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const fakeStore = makeStore({ targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: postFn, postKey: () => {} });

  ctrl.confirm(40);
  ctrl.set(50);
  await tick();
  assert.equal(calls.length, 1, 'POST fired for different level');
  assert.equal(calls[0], 50);

  resolveNext();
  await tick();
});

test('eager update: set(N) mutates targetVolume synchronously and notifies', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const fakeStore = makeStore({ targetVolume: 0, actualVolume: 0, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: postFn, postKey: () => {} });

  ctrl.set(60);
  assert.equal(fakeStore.state.speaker.volume.targetVolume, 60, 'targetVolume updated synchronously');
  assert.ok(fakeStore.touchCount >= 1, 'speaker key touched');

  await tick();
  assert.equal(calls.length, 1, 'postVolume eventually called');
  assert.equal(calls[0], 60);

  resolveNext();
  await tick();
});

test('adjust positive: targetVolume=30, adjust(+5) → postVolume(35), target=35', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const fakeStore = makeStore({ targetVolume: 30, actualVolume: 30, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: postFn, postKey: () => {} });

  ctrl.adjust(5);
  await tick();
  assert.equal(fakeStore.state.speaker.volume.targetVolume, 35);
  assert.equal(calls[0], 35);

  resolveNext();
  await tick();
});

test('adjust clamp high: targetVolume=98, adjust(+5) → postVolume(100)', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const fakeStore = makeStore({ targetVolume: 98, actualVolume: 98, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: postFn, postKey: () => {} });

  ctrl.adjust(5);
  await tick();
  assert.equal(fakeStore.state.speaker.volume.targetVolume, 100);
  assert.equal(calls[0], 100);

  resolveNext();
  await tick();
});

test('adjust clamp low: targetVolume=10, adjust(-50) → postVolume(0)', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const fakeStore = makeStore({ targetVolume: 10, actualVolume: 10, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: postFn, postKey: () => {} });

  ctrl.adjust(-50);
  await tick();
  assert.equal(fakeStore.state.speaker.volume.targetVolume, 0);
  assert.equal(calls[0], 0);

  resolveNext();
  await tick();
});

test('toggleMute: calls postKey("MUTE") once', () => {
  const keyCalls = [];
  const fakeStore = makeStore({ targetVolume: 50, actualVolume: 50, muteEnabled: false });
  const ctrl = makeVolumeController({ store: fakeStore, postVolume: () => Promise.resolve(), postKey: (k) => keyCalls.push(k) });

  ctrl.toggleMute();
  assert.deepStrictEqual(keyCalls, ['MUTE']);
});
