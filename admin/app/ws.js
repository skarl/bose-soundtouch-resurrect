// WebSocket deep module. Public surface: connect(state), disconnect().
// Owns the WebSocket lifecycle; internals are not exported.
// See admin/PLAN.md § Live updates and § State management.

let socket = null;

// --- XML dispatch ---------------------------------------------------

// Dispatch table for events that arrive inside <updates …>…</updates>.
// Each handler receives (innerElement, state). Returning early on an
// unknown tag is safe — the firmware freely adds tags we haven't mapped yet.
const ENVELOPE_HANDLERS = {
  volumeUpdated(el, state) {             // TODO slice 3
    void el; void state;
  },
  nowPlayingUpdated(el, state) {         // TODO slice 4
    void el; void state;
  },
  nowSelectionUpdated(el, state) {       // TODO slice 6
    void el; void state;
  },
  sourcesUpdated(el, state) {            // TODO slice 5
    void el; void state;
  },
  presetsUpdated(el, state) {            // TODO slice 6
    void el; void state;
  },
  keyEvent(el, state) {                  // TODO slice 8
    void el; void state;
  },
  connectionStateUpdated(el, state) {    // TODO slice 2
    void el; void state;
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
    store.state.ws.connected = true;
    store.state.ws.mode = 'ws';
    store.touch('ws');
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
      if (handler) handler(child, store.state);
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

// --- Socket lifecycle -----------------------------------------------

export function connect(store) {
  if (socket) return;

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
    store.state.ws.connected = false;
    store.state.ws.mode = 'offline';
    store.touch('ws');
  });

  socket.addEventListener('error', () => {
    // 'error' is always followed by 'close', which sets mode to 'offline'.
    // Nothing extra to do here.
  });
}

export function disconnect() {
  if (!socket) return;
  socket.close();
  socket = null;
}
