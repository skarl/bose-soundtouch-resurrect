// Shared UI fragments. dom.js stays minimal (just the html`...` tag +
// mount); anything view-shaped that's reused across views lives here.
//
// Built with imperative DOM rather than html`...`: the html tag handles
// text-position interpolation only, and stationCard needs to set
// href/src/dataset on real elements.

import { setArt } from './art.js';
import * as theme from './theme.js';

// Connection-state pill. Returns a <span> node with data-state reflecting
// state.ws.mode. The caller is responsible for subscribing to 'ws' and
// calling updatePill(pill, state) when mode changes — never re-creating
// the node.
//
// Supported data-state values (CSS drives colour via [data-state="…"]):
//   connecting   — socket opened, hello not yet received
//   ws           — live WebSocket, hello received
//   offline      — socket closed, no reconnect scheduled
//   reconnecting — first close, backoff timer running
//   polling      — second+ close, falling back to REST while retrying
const PILL_LABELS = {
  connecting:   'connecting…',
  ws:           'live',
  offline:      'offline',
  reconnecting: 'reconnecting…',
  polling:      'polling',
};

export function connectionPill(state) {
  const pill = document.createElement('span');
  pill.className = 'conn-pill';
  const mode = (state && state.ws && state.ws.mode) || 'offline';
  pill.dataset.state = mode;
  pill.textContent = PILL_LABELS[mode] || mode;
  return pill;
}

export function updatePill(pill, state) {
  const mode = (state && state.ws && state.ws.mode) || 'offline';
  pill.dataset.state = mode;
  pill.textContent = PILL_LABELS[mode] || mode;
}

// Theme-toggle button for the app header. Clicking cycles the preference
// (auto → light → dark → auto) and updates its own label. Does NOT
// subscribe to any store key — theme is a pre-mount global, not reactive
// store state.
const THEME_GLYPHS = { auto: '◑', light: '☀', dark: '☾' };

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

// Live VU dot. A small pulsing indicator mounted inside .np-card that
// reflects playback state. Returns a <span class="vu-dot"> node.
// The caller subscribes to 'speaker' and calls updateVuDot(dot, state)
// on each tick — never re-creates the node.
//
// CSS drives the pulse via [data-playing="true"]; the dot is invisible
// when data-playing is absent or "false".
export function vuDot() {
  const dot = document.createElement('span');
  dot.className = 'vu-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.dataset.playing = 'false';
  return dot;
}

export function updateVuDot(dot, state) {
  const np = state && state.speaker && state.speaker.nowPlaying;
  const playing = np && np.playStatus === 'PLAY_STATE';
  dot.dataset.playing = playing ? 'true' : 'false';
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
