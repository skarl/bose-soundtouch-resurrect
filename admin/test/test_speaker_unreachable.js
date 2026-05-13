// Tests for admin/app/speaker-unreachable.js (#101) and the
// upstream-failure observable seam in admin/app/api.js.
//
// The blocking error overlay appears when the SPA observes an
// UPSTREAM_UNREACHABLE or TIMEOUT envelope from any speaker-proxy call.
// The next successful speaker-proxy response auto-dismisses it. A Retry
// button re-issues a reconcile.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, ev } from './fixtures/dom-shim.js';

const api = await import('../app/api.js');
const { onUpstreamFailure, presetsList, playGuideId, getVolume } = api;
const {
  copyFor,
  reduce,
  mountSpeakerUnreachable,
} = await import('../app/speaker-unreachable.js');

// --- pure helpers ---------------------------------------------------

test('copyFor: UPSTREAM_UNREACHABLE → asleep/off-network copy', () => {
  const c = copyFor('UPSTREAM_UNREACHABLE');
  assert.match(c.title, /asleep or off-network/i);
  assert.ok(c.body.length > 0);
});

test('copyFor: TIMEOUT → not responding copy', () => {
  const c = copyFor('TIMEOUT');
  assert.match(c.title, /responding/i);
  assert.ok(c.body.length > 0);
});

test('copyFor: unknown reason falls back to unreachable copy', () => {
  const c = copyFor('GREMLINS');
  assert.match(c.title, /asleep or off-network/i);
});

// --- reduce: state machine -----------------------------------------

test('reduce: failure raises overlay and remembers reason', () => {
  const next = reduce({ visible: false, reason: null }, { kind: 'failure', reason: 'TIMEOUT' });
  assert.deepEqual(next, { visible: true, reason: 'TIMEOUT' });
});

test('reduce: failure without reason defaults to UPSTREAM_UNREACHABLE', () => {
  const next = reduce({ visible: false, reason: null }, { kind: 'failure' });
  assert.deepEqual(next, { visible: true, reason: 'UPSTREAM_UNREACHABLE' });
});

test('reduce: success after visible failure clears overlay', () => {
  const next = reduce({ visible: true, reason: 'TIMEOUT' }, { kind: 'success' });
  assert.deepEqual(next, { visible: false, reason: null });
});

test('reduce: success while hidden is a no-op (identity)', () => {
  const prev = { visible: false, reason: null };
  const next = reduce(prev, { kind: 'success' });
  assert.equal(next, prev, 'returns the same object reference (no churn)');
});

test('reduce: failure after failure swaps the reason', () => {
  const next = reduce(
    { visible: true, reason: 'UPSTREAM_UNREACHABLE' },
    { kind: 'failure', reason: 'TIMEOUT' },
  );
  assert.deepEqual(next, { visible: true, reason: 'TIMEOUT' });
});

test('reduce: unknown event shape leaves state untouched', () => {
  const prev = { visible: true, reason: 'TIMEOUT' };
  assert.equal(reduce(prev, null),               prev);
  assert.equal(reduce(prev, {}),                 prev);
  assert.equal(reduce(prev, { kind: 'mauve' }),  prev);
});

// --- mount + DOM lifecycle ------------------------------------------

function setupDOM() {
  const html = doc.documentElement;
  while (html.firstChild) html.removeChild(html.firstChild);
  const body = doc.createElement('body');
  html.appendChild(body);
  doc.body = body;
  return body;
}

// Build a fake observable that mirrors api.onUpstreamFailure's contract:
//   onFailure(listener) → unsubscribe()
function fakeObservable() {
  const listeners = new Set();
  return {
    onFailure(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire(event) {
      for (const fn of listeners) fn(event);
    },
    size() { return listeners.size; },
  };
}

test('mount: overlay starts hidden', () => {
  setupDOM();
  const obs = fakeObservable();
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => {},
  });
  const root = doc.querySelector('.speaker-unreachable');
  assert.ok(root, 'overlay mounted');
  assert.equal(root.hidden, true, 'starts hidden');
  assert.deepEqual(overlay.getState(), { visible: false, reason: null });
  overlay.unmount();
});

