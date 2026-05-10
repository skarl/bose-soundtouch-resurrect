// Tests for app/probe.js — cache-aware probe orchestrator + preset assign.
//
// Stubs: tuneinProbe, presetsAssign, setPresets injected via _setDeps().
// The probe cache (state.caches.probe) is reset before each test by
// clearing the Map directly.
//
// Run locally:
//   node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { probe, assignToPreset, buildBosePayload, _setDeps } from '../app/probe.js';
import { store } from '../app/state.js';
import { reshape } from '../app/reshape.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

// Reset the probe cache and dep stubs before each test.
beforeEach(() => {
  store.state.caches.probe.clear();
  _setDeps({
    tuneinProbe: async (_sid) => { throw new Error('tuneinProbe not stubbed'); },
    presetsAssign: async (_slot, _payload) => { throw new Error('presetsAssign not stubbed'); },
    setPresets: (_list) => { throw new Error('setPresets not stubbed'); },
  });
});

// ---- probe() tests -------------------------------------------------------

test('probe: cache miss — tuneinProbe called once, result cached and returned', async () => {
  const tunein = await readJson(join(FIXTURES, 's12345.tunein.json'));
  const calls = [];
  _setDeps({
    tuneinProbe: async (sid) => { calls.push(sid); return tunein; },
  });

  const result = await probe('s12345');

  assert.equal(calls.length, 1, 'tuneinProbe called exactly once');
  assert.equal(calls[0], 's12345');
  assert.equal(result.sid, 's12345');
  assert.equal(result.verdict.kind, 'playable');
  assert.deepStrictEqual(result.tuneinJson, tunein);
  assert.ok(typeof result.expires === 'number' && result.expires > Date.now(), 'expires in the future');

  // Cache should now hold the entry.
  const cached = store.state.caches.probe.get('s12345');
  assert.ok(cached, 'entry stored in cache');
  assert.equal(cached.sid, 's12345');
});

test('probe: cache hit (fresh) — tuneinProbe not called, cached entry returned', async () => {
  const tunein = await readJson(join(FIXTURES, 's12345.tunein.json'));
  const existing = {
    sid: 's12345',
    verdict: { kind: 'playable', streams: [{ streamUrl: 'http://example.com/stream' }] },
    tuneinJson: tunein,
    expires: Date.now() + 5 * 60 * 1000,
  };
  store.state.caches.probe.set('s12345', existing);

  const calls = [];
  _setDeps({ tuneinProbe: async (sid) => { calls.push(sid); return tunein; } });

  const result = await probe('s12345');

  assert.equal(calls.length, 0, 'tuneinProbe not called on cache hit');
  assert.strictEqual(result, existing, 'returned the exact cached object');
});

test('probe: cache hit (expired) — tuneinProbe re-called, cache overwritten', async () => {
  const tunein = await readJson(join(FIXTURES, 's12345.tunein.json'));
  const stale = {
    sid: 's12345',
    verdict: { kind: 'dark', reason: 'stale' },
    tuneinJson: {},
    expires: Date.now() - 1,   // already expired
  };
  store.state.caches.probe.set('s12345', stale);

  const calls = [];
  _setDeps({ tuneinProbe: async (sid) => { calls.push(sid); return tunein; } });

  const result = await probe('s12345');

  assert.equal(calls.length, 1, 'tuneinProbe re-called for expired entry');
  assert.equal(result.verdict.kind, 'playable', 'fresh verdict from re-fetch');
  assert.ok(result.expires > Date.now(), 'new expires in the future');

  const cached = store.state.caches.probe.get('s12345');
  assert.notStrictEqual(cached, stale, 'cache entry overwritten');
  assert.equal(cached.verdict.kind, 'playable');
});

test('probe: transport error — probe() rejects and no cache write', async () => {
  _setDeps({ tuneinProbe: async () => { throw new Error('network failure'); } });

  await assert.rejects(
    () => probe('s12345'),
    /network failure/,
    'probe rejects with the transport error',
  );

  assert.equal(store.state.caches.probe.size, 0, 'nothing written to cache on error');
});

