// Tests for app/dom.js — defineView + mountChild shell.
//
// Pure logic: subscriptions, signal/cleanup wiring, key validation,
// cascading via mountChild. Exercises the shell against a tiny in-memory
// store stub; no real DOM is touched (the shell itself is DOM-agnostic —
// it only invokes whatever mount() the caller hands it).
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { defineView, mountChild } from '../app/dom.js';

const ALLOWED_KEYS = ['speaker', 'ws', 'ui', 'caches'];

function makeStore() {
  const subs = new Map(ALLOWED_KEYS.map((k) => [k, new Set()]));
  const state = { speaker: {}, ws: {}, ui: {}, caches: {} };
  return {
    state,
    subscribe(key, fn) {
      if (!subs.has(key)) throw new Error(`unknown state key: ${key}`);
      subs.get(key).add(fn);
      return () => subs.get(key).delete(fn);
    },
    notify(key) {
      for (const fn of subs.get(key)) fn(state, key);
    },
    subCount(key) { return subs.get(key).size; },
  };
}

test('mount runs once and updaters fire on subscribed keys', () => {
  const store = makeStore();
  const calls = { speaker: 0, ws: 0 };
  let mounts = 0;

  const view = defineView({
    mount(_root, _store, _ctx, _env) {
      mounts++;
      return {
        speaker() { calls.speaker++; },
        ws()      { calls.ws++; },
      };
    },
  });

  const destroy = view.init({}, store, {});
  assert.equal(mounts, 1, 'mount runs exactly once');
  assert.equal(store.subCount('speaker'), 1);
  assert.equal(store.subCount('ws'), 1);
  assert.equal(store.subCount('ui'), 0, 'no subscription for unreturned keys');

  store.notify('speaker');
  store.notify('ws');
  store.notify('ui');
  assert.equal(calls.speaker, 1);
  assert.equal(calls.ws, 1);

  destroy();
});

test('unknown updater key throws', () => {
  const store = makeStore();
  const view = defineView({
    mount() { return { bogus() {} }; },
  });
  assert.throws(
    () => view.init({}, store, {}),
    /unknown updater key "bogus"/,
  );
});

test('signal aborts on unmount; cleanups run LIFO; subscriptions detach', () => {
  const store = makeStore();
  const order = [];
  let signal;

  const view = defineView({
    mount(_root, _store, _ctx, env) {
      signal = env.signal;
      env.onCleanup(() => order.push('first'));
      env.onCleanup(() => order.push('second'));
      env.onCleanup(() => order.push('third'));
      return { speaker() {} };
    },
  });

  const destroy = view.init({}, store, {});
  assert.equal(signal.aborted, false);
  assert.equal(store.subCount('speaker'), 1);

  destroy();
  assert.equal(signal.aborted, true, 'signal aborted on unmount');
  assert.deepEqual(order, ['third', 'second', 'first'], 'cleanups run LIFO');
  assert.equal(store.subCount('speaker'), 0, 'subscription removed on unmount');
});

test('in-flight fetch rejects with AbortError when env.signal aborts', async () => {
  const store = makeStore();
  let pending;

  const view = defineView({
    mount(_root, _store, _ctx, env) {
      pending = new Promise((_resolve, reject) => {
        env.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      return {};
    },
  });

  const destroy = view.init({}, store, {});
  destroy();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
});

test('mountChild registers child destroy with parent — cleanup cascades', () => {
  const store = makeStore();
  const events = [];

  const child = defineView({
    mount(_root, _store, _ctx, env) {
      env.onCleanup(() => events.push('child-cleanup'));
      return { ws() { events.push('child-ws'); } };
    },
  });

  const parent = defineView({
    mount(_root, _store, _ctx, env) {
      env.onCleanup(() => events.push('parent-cleanup'));
      mountChild({}, child, store, {}, env);
      return { speaker() { events.push('parent-speaker'); } };
    },
  });

  const destroy = parent.init({}, store, {});
  assert.equal(store.subCount('speaker'), 1, 'parent subscribed');
  assert.equal(store.subCount('ws'), 1, 'child subscribed via mountChild');

  store.notify('speaker');
  store.notify('ws');
  assert.deepEqual(events, ['parent-speaker', 'child-ws']);

  destroy();
  // Parent cleanup is registered before mountChild registers the child's
  // destroy, so LIFO order means child unmounts first.
  assert.deepEqual(
    events.slice(2),
    ['child-cleanup', 'parent-cleanup'],
    'parent destroy cascades child cleanup; LIFO across boundaries',
  );
  assert.equal(store.subCount('speaker'), 0, 'parent unsubscribed');
  assert.equal(store.subCount('ws'), 0, 'child unsubscribed via cascade');
});

test('mount returning nothing is allowed (no updaters)', () => {
  const store = makeStore();
  const view = defineView({ mount() { /* implicit undefined */ } });
  const destroy = view.init({}, store, {});
  for (const k of ALLOWED_KEYS) assert.equal(store.subCount(k), 0);
  destroy();
});
