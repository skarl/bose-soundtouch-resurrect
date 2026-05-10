// Shared UI fragments. dom.js stays minimal (just the html`...` tag +
// mount); anything view-shaped that's reused across views lives here.
//
// Built with imperative DOM rather than html`...`: the html tag handles
// text-position interpolation only, and stationCard needs to set
// href/src/dataset on real elements.

import { setArt } from './art.js';
import { icon } from './icons.js';
import * as theme from './theme.js';

// pill({ tone, pulse, text }) — generic status badge.
// Tones map to .pill--{tone}; the optional pulse dot is a tiny child span.
// The returned element has an update({ tone, pulse, text }) method so
// callers can mutate without re-creating the node (re-creating loses
// surrounding focus / hover state).
const PILL_TONES = new Set(['live', 'ok', 'warn', 'danger']);

export function pill({ tone = 'ok', pulse = false, text = '' } = {}) {
  const el = document.createElement('span');
  el.setAttribute('class', 'pill');
  el.setAttribute('role', 'status');

  const dot = document.createElement('span');
  dot.setAttribute('class', 'pill__dot');
  dot.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.setAttribute('class', 'pill__text');

  el.appendChild(dot);
  el.appendChild(label);

  function apply({ tone: nextTone, pulse: nextPulse, text: nextText }) {
    const t = PILL_TONES.has(nextTone) ? nextTone : 'ok';
    for (const cls of ['pill--live', 'pill--ok', 'pill--warn', 'pill--danger']) {
      el.classList.remove(cls);
    }
    el.classList.add(`pill--${t}`);
    el.setAttribute('data-tone', t);
    if (nextPulse) {
      dot.classList.add('pill__dot--on');
    } else {
      dot.classList.remove('pill__dot--on');
    }
    label.textContent = nextText == null ? '' : String(nextText);
  }

  apply({ tone, pulse, text });
  el.update = (next = {}) => apply({
    tone:  next.tone  != null ? next.tone  : el.getAttribute('data-tone'),
    pulse: next.pulse != null ? next.pulse : dot.classList.contains('pill__dot--on'),
    text:  next.text  != null ? next.text  : label.textContent,
  });
  return el;
}

// Connection-state pill. Wraps pill() with the WS mode → tone/text mapping.
// CSS keeps the legacy .conn-pill[data-state="…"] selectors in place so any
// downstream override still works; we layer them on top of pill().
//
// Supported data-state values (CSS drives colour via [data-state="…"]):
//   connecting   — socket opened, hello not yet received
//   ws           — live WebSocket, hello received
//   offline      — socket closed, no reconnect scheduled
//   reconnecting — first close, backoff timer running
//   polling      — second+ close, falling back to REST while retrying
const CONN_PILL_LABELS = {
  connecting:   'connecting…',
  ws:           'live',
  offline:      'offline',
  reconnecting: 'reconnecting…',
  polling:      'polling',
};

const CONN_PILL_ARIA = {
  connecting:   'Connection: connecting',
  ws:           'Connection: live',
  offline:      'Connection: offline',
  reconnecting: 'Connection: reconnecting',
  polling:      'Connection: polling',
};

const CONN_PILL_TONE = {
  connecting:   'warn',
  ws:           'live',
  offline:      'danger',
  reconnecting: 'warn',
  polling:      'ok',
};

function modeOf(state) {
  return (state && state.ws && state.ws.mode) || 'offline';
}

function applyConnPill(el, mode) {
  const tone = CONN_PILL_TONE[mode] || 'ok';
  el.update({ tone, pulse: tone === 'live', text: CONN_PILL_LABELS[mode] || mode });
  el.setAttribute('data-state', mode);
  el.setAttribute('aria-label', CONN_PILL_ARIA[mode] || `Connection: ${mode}`);
}

export function connectionPill(state) {
  const el = pill({ tone: 'ok', text: '' });
  el.classList.add('conn-pill');
  applyConnPill(el, modeOf(state));
  return el;
}

export function updatePill(el, state) {
  applyConnPill(el, modeOf(state));
}

