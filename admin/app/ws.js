// WebSocket driver. Public surface: connect(store), disconnect().
//
// Owns the WebSocket, the reconnect/polling timers, the visibility
// listener, the inbound envelope router (XML root tag branch + per-child
// speakerDispatch), and the recent-events ring buffer. Pure connection
// state-machine logic lives in ws-fsm.js — this file executes the
// action lists that step() emits. Speaker-button-press toasts live in
// speaker-button-watcher.js.
//
// See admin/PLAN.md § Live updates and § State management.

import { reconcile, dispatch as speakerDispatch } from './speaker-state.js';
import { showToast } from './toast.js';
import * as fsm from './ws-fsm.js';
import * as buttonWatcher from './speaker-button-watcher.js';

const PRESETS_TOAST_GAP_MS = 1500;

function makeDriver() {
  return {
    socket:             null,
    userInitiatedClose: false,
    reconnectTimer:     null,
    pollInterval:       null,
    storeRef:           null,
    visibilityBound:    false,
    fsmState:           fsm.initialState(),
    lastPresetsToastAt: 0,
  };
}

let drv = makeDriver();

// Re-export for callers that referenced ws.js directly.
export const backoff = fsm.backoff;

// --- Action executor ------------------------------------------------

function runActions(actions) {
  for (const action of actions) {
    switch (action.type) {
      case 'startPolling':       doStartPolling(); break;
      case 'stopPolling':        doStopPolling(); break;
      case 'scheduleReconnect':  doScheduleReconnect(action.ms); break;
      case 'cancelReconnect':    doCancelReconnect(); break;
      case 'reconcile':          if (drv.storeRef) reconcile(drv.storeRef); break;
      case 'openSocket':         openSocket(); break;
      case 'closeSocket':        doCloseSocket(); break;
      default: break;
    }
  }
}

function dispatchEvent(event) {
  const { state, actions } = fsm.step(drv.fsmState, event);
  drv.fsmState = state;
  syncStoreMode();
  runActions(actions);
}

function syncStoreMode() {
  const store = drv.storeRef;
  if (!store || !store.state || !store.state.ws) return;
  const mode = drv.fsmState.mode;
  const connected = mode === 'connected';
  // Mode strings the UI uses: 'connecting' | 'ws' | 'reconnecting' | 'polling'.
  store.state.ws.mode = mode === 'connected' ? 'ws' : mode;
  store.state.ws.connected = connected;
  store.touch('ws');
}

// --- Polling fallback -----------------------------------------------

function doStartPolling() {
  if (drv.pollInterval != null) return;
  drv.pollInterval = setInterval(() => {
    if (drv.storeRef) reconcile(drv.storeRef);
  }, 2000);
}

function doStopPolling() {
  if (drv.pollInterval == null) return;
  clearInterval(drv.pollInterval);
  drv.pollInterval = null;
}

// --- Reconnect timer ------------------------------------------------

function doScheduleReconnect(ms) {
  doCancelReconnect();
  drv.reconnectTimer = setTimeout(() => {
    drv.reconnectTimer = null;
    dispatchEvent({ type: 'timerFire' });
  }, ms);
}

function doCancelReconnect() {
  if (drv.reconnectTimer != null) {
    clearTimeout(drv.reconnectTimer);
    drv.reconnectTimer = null;
  }
}

// --- Ring buffer ----------------------------------------------------

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

// --- XML dispatch ---------------------------------------------------

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
    // Hello frame received — WS is live. The FSM transitions us to
    // 'connected' and emits stopPolling + reconcile. Bind the store
    // so callers that drive dispatch() directly (tests) get the mirror.
    if (!drv.storeRef) drv.storeRef = store;
    dispatchEvent({ type: 'hello' });
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
        if (now - drv.lastPresetsToastAt >= PRESETS_TOAST_GAP_MS) {
          drv.lastPresetsToastAt = now;
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
  dispatchEvent({ type: 'visibilityChange', hidden: !!document.hidden });
}

function bindVisibility() {
  if (drv.visibilityBound) return;
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  drv.visibilityBound = true;
}

function unbindVisibility() {
  if (!drv.visibilityBound) return;
  if (typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  drv.visibilityBound = false;
}

// --- Socket lifecycle -----------------------------------------------

function openSocket() {
  if (drv.socket) return;
  if (!drv.storeRef) return;
  const store = drv.storeRef;

  const url = `ws://${location.hostname}:8080/`;
  drv.socket = new WebSocket(url, 'gabbo');

  // Driver-side store mirror: FSM mode might be 'connecting' or
  // 'reconnecting' here; either way we're not connected yet.
  store.state.ws.connected = false;
  store.touch('ws');

  drv.socket.addEventListener('open', () => {
    dispatchEvent({ type: 'open' });
  });

  drv.socket.addEventListener('message', (evt) => {
    dispatch(evt.data, store);
  });

  drv.socket.addEventListener('close', () => {
    drv.socket = null;
    if (drv.userInitiatedClose) {
      drv.userInitiatedClose = false;
      return;
    }
    dispatchEvent({ type: 'close' });
  });

  drv.socket.addEventListener('error', () => {
    // 'error' is always followed by 'close', which drives reconnect logic.
  });
}

function doCloseSocket() {
  const socket = drv.socket;
  drv.socket = null;
  if (!socket) return;
  drv.userInitiatedClose = true;
  try { socket.close(); } catch (_err) { /* noop */ }
}

export function connect(store) {
  if (drv.socket) return;
  if (!store) return;

  drv.storeRef = store;
  drv.fsmState = fsm.initialState();
  buttonWatcher.attach(store);
  bindVisibility();

  syncStoreMode();
  openSocket();
}

export function disconnect() {
  dispatchEvent({ type: 'userDisconnect' });
  unbindVisibility();
  buttonWatcher.detach();
  drv = makeDriver();
}
