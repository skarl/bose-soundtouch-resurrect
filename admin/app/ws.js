// WebSocket deep module. Public surface: connect(state), disconnect().
// Owns the WebSocket lifecycle; internals are not exported.
// See admin/PLAN.md § Live updates and § State management.

import {
  getSpeakerInfo, getNowPlaying, presetsList,
  parseNowPlayingEl,
  getVolume, parseVolumeEl,
  getSources, parseSourcesEl,
} from './api.js';
import { setNowPlaying, setPresets } from './state.js';
import { showToast } from './toast.js';

let socket = null;
let userInitiatedClose = false;

// Throttle "Presets changed" toasts — the firmware can emit several
// presetsUpdated events in quick succession when reordering slots.
let lastPresetsToastAt = 0;
const PRESETS_TOAST_GAP_MS = 1500;

// Injected by now-playing.js after it creates its volume sender.
// Called by volumeUpdated so the sender can suppress redundant POSTs
// when the speaker already reflects the queued level.
let volumeConfirmFn = null;
export function setVolumeConfirmFn(fn) { volumeConfirmFn = fn; }

// --- Backoff sequencer ----------------------------------------------

// Exponential backoff with full jitter. baseline = min(30000, 500 * 2^attempt).
// Jitter selects uniformly from [0, baseline), keeping reconnect storms
// at bay when many tabs wake up simultaneously.
export function backoff(attempt) {
  const baseline = Math.min(30000, 500 * Math.pow(2, attempt));
  return Math.random() * baseline;
}

// --- Module-scoped reconnect state ----------------------------------

let attempt      = 0;   // reconnect attempt counter; reset to 0 on successful hello
let consecutiveFails = 0; // consecutive close events without a successful hello
let reconnectTimer = null;
let pollInterval   = null;
let storeRef       = null;    // set on first connect() call
let visibilityBound = false;

// --- Polling fallback -----------------------------------------------

async function pollTick() {
  if (!storeRef) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  try {
    const [info, np, env, vol, sources] = await Promise.allSettled([
      getSpeakerInfo(),
      getNowPlaying(),
      presetsList(),
      getVolume(),
      getSources(),
    ]);
    if (info.status === 'fulfilled' && info.value) {
      storeRef.state.speaker.info = info.value;
      storeRef.touch('speaker');
    }
    if (np.status === 'fulfilled' && np.value) {
      setNowPlaying(np.value);
    }
    if (env.status === 'fulfilled' && env.value && env.value.ok && Array.isArray(env.value.data)) {
      setPresets(env.value.data);
    }
    if (vol.status === 'fulfilled' && vol.value) {
      storeRef.state.speaker.volume = vol.value;
      storeRef.touch('speaker');
    }
    if (sources.status === 'fulfilled' && sources.value) {
      storeRef.state.speaker.sources = sources.value;
      storeRef.touch('speaker');
    }
  } catch (_err) {
    // Network errors are non-fatal; next tick will retry.
  }
}

function startPolling() {
  if (pollInterval != null) return;
  pollInterval = setInterval(pollTick, 2000);
}

function stopPolling() {
  if (pollInterval == null) return;
  clearInterval(pollInterval);
  pollInterval = null;
}

// --- Full state refetch (called after WS hello) ---------------------

async function refetchAll() {
  if (!storeRef) return;
  try {
    const [info, np, env, vol, sources] = await Promise.allSettled([
      getSpeakerInfo(),
      getNowPlaying(),
      presetsList(),
      getVolume(),
      getSources(),
    ]);
    if (info.status === 'fulfilled' && info.value) {
      storeRef.state.speaker.info = info.value;
      storeRef.touch('speaker');
    }
    if (np.status === 'fulfilled' && np.value) {
      setNowPlaying(np.value);
    }
    if (env.status === 'fulfilled' && env.value && env.value.ok && Array.isArray(env.value.data)) {
      setPresets(env.value.data);
    }
    if (vol.status === 'fulfilled' && vol.value) {
      storeRef.state.speaker.volume = vol.value;
      storeRef.touch('speaker');
    }
    if (sources.status === 'fulfilled' && sources.value) {
      storeRef.state.speaker.sources = sources.value;
      storeRef.touch('speaker');
    }
  } catch (_err) {
    // Non-fatal; state was already live via WS events.
  }
}

// --- XML dispatch ---------------------------------------------------