// switchEl({ checked, label, onChange }) — binary toggle with proper
// role="switch" + aria-checked. The returned element exposes toggle()
// and setChecked(next) so callers (and tests) can flip programmatically;
// click + Space + Enter all funnel through toggle().
export function switchEl({ checked = false, label = '', onChange } = {}) {
  const btn = document.createElement('button');
  btn.setAttribute('type', 'button');
  btn.setAttribute('class', 'switch');
  btn.setAttribute('role', 'switch');
  if (label) btn.setAttribute('aria-label', label);

  const track = document.createElement('span');
  track.setAttribute('class', 'switch__track');
  const thumb = document.createElement('span');
  thumb.setAttribute('class', 'switch__thumb');
  track.appendChild(thumb);
  btn.appendChild(track);

  let state = !!checked;

  function paint() {
    btn.setAttribute('aria-checked', state ? 'true' : 'false');
    btn.setAttribute('data-checked', state ? 'true' : 'false');
  }

  function setChecked(next) {
    const nv = !!next;
    if (nv === state) return;
    state = nv;
    paint();
  }

  function toggle() {
    state = !state;
    paint();
    if (typeof onChange === 'function') onChange(state);
  }

  paint();

  btn.addEventListener('click', toggle);
  btn.addEventListener('keydown', (evt) => {
    if (evt.key === ' ' || evt.key === 'Enter') {
      evt.preventDefault();
      toggle();
    }
  });

  btn.toggle = toggle;
  btn.setChecked = setChecked;
  Object.defineProperty(btn, 'checked', { get: () => state });
  return btn;
}

// slider({ min, max, value, step, onChange, ariaLabel, throttleMs })
// Wraps <input type="range"> with a leading-and-trailing throttle on
// onChange — fires immediately on the first move so volume feels live,
// then trails the final value at the end of the throttle window so the
// resting position is never lost. 50ms matches the existing volume-POST
// cadence (admin/app/actions/sliders.js).
export function slider({
  min = 0,
  max = 100,
  value = 0,
  step = 1,
  onChange,
  ariaLabel,
  throttleMs = 50,
} = {}) {
  const input = document.createElement('input');
  input.setAttribute('type', 'range');
  input.setAttribute('class', 'slider');
  input.setAttribute('min',  String(min));
  input.setAttribute('max',  String(max));
  input.setAttribute('step', String(step));
  input.setAttribute('value', String(value));
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);

  const fire = throttleLeadingTrailing((v) => {
    if (typeof onChange === 'function') onChange(v);
  }, throttleMs);

  input.addEventListener('input', () => {
    fire(Number(input.value));
  });

  input.setValue = (v) => {
    input.value = String(v);
    input.setAttribute('value', String(v));
  };
  return input;
}

// throttleLeadingTrailing(fn, ms) — invoke immediately, then suppress
// further calls for ms; if any arrived during the suppression window,
// fire once more at the end with the most-recent argument. Exposed
// separately so it has a unit test independent of any DOM event loop.
export function throttleLeadingTrailing(fn, ms) {
  let timer = null;
  let pending = null;
  let hasPending = false;
  return function throttled(arg) {
    if (timer == null) {
      fn(arg);
      timer = setTimeout(function tick() {
        if (hasPending) {
          const v = pending;
          pending = null;
          hasPending = false;
          fn(v);
          timer = setTimeout(tick, ms);
        } else {
          timer = null;
        }
      }, ms);
    } else {
      pending = arg;
      hasPending = true;
    }
  };
}

// equalizer({ playing }) — wraps icon('equalizer') in a parent that
// toggles data-state="playing", which is the selector style.css already
// uses to drive the bar animation (and to honour prefers-reduced-motion).
// Exposes setPlaying(next) so callers don't reach into dataset.
export function equalizer({ playing = false } = {}) {
  const wrap = document.createElement('span');
  wrap.setAttribute('class', 'equalizer');
  wrap.appendChild(icon('equalizer'));

  function setPlaying(next) {
    if (next) wrap.setAttribute('data-state', 'playing');
    else wrap.removeAttribute('data-state');
  }

  setPlaying(playing);
  wrap.setPlaying = setPlaying;
  return wrap;
}

// stationArt({ url, name, size }) — uniform art slot that delegates
// loading + hashed-name fallback to setArt(). Wraps an <img> in a sized
// box so callers don't have to repeat the box-art-image pattern.
// update({ url, name }) re-points the image without re-creating the node.
export function stationArt({ url = '', name = '', size = 48 } = {}) {
  const wrap = document.createElement('span');
  wrap.setAttribute('class', 'station-art');
  wrap.setAttribute('style', `width:${size}px;height:${size}px`);

  const img = document.createElement('img');
  img.setAttribute('class', 'station-art__img');
  img.setAttribute('loading', 'lazy');
  wrap.appendChild(img);

  setArt(img, url, name);

  wrap.update = ({ url: nextUrl, name: nextName } = {}) => {
    const u = nextUrl != null ? nextUrl : (img.src || '');
    const n = nextName != null ? nextName : (img.alt || '');
    setArt(img, u || '', n || '');
  };
  return wrap;
}

// Theme-toggle button for the app header. Clicking cycles the preference
// (auto → graphite → cream → terminal → auto) and updates its own label.
// Does NOT subscribe to any store key — theme is a pre-mount global, not
// reactive store state.
const THEME_GLYPHS = {
  auto:     '◑',
  graphite: '☀',
  cream:    '◐',
  terminal: '☾',
};

