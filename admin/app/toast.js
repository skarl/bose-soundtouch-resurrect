// Toast — minimal fire-and-forget banner. Mounts a fixed container at
// the bottom-right of the page and stacks short-lived messages inside
// it. Stateless on purpose: no store coupling, no queue. Each call
// creates a node that auto-removes after the dwell.
//
// Used by the station detail view's preset-assign feedback and by ws.js
// for "pressed on speaker" toasts.
//
// `showActionToast` extends the surface with a single inline action
// button (e.g. "Undo" for the favourites-tab delete in #127). Its
// dismiss() handle lets callers tear it down early — when the user
// performs any other action, the in-flight toast collapses.

const CONTAINER_ID = 'toast-container';
const DEFAULT_DWELL_MS = 2000;
const FADE_MS = 200;

function ensureContainer() {
  let el = document.getElementById(CONTAINER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = CONTAINER_ID;
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'false');
  document.body.appendChild(el);
  return el;
}

// Animate-out + remove. Safe to call twice (idempotent on the node
// already detached).
function dismissNode(node) {
  if (!node || node.__dismissed) return;
  node.__dismissed = true;
  node.classList.remove('is-shown');
  setTimeout(() => {
    if (node.parentNode) node.parentNode.removeChild(node);
  }, FADE_MS);
}

// Show a toast with the given message. Returns the toast node so
// callers can dismiss it early if they want; in practice the dwell is
// short enough that no one will.
export function showToast(message, dwellMs) {
  if (typeof message !== 'string' || !message) return null;
  if (typeof document === 'undefined') return null;

  const container = ensureContainer();
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.textContent = message;
  container.appendChild(node);

  // Force a reflow so the next style change kicks the CSS transition.
  void node.offsetWidth;
  node.classList.add('is-shown');

  const ttl = Number.isFinite(dwellMs) && dwellMs > 0 ? dwellMs : DEFAULT_DWELL_MS;
  setTimeout(() => dismissNode(node), ttl);

  return node;
}

// Show a toast with an inline action button (label + onAction handler).
// Returns `{ node, dismiss(reason) }`:
//   - `dismiss('action')`  — fired internally when the user taps the
//                            action; onAction has already been called.
//   - `dismiss('timeout')` — auto-fired after `dwellMs` (5 s for
//                            favourites delete) and signals that the
//                            window of opportunity has closed; the
//                            `onTimeout` callback runs.
//   - `dismiss('early')`   — caller-driven (e.g. "any other user action
//                            collapses the in-flight toast"); fires
//                            `onEarlyDismiss` if provided.
//
// Only the first dismiss wins; subsequent calls are no-ops, so a
// double-tap or a timeout firing during the action callback can't
// double-dispatch the delete-permanent path.
export function showActionToast({ message, actionLabel, onAction, onTimeout, onEarlyDismiss, dwellMs } = {}) {
  if (typeof message !== 'string' || !message) return null;
  if (typeof document === 'undefined') return null;

  const container = ensureContainer();
  const node = document.createElement('div');
  node.className = 'toast toast--action';
  node.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = message;
  node.appendChild(text);

  let settled = false;

  function dismiss(reason) {
    if (settled) return;
    settled = true;
    dismissNode(node);
    if (reason === 'timeout' && typeof onTimeout === 'function') {
      try { onTimeout(); } catch (_e) { /* swallow */ }
    } else if (reason === 'early' && typeof onEarlyDismiss === 'function') {
      try { onEarlyDismiss(); } catch (_e) { /* swallow */ }
    }
  }

  if (typeof actionLabel === 'string' && actionLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', (evt) => {
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      if (settled) return;
      // Mark settled BEFORE firing the action so a re-entrant call into
      // dismiss() (or a timeout racing in mid-action) can't double-fire.
      settled = true;
      try {
        if (typeof onAction === 'function') onAction();
      } finally {
        dismissNode(node);
      }
    });
    node.appendChild(btn);
  }

  container.appendChild(node);
  void node.offsetWidth;
  node.classList.add('is-shown');

  const ttl = Number.isFinite(dwellMs) && dwellMs > 0 ? dwellMs : DEFAULT_DWELL_MS;
  const timer = setTimeout(() => dismiss('timeout'), ttl);

  // Wrap dismiss so the timer is cleared on any external dismissal too.
  function dismissAndClear(reason) {
    clearTimeout(timer);
    dismiss(reason);
  }

  return { node, dismiss: dismissAndClear };
}
