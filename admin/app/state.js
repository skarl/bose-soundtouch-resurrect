// Split observable store. Top-level keys: speaker, caches, ws, ui.
// Mutators subscribe to one key and receive (state, changedTopLevelKey).
// See admin/PLAN.md § State management.

const TOP_LEVEL_KEYS = ['speaker', 'caches', 'ws', 'ui'];

// Recently-viewed station list. station.js prepends on view-entry;
// search.js renders it as the empty-state landing. Shape:
// Array<{ sid, name, art? }>, most-recent first, capped at RECENT_MAX.
// In-memory only — the list is short-lived UX scaffolding, not a record.
const RECENT_MAX = 10;

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
    update(key, mutator) {
      if (!subs.has(key)) throw new Error(`unknown state key: ${key}`);
      mutator(store.state);
      notify(key);
    },
  };
  return store;
}

export const store = observable({
  speaker: {
    info:           null,   // {deviceID, name, type, firmwareVersion, ...}
    nowPlaying:     null,   // {source, item, track, artist, art, playStatus}
    presets:        null,   // [{slot, source, type, location, itemName, art}, ...]
    volume:         null,   // {targetVolume, actualVolume, muteEnabled}
    sources:        null,   // [{source, sourceAccount, displayName, status, isLocal}, ...]
    bass:           null,   // {targetBass, actualBass}
    balance:        null,   // {targetBalance, actualBalance}
    dspMonoStereo:  null,   // {mode: 'mono' | 'stereo'}
    zone:           null,   // {master, members: [{ipAddress, deviceID}, ...]}
    bluetooth:      null,   // {paired: [{name, mac}, ...], pairing}
    network:        null,   // {ssid, ipAddress, macAddress, signalDbm}
    recents:        null,   // [{utcTime, source, sourceAccount, type, location, itemName, containerArt}, ...]
    capabilities:   null,   // {deviceID, dspMonoStereo, lrStereoCapable, ..., capabilities:[{name,url}]}
    systemTimeout:    null, // {enabled, minutes}
  },
  caches: {
    probe:          new Map(),               // sid → Probe = {sid, verdict, tuneinJson, expires} — TTL 10 min
  },
  // recentEvents is a 50-entry FIFO ring of inbound WS frames (raw text +
  // root tag), surfaced by the System settings section as a debug log.
  ws: { connected: false, mode: 'offline', lastEvent: null, recentEvents: [] },
  ui: {
    toast: null,
    testPlaying: null,
    activeTab: 'now',
    // Station detail pages the admin user has opened, most-recent
    // first. UX scaffolding for the search empty state — distinct from
    // state.speaker.recents (the speaker's own play history). Lives
    // under .ui so the structural distinction is unmistakable.
    visitedStations: [],                     // [{sid, name, art?}], in-memory only
  },
});

// Prepend an entry to state.ui.visitedStations, dedupe by sid, cap at
// RECENT_MAX, and notify 'ui' subscribers. Station view calls this on
// entry; search empty state reads the array.
export function addVisitedStation({ sid, name, art }) {
  if (typeof sid !== 'string' || !sid) return;
  if (typeof name !== 'string' || !name) return;
  const entry = { sid, name };
  if (typeof art === 'string' && art) entry.art = art;

  const current = store.state.ui.visitedStations || [];
  const deduped = current.filter((e) => e.sid !== sid);
  const next = [entry, ...deduped].slice(0, RECENT_MAX);

  store.state.ui.visitedStations = next;
  store.touch('ui');
}
