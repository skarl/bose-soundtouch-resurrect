// Unit tests for the pure WebSocket FSM in app/ws-fsm.js.
//
// No socket / DOM mocks — the FSM takes plain data in and returns
// plain data out. The driver in ws.js wires the side effects.
//
// Run locally:
//   node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { step, backoff, initialState } from '../app/ws-fsm.js';

const RUNS = 1000;

// --- backoff ---------------------------------------------------------

test('backoff(0) returns a number in [0, 500)', () => {
  for (let i = 0; i < RUNS; i++) {
    const ms = backoff(0);
    assert.ok(ms >= 0,  `expected ms >= 0, got ${ms}`);
    assert.ok(ms < 500, `expected ms < 500, got ${ms}`);
  }
});

test('backoff(1) returns a number in [0, 1000)', () => {
  for (let i = 0; i < RUNS; i++) {
    const ms = backoff(1);
    assert.ok(ms >= 0,   `expected ms >= 0, got ${ms}`);
    assert.ok(ms < 1000, `expected ms < 1000, got ${ms}`);
  }
});

test('backoff(2) returns a number in [0, 2000)', () => {
  for (let i = 0; i < RUNS; i++) {
    const ms = backoff(2);
    assert.ok(ms >= 0,    `expected ms >= 0, got ${ms}`);
    assert.ok(ms < 2000,  `expected ms < 2000, got ${ms}`);
  }
});

test('backoff(100) returns a number in [0, 30000]', () => {
  for (let i = 0; i < RUNS; i++) {
    const ms = backoff(100);
    assert.ok(ms >= 0,     `expected ms >= 0, got ${ms}`);
    assert.ok(ms <= 30000, `expected ms <= 30000, got ${ms}`);
  }
});

test('backoff mean at attempt=10 is approximately 15000 (cap/2)', () => {
  let sum = 0;
  for (let i = 0; i < RUNS; i++) sum += backoff(10);
  const mean = sum / RUNS;
  assert.ok(mean > 12000, `mean ${mean.toFixed(0)} should be > 12000`);
  assert.ok(mean < 18000, `mean ${mean.toFixed(0)} should be < 18000`);
});

// --- initialState ----------------------------------------------------

test('initialState starts in connecting with zero counters', () => {
  const s = initialState();
  assert.equal(s.mode, 'connecting');
  assert.equal(s.attempt, 0);
  assert.equal(s.consecutiveFails, 0);
  assert.equal(s.hidden, false);
});

// --- helpers ---------------------------------------------------------

function actionTypes(actions) {
  return actions.map((a) => a.type);
}

function drive(state, events) {
  let s = state;
  const allActions = [];
  for (const e of events) {
    const r = step(s, e);
    s = r.state;
    for (const a of r.actions) allActions.push(a);
  }
  return { state: s, actions: allActions };
}

// --- documented transitions -----------------------------------------

test('open before hello: no state change, no actions', () => {
  const s = initialState();
  const r = step(s, { type: 'open' });
  assert.equal(r.state.mode, 'connecting');
  assert.deepEqual(r.actions, []);
});

test('connecting -> connected on hello: emits stopPolling + reconcile, resets counters', () => {
  const s = { mode: 'connecting', attempt: 3, consecutiveFails: 2, hidden: false };
  const r = step(s, { type: 'hello' });
  assert.equal(r.state.mode, 'connected');
  assert.equal(r.state.attempt, 0);
  assert.equal(r.state.consecutiveFails, 0);
  assert.deepEqual(actionTypes(r.actions), ['stopPolling', 'reconcile']);
});

test('connected -> reconnecting on first close: startPolling + scheduleReconnect, attempt=1, fails=1', () => {
  const s = { mode: 'connected', attempt: 0, consecutiveFails: 0, hidden: false };
  const r = step(s, { type: 'close' });
  assert.equal(r.state.mode, 'reconnecting');
  assert.equal(r.state.attempt, 1);
  assert.equal(r.state.consecutiveFails, 1);
  assert.deepEqual(actionTypes(r.actions), ['startPolling', 'scheduleReconnect']);
  const sched = r.actions.find((a) => a.type === 'scheduleReconnect');
  assert.ok(typeof sched.ms === 'number' && sched.ms >= 0 && sched.ms < 500);
});

