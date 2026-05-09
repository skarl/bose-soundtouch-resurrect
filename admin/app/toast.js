// Toast — minimal fire-and-forget banner. Mounts a fixed container at
// the bottom-right of the page and stacks short-lived messages inside
// it. Stateless on purpose: no store coupling, no queue. Each call
// creates a node that auto-removes after the dwell.
//
// Used by the station detail view's preset-assign feedback. Other call
// sites (0.3 "pressed on speaker" toasts) can reuse showToast() as-is.

const CONTAINER_ID = 'toast-container';
const DEFAULT_DWELL_MS = 2000;
const FADE_MS = 200;

function ensureContainer() {
  let el = document.getElementById(CONTAINER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = CONTAINER_ID;
  document.body.appendChild(el);
  return el;
}

// Show a toast with the given message. Returns the toast node so
// callers can dismiss it early if they want; in practice the dwell is
// short enough that no one will.
export function showToast(message, dwellMs) {
  if (typeof message !== 'string' || !message) return null;

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
  setTimeout(() => {
    node.classList.remove('is-shown');
    setTimeout(() => {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, FADE_MS);
  }, ttl);

  return node;
}
