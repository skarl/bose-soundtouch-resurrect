// Split observable store. Top-level keys: speaker, caches, ws, ui.
// Mutators subscribe to one key and receive (state, changedTopLevelKey).
// See admin/PLAN.md § State management.

const TOP_LEVEL_KEYS = ['speaker', 'caches', 'ws', 'ui'];

// Recently-viewed station list. station.js prepends on view-entry;
// search.js renders it as the empty-state landing. Shape:
// Array<{ sid, name, art? }>, most-recent first, capped at RECENT_MAX,
// persisted in localStorage.
const RECENT_KEY = 'admin.recentlyViewed';
const RECENT_MAX = 20;

function loadRecentlyViewed() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: drop anything missing the required {sid, name} pair so
    // search.js can render via stationCard() without null checks.
    return parsed.filter((e) => e && typeof e.sid === 'string' && typeof e.name === 'string');
  } catch (_err) {
    return [];
  }
}

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
    volume:     null,   // {targetVolume, actualVolume, muteEnabled}
    sources:    null,   // [{source, sourceAccount, displayName, status, isLocal}, ...]
  },
  caches: {
    probe:          new Map(),               // sid -> {kind, streams?, reason?, expires}
    recentlyViewed: loadRecentlyViewed(),    // [{sid, name, art?}], persisted in localStorage
  },
  ws: { connected: false, mode: 'offline', lastEvent: null },
  ui: { toast: null, testPlaying: null },
});

// Update state.speaker.nowPlaying and notify 'speaker' subscribers.
// now-playing.js calls this on every successful poll tick.
export function setNowPlaying(np) {
  store.state.speaker.nowPlaying = np;
  store.touch('speaker');
}

// Reconcile state.speaker.presets from the presets CGI envelope's
// `data` array. Defensive — the CGI guarantees a length-6 array, but
// store the value verbatim so any missing slots surface as `undefined`
// rather than masked. Notifies 'speaker' subscribers (now-playing).
export function setPresets(list) {
  if (!Array.isArray(list)) return;
  store.state.speaker.presets = list;
  store.touch('speaker');
}

// Prepend an entry to state.caches.recentlyViewed, dedupe by sid, cap
// at RECENT_MAX, persist to localStorage, and notify 'caches'
// subscribers. Station view calls this on entry; search empty state
// reads the array.
export function addRecentlyViewed({ sid, name, art }) {
  if (typeof sid !== 'string' || !sid) return;
  if (typeof name !== 'string' || !name) return;
  const entry = { sid, name };
  if (typeof art === 'string' && art) entry.art = art;

  const current = store.state.caches.recentlyViewed || [];
  const deduped = current.filter((e) => e.sid !== sid);
  const next = [entry, ...deduped].slice(0, RECENT_MAX);

  store.state.caches.recentlyViewed = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    }
  } catch (_err) {
    // Storage quota / private mode — non-fatal; in-memory list still works.
  }
  store.touch('caches');
}
