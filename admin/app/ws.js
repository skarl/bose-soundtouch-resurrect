// WebSocket lifecycle module. Public surface: connect(store), disconnect().
// Owns the WebSocket lifecycle, backoff, polling fallback, and top-level
// XML routing. Per-field fetch/parse/apply logic lives in speaker-state.js.
// See admin/PLAN.md § Live updates and § State management.
//
// Connection state machine:
//
//     +-------------+   open + hello   +-----------+
//     | connecting  | ---------------> | connected |
//     +-------------+                  +-----------+
//            ^                               |
//            |                               | close
//            | backoff timer                 v
//     +-------------+    next close    +-----------+
//     | reconnecting| <--------------- |  polling  |
//     +-------------+   (still down)   +-----------+
//
// Edges:
//   connecting  -> connected     SoundTouchSdkInfo hello frame received
//   connected   -> reconnecting  socket close (first consecutive fail)
//   reconnecting-> connecting    backoff timer fires
//   reconnecting-> polling       second+ consecutive close
//   polling     -> connected     hello frame on a later reconnect attempt

import { reconcile, dispatch as speakerDispatch, ledgerKindForEventTag } from './speaker-state.js';
import { showToast } from './toast.js';
import { wasRecent } from './actions/index.js';

const SOURCE_KIND = ledgerKindForEventTag('sourcesUpdated');
const VOLUME_KIND = ledgerKindForEventTag('volumeUpdated');

const PRESETS_TOAST_GAP_MS = 1500;
const VOL_TOAST_COOLDOWN   = 1500;

function makeConnectionState() {
  return {
    socket:             null,
    userInitiatedClose: false,
    attempt:            0,
    consecutiveFails:   0,
    reconnectTimer:     null,
    pollInterval:       null,
    storeRef:           null,
    visibilityBound:    false,
    speakerWatchBound:  false,
  };
}

function makeButtonWatch() {
  return {
    prevPlayStatus:     null,
    prevSource:         null,
    prevVolume:         null,
    volToastTs:         0,
    lastPresetsToastAt: 0,
  };
}

let conn  = makeConnectionState();
let watch = makeButtonWatch();

// --- Backoff sequencer ----------------------------------------------

// Exponential backoff with full jitter. baseline = min(30000, 500 * 2^attempt).
// Jitter selects uniformly from [0, baseline), keeping reconnect storms
// at bay when many tabs wake up simultaneously.
export function backoff(attempt) {
  const baseline = Math.min(30000, 500 * Math.pow(2, attempt));
  return Math.random() * baseline;
}

function watchSpeakerButtons(store) {
  store.subscribe('speaker', (state) => {
    const np  = state.speaker.nowPlaying;
    const vol = state.speaker.volume;

    // --- play/pause change ---
    const ps = np && np.playStatus;
    if (ps !== watch.prevPlayStatus) {
      if (watch.prevPlayStatus !== null && (ps === 'PLAY_STATE' || ps === 'PAUSE_STATE')) {
        if (!wasRecent('transport')) {
          showToast('Play/Pause pressed on speaker');
        }
      }
      watch.prevPlayStatus = ps;
    }

    // --- source / selection change ---
    // Use source + item location as a compound key to distinguish preset changes.
    const sourceKey = np && np.source && np.source !== 'STANDBY'
      ? `${np.source}:${(np.item && np.item.location) || ''}`
      : null;
    if (sourceKey !== null && sourceKey !== watch.prevSource) {
      if (watch.prevSource !== null && !wasRecent(SOURCE_KIND) && !wasRecent('preset')) {
        showToast('Source switched on speaker');
      }
      watch.prevSource = sourceKey;
    } else if (sourceKey !== null) {
      watch.prevSource = sourceKey;
    }

    // --- volume change ---
    const av = vol && vol.actualVolume;
    if (typeof av === 'number' && av !== watch.prevVolume) {
      if (watch.prevVolume !== null && !wasRecent(VOLUME_KIND)) {
        const delta = Math.abs(av - watch.prevVolume);
        if (delta > 1) {
          const now = Date.now();
          if (now - watch.volToastTs > VOL_TOAST_COOLDOWN) {
            showToast('Volume changed on speaker');
            watch.volToastTs = now;
          }
        }
      }
      watch.prevVolume = av;
    }
  });
}

// --- Polling fallback -----------------------------------------------

function startPolling() {
  if (conn.pollInterval != null) return;
  conn.pollInterval = setInterval(() => reconcile(conn.storeRef), 2000);
}