test('reconnecting -> connecting on timerFire: emits openSocket', () => {
  const s = { mode: 'reconnecting', attempt: 1, consecutiveFails: 1, hidden: false };
  const r = step(s, { type: 'timerFire' });
  assert.equal(r.state.mode, 'connecting');
  assert.equal(r.state.attempt, 1);
  assert.deepEqual(actionTypes(r.actions), ['openSocket']);
});

test('reconnecting -> polling on second close: startPolling + scheduleReconnect, fails=2', () => {
  // After first close + timer fire we are in connecting with attempt=1/fails=1.
  // A second close (still no hello) escalates to polling.
  const s0 = initialState();
  const s1 = step(s0, { type: 'hello' }).state;             // connected
  const s2 = step(s1, { type: 'close' }).state;             // reconnecting fails=1 attempt=1
  const s3 = step(s2, { type: 'timerFire' }).state;         // connecting
  const r  = step(s3, { type: 'close' });
  assert.equal(r.state.mode, 'polling');
  assert.equal(r.state.consecutiveFails, 2);
  assert.equal(r.state.attempt, 2);
  assert.deepEqual(actionTypes(r.actions), ['startPolling', 'scheduleReconnect']);
});

test('polling -> connected on hello: counters reset, stopPolling + reconcile', () => {
  const s = { mode: 'polling', attempt: 5, consecutiveFails: 3, hidden: false };
  const r = step(s, { type: 'hello' });
  assert.equal(r.state.mode, 'connected');
  assert.equal(r.state.attempt, 0);
  assert.equal(r.state.consecutiveFails, 0);
  assert.deepEqual(actionTypes(r.actions), ['stopPolling', 'reconcile']);
});

test('close while hidden: no startPolling, no scheduleReconnect, but counters still advance', () => {
  const s = { mode: 'connected', attempt: 0, consecutiveFails: 0, hidden: true };
  const r = step(s, { type: 'close' });
  assert.equal(r.state.mode, 'reconnecting');
  assert.equal(r.state.consecutiveFails, 1);
  assert.equal(r.state.attempt, 1);
  assert.deepEqual(r.actions, []);
});

test('timerFire while hidden: no-op', () => {
  const s = { mode: 'reconnecting', attempt: 1, consecutiveFails: 1, hidden: true };
  const r = step(s, { type: 'timerFire' });
  assert.equal(r.state.mode, 'reconnecting');
  assert.deepEqual(r.actions, []);
});

test('visibilityChange to hidden cancels reconnect + stops polling', () => {
  const s = { mode: 'reconnecting', attempt: 1, consecutiveFails: 1, hidden: false };
  const r = step(s, { type: 'visibilityChange', hidden: true });
  assert.equal(r.state.hidden, true);
  assert.equal(r.state.mode, 'reconnecting');
  assert.deepEqual(actionTypes(r.actions), ['cancelReconnect', 'stopPolling']);
});

test('visibilityChange to visible while connected: no actions', () => {
  const s = { mode: 'connected', attempt: 0, consecutiveFails: 0, hidden: true };
  const r = step(s, { type: 'visibilityChange', hidden: false });
  assert.equal(r.state.hidden, false);
  assert.equal(r.state.mode, 'connected');
  assert.deepEqual(r.actions, []);
});

test('visibilityChange to visible while disconnected: resets attempt and openSocket', () => {
  const s = { mode: 'reconnecting', attempt: 5, consecutiveFails: 3, hidden: true };
  const r = step(s, { type: 'visibilityChange', hidden: false });
  assert.equal(r.state.hidden, false);
  assert.equal(r.state.mode, 'connecting');
  assert.equal(r.state.attempt, 0);
  assert.deepEqual(actionTypes(r.actions), ['openSocket']);
});

test('visibilityChange with same value is a no-op', () => {
  const s = { mode: 'connected', attempt: 0, consecutiveFails: 0, hidden: false };
  const r = step(s, { type: 'visibilityChange', hidden: false });
  assert.deepEqual(r.state, s);
  assert.deepEqual(r.actions, []);
});

test('userDisconnect: cancelReconnect + stopPolling + closeSocket, counters reset', () => {
  const s = { mode: 'polling', attempt: 4, consecutiveFails: 3, hidden: false };
  const r = step(s, { type: 'userDisconnect' });
  assert.equal(r.state.attempt, 0);
  assert.equal(r.state.consecutiveFails, 0);
  assert.deepEqual(actionTypes(r.actions), ['cancelReconnect', 'stopPolling', 'closeSocket']);
});