// ---- assignToPreset() tests -----------------------------------------------

test('assignToPreset: auto-pick — payload.json matches reshape(), setPresets called on ok', async () => {
  const tunein = await readJson(join(FIXTURES, 's12345.tunein.json'));
  const expected = await readJson(join(FIXTURES, 's12345.bose.json'));

  const probeResult = {
    sid: 's12345',
    verdict: { kind: 'playable', streams: [{ streamUrl: 'http://streams.example.de/live/hqlivestream.aac' }] },
    tuneinJson: tunein,
    expires: Date.now() + PROBE_TTL_MS_FOR_TEST,
  };

  const assignCalls = [];
  const setPresetsCalls = [];
  const okEnvelope = { ok: true, data: [{ slot: 2, name: 'Example Radio' }] };

  _setDeps({
    presetsAssign: async (slot, payload) => { assignCalls.push({ slot, payload }); return okEnvelope; },
    setPresets: (list) => { setPresetsCalls.push(list); },
  });

  const env = await assignToPreset(probeResult, 2, { name: 'Example Radio', art: '' });

  assert.ok(env.ok, 'envelope ok');
  assert.equal(assignCalls.length, 1, 'presetsAssign called once');
  assert.deepStrictEqual(assignCalls[0].payload.json, expected, 'payload.json matches reshape() fixture');
  assert.equal(assignCalls[0].slot, 2);
  assert.equal(setPresetsCalls.length, 1, 'setPresets called on ok');
  assert.deepStrictEqual(setPresetsCalls[0], okEnvelope.data);
});

test('assignToPreset: chosen-stream override — outgoing payload.json.audio.streamUrl equals chosen URL', async () => {
  const tunein = await readJson(join(FIXTURES, 's12345.tunein.json'));
  const chosenUrl = 'http://streams.example.de/live/livestream.mp3';

  const probeResult = {
    sid: 's12345',
    verdict: { kind: 'playable', streams: [{ streamUrl: 'http://streams.example.de/live/hqlivestream.aac' }] },
    tuneinJson: tunein,
    expires: Date.now() + PROBE_TTL_MS_FOR_TEST,
  };

  const assignCalls = [];
  _setDeps({
    presetsAssign: async (slot, payload) => { assignCalls.push(payload); return { ok: true, data: [] }; },
    setPresets: () => {},
  });

  await assignToPreset(probeResult, 1, { name: 'Example Radio', chosenStreamUrl: chosenUrl });

  assert.equal(assignCalls.length, 1);
  assert.equal(
    assignCalls[0].json.audio.streamUrl,
    chosenUrl,
    'chosen stream URL overrides the auto-picked default',
  );
});

test('assignToPreset: non-playable verdict — returns NOT_PLAYABLE, presetsAssign not called, setPresets not called', async () => {
  const tunein = await readJson(join(FIXTURES, 's99999.tunein.json'));

  const probeResult = {
    sid: 's99999',
    verdict: { kind: 'gated', reason: 'notcompatible' },
    tuneinJson: tunein,
    expires: Date.now() + PROBE_TTL_MS_FOR_TEST,
  };

  const assignCalls = [];
  const setPresetsCalls = [];
  _setDeps({
    presetsAssign: async (...args) => { assignCalls.push(args); return { ok: true, data: [] }; },
    setPresets: (list) => { setPresetsCalls.push(list); },
  });

  const env = await assignToPreset(probeResult, 3, { name: 'Gated Station' });

  assert.equal(env.ok, false, 'envelope not ok');
  assert.equal(env.error.code, 'NOT_PLAYABLE');
  assert.equal(assignCalls.length, 0, 'presetsAssign not called');
  assert.equal(setPresetsCalls.length, 0, 'setPresets not called');
});

// Constant used in tests — not importing from probe.js since it's internal.
const PROBE_TTL_MS_FOR_TEST = 10 * 60 * 1000;
