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
import { makeSliderController } from '../app/sliders.js';

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

// --- optimistic action helper + selectSource / playPreset ------------
//
// Minimal document shim that captures toast nodes. toast.js appends
// status nodes to a fixed container in document.body; we observe the
// container's child count to assert "toast surfaced". showToast bails
// silently if document is undefined, so without this shim the rollback
// path's toast call would be a no-op and the test would be vacuous.

function installToastDom() {
  const created = [];
  const containerChildren = [];
  const fakeContainer = {
    id: 'toast-container',
    setAttribute() {},
    appendChild(node) { containerChildren.push(node); },
  };
  const fakeBody = { appendChild() {} };
  const prevDoc = globalThis.document;
  globalThis.document = {
    getElementById(id) { return id === 'toast-container' ? fakeContainer : null; },
    createElement(tag) {
      const node = {
        tag,
        className: '',
        textContent: '',
        classList: { add() {}, remove() {} },
        setAttribute() {},
        get offsetWidth() { return 0; },
        parentNode: null,
      };
      created.push(node);
      return node;
    },
    body: fakeBody,
  };
  return {
    toastCount: () => containerChildren.length,
    restore: () => { globalThis.document = prevDoc; },
  };
}

test('optimistic helper: POST resolves → state stays at optimistic value, no toast', async () => {
  const { toastCount, restore } = installToastDom();
  try {
    const { runOptimistic } = await import('../app/optimistic.js');
    seed('nowPlaying', { source: 'TUNEIN', item: { name: 'Old' } });

    await runOptimistic({
      snapshot: () => store.state.speaker.nowPlaying,
      apply: () => { store.state.speaker.nowPlaying = { source: 'SPOTIFY', item: null }; },
      post: () => Promise.resolve(),
      rollback: (prev) => { store.state.speaker.nowPlaying = prev; },
      errorMessage: 'should not surface',
    });

    assert.equal(store.state.speaker.nowPlaying.source, 'SPOTIFY',
      'optimistic mutation persists when POST resolves');
    assert.equal(toastCount(), 0, 'no toast on success');
  } finally {
    restore();
  }
});

test('optimistic helper: POST rejects → state rolls back, toast surfaced', async () => {
  const { toastCount, restore } = installToastDom();
  try {
    const { runOptimistic } = await import('../app/optimistic.js');
    const original = { source: 'TUNEIN', item: { name: 'Old' } };
    seed('nowPlaying', original);

    await assert.rejects(() => runOptimistic({
      snapshot: () => store.state.speaker.nowPlaying,
      apply: () => { store.state.speaker.nowPlaying = { source: 'SPOTIFY', item: null }; },
      post: () => Promise.reject(new Error('network down')),
      rollback: (prev) => { store.state.speaker.nowPlaying = prev; },
      errorMessage: 'Switch failed',
    }), /network down/);

    assert.equal(store.state.speaker.nowPlaying, original,
      'rollback restores the prior nowPlaying reference');
    assert.equal(toastCount(), 1, 'one toast surfaced on rejection');
  } finally {
    restore();
  }
});

// --- selectSource ----------------------------------------------------
//
// selectSource imports postSelect / postSelectLocalSource from api.js,
// which call fetch. The standing `globalThis.fetch = () => Promise(...)`
// stub in test_now_playing.js doesn't apply here — test_actions.js runs
// in its own module scope. We swap api.js's exports via dynamic import +
// a controlled fetch stub so we can choose resolve vs reject per test.

function withFetchStub() {
  const calls = [];
  let nextResult = { ok: true };
  globalThis.fetch = (...args) => {
    calls.push(args);
    return Promise.resolve({
      ok: nextResult.ok,
      status: nextResult.ok ? 200 : 500,
      text: () => Promise.resolve(nextResult.text || '<status>ok</status>'),
    });
  };
  return {
    calls,
    resolveOk(text = '<status>ok</status>') { nextResult = { ok: true, text }; },
    resolveFail(status = 500) { nextResult = { ok: false, status }; },
    reject(err) {
      globalThis.fetch = () => Promise.reject(err || new Error('network down'));
    },
  };
}

test('selectSource: POST resolves → nowPlaying.source flips to the new source', async () => {
  const { restore } = installToastDom();
  const stub = withFetchStub();
  stub.resolveOk();
  try {
    const actions = await import('../app/actions/index.js');
    seed('nowPlaying', { source: 'TUNEIN', item: { name: 'KEXP' } });

    await actions.selectSource({ source: 'SPOTIFY', sourceAccount: 'a-1', isLocal: false, displayName: 'Spotify' });

    assert.equal(store.state.speaker.nowPlaying.source, 'SPOTIFY',
      'optimistic source flip persists after the POST resolves');
  } finally {
    restore();
  }
});

test('selectSource: POST rejects → nowPlaying restored, error toast surfaced', async () => {
  const { toastCount, restore } = installToastDom();
  const stub = withFetchStub();
  stub.reject(new Error('boom'));
  try {
    const actions = await import('../app/actions/index.js');
    const original = { source: 'TUNEIN', item: { name: 'KEXP' } };
    seed('nowPlaying', original);

    await assert.rejects(
      () => actions.selectSource({ source: 'SPOTIFY', sourceAccount: 'a-1', isLocal: false }),
    );

    assert.equal(store.state.speaker.nowPlaying, original,
      'rollback restored the previous nowPlaying object');
    assert.equal(toastCount(), 1, 'an error toast was surfaced');
  } finally {
    restore();
  }
});

// --- playPreset ------------------------------------------------------

test('playPreset: POST resolves → nowPlaying carries the preset contentItem', async () => {
  const { restore } = installToastDom();
  const stub = withFetchStub();
  stub.resolveOk();
  try {
    const actions = await import('../app/actions/index.js');
    seed('nowPlaying', { source: 'TUNEIN', item: { name: 'Old Station', location: 'sX' } });
    seed('presets', [
      { slot: 1, empty: false, itemName: 'KEXP', source: 'TUNEIN', sourceAccount: '',
        type: 'stationurl', location: 's12345', art: 'http://example/kexp.png' },
      { slot: 2, empty: true },
      { slot: 3, empty: true },
      { slot: 4, empty: true },
      { slot: 5, empty: true },
      { slot: 6, empty: true },
    ]);

    await actions.playPreset(1);

    const np = store.state.speaker.nowPlaying;
    assert.equal(np.source, 'TUNEIN');
    assert.equal(np.item.location, 's12345',
      'optimistic nowPlaying.item.location matches the preset');
    assert.equal(np.item.name, 'KEXP');
  } finally {
    restore();
  }
});

test('playPreset: POST rejects → nowPlaying restored, error toast surfaced', async () => {
  const { toastCount, restore } = installToastDom();
  const stub = withFetchStub();
  stub.reject(new Error('preset boom'));
  try {
    const actions = await import('../app/actions/index.js');
    const original = { source: 'TUNEIN', item: { name: 'Old Station', location: 'sX' } };
    seed('nowPlaying', original);
    seed('presets', [
      { slot: 1, empty: false, itemName: 'KEXP', source: 'TUNEIN', sourceAccount: '',
        type: 'stationurl', location: 's12345' },
      { slot: 2, empty: true },
      { slot: 3, empty: true },
      { slot: 4, empty: true },
      { slot: 5, empty: true },
      { slot: 6, empty: true },
    ]);

    await assert.rejects(() => actions.playPreset(1));

    assert.equal(store.state.speaker.nowPlaying, original,
      'rollback restored the previous nowPlaying object');
    assert.equal(toastCount(), 1, 'an error toast was surfaced');
  } finally {
    restore();
  }
});
