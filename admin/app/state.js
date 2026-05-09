// Split observable store. Top-level keys: speaker, caches, ws, ui.
// Mutators subscribe to one key and receive (state, changedTopLevelKey).
// See admin/PLAN.md § State management.

const TOP_LEVEL_KEYS = ['speaker', 'caches', 'ws', 'ui'];

function observable(initial) {
  const subs = new Map(TOP_LEVEL_KEYS.map((k) => [k, new Set()]));
  const notify = (key) => {
    for (const fn of subs.get(key)) fn(store.state, key);
  };
  const store = {
    state: initial,
    subscribe(key, fn) {
      if (!subs.has(key)) throw new Error(`unknown state key: ${key}`);
      subs.get(key).add(fn);
      return () => subs.get(key).delete(fn);
    },
    set(key, value) {
      if (!subs.has(key)) throw new Error(`unknown state key: ${key}`);
      store.state[key] = value;
      notify(key);
    },
    touch(key) {
      if (!subs.has(key)) throw new Error(`unknown state key: ${key}`);
      notify(key);
    },
  };
  return store;
}

export const store = observable({
  speaker: {
    info:       null,   // {deviceID, name, type, firmwareVersion, ...}
    nowPlaying: null,   // {source, item, track, artist, art, playStatus}
    presets:    null,   // [{slot, source, type, location, itemName, art}, ...]
    volume:     null,   // 0.3+
    sources:    null,   // 0.3+
  },
  caches: {
    probe:          new Map(),  // sid -> {ok, kind, url, expires}
    recentlyViewed: [],         // station ids, persisted in localStorage
  },
  ws: { connected: false, lastEvent: null },   // 0.3+
  ui: { toast: null, testPlaying: null },
});
