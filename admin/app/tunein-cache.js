// tunein-cache — generic TTL-aware session cache for TuneIn metadata.
//
// One key, one value, one TTL — the cache is content-agnostic. Callers
// compose their own keys (e.g. `tunein.label.<guide_id>`,
// `tunein.drill.<sig>`, `tunein.stream.<sid>`) and pick the appropriate
// TTL constant for the volatility of that content.
//
// Storage is sessionStorage so the cache survives soft navigations
// inside one admin SPA tab but resets on a full reload — which is the
// right granularity for "the labels I just saw" without retaining
// stale data across speakers.
//
// Envelope shape, serialised as JSON under each key:
//   { ts: <ms-since-epoch>, ttl: <ms>, value: <whatever the caller stored> }
//
// `get(key)` auto-expires: when `Date.now() - ts > ttl` it removes the
// key and returns undefined. `set(key, value, ttl)` writes a fresh
// envelope. `invalidate(key)` removes unconditionally.
//
// Time source is `Date.now`. Tests override it via the optional
// `clock` argument to `createCache()`; the default-exported `cache`
// uses real time. Same trick for the storage backend so tests can
// swap in a mock without polluting the global sessionStorage shim.
//
// TTL constants below are content-type recipes — callers pick the
// one that matches the volatility tier from
// docs/tunein-api.md § 11 (cache budgets). They are not enforced by
// the cache itself.

// Stable / slow-moving content — drill head (15 minutes).
export const TTL_DRILL_HEAD = 15 * 60_000;

// Effectively-stable taxonomy — drill tail / catalogue dumps (24 h).
export const TTL_DRILL_TAIL = 24 * 60 * 60_000;

// Volatile stream URLs — verified-good per session (5 minutes).
export const TTL_STREAM     = 5 * 60_000;

// Display labels — names of nodes the user has already visited. The
// TuneIn taxonomy is effectively stable so labels age out daily.
export const TTL_LABEL      = 24 * 60 * 60_000;

// Decide whether the runtime exposes a usable sessionStorage. Node
// has none; the test harness installs a shim on globalThis. Anything
// missing the three methods we touch fails closed (every read returns
// undefined and every write is silently dropped).
function defaultStorage() {
  const ss = (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
  if (!ss) return null;
  if (typeof ss.getItem !== 'function') return null;
  if (typeof ss.setItem !== 'function') return null;
  if (typeof ss.removeItem !== 'function') return null;
  return ss;
}

// Internal factory so tests can dependency-inject the clock and the
// storage backend. The default export wires both to their real-world
// values.
export function createCache(opts = {}) {
  const now = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  // Distinguish "not passed" (use the runtime default) from "explicitly
  // null" (no storage at all — fails closed). Tests rely on the
  // explicit-null path to assert the silent-no-op behaviour.
  const store = ('storage' in opts) ? opts.storage : defaultStorage();

  function safeGet(key) {
    if (!store) return null;
    try { return store.getItem(key); }
    catch (_err) { return null; }
  }

  function safeSet(key, value) {
    if (!store) return;
    try { store.setItem(key, value); }
    catch (_err) { /* quota / private-mode: silently drop */ }
  }

  function safeRemove(key) {
    if (!store) return;
    try { store.removeItem(key); }
    catch (_err) { /* same fail-closed posture as safeSet */ }
  }

  return {
    // get(key) → value | undefined. Auto-expires: when the envelope's
    // age exceeds its ttl the key is deleted and undefined is returned.
    get(key) {
      const raw = safeGet(key);
      if (raw == null) return undefined;
      let env;
      try { env = JSON.parse(raw); }
      catch (_err) {
        // Corrupt envelope — drop it so a subsequent set can recover.
        safeRemove(key);
        return undefined;
      }
      if (!env || typeof env !== 'object') {
        safeRemove(key);
        return undefined;
      }
      const ts  = Number(env.ts);
      const ttl = Number(env.ttl);
      if (!Number.isFinite(ts) || !Number.isFinite(ttl)) {
        safeRemove(key);
        return undefined;
      }
      if (now() - ts > ttl) {
        safeRemove(key);
        return undefined;
      }
      return env.value;
    },

    // set(key, value, ttlMs). Stores a {ts, ttl, value} envelope under
    // `key`. JSON-serialisation failures (cyclic values, etc.) are
    // swallowed — the cache fails closed rather than throwing on the
    // hot path.
    set(key, value, ttlMs) {
      if (typeof key !== 'string' || key === '') return;
      const ttl = Number(ttlMs);
      if (!Number.isFinite(ttl) || ttl <= 0) return;
      const env = { ts: now(), ttl, value };
      let serialised;
      try { serialised = JSON.stringify(env); }
      catch (_err) { return; }
      safeSet(key, serialised);
    },

    // invalidate(key). Unconditional removal; no error if absent.
    invalidate(key) {
      if (typeof key !== 'string' || key === '') return;
      safeRemove(key);
    },
  };
}

// Default-exported singleton wired to the real clock and the runtime's
// sessionStorage (or a no-op fallback when sessionStorage is unavailable).
// Tests that need clock control build their own via createCache().
export const cache = createCache();
