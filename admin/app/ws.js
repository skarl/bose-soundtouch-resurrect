// WebSocket lifecycle module. Public surface: connect(store), disconnect().
// Owns the WebSocket lifecycle, backoff, polling fallback, and top-level
// XML routing. Per-field fetch/parse/apply logic lives in speaker-state.js.
// See admin/PLAN.md § Live updates and § State management.

import { reconcile, dispatch as speakerDispatch } from './speaker-state.js';
import { showToast } from './toast.js';
import { wasRecentOutgoing } from './io-ledger.js';

let socket = null;
let userInitiatedClose = false;

// Throttle "Presets changed" toasts — the firmware can emit several
// presetsUpdated events in quick succession when reordering slots.
let lastPresetsToastAt = 0;
const PRESETS_TOAST_GAP_MS = 1500;

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

// --- Speaker-button attribution (Option B) --------------------------
//
// We can't rely on <keyEvent> firing on physical button presses — the
// spike showed nowPlayingUpdated/volumeUpdated DO fire reliably but
// keyEvent does not. Instead, watch state changes and attribute them to
// hardware buttons when no outgoing API call was recorded in the last 2s.

let prevPlayStatus = null;    // last known playStatus value
let prevSource     = null;    // last known nowPlaying source/item combo
let prevVolume     = null;    // last known actualVolume
let volToastTs     = 0;       // timestamp of last volume toast (throttle)
const VOL_TOAST_COOLDOWN = 1500;

function watchSpeakerButtons(store) {
  store.subscribe('speaker', (state) => {
    const np  = state.speaker.nowPlaying;
    const vol = state.speaker.volume;

    // --- play/pause change ---
    const ps = np && np.playStatus;
    if (ps !== prevPlayStatus) {
      if (prevPlayStatus !== null && (ps === 'PLAY_STATE' || ps === 'PAUSE_STATE')) {
        if (!wasRecentOutgoing('transport')) {
          showToast('Play/Pause pressed on speaker');
        }
      }
      prevPlayStatus = ps;
    }

    // --- source / selection change ---
    // Use source + item location as a compound key to distinguish preset changes.
    const sourceKey = np && np.source && np.source !== 'STANDBY'
      ? `${np.source}:${(np.item && np.item.location) || ''}`
      : null;
    if (sourceKey !== null && sourceKey !== prevSource) {
      if (prevSource !== null && !wasRecentOutgoing('source') && !wasRecentOutgoing('preset')) {
        showToast('Source switched on speaker');
      }
      prevSource = sourceKey;
    } else if (sourceKey !== null) {
      prevSource = sourceKey;
    }

    // --- volume change ---
    const av = vol && vol.actualVolume;
    if (typeof av === 'number' && av !== prevVolume) {
      if (prevVolume !== null && !wasRecentOutgoing('volume')) {
        const delta = Math.abs(av - prevVolume);
        if (delta > 1) {
          const now = Date.now();
          if (now - volToastTs > VOL_TOAST_COOLDOWN) {
            showToast('Volume changed on speaker');
            volToastTs = now;
          }
        }
      }
      prevVolume = av;
    }
  });
}

// --- Polling fallback -----------------------------------------------

function startPolling() {
  if (pollInterval != null) return;
  pollInterval = setInterval(() => reconcile(storeRef), 2000);
}

function stopPolling() {
  if (pollInterval == null) return;
  clearInterval(pollInterval);
  pollInterval = null;
}

// --- XML dispatch ---------------------------------------------------

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
    reconcile(store);
    return;
  }

  if (tag === 'userActivityUpdate') {
    store.state.ws.lastEvent = Date.now();
    store.touch('ws');
    return;
  }

  if (tag === 'updates') {
    for (const child of root.children) {
      if (child.tagName === 'nowSelectionUpdated') {
        // Not a field-state event — just a "preset N selected" toast.
        const presets = child.getElementsByTagName('preset');
        const preset = presets && presets[0];
        if (preset) {
          const slot = preset.getAttribute('id');
          if (slot) showToast(`Preset ${slot} selected`);
        }
        // Also trigger a presets refetch so the row stays in sync.
        // Pass a minimal fake element so speakerDispatch's hint-only path fires.
        speakerDispatch({ tagName: 'presetsUpdated', getElementsByTagName: () => null }, store);
        continue;
      }

      if (child.tagName === 'presetsUpdated') {
        const now = Date.now();
        if (now - lastPresetsToastAt >= PRESETS_TOAST_GAP_MS) {
          lastPresetsToastAt = now;
          showToast('Presets changed');
        }
      }

      speakerDispatch(child, store);
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

let speakerWatchBound = false;

export function connect(store) {
  if (socket) return;
  if (!store) return;

  storeRef = store;
  if (!speakerWatchBound) {
    watchSpeakerButtons(store);
    speakerWatchBound = true;
  }
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
  speakerWatchBound = false;
  prevPlayStatus = null;
  prevSource     = null;
  prevVolume     = null;
  volToastTs     = 0;
  if (!socket) return;
  userInitiatedClose = true;
  socket.close();
  socket = null;
}
