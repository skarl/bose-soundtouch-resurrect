// Shared UI fragments. dom.js stays minimal (just the html`...` tag +
// mount); anything view-shaped that's reused across views lives here.
//
// Built with imperative DOM rather than html`...`: the html tag handles
// text-position interpolation only, and stationCard needs to set
// href/src/dataset on real elements.

import { setArt } from './art.js';
import { icon } from './icons.js';
import * as theme from './theme.js';
import { canonicaliseBrowseUrl } from './tunein-url.js';
import { playGuideId } from './api.js';
import { cache, TTL_STREAM } from './tunein-cache.js';
import { showToast } from './toast.js';

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
// cadence (admin/app/sliders.js).
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

// hrefForSid — derive the row/card anchor href from the TuneIn guide_id
// prefix. The router only mounts the station detail view for `s` sids
// (preset assignment + probe live there); `p` (show) and `t` (topic) sids
// resolve through Browse.ashx, so their natural detail page is the
// browse drill. The `p` route carries `c=pbrowse` so the browse view's
// show-landing dispatch (#84) takes over and renders the Describe-driven
// show card — without `c=pbrowse` the bare-id path falls into the
// generic drill, which renders the show's Genres / Networks but not
// the show metadata itself. Anything else — missing sid, unknown prefix
// — collapses to "#" (an explicit no-op anchor) rather than emitting a
// route that would 404. Closing this seam in the row primitive itself
// catches every call site at once; the alternative (override-at-each-
// caller) is exactly what regressed in #86.
function hrefForSid(sid) {
  if (typeof sid !== 'string' || sid.length < 2) return '#';
  const enc = encodeURIComponent(sid);
  switch (sid.charAt(0)) {
    case 's': return `#/station/${enc}`;
    case 'p': return `#/browse?c=pbrowse&id=${enc}`;
    case 't': return `#/browse?id=${enc}`;
    default:  return '#';
  }
}

// Build a clickable card for a TuneIn station. `sid` is the only
// required field; everything else degrades gracefully when missing.
// Clicking the card sets location.hash to a route derived from the sid
// prefix via hrefForSid — `s` → station detail, `p`/`t` → browse drill,
// unknown → "#". The card primitive is currently only used by callers
// passing `s` sids, but we route through hrefForSid for parity with
// stationRow so a future caller passing a `p`/`t` sid doesn't dead-end.
export function stationCard({ sid, name, art, location, format }) {
  const card = document.createElement('a');
  card.className = 'station-card';
  card.href = hrefForSid(sid);
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

// stationRow({ sid, name, art, location, bitrate, codec, tertiary,
//              badges, chips }) — the shared list row used by
// browse-drill, search results, and search empty state. Layout
// matches admin/design-mockup/app/views-browse-search.jsx
// StationCard, with the polish-slice extensions (#79):
//   [stationArt 40] name (semibold, ellipsis)
//                   location · NNk CODEC · [reliability ●] · [genre]
//                   [tertiary line — current_track or "Now airing: …"]
//                                                      [▶ Play] [chev]
//
// All metadata fields are optional; the meta line still renders if
// any piece is present so the row height stays stable across mixed
// lists. The tertiary line is the ceiling — three subtitle lines +
// chips + logo is the densest the card can ever be.
//
//   - tertiary: either a plain string ("Artist - Title") or a
//     { kind: "show-airing", id, label } spec, which renders as a
//     clickable "Now airing: <label>" anchor that drills to the
//     show via Browse.ashx?id=<id>.
//   - badges:   array of badge specs from normaliseRow. Currently
//     just { kind: "reliability", tier: "green"|"amber"|"red" }.
//   - chips:    array of chip specs from normaliseRow. Currently
//     { kind: "genre", id } drills into the genre via
//     canonicaliseBrowseUrl; { kind: "show-airing", id, label } is
//     consumed by the tertiary-line path and skipped here.
//
// When `sid` carries an `s`, `p`, or `t` prefix the row gets an inline
// Play button between the body and the chevron. Tapping the Play
// button calls /play (via api.playGuideId) and toasts the outcome —
// caching the resolved URL under `tunein.stream.<sid>` for 5 min so
// repeat plays skip the resolve roundtrip. The rest of the row still
// drills to the detail view; only the icon plays. Other prefixes
// (`g`, `c`, `r`, `m`, `a`, `l`, `n` — drill-only types) get no Play
// button.
export function stationRow({
  sid,
  name,
  art = '',
  location = '',
  bitrate,
  codec = '',
  tertiary = '',
  badges,
  chips,
} = {}) {
  const row = document.createElement('a');
  row.className = 'station-row';
  // Per #86 — href is derived from the sid prefix. The previous
  // hard-coded `#/station/<sid>` produced silent dead links whenever a
  // caller passed a `p` or `t` sid (the show-self card on the show
  // landing was the live offender). Routing through hrefForSid closes
  // that class of bug at the primitive: every caller now gets the right
  // detail page for free, with `#` as the explicit no-op fallback.
  row.href = hrefForSid(sid);
  row.dataset.sid = sid;

  row.appendChild(stationArt({ url: art, name: name || sid, size: 40 }));

  const body = document.createElement('span');
  body.className = 'station-row__body';

  const nameEl = document.createElement('span');
  nameEl.className = 'station-row__name';
  nameEl.textContent = name || sid;
  body.appendChild(nameEl);

  // --- secondary meta line (location · bitrate · chips · reliability) -

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
    if (location) appendMetaSeparator(meta);
    const codecText = codec ? String(codec).toUpperCase() : '';
    const fmt = document.createElement('span');
    fmt.className = 'station-row__fmt';
    fmt.textContent = haveKbps
      ? (codecText ? `${kbps}k ${codecText}` : `${kbps}k`)
      : codecText;
    meta.appendChild(fmt);
  }

  // Reliability badge sits on the chips row, alongside bitrate/codec.
  // It's stamped after the format chunk so it reads as the rightmost
  // status on the line.
  const reliability = Array.isArray(badges)
    ? badges.find((b) => b && b.kind === 'reliability')
    : null;
  if (reliability) {
    if (meta.childNodes.length > 0) appendMetaSeparator(meta);
    meta.appendChild(reliabilityBadge(reliability));
    // The row itself carries the tier as a data attribute so CSS /
    // tests can target rows by reliability without walking the chips.
    row.setAttribute('data-reliability-tier', reliability.tier);
  }

  // Genre chip on the meta line — clickable; the renderer composes
  // the drill URL via canonicaliseBrowseUrl so the hash anchor stays
  // canonical.
  const genreChip = Array.isArray(chips)
    ? chips.find((c) => c && c.kind === 'genre')
    : null;
  if (genreChip) {
    if (meta.childNodes.length > 0) appendMetaSeparator(meta);
    meta.appendChild(genreChipEl(genreChip));
  }

  if (meta.childNodes.length > 0) body.appendChild(meta);

  // --- tertiary line (current_track or "Now airing: <label>") ---------

  if (tertiary != null && tertiary !== '') {
    body.appendChild(tertiaryLine(tertiary));
  }

  row.appendChild(body);

  if (isPlayableSid(sid)) {
    row.appendChild(playButton(sid, name || sid));
  }

  const chev = document.createElement('span');
  chev.className = 'station-row__chev';
  chev.appendChild(icon('arrow', 14));
  row.appendChild(chev);

  return row;
}