// Dispatch table for events that arrive inside <updates …>…</updates>.
// Each handler receives (innerElement, store). Returning early on an
// unknown tag is safe — the firmware freely adds tags we haven't mapped yet.
const ENVELOPE_HANDLERS = {
  volumeUpdated(el, store) {
    const volEls = el.getElementsByTagName('volume');
    const volEl = volEls && volEls[0];
    if (!volEl) return;
    const parsed = parseVolumeEl(volEl);
    if (!parsed) return;
    store.state.speaker.volume = parsed;
    store.touch('speaker');
    if (volumeConfirmFn) volumeConfirmFn(parsed.actualVolume);
  },
  nowPlayingUpdated(el, store) {
    const nps = el.getElementsByTagName('nowPlaying');
    const np = nps && nps[0];
    if (!np) return;
    const parsed = parseNowPlayingEl(np);
    if (!parsed) return;
    store.state.speaker.nowPlaying = parsed;
    store.touch('speaker');
  },
  nowSelectionUpdated(el, store) {
    // <nowSelectionUpdated><preset id="N"><ContentItem …/></preset></nowSelectionUpdated>
    // The id attribute is the preset slot number (1-based). Emit a toast
    // so the user knows which preset is now active regardless of whether
    // the trigger was a hardware button, another tab, or this tab's tap.
    const presets = el.getElementsByTagName('preset');
    const preset = presets && presets[0];
    if (preset) {
      const slot = preset.getAttribute('id');
      if (slot) showToast(`Preset ${slot} selected`);
    }
    void store;
  },
  sourcesUpdated(el, store) {
    // The firmware sends <sourcesUpdated deviceID="…"/> as a hint-only
    // event — no inline sources list. Refetch /sources for the new state.
    // Some firmware variants may embed a <sources> child; try that first
    // so we avoid a round-trip when the data is already there.
    const sourcesList = el.getElementsByTagName('sources');
    if (sourcesList && sourcesList[0]) {
      const parsed = parseSourcesEl(sourcesList[0]);
      if (parsed) {
        store.state.speaker.sources = parsed;
        store.touch('speaker');
        return;
      }
    }
    getSources().then((sources) => {
      if (!sources) return;
      store.state.speaker.sources = sources;
      store.touch('speaker');
    }).catch(() => {});
  },
  presetsUpdated(el, store) {
    // <presetsUpdated/> is a hint-only event (parallel to sourcesUpdated).
    // Refetch /presets via the existing CGI parser — one source of truth
    // for slot ordering, art enrichment, and empty-slot detection.
    presetsList().then((env) => {
      if (!env || !env.ok || !Array.isArray(env.data)) return;
      setPresets(env.data);
    }).catch(() => {});

    const now = Date.now();
    if (now - lastPresetsToastAt >= PRESETS_TOAST_GAP_MS) {
      lastPresetsToastAt = now;
      showToast('Presets changed');
    }
    void el; void store;
  },
  keyEvent(el, store) {                  // TODO slice 8
    void el; void store;
  },
  connectionStateUpdated(el, store) {
    // The speaker sends this when network topology changes (e.g. a
    // second device connects or disconnects). No state to update yet;
    // slice 5 (sources) will decode the payload when it needs to.
    void el; void store;
  },
};

// Dispatch a single parsed frame against the store state.
// Exported so test_ws_dispatch.js can drive it without a live socket.
export function dispatch(xmlText, store) {
  const doc = parseXml(xmlText);
  if (!doc) return;

  const root = doc.documentElement;
  if (!root) return;

  const tag = root.tagName;

  if (tag === 'SoundTouchSdkInfo') {
    // Hello frame received — WS is live. Reset reconnect counters,
    // stop polling, and refetch state the speaker didn't replay.
    attempt = 0;
    consecutiveFails = 0;
    stopPolling();
    store.state.ws.connected = true;
    store.state.ws.mode = 'ws';
    store.touch('ws');
    refetchAll();
    return;
  }

  if (tag === 'userActivityUpdate') {
    store.state.ws.lastEvent = Date.now();
    store.touch('ws');
    return;
  }

  if (tag === 'updates') {
    for (const child of root.children) {
      const handler = ENVELOPE_HANDLERS[child.tagName];
      if (handler) handler(child, store);
    }
    return;
  }
}

// --- XML parsing ----------------------------------------------------

// parseXml returns a Document or null. Browser DOMParser signals a
// parse failure by appending a <parsererror> node; @xmldom/xmldom (the
// test runtime) throws instead. Handle both shapes so dispatch() can
// stay simple.
function parseXml(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (typeof DOMParser === 'undefined') return null;
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (_err) {
    return null;
  }
  if (!doc || !doc.documentElement) return null;
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  return doc;
}

// --- Visibility handling --------------------------------------------

function onVisibilityChange() {
  if (typeof document === 'undefined') return;
  if (document.hidden) {
    // Cancel pending reconnect and REST polling while hidden.
    // Don't close a live socket — it may still deliver events on resume.
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopPolling();
  } else {
    // Tab became visible again.
    if (storeRef && storeRef.state.ws.connected) {
      // WS is still alive — events resume automatically.
    } else {
      // WS dropped while hidden (or never connected). Retry immediately.
      attempt = 0;
      connect(storeRef);
    }
  }
}

function bindVisibility() {
  if (visibilityBound) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityBound = true;
}

function unbindVisibility() {
  if (!visibilityBound) return;
  if (typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  visibilityBound = false;
}

// --- Socket lifecycle -----------------------------------------------

export function connect(store) {
  if (socket) return;
  if (!store) return;

  storeRef = store;
  bindVisibility();

  const url = `ws://${location.hostname}:8080/`;
  socket = new WebSocket(url, 'gabbo');

  store.state.ws.connected = false;
  store.state.ws.mode = 'connecting';
  store.touch('ws');

  socket.addEventListener('message', (evt) => {
    dispatch(evt.data, store);
  });

  socket.addEventListener('close', () => {
    socket = null;
    if (userInitiatedClose) {
      userInitiatedClose = false;
      return;
    }

    store.state.ws.connected = false;
    consecutiveFails += 1;

    // First close → reconnecting; subsequent → polling (with continued polling).
    if (consecutiveFails === 1) {
      store.state.ws.mode = 'reconnecting';
    } else {
      store.state.ws.mode = 'polling';
    }
    store.touch('ws');

    // Start REST polling on first drop and keep it running.
    if (typeof document === 'undefined' || !document.hidden) {
      startPolling();
    }

    // Schedule reconnect unless the tab is hidden.
    if (typeof document === 'undefined' || !document.hidden) {
      const delay = backoff(attempt);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(store);
      }, delay);
    }
  });

  socket.addEventListener('error', () => {
    // 'error' is always followed by 'close', which drives reconnect logic.
  });
}

export function disconnect() {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPolling();
  unbindVisibility();
  attempt = 0;
  consecutiveFails = 0;
  if (!socket) return;
  userInitiatedClose = true;
  socket.close();
  socket = null;
}
