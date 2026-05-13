// Tests for admin/app/api.js timeout handling (#100).
//
// fetchWithTimeout wraps fetch() in an AbortController + setTimeout so
// a hung speaker can't stall the REST polling loop. The wrappers route
// transport timeouts back to callers via:
//   - throw `{name:'TimeoutError'}` for the bare wrappers (xmlGet,
//     xmlPost, getJson, presetsList, postRefreshAll), and
//   - the structured `{ok:false, error:{code:'TIMEOUT', message}}`
//     envelope for the three endpoints that already speak that schema
//     (playGuideId, previewStream, presetsAssign).
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import './fixtures/dom-shim.js';

const api = await import('../app/api.js');
const {
  fetchWithTimeout,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  playGuideId,
  previewStream,
  presetsAssign,
  presetsList,
  postRefreshAll,
  getVolume,
  postVolume,
  tuneinSearch,
} = api;

// --- fetchWithTimeout: primitive ------------------------------------

test('fetchWithTimeout: resolves and clears the timer on success', async () => {
  let cleared = false;
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => { cleared = true; return realClear(id); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });

  try {
    const res = await fetchWithTimeout('/x', {}, 50);
    assert.equal(res.ok, true, 'response surfaces verbatim');
    assert.equal(cleared, true, 'success path clears the timeout');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.clearTimeout = realClear;
  }
});

test('fetchWithTimeout: clears the timer on failure too (no leak)', async () => {
  let cleared = false;
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => { cleared = true; return realClear(id); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('boom'); };

  try {
    await assert.rejects(() => fetchWithTimeout('/x', {}, 50), /boom/);
    assert.equal(cleared, true, 'error path clears the timeout');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.clearTimeout = realClear;
  }
});

test('fetchWithTimeout: fires a tagged TimeoutError when fetch never resolves', async () => {
  const realFetch = globalThis.fetch;
  // Honour the AbortSignal so the wrapper's abort actually rejects the
  // pending fetch promise (matches real browser semantics).
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

  try {
    const err = await fetchWithTimeout('/slow', {}, 20).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, 'fetchWithTimeout rejects');
    assert.equal(err.name, 'TimeoutError', 'tagged with name=TimeoutError');
    assert.equal(err.url, '/slow');
    assert.equal(err.timeoutMs, 20);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchWithTimeout: propagates AbortError from an external signal', async () => {
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

  try {
    const controller = new AbortController();
    const pending = fetchWithTimeout('/x', { signal: controller.signal }, 5000);
    controller.abort();
    const err = await pending.then(() => null, (e) => e);
    assert.ok(err, 'rejects when external signal aborts');
    assert.equal(err.name, 'AbortError',
      'external abort surfaces as AbortError, not TimeoutError');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- wrappers: bare throwers ----------------------------------------

test('getVolume (GET wrapper) throws TimeoutError when speaker stalls', async () => {
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
  // Bypass the default 5s read timeout by overriding setTimeout to fire
  // immediately for this assertion only.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);

  try {
    const err = await getVolume().then(() => null, (e) => e);
    assert.ok(err, 'getVolume rejects on stall');
    assert.equal(err.name, 'TimeoutError');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('postVolume (POST wrapper) throws TimeoutError when speaker stalls', async () => {
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
    const err = await postVolume(20).then(() => null, (e) => e);
    assert.ok(err, 'postVolume rejects on stall');
    assert.equal(err.name, 'TimeoutError');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('presetsList throws TimeoutError when fetch stalls', async () => {
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
    const err = await presetsList().then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.name, 'TimeoutError');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('postRefreshAll throws TimeoutError when fetch stalls', async () => {
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
    const err = await postRefreshAll().then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.name, 'TimeoutError');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('tuneinSearch (getJson) throws TimeoutError when fetch stalls', async () => {
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
    const err = await tuneinSearch('jazz').then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(err.name, 'TimeoutError');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

// --- wrappers: envelope endpoints -----------------------------------

test('playGuideId: timeout maps to {ok:false, error:{code:TIMEOUT}} envelope', async () => {
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
    const body = await playGuideId('s12345', 'Radio Test');
    assert.equal(body.ok, false, 'envelope-shape failure, not a throw');
    assert.equal(body.error.code, 'TIMEOUT');
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.message.length > 0);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('playGuideId: still throws synchronously when name is missing (#99 contract)', async () => {
  // #99 invariant — name is structurally required. Don't regress it.
  await assert.rejects(() => playGuideId('s12345'), /label is required/);
  await assert.rejects(() => playGuideId('s12345', ''), /label is required/);
});

test('previewStream: timeout maps to {ok:false, error:{code:TIMEOUT}} envelope', async () => {
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
    const body = await previewStream({ id: 's1', name: 'x', json: '{}' });
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'TIMEOUT');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('presetsAssign: timeout maps to {ok:false, error:{code:TIMEOUT}} envelope', async () => {
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
    const body = await presetsAssign(1, { id: 'x', slot: 1, name: 'x', kind: 'playable', json: '{}' });
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'TIMEOUT');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

// --- happy-path regressions -----------------------------------------

test('happy path: timer is cleared on a normal POST response', async () => {
  const realFetch = globalThis.fetch;
  let clearCount = 0;
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => { clearCount += 1; return realClear(id); };

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, url: 'http://stream/x' }),
  });

  try {
    const body = await playGuideId('s24862', 'Radio Test');
    assert.equal(body.ok, true, 'happy-path envelope preserved');
    assert.ok(clearCount >= 1, 'timer cleared at least once on success');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.clearTimeout = realClear;
  }
});

test('defaults: read=5000ms, write=10000ms match server-side --max-time', () => {
  assert.equal(DEFAULT_READ_TIMEOUT_MS, 5000);
  assert.equal(DEFAULT_WRITE_TIMEOUT_MS, 10000);
});