// Append a "·" dot to a meta line. Used between each segment of the
// chip-and-meta row so location/bitrate/reliability/genre never collide
// when they line up.
function appendMetaSeparator(meta) {
  const sep = document.createElement('span');
  sep.className = 'station-row__sep';
  sep.textContent = '·';
  meta.appendChild(sep);
}

// reliabilityBadge — small coloured dot + percentage label. CSS
// drives the tier colour via `data-tier`; the rendered text is the
// numeric reliability for readers who want the underlying value.
function reliabilityBadge(spec) {
  const el = document.createElement('span');
  el.className = 'station-row__reliability';
  el.setAttribute('data-tier', spec.tier);
  // ARIA-friendly hint so screen readers don't read a bare percentage.
  const pct = Number.isFinite(spec.value) ? Math.round(spec.value) : null;
  if (pct != null) {
    el.setAttribute('aria-label', `Reliability ${pct}%`);
  } else {
    el.setAttribute('aria-label', `Reliability ${spec.tier}`);
  }
  const dot = document.createElement('span');
  dot.className = 'station-row__reliability-dot';
  dot.setAttribute('aria-hidden', 'true');
  el.appendChild(dot);
  if (pct != null) {
    const text = document.createElement('span');
    text.className = 'station-row__reliability-text';
    text.textContent = `${pct}%`;
    el.appendChild(text);
  }
  return el;
}

// genreChipEl — small clickable pill that drills into the genre.
// The href is composed via canonicaliseBrowseUrl so the URL passes
// through the language-tree rewrite and the magic-param strip; the
// resulting `Browse.ashx?id=g<NN>&render=json` is then translated
// into the SPA hash form (#/browse?id=g<NN>).
function genreChipEl(chip) {
  const id = chip && typeof chip.id === 'string' ? chip.id : '';
  if (!id) {
    const stub = document.createElement('span');
    stub.className = 'station-row__chip station-row__chip--genre is-disabled';
    return stub;
  }
  // Compose a Browse URL from the bare id and canonicalise it, then
  // strip the host/path/render so we land on a #/browse?... hash.
  let drillHash;
  try {
    const browseUrl = canonicaliseBrowseUrl(`Browse.ashx?id=${encodeURIComponent(id)}`);
    drillHash = browseUrlToHash(browseUrl);
  } catch (_err) {
    drillHash = `#/browse?id=${encodeURIComponent(id)}`;
  }
  const a = document.createElement('a');
  a.className = 'station-row__chip station-row__chip--genre';
  a.setAttribute('href', drillHash);
  a.setAttribute('data-chip-kind', 'genre');
  a.setAttribute('data-genre-id', id);
  a.textContent = id;
  // The chip is its own click target inside the row anchor; the row
  // itself drills to the station's detail view, the chip drills to
  // the genre. Stop the click bubbling so the row's href doesn't fire.
  a.addEventListener('click', (evt) => {
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
  });
  return a;
}

