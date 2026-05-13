// Pure WebSocket connection state machine.
//
// step(state, event) -> { state, actions }
//
// Inputs and outputs are plain data. No DOM, no fetch, no timers, no
// console, no module-level mutable state. The driver in ws.js owns the
// socket, timers, and visibility listener; it pumps events into step()
// and executes the action list it gets back.
//
// State shape:
//   {
//     mode:             'connecting' | 'connected' | 'reconnecting' | 'polling',
//     attempt:           number,   // next reconnect attempt index (for backoff)
//     consecutiveFails:  number,   // socket closes since last hello frame
//     hidden:            boolean,  // tab is currently hidden
//   }
//
// Events:
//   { type: 'open' }                  — socket opened (TCP-level)
//   { type: 'hello' }                 — SoundTouchSdkInfo frame received
//   { type: 'close' }                 — socket closed (network drop)
//   { type: 'timerFire' }             — reconnect backoff timer elapsed
//   { type: 'visibilityChange', hidden: boolean }
//   { type: 'userDisconnect' }        — caller invoked disconnect()
//
// Actions (data; the driver maps them to side effects):
//   { type: 'startPolling' }
//   { type: 'stopPolling' }
//   { type: 'scheduleReconnect', ms } — schedule a timerFire after ms
//   { type: 'cancelReconnect' }       — cancel a pending reconnect timer
//   { type: 'reconcile' }             — refetch speaker state via REST
//   { type: 'openSocket' }            — driver should open a new WebSocket
//   { type: 'closeSocket' }           — driver should close the live socket

// Exponential backoff with full jitter.
// baseline = min(30000, 500 * 2^attempt); pick uniformly from [0, baseline).
export function backoff(attempt) {
  const baseline = Math.min(30000, 500 * Math.pow(2, attempt));
  return Math.random() * baseline;
}

export function initialState() {
  return { mode: 'connecting', attempt: 0, consecutiveFails: 0, hidden: false };
}

function clone(state, patch) {
  return { ...state, ...patch };
}

export function step(state, event) {
  switch (event.type) {
    case 'open':
      // TCP open precedes the hello frame; no state change until hello.
      return { state, actions: [] };

    case 'hello': {
      // Live connection confirmed. Reset counters, stop polling, refetch.
      const next = clone(state, { mode: 'connected', attempt: 0, consecutiveFails: 0 });
      return { state: next, actions: [{ type: 'stopPolling' }, { type: 'reconcile' }] };
    }

    case 'close': {
      const consecutiveFails = state.consecutiveFails + 1;
      const mode = consecutiveFails === 1 ? 'reconnecting' : 'polling';
      const next = clone(state, { mode, consecutiveFails, attempt: state.attempt + 1 });
      const actions = [];
      if (!state.hidden) {
        actions.push({ type: 'startPolling' });
        actions.push({ type: 'scheduleReconnect', ms: backoff(state.attempt) });
      }
      return { state: next, actions };
    }

    case 'timerFire': {
      // Reconnect timer elapsed — driver should open a new socket.
      if (state.hidden) return { state, actions: [] };
      const next = clone(state, { mode: 'connecting' });
      return { state: next, actions: [{ type: 'openSocket' }] };
    }

    case 'visibilityChange': {
      const hidden = !!event.hidden;
      if (hidden === state.hidden) return { state, actions: [] };
      const next = clone(state, { hidden });
      if (hidden) {
        // Tab hidden: cancel pending reconnect and pause REST polling.
        // Don't close a live socket — events may still arrive on resume.
        return { state: next, actions: [{ type: 'cancelReconnect' }, { type: 'stopPolling' }] };
      }
      // Tab visible again.
      if (state.mode === 'connected') {
        // Socket still alive; events resume automatically.
        return { state: next, actions: [] };
      }
      // Socket dropped (or never connected). Retry immediately.
      const retry = clone(next, { mode: 'connecting', attempt: 0 });
      return { state: retry, actions: [{ type: 'openSocket' }] };
    }

    case 'userDisconnect': {
      const next = clone(state, { mode: 'connecting', attempt: 0, consecutiveFails: 0 });
      return {
        state: next,
        actions: [{ type: 'cancelReconnect' }, { type: 'stopPolling' }, { type: 'closeSocket' }],
      };
    }

    default:
      return { state, actions: [] };
  }
}