test('mount: failure → overlay becomes visible with reason copy', () => {
  setupDOM();
  const obs = fakeObservable();
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => {},
  });

  obs.fire({ kind: 'failure', reason: 'UPSTREAM_UNREACHABLE' });

  const root = doc.querySelector('.speaker-unreachable');
  assert.equal(root.hidden, false, 'overlay is now visible');
  const title = root.querySelector('.speaker-unreachable__title');
  assert.match(title.textContent, /asleep or off-network/i);
  assert.equal(overlay.getState().reason, 'UPSTREAM_UNREACHABLE');
  overlay.unmount();
});

test('mount: TIMEOUT event uses the timeout-specific copy', () => {
  setupDOM();
  const obs = fakeObservable();
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => {},
  });

  obs.fire({ kind: 'failure', reason: 'TIMEOUT' });

  const title = doc.querySelector('.speaker-unreachable__title');
  assert.match(title.textContent, /responding/i);
  overlay.unmount();
});

test('mount: success after failure auto-clears the overlay', () => {
  setupDOM();
  const obs = fakeObservable();
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => {},
  });

  obs.fire({ kind: 'failure', reason: 'TIMEOUT' });
  const root = doc.querySelector('.speaker-unreachable');
  assert.equal(root.hidden, false, 'visible after failure');

  obs.fire({ kind: 'success' });
  assert.equal(root.hidden, true, 'hidden after success');
  assert.deepEqual(overlay.getState(), { visible: false, reason: null });
  overlay.unmount();
});

test('mount: retry button invokes onRetry and re-enables when the promise settles', async () => {
  setupDOM();
  const obs = fakeObservable();
  let retries = 0;
  let resolveRetry;
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => {
      retries += 1;
      return new Promise((r) => { resolveRetry = r; });
    },
  });

  obs.fire({ kind: 'failure', reason: 'UPSTREAM_UNREACHABLE' });
  const root = doc.querySelector('.speaker-unreachable');
  const btn = root.querySelector('.speaker-unreachable__retry');

  btn.dispatchEvent(ev('click'));
  assert.equal(retries, 1, 'first tap fires onRetry');
  assert.equal(btn.disabled, true, 'button disabled while retry in flight');

  // Re-entrant tap while disabled is a no-op (the issue body warns
  // against panicked double-taps queuing two reconciles).
  btn.dispatchEvent(ev('click'));
  assert.equal(retries, 1, 'second tap during in-flight retry does not re-fire');

  resolveRetry();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(btn.disabled, false, 'button re-enabled after retry resolves');

  overlay.unmount();
});

test('mount: retry button still re-enables when onRetry rejects', async () => {
  setupDOM();
  const obs = fakeObservable();
  let rejectRetry;
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => new Promise((_resolve, reject) => { rejectRetry = reject; }),
  });

  obs.fire({ kind: 'failure', reason: 'UPSTREAM_UNREACHABLE' });
  const btn = doc.querySelector('.speaker-unreachable__retry');
  btn.dispatchEvent(ev('click'));
  assert.equal(btn.disabled, true);

  rejectRetry(new Error('still asleep'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(btn.disabled, false, 'button re-enabled on retry rejection');

  overlay.unmount();
});

test('mount: retry tolerates a synchronous-throw onRetry', () => {
  setupDOM();
  const obs = fakeObservable();
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => { throw new Error('blew up'); },
  });

  obs.fire({ kind: 'failure', reason: 'UPSTREAM_UNREACHABLE' });
  const btn = doc.querySelector('.speaker-unreachable__retry');
  // Must not propagate — the overlay swallows the throw to keep the UI alive.
  btn.dispatchEvent(ev('click'));
  overlay.unmount();
});

test('mount: unmount removes the overlay from the DOM and unsubscribes', () => {
  setupDOM();
  const obs = fakeObservable();
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => {},
  });
  assert.equal(obs.size(), 1, 'subscribed to the observable');
  assert.ok(doc.querySelector('.speaker-unreachable'));

  overlay.unmount();
  assert.equal(doc.querySelector('.speaker-unreachable'), null, 'overlay removed');
  assert.equal(obs.size(), 0, 'unsubscribed on unmount');
});

test('mount: requires onFailure and onRetry', () => {
  setupDOM();
  assert.throws(() => mountSpeakerUnreachable({}),
    /onFailure is required/);
  assert.throws(() => mountSpeakerUnreachable({ onFailure: () => () => {} }),
    /onRetry is required/);
});