// Convert a canonical `Browse.ashx?...&render=json` URL into the SPA
// hash form. Drops the path + render param; preserves drill keys.
function browseUrlToHash(canonical) {
  const qIdx = canonical.indexOf('?');
  if (qIdx < 0) return '#/browse';
  const qs = new URLSearchParams(canonical.slice(qIdx + 1));
  qs.delete('render');
  const out = qs.toString();
  return out ? `#/browse?${out}` : '#/browse';
}

// tertiaryLine — the third subtitle slot. `spec` is either a plain
// string ("Artist - Title") or a { kind: "show-airing", id, label }
// link spec, in which case the line renders as a clickable
// "Now airing: <label>" anchor.
function tertiaryLine(spec) {
  const el = document.createElement('span');
  el.className = 'station-row__tertiary';
  if (typeof spec === 'string') {
    el.textContent = spec;
    return el;
  }
  if (spec && spec.kind === 'show-airing' && typeof spec.id === 'string') {
    const prefix = document.createElement('span');
    prefix.className = 'station-row__tertiary-prefix';
    prefix.textContent = 'Now airing: ';
    el.appendChild(prefix);
    let drillHash;
    try {
      const browseUrl = canonicaliseBrowseUrl(
        `Browse.ashx?c=pbrowse&id=${encodeURIComponent(spec.id)}`,
      );
      drillHash = browseUrlToHash(browseUrl);
    } catch (_err) {
      drillHash = `#/browse?c=pbrowse&id=${encodeURIComponent(spec.id)}`;
    }
    const a = document.createElement('a');
    a.className = 'station-row__show-link';
    a.setAttribute('href', drillHash);
    a.setAttribute('data-show-id', spec.id);
    a.textContent = spec.label || spec.id;
    // The row's outer anchor also has an href; the show link must
    // win on click without dragging the row along.
    a.addEventListener('click', (evt) => {
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    });
    el.appendChild(a);
    return el;
  }
  // Unknown spec shape — render an empty span so callers don't crash.
  return el;
}

// The Play icon only attaches to rows whose classified type plays
// directly. The TuneIn guide_id prefixes are documented in
// docs/tunein-api.md § 4; s/p/t are the only ones that resolve to a
// stream. Everything else (g/c/r/m/a/l/n) is drill-only.
const PLAYABLE_PREFIXES = ['s', 'p', 't'];

export function isPlayableSid(sid) {
  if (typeof sid !== 'string' || sid.length < 2) return false;
  const prefix = sid.charAt(0);
  if (!PLAYABLE_PREFIXES.includes(prefix)) return false;
  // Cheap digit-tail check — avoids treating arbitrary text starting
  // with s/p/t (e.g. `style`) as a playable guide_id if a future caller
  // forgets to validate.
  for (let i = 1; i < sid.length; i++) {
    const c = sid.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

// Build the inline Play button. The button is a <span role="button">
// inside the <a> row so the click target is its own and we can
// preventDefault + stopPropagation cleanly without losing keyboard
// navigability of the row itself.
function playButton(sid, label) {
  const btn = document.createElement('span');
  btn.className = 'station-row__play';
  btn.setAttribute('role', 'button');
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('aria-label', `Play ${label} on Bo`);
  // Mobile tap target — 44x44 css per the issue.
  btn.setAttribute('data-tap', '44');

  const glyph = icon('play', 20);
  btn.appendChild(glyph);

  // Re-entrancy guard so a double-tap doesn't fire two POSTs.
  let busy = false;

  async function trigger(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    if (busy) return;
    busy = true;
    btn.classList.add('is-loading');

    const cacheKey = `tunein.stream.${sid}`;
    const cached = cache.get(cacheKey);

    try {
      const result = await playGuideId(sid, cached);
      if (result && result.ok) {
        if (typeof result.url === 'string' && result.url) {
          cache.set(cacheKey, result.url, TTL_STREAM);
        }
        showToast(`Playing on Bo: ${label}`);
      } else {
        // Stale cache entry that resolved to a placeholder — drop it so
        // the next click re-resolves cleanly.
        cache.invalidate(cacheKey);
        const code = result && result.error;
        showToast(messageFor(code));
      }
    } catch (err) {
      cache.invalidate(cacheKey);
      showToast('Could not reach Bo');
    } finally {
      btn.classList.remove('is-loading');
      busy = false;
    }
  }

  btn.addEventListener('click', trigger);
  btn.addEventListener('keydown', (evt) => {
    if (evt && (evt.key === ' ' || evt.key === 'Enter')) trigger(evt);
  });

  return btn;
}

const PLAY_ERROR_MESSAGES = {
  'off-air':         'Off-air right now',
  'not-available':   'Not available in your region',
  'invalid-id':      'Cannot play this row',
  'no-stream':       'No stream available',
  'tune-failed':     'TuneIn lookup failed',
  'select-failed':   'Speaker rejected the stream',
  'select-rejected': 'Speaker rejected the stream',
};

function messageFor(code) {
  return PLAY_ERROR_MESSAGES[code] || 'Could not play this row';
}