export function themeToggle() {
  const btn = document.createElement('button');
  btn.className = 'theme-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle colour theme');

  function sync() {
    const { preference } = theme.current();
    btn.dataset.pref = preference;
    btn.textContent = THEME_GLYPHS[preference] || preference;
    btn.title = preference;
  }

  btn.addEventListener('click', () => {
    theme.toggle();
    sync();
  });

  sync();
  return btn;
}

// confirm(message, options) — minimal modal confirm. Returns
// Promise<boolean> that resolves true on accept, false on cancel /
// dismiss / Escape. Single-button confirm; no typed-confirmation. Used
// for low-risk destructive actions (e.g. clear paired BT devices); a
// future caller wanting typed-confirm can extend the options.
//
// options: { confirmLabel?: string, cancelLabel?: string, danger?: boolean }
//
// Mounts itself on document.body; tears itself down on resolve.
export function confirm(message, options = {}) {
  return new Promise((resolve) => {
    const confirmLabel = options.confirmLabel || 'OK';
    const cancelLabel  = options.cancelLabel  || 'Cancel';
    const danger       = !!options.danger;

    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const msg = document.createElement('p');
    msg.className = 'confirm-message';
    msg.textContent = message;
    dialog.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-btn confirm-btn--cancel';
    cancelBtn.textContent = cancelLabel;

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'confirm-btn confirm-btn--ok';
    if (danger) okBtn.classList.add('confirm-btn--danger');
    okBtn.textContent = confirmLabel;

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    }

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}

// Build a clickable card for a TuneIn station. `sid` is the only
// required field; everything else degrades gracefully when missing.
// Clicking the card sets location.hash to #/station/<sid> via the
// anchor's default behaviour (no JS handler needed).
export function stationCard({ sid, name, art, location, format }) {
  const card = document.createElement('a');
  card.className = 'station-card';
  card.href = `#/station/${encodeURIComponent(sid)}`;
  card.dataset.sid = sid;

  const artBox = document.createElement('div');
  artBox.className = 'station-card__art';
  const img = document.createElement('img');
  img.loading = 'lazy';
  artBox.appendChild(img);
  setArt(img, art || '', name || sid);

  const nameEl = document.createElement('div');
  nameEl.className = 'station-card__name';
  nameEl.textContent = name || sid;

  const body = document.createElement('div');
  body.className = 'station-card__body';
  body.appendChild(nameEl);

  const metaText = [location, format].filter(Boolean).join(' . ');
  if (metaText) {
    const meta = document.createElement('div');
    meta.className = 'station-card__meta';
    meta.textContent = metaText;
    body.appendChild(meta);
  }

  card.appendChild(artBox);
  card.appendChild(body);
  return card;
}

// stationRow({ sid, name, art, location, bitrate, codec }) — the shared
// list row used by browse-drill, search results, and search empty
// state. Layout matches admin/design-mockup/app/views-browse-search.jsx
// StationCard:
//   [stationArt 40] name (semibold, ellipsis)
//                   location · NNk CODEC      [chevron]
// All metadata fields are optional; the meta line still renders if any
// piece is present so the row height stays stable across mixed lists.
export function stationRow({
  sid,
  name,
  art = '',
  location = '',
  bitrate,
  codec = '',
} = {}) {
  const row = document.createElement('a');
  row.className = 'station-row';
  row.href = `#/station/${encodeURIComponent(sid)}`;
  row.dataset.sid = sid;

  row.appendChild(stationArt({ url: art, name: name || sid, size: 40 }));

  const body = document.createElement('span');
  body.className = 'station-row__body';

  const nameEl = document.createElement('span');
  nameEl.className = 'station-row__name';
  nameEl.textContent = name || sid;
  body.appendChild(nameEl);

  const meta = document.createElement('span');
  meta.className = 'station-row__meta';

  if (location) {
    const loc = document.createElement('span');
    loc.className = 'station-row__loc';
    loc.textContent = String(location);
    meta.appendChild(loc);
  }

  const kbps = Number(bitrate);
  const haveKbps = Number.isFinite(kbps) && kbps > 0;
  if (haveKbps || codec) {
    if (location) {
      const sep = document.createElement('span');
      sep.className = 'station-row__sep';
      sep.textContent = '·';
      meta.appendChild(sep);
    }
    const codecText = codec ? String(codec).toUpperCase() : '';
    const fmt = document.createElement('span');
    fmt.className = 'station-row__fmt';
    fmt.textContent = haveKbps
      ? (codecText ? `${kbps}k ${codecText}` : `${kbps}k`)
      : codecText;
    meta.appendChild(fmt);
  }

  if (meta.childNodes.length > 0) body.appendChild(meta);

  row.appendChild(body);

  const chev = document.createElement('span');
  chev.className = 'station-row__chev';
  chev.appendChild(icon('arrow', 14));
  row.appendChild(chev);

  return row;
}