test('mount: onChange listener fires on state transitions', () => {
  setupDOM();
  const obs = fakeObservable();
  const overlay = mountSpeakerUnreachable({
    onFailure: obs.onFailure,
    onRetry: () => {},
  });
  const seen = [];
  const off = overlay.onChange((s) => seen.push({ ...s }));

  obs.fire({ kind: 'failure', reason: 'TIMEOUT' });
  obs.fire({ kind: 'success' });
  obs.fire({ kind: 'success' }); // identity — should NOT re-fire

  assert.equal(seen.length, 2, 'two state transitions observed');
  assert.deepEqual(seen[0], { visible: true,  reason: 'TIMEOUT' });
  assert.deepEqual(seen[1], { visible: false, reason: null });

  off();
  overlay.unmount();
});

// --- api.js: upstream-failure observable wiring ---------------------

test('onUpstreamFailure: getVolume timeout fans a failure event', async () => {
  // Listen first, fire the stalled fetch second. The TimeoutError path
  // in xmlGet notifies before throwing.
  const events = [];
  const off = onUpstreamFailure((e) => events.push(e));

  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    const sig = opts && opts.signal;
    if (sig) {
      sig.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
  });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);

  try {
    await getVolume().catch(() => {});
    assert.ok(events.some((e) => e.kind === 'failure' && e.reason === 'TIMEOUT'),
      `expected a TIMEOUT failure event, got ${JSON.stringify(events)}`);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    off();
  }
});

test('onUpstreamFailure: presetsList UPSTREAM_UNREACHABLE envelope fans a failure event', async () => {
  const events = [];
  const off = onUpstreamFailure((e) => events.push(e));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({
      ok: false,
      error: { code: 'UPSTREAM_UNREACHABLE', message: 'speaker API at localhost:8090 did not respond' },
    }),
  });

  try {
    const body = await presetsList();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'UPSTREAM_UNREACHABLE');
    assert.ok(events.some((e) => e.kind === 'failure' && e.reason === 'UPSTREAM_UNREACHABLE'),
      'failure event fanned with the right reason');
  } finally {
    globalThis.fetch = realFetch;
    off();
  }
});

test('onUpstreamFailure: playGuideId UPSTREAM_UNREACHABLE envelope fans a failure event', async () => {
  const events = [];
  const off = onUpstreamFailure((e) => events.push(e));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({
      ok: false,
      error: { code: 'UPSTREAM_UNREACHABLE', message: '...' },
    }),
  });

  try {
    const body = await playGuideId('s12345', 'Radio Test');
    assert.equal(body.ok, false);
    assert.ok(events.some((e) => e.kind === 'failure' && e.reason === 'UPSTREAM_UNREACHABLE'),
      'playGuideId envelope wired into the observable');
  } finally {
    globalThis.fetch = realFetch;
    off();
  }
});

test('onUpstreamFailure: happy presetsList fans a success event', async () => {
  const events = [];
  const off = onUpstreamFailure((e) => events.push(e));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: [] }),
  });

  try {
    const body = await presetsList();
    assert.equal(body.ok, true);
    assert.ok(events.some((e) => e.kind === 'success'),
      'success path fans a success event');
  } finally {
    globalThis.fetch = realFetch;
    off();
  }
});

test('onUpstreamFailure: unsubscribe stops the listener', async () => {
  const events = [];
  const off = onUpstreamFailure((e) => events.push(e));
  off();

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ ok: false, error: { code: 'UPSTREAM_UNREACHABLE', message: '' } }),
  });

  try {
    await presetsList();
    assert.equal(events.length, 0, 'no events after unsubscribe');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- end-to-end: overlay reacts to real api.js notifications --------

test('e2e: mount overlay wired to onUpstreamFailure → presetsList stall → success', async () => {
  setupDOM();
  let retries = 0;
  const overlay = mountSpeakerUnreachable({
    onFailure: onUpstreamFailure,
    onRetry: () => { retries += 1; return Promise.resolve(); },
  });
  const root = doc.querySelector('.speaker-unreachable');
  assert.equal(root.hidden, true, 'starts hidden');

  // Fire a real UPSTREAM_UNREACHABLE envelope through presetsList.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ ok: false, error: { code: 'UPSTREAM_UNREACHABLE', message: '' } }),
  });
  try {
    await presetsList();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(root.hidden, false, 'overlay raised by real API event');
  assert.equal(overlay.getState().reason, 'UPSTREAM_UNREACHABLE');

  // Now a real success-path call should auto-dismiss.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: [] }),
  });
  try {
    await presetsList();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(root.hidden, true, 'overlay auto-clears on success frame');

  overlay.unmount();
  void retries;
});
