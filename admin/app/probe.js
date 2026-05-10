// probe — cache-aware probe orchestrator and preset-assign helper.
//
// Three exports:
//   probe(sid)                               → Promise<Probe>
//   assignToPreset(probe, slot, opts)        → Promise<envelope>
//   buildBosePayload(probe, name, url?)      → BoseJson
//
// See admin/PLAN.md § State management and § REST API.

import { tuneinProbe as _tuneinProbe, presetsAssign as _presetsAssign } from './api.js';
import { store, setPresets as _setPresets } from './state.js';
import { classify, reshape } from './reshape.js';

const PROBE_TTL_MS = 10 * 60 * 1000;   // 10 minutes

// Swappable deps — test suite replaces these via _setDeps().
let deps = {
  tuneinProbe: _tuneinProbe,
  presetsAssign: _presetsAssign,
  setPresets: _setPresets,
};

// _setDeps(overrides) — test-only injection point. Pass a partial object;
// any keys provided replace the corresponding default dep.
export function _setDeps(overrides) {
  deps = { ...deps, ...overrides };
}

// probe(sid) → Promise<Probe>
//
// Probe = { sid, verdict, tuneinJson, expires }
// verdict mirrors classify() directly:
//   { kind: 'playable', streams: [...] }
//   { kind: 'gated', reason: '...' }
//   { kind: 'dark', reason: '...' }
//
// Cache hit (not expired) → return cached. Cache hit (expired) → re-fetch.
// Cache miss → fetch via tuneinProbe, classify, store, return.
// Transport errors propagate; no cache write on error.
export async function probe(sid) {
  const cache = store.state.caches.probe;

  const hit = cache.get(sid);
  if (hit) {
    if (hit.expires > Date.now()) return hit;
    cache.delete(sid);
  }

  const tuneinJson = await deps.tuneinProbe(sid);
  const verdict = classify(tuneinJson);
  const entry = { sid, verdict, tuneinJson, expires: Date.now() + PROBE_TTL_MS };
  cache.set(sid, entry);
  return entry;
}

// buildBosePayload(probeResult, name, chosenStreamUrl?) → BoseJson
//
// Calls reshape() (byte-pinned against resolver/build.py:make_bose).
// If chosenStreamUrl is provided, overrides result.audio.streamUrl with
// the user's chosen stream — the override is a JS-only workflow concern
// that must not touch reshape() itself.
export function buildBosePayload(probeResult, name, chosenStreamUrl) {
  const j = reshape(probeResult.tuneinJson, probeResult.sid, name);
  if (!j) return null;
  if (chosenStreamUrl && j.audio && Array.isArray(j.audio.streams)) {
    const match = j.audio.streams.find((s) => s.streamUrl === chosenStreamUrl);
    if (match) j.audio.streamUrl = match.streamUrl;
  }
  return j;
}

// assignToPreset(probeResult, slot, opts) → Promise<envelope>
//
// opts = { name: string, art?: string, chosenStreamUrl?: string }
//
// Non-playable verdict → synthesized {ok:false, error:{code:'NOT_PLAYABLE'}};
// presetsAssign and setPresets are not called.
// Playable → build Bose JSON, POST presetsAssign, on {ok:true} reconcile
// state via setPresets(envelope.data), return envelope.
// Transport errors from presetsAssign propagate.
export async function assignToPreset(probeResult, slot, opts) {
  const { name, art, chosenStreamUrl } = opts || {};

  if (!probeResult || !probeResult.verdict || probeResult.verdict.kind !== 'playable') {
    return { ok: false, error: { code: 'NOT_PLAYABLE' } };
  }

  const bose = buildBosePayload(probeResult, name, chosenStreamUrl);
  if (!bose) {
    return { ok: false, error: { code: 'NOT_PLAYABLE' } };
  }

  const envelope = await deps.presetsAssign(slot, {
    id:   probeResult.sid,
    slot,
    name,
    art:  art || '',
    kind: 'playable',
    json: bose,
  });

  if (envelope && envelope.ok && Array.isArray(envelope.data)) {
    deps.setPresets(envelope.data);
  }

  return envelope;
}
