// Unit tests for the backoff(attempt) pure function in app/ws.js.
//
// Run locally:
//   node --test admin/test
//

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// ws.js imports from api.js and state.js, both of which reference browser
// globals (fetch, DOMParser, localStorage). Stub the minimum set so the
// module loads in Node without errors.
globalThis.fetch         = async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' });
globalThis.DOMParser     = class { parseFromString() { return { documentElement: null, getElementsByTagName: () => [] }; } };
globalThis.localStorage  = { getItem: () => null, setItem: () => {} };
globalThis.location      = { hostname: 'localhost' };
globalThis.WebSocket     = class { addEventListener() {} close() {} };

import { backoff } from '../app/ws.js';

const RUNS = 1000;

test('backoff(0) returns a number in [0, 500)', () => {
  for (let i = 0; i < RUNS; i++) {
    const ms = backoff(0);
    assert.ok(ms >= 0,   `expected ms >= 0, got ${ms}`);
    assert.ok(ms < 500,  `expected ms < 500, got ${ms}`);
  }
});

test('backoff(1) returns a number in [0, 1000)', () => {
  for (let i = 0; i < RUNS; i++) {
    const ms = backoff(1);
    assert.ok(ms >= 0,    `expected ms >= 0, got ${ms}`);
    assert.ok(ms < 1000,  `expected ms < 1000, got ${ms}`);
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
    assert.ok(ms >= 0,      `expected ms >= 0, got ${ms}`);
    assert.ok(ms <= 30000,  `expected ms <= 30000, got ${ms}`);
  }
});

test('backoff mean at attempt=10 is approximately 15000 (cap/2)', () => {
  // At attempt=10, baseline = min(30000, 500 * 1024) = 30000 (capped).
  // Full jitter gives a uniform [0, 30000) distribution → mean ≈ 15000.
  // Allow ±3000 tolerance for 1000-sample variance.
  let sum = 0;
  for (let i = 0; i < RUNS; i++) sum += backoff(10);
  const mean = sum / RUNS;
  assert.ok(mean > 12000, `mean ${mean.toFixed(0)} should be > 12000`);
  assert.ok(mean < 18000, `mean ${mean.toFixed(0)} should be < 18000`);
});