function stopPolling() {
  if (conn.pollInterval == null) return;
  clearInterval(conn.pollInterval);
  conn.pollInterval = null;
}

// --- XML dispatch ---------------------------------------------------

// Cap of the state.ws.recentEvents ring buffer. The settings/system WS
// log surfaces these; anything older falls off the back.
export const WS_LOG_CAP = 50;

// Append an event to the ring buffer and trim to WS_LOG_CAP. Most-recent
// first. Called from dispatch() once per inbound frame (pre-route) so we
// log even malformed payloads — they're the ones an operator wants to see.
export function pushRecentEvent(store, entry) {
  if (!store || !store.state || !store.state.ws) return;
  const buf = store.state.ws.recentEvents;
  if (!Array.isArray(buf)) {
    store.state.ws.recentEvents = [entry];
  } else {
    buf.unshift(entry);
    if (buf.length > WS_LOG_CAP) buf.length = WS_LOG_CAP;
  }
  if (typeof store.touch === 'function') store.touch('ws');
}

// Dispatch a single parsed frame against the store state.
// Exported so test_ws_dispatch.js can drive it without a live socket.
export function dispatch(xmlText, store) {
  const doc = parseXml(xmlText);
  // Log every inbound frame (pre-route) so the System WS log shows even
  // malformed envelopes; only frames we never receive (network drops)
  // are absent.
  if (store && store.state && store.state.ws) {
    const root0 = doc && doc.documentElement;
    pushRecentEvent(store, {
      ts: Date.now(),
      tag: root0 ? root0.tagName : '(unparsed)',
      raw: typeof xmlText === 'string' ? xmlText : '',
    });
  }
  if (!doc) return;

  const root = doc.documentElement;
  if (!root) return;

  const tag = root.tagName;

  if (tag === 'SoundTouchSdkInfo') {
    // Hello frame received — WS is live. Reset reconnect counters,
    // stop polling, and refetch state the speaker didn't replay.
    conn.attempt = 0;
    conn.consecutiveFails = 0;
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
        if (now - watch.lastPresetsToastAt >= PRESETS_TOAST_GAP_MS) {
          watch.lastPresetsToastAt = now;
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
    if (conn.reconnectTimer != null) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    stopPolling();
  } else {
    // Tab became visible again.
    if (conn.storeRef && conn.storeRef.state.ws.connected) {
      // WS is still alive — events resume automatically.
    } else {
      // WS dropped while hidden (or never connected). Retry immediately.
      conn.attempt = 0;
      connect(conn.storeRef);
    }
  }
}

function bindVisibility() {
  if (conn.visibilityBound) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  conn.visibilityBound = true;
}

function unbindVisibility() {
  if (!conn.visibilityBound) return;
  if (typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  conn.visibilityBound = false;
}

// --- Socket lifecycle -----------------------------------------------

export function connect(store) {
  if (conn.socket) return;
  if (!store) return;

  conn.storeRef = store;
  if (!conn.speakerWatchBound) {
    watchSpeakerButtons(store);
    conn.speakerWatchBound = true;
  }
  bindVisibility();

  const url = `ws://${location.hostname}:8080/`;
  conn.socket = new WebSocket(url, 'gabbo');

  store.state.ws.connected = false;
  store.state.ws.mode = 'connecting';
  store.touch('ws');

  conn.socket.addEventListener('message', (evt) => {
    dispatch(evt.data, store);
  });

  conn.socket.addEventListener('close', () => {
    conn.socket = null;
    if (conn.userInitiatedClose) {
      conn.userInitiatedClose = false;
      return;
    }

    store.state.ws.connected = false;
    conn.consecutiveFails += 1;

    // First close → reconnecting; subsequent → polling (with continued polling).
    if (conn.consecutiveFails === 1) {
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
      const delay = backoff(conn.attempt);
      conn.attempt += 1;
      conn.reconnectTimer = setTimeout(() => {
        conn.reconnectTimer = null;
        connect(store);
      }, delay);
    }
  });

  conn.socket.addEventListener('error', () => {
    // 'error' is always followed by 'close', which drives reconnect logic.
  });
}

export function disconnect() {
  if (conn.reconnectTimer != null) {
    clearTimeout(conn.reconnectTimer);
  }
  stopPolling();
  unbindVisibility();
  const socket = conn.socket;
  conn  = makeConnectionState();
  watch = makeButtonWatch();
  if (!socket) return;
  conn.userInitiatedClose = true;
  socket.close();
}