test('unknown event is a no-op', () => {
  const s = initialState();
  const r = step(s, { type: 'nope' });
  assert.deepEqual(r.state, s);
  assert.deepEqual(r.actions, []);
});

// --- input-sequence golden assertions -------------------------------

test('golden sequence: connect, hello, close x3, hello recovers', () => {
  // open + hello → connected; three drops escalate to polling; final hello recovers.
  const events = [
    { type: 'open' },
    { type: 'hello' },        // connected
    { type: 'close' },        // reconnecting, fails=1, attempt=1
    { type: 'timerFire' },    // connecting
    { type: 'close' },        // polling, fails=2, attempt=2
    { type: 'timerFire' },    // connecting
    { type: 'close' },        // polling, fails=3, attempt=3
    { type: 'timerFire' },    // connecting
    { type: 'hello' },        // connected (recovery)
  ];
  const { state, actions } = drive(initialState(), events);
  assert.equal(state.mode, 'connected');
  assert.equal(state.attempt, 0);
  assert.equal(state.consecutiveFails, 0);
  // Walk the action types to confirm the golden shape.
  assert.deepEqual(actionTypes(actions), [
    // hello → connected
    'stopPolling', 'reconcile',
    // 1st close
    'startPolling', 'scheduleReconnect',
    // 1st timerFire
    'openSocket',
    // 2nd close
    'startPolling', 'scheduleReconnect',
    // 2nd timerFire
    'openSocket',
    // 3rd close
    'startPolling', 'scheduleReconnect',
    // 3rd timerFire
    'openSocket',
    // recovery hello
    'stopPolling', 'reconcile',
  ]);
});

test('golden sequence: visibility hidden during reconnect pauses, visible resumes', () => {
  const events = [
    { type: 'hello' },                                  // connected
    { type: 'close' },                                  // reconnecting (visible)
    { type: 'visibilityChange', hidden: true },         // pause: cancel + stopPolling
    { type: 'close' },                                  // still reconnecting/escalates but no actions while hidden
    { type: 'timerFire' },                              // no-op while hidden
    { type: 'visibilityChange', hidden: false },        // resume: openSocket, attempt reset
    { type: 'hello' },                                  // connected
  ];
  const { state, actions } = drive(initialState(), events);
  assert.equal(state.mode, 'connected');
  assert.equal(state.hidden, false);
  assert.deepEqual(actionTypes(actions), [
    // first hello
    'stopPolling', 'reconcile',
    // first close (visible)
    'startPolling', 'scheduleReconnect',
    // visibilityChange to hidden
    'cancelReconnect', 'stopPolling',
    // second close (hidden → no actions)
    // timerFire (hidden → no actions)
    // visibilityChange to visible (disconnected → openSocket)
    'openSocket',
    // final hello
    'stopPolling', 'reconcile',
  ]);
});

test('golden sequence: userDisconnect from connected', () => {
  const events = [
    { type: 'hello' },
    { type: 'userDisconnect' },
  ];
  const { state, actions } = drive(initialState(), events);
  assert.equal(state.mode, 'connecting');
  assert.equal(state.attempt, 0);
  assert.equal(state.consecutiveFails, 0);
  assert.deepEqual(actionTypes(actions), [
    'stopPolling', 'reconcile',
    'cancelReconnect', 'stopPolling', 'closeSocket',
  ]);
});

test('scheduleReconnect ms grows with attempt (monotone baseline)', () => {
  // Drive two consecutive close events from connected. backoff is randomised
  // so we sample many times and assert the average grows with attempt.
  let sum0 = 0, sum1 = 0;
  for (let i = 0; i < 200; i++) {
    const r0 = step({ mode: 'connected', attempt: 0, consecutiveFails: 0, hidden: false }, { type: 'close' });
    const r1 = step({ mode: 'connected', attempt: 3, consecutiveFails: 0, hidden: false }, { type: 'close' });
    sum0 += r0.actions.find((a) => a.type === 'scheduleReconnect').ms;
    sum1 += r1.actions.find((a) => a.type === 'scheduleReconnect').ms;
  }
  assert.ok(sum1 > sum0 * 3, `attempt=3 mean should be much greater than attempt=0; got sums ${sum0} vs ${sum1}`);
});
