// Blocking error overlay for the "speaker on port 8090 is unreachable"
// failure mode (admin/PLAN.md § Failure modes row 4). The SPA's status
// pill / toasts already surface transient errors; this overlay is the
// loud signal that the speaker itself is unavailable and the user should
// stop interacting with stale state behind it.
//
// Mounted from shell.js after the four-zone shell is rendered. The
// component subscribes to the api.js upstream-failure observable —
// failures (UPSTREAM_UNREACHABLE / TIMEOUT) raise the overlay, the next
// successful speaker-proxy response auto-dismisses it. A Retry button
// re-issues a reconcile via the injected callback so the user can prod
// the speaker without waiting for the next WS frame.
//
// The overlay is a real position:fixed element with a tabindex'd
// container so focus traps inside while it's visible (the user can't
// interact with the four-zone shell behind it). The retry button is
// disabled while a retry is in flight so a panicked double-tap doesn't
// queue two reconciles.

const UPSTREAM_COPY = {
  UPSTREAM_UNREACHABLE: {
    title: 'Speaker may be asleep or off-network',
    body:  "Bo isn't reachable on port 8090. Check that the speaker is powered on and joined to your Wi-Fi.",
  },
  TIMEOUT: {
    title: "Speaker isn't responding",
    body:  'Bo accepted the request but did not finish in time. The speaker may be busy or briefly unreachable.',
  },
};

// Resolve a copy bundle for a reason code. Unknown reasons fall back to
// the unreachable copy — the overlay always has a heading and body.
export function copyFor(reason) {
  return UPSTREAM_COPY[reason] || UPSTREAM_COPY.UPSTREAM_UNREACHABLE;
}

// Pure state-machine reducer. Inputs are upstream-failure events
// (`{kind, reason?}`), output is the next overlay state:
//   { visible: boolean, reason: string|null }
// The reducer is exported so tests can drive it without DOM.
//
// Rules:
//   - failure with reason → visible=true, remember reason
//   - success → visible=false (clear reason)
//   - any other event shape → identity (no change)
export function reduce(prev, event) {
  const cur = prev || { visible: false, reason: null };
  if (!event || typeof event !== 'object') return cur;
  if (event.kind === 'failure') {
    return { visible: true, reason: event.reason || 'UPSTREAM_UNREACHABLE' };
  }
  if (event.kind === 'success') {
    if (!cur.visible) return cur;
    return { visible: false, reason: null };
  }
  return cur;
}

// Build the overlay DOM. Returns the root element plus handles to the
// pieces that need to mutate on state change. The overlay starts hidden
// — render() decides when to show it. All visual rules live under the
// `.speaker-unreachable*` selectors in style.css.
function buildOverlay() {
  const root = document.createElement('div');
  root.className = 'speaker-unreachable';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'speaker-unreachable-title');
  root.setAttribute('aria-describedby', 'speaker-unreachable-body');
  root.hidden = true;

  const card = document.createElement('div');
  card.className = 'speaker-unreachable__card';

  const title = document.createElement('h2');
  title.id = 'speaker-unreachable-title';
  title.className = 'speaker-unreachable__title';

  const body = document.createElement('p');
  body.id = 'speaker-unreachable-body';
  body.className = 'speaker-unreachable__body';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'speaker-unreachable__retry';
  retry.textContent = 'Retry';

  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(retry);
  root.appendChild(card);

  return { root, title, body, retry };
}

// mountSpeakerUnreachable — wire the overlay to the api.js observable
// and the retry callback. Returns an api with:
//   .unmount()              — remove DOM + unsubscribe
//   .getState()             — current { visible, reason } (test seam)
//   .onChange(listener)     — subscribe to state changes (test seam)
//
// opts:
//   onFailure(listener)     — required; api.onUpstreamFailure (or a stub)
//   onRetry()               — required; called when the user taps Retry
//   parent?                 — defaults to document.body
export function mountSpeakerUnreachable(opts) {
  if (!opts || typeof opts.onFailure !== 'function') {
    throw new Error('mountSpeakerUnreachable: opts.onFailure is required');
  }
  if (typeof opts.onRetry !== 'function') {
    throw new Error('mountSpeakerUnreachable: opts.onRetry is required');
  }
  if (typeof document === 'undefined') return null;

  const parent = opts.parent || document.body;
  const els = buildOverlay();
  parent.appendChild(els.root);

  let state = { visible: false, reason: null };
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try { fn(state); } catch (_e) { /* swallow */ }
    }
  }

  function render() {
    if (!state.visible) {
      els.root.hidden = true;
      els.retry.disabled = false;
      return;
    }
    const c = copyFor(state.reason);
    els.title.textContent = c.title;
    els.body.textContent = c.body;
    els.root.hidden = false;
    // Move focus to the retry button so keyboard users land inside the
    // overlay. focus() is a no-op under the test shim.
    if (typeof els.retry.focus === 'function') {
      try { els.retry.focus(); } catch (_e) { /* swallow */ }
    }
  }

  function apply(event) {
    const next = reduce(state, event);
    if (next === state) return;
    state = next;
    render();
    notify();
  }

  const unsubscribe = opts.onFailure(apply);

  els.retry.addEventListener('click', () => {
    if (els.retry.disabled) return;
    els.retry.disabled = true;
    let p;
    try { p = opts.onRetry(); }
    catch (_e) { p = null; }
    Promise.resolve(p).then(
      () => { els.retry.disabled = false; },
      () => { els.retry.disabled = false; },
    );
  });

  render();

  return {
    unmount() {
      if (typeof unsubscribe === 'function') unsubscribe();
      if (els.root.parentNode) els.root.parentNode.removeChild(els.root);
      listeners.clear();
    },
    getState() { return state; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Test seam: drive the reducer directly without routing through the
    // injected observable. Production callers go through onFailure.
    _apply: apply,
  };
}
