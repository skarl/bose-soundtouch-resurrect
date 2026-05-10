// Tests for the throttle/coalesce volume sender in app/transport.js.
//
// Uses a controllable promise — the test holds a resolve handle so it
// can decide exactly when each in-flight POST completes, making the
// sequence deterministic without timers.
//
// Run locally:
//   node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { makeVolumeSender } from '../app/transport.js';

// Build a recording mock postFn.
// returns { postFn, calls, resolveNext }
// - calls: array of levels passed to postFn in order.
// - resolveNext(): resolves the oldest pending postFn promise.
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

test('single setVolume(20) fires postFn(20) after resolution', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const { setVolume } = makeVolumeSender(postFn);

  setVolume(20);
  await tick();               // let flush() start
  assert.deepStrictEqual(calls, [20], 'one call queued');

  resolveNext();              // complete the POST
  await tick();               // let finally block run
  assert.deepStrictEqual(calls, [20], 'still exactly one call');
});

test('coalesce: only first and last value reach postFn when calls arrive during flight', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const { setVolume } = makeVolumeSender(postFn);

  setVolume(20);              // starts the in-flight POST
  await tick();
  assert.equal(calls.length, 1, 'first POST started');

  // These three arrive while the first POST is still in flight.
  setVolume(25);
  setVolume(28);
  setVolume(30);              // only this one should survive as the trailing call

  resolveNext();              // resolve first POST
  await tick();               // flush() finally block queues the trailing call
  await tick();               // trailing flush() starts

  assert.equal(calls[0], 20, 'first in-flight was 20');
  assert.equal(calls[1], 30, 'trailing is the last queued value (30)');
  assert.equal(calls.length, 2, 'intermediate 25 and 28 were dropped');

  resolveNext();              // resolve trailing POST
  await tick();
});

test('after first POST resolves, a fresh setVolume fires another POST', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const { setVolume } = makeVolumeSender(postFn);

  setVolume(20);
  await tick();
  resolveNext();
  await tick();               // in-flight clears

  setVolume(40);
  await tick();
  assert.equal(calls.length, 2, 'second POST started');
  assert.equal(calls[1], 40);

  resolveNext();
  await tick();
});

test('after confirm(40), setVolume(40) is suppressed', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const { setVolume, confirm } = makeVolumeSender(postFn);

  // Fire and resolve a POST to level 40.
  setVolume(40);
  await tick();
  resolveNext();
  await tick();
  assert.equal(calls.length, 1);

  // Simulate WS volumeUpdated reporting actual=40.
  confirm(40);

  // Now setVolume(40) should be suppressed.
  setVolume(40);
  await tick();
  assert.equal(calls.length, 1, 'no new POST after confirmed level equals request');
});

test('after confirm(40), setVolume(50) fires a new POST', async () => {
  const { postFn, calls, resolveNext } = makeMock();
  const { setVolume, confirm } = makeVolumeSender(postFn);

  setVolume(40);
  await tick();
  resolveNext();
  await tick();

  confirm(40);

  setVolume(50);              // different value — should fire
  await tick();
  assert.equal(calls.length, 2, 'new POST fired for different level');
  assert.equal(calls[1], 50);

  resolveNext();
  await tick();
});
