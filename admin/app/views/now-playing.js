// now-playing — 0.2 header-strip variant.
// Read-only: current station name + art + 6 preset slots, polled
// every 2s while the tab is visible. No transport, no volume, no
// source switching, no preset tap-to-play — those land in 0.3.
//
// Render strategy (see admin/PLAN.md § Render strategy):
//   init() mounts a static DOM tree once; update() mutates only the
//   affected nodes when state.speaker changes. No re-render.

import { html, mount } from '../dom.js';
import { store, setPresets } from '../state.js';
import { speakerNowPlaying, presetsList } from '../api.js';
import { setArt } from '../art.js';

const POLL_MS = 2000;
const PRESET_SLOTS = 6;

// Refs to mutable DOM nodes — populated by init(), used by update().
let nameEl    = null;
let trackEl   = null;
let artEl     = null;
let presetEls = [];

// Polling state — module-scoped so visibilitychange can pause/resume
// even though the view's lifecycle is owned by the router.
let pollTimer       = null;
let inFlight        = false;
let visibilityBound = false;

function clearPoll() {
  if (pollTimer != null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce() {
  if (inFlight) return;
  if (document.hidden) return;
  inFlight = true;
  try {
    const np = await speakerNowPlaying();
    // Only mutate if we're still the active view (the DOM refs would
    // otherwise point at detached nodes). The store update is harmless
    // either way — the next view's subscriber will overwrite.
    store.set('speaker', { ...store.state.speaker, nowPlaying: np });
  } catch (_err) {
    // Network blip / proxy error / parse error — leave previous state
    // visible. Persistent errors surface via the toast layer.
  } finally {
    inFlight = false;
    if (!document.hidden && pollTimer != null) {
      pollTimer = setTimeout(pollOnce, POLL_MS);
    }
  }
}

// One-shot presets fetch. Presets change rarely (only when a user
// assigns one), so we don't poll them — slice 5's POST reconciles the
// list via its own response, and 0.3's WebSocket will replace this
// boot fetch with <presetsUpdated> events.
async function fetchPresetsOnce() {
  try {
    const env = await presetsList();
    if (env && env.ok && Array.isArray(env.data)) {
      setPresets(env.data);
    }
  } catch (_err) {
    // Same posture as pollOnce: keep the last known state on error.
  }
}

function startPolling() {
  if (pollTimer != null) return;
  // Kick off immediately so the strip populates without waiting 2s.
  pollTimer = setTimeout(pollOnce, 0);
}

function onVisibilityChange() {
  if (document.hidden) {
    clearPoll();
  } else if (nameEl) {
    // We're still mounted (nameEl still points at a live node); resume.
    startPolling();
  }
}

function bindVisibilityOnce() {
  if (visibilityBound) return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityBound = true;
}

function renderName(np) {
  if (!np) return '';
  // Prefer the ContentItem's itemName (station name); fall back to
  // track for sources where ContentItem.itemName is empty.
  return (np.item && np.item.name) || np.track || '';
}

function applyNowPlaying(np) {
  if (!nameEl) return;
  const name = renderName(np);
  nameEl.textContent = name;

  // Track for the currently-selected station only (one line).
  // For stations whose track equals the station name (TuneIn often
  // does this — sometimes with different casing), suppress the
  // duplicate. A future ticker/marquee will surface long titles +
  // artist when we run out of space.
  if (trackEl) {
    const track = (np && typeof np.track === 'string') ? np.track.trim() : '';
    const showTrack = !!track && track.toLowerCase() !== (name || '').toLowerCase();
    trackEl.textContent = showTrack ? track : '';
    trackEl.toggleAttribute('hidden', !showTrack);
  }

  const artUrl = np && typeof np.art === 'string' && np.art.startsWith('http')
    ? np.art
    : '';
  setArt(artEl, artUrl, name);
}

function applyPresets(presets) {
  if (!presetEls.length) return;
  for (let i = 0; i < PRESET_SLOTS; i++) {
    const slot = presetEls[i];
    if (!slot) continue;
    const p = presets && presets[i] ? presets[i] : null;
    const labelEl = slot.querySelector('.preset-name');
    const imgEl   = slot.querySelector('.preset-art');

    if (!p || p.empty) {
      slot.classList.add('empty');
      if (labelEl) labelEl.textContent = 'Empty';
      if (imgEl) {
        imgEl.removeAttribute('src');
        imgEl.setAttribute('hidden', '');
      }
      continue;
    }

    slot.classList.remove('empty');
    const name = p.itemName || `Preset ${i + 1}`;
    if (labelEl) labelEl.textContent = name;
    if (imgEl) {
      const url = (typeof p.art === 'string' && p.art.startsWith('http')) ? p.art : '';
      setArt(imgEl, url, name);
    }
  }
}

export default {
  init(root /* , _store, _ctx */) {
    // Build the 6 preset slot nodes ahead of time so we can keep refs.
    const slotNodes = [];
    for (let i = 0; i < PRESET_SLOTS; i++) {
      const slot = document.createElement('div');
      slot.className = 'preset-slot empty';
      slot.dataset.slot = String(i + 1);

      const num = document.createElement('span');
      num.className = 'preset-num';
      num.textContent = String(i + 1);
      slot.appendChild(num);

      const img = document.createElement('img');
      img.className = 'preset-art';
      img.alt = '';
      img.setAttribute('hidden', '');
      slot.appendChild(img);

      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = 'Empty';
      slot.appendChild(name);

      slotNodes.push(slot);
    }

    const presetRow = document.createElement('div');
    presetRow.className = 'preset-row';
    for (const n of slotNodes) presetRow.appendChild(n);

    mount(root, html`
      <section class="now-playing-strip" data-view="now-playing">
        <header class="np-header">
          <img class="np-art" alt="">
          <div class="np-text">
            <h1 class="np-name"></h1>
            <p class="np-track" hidden></p>
          </div>
        </header>
        ${presetRow}
      </section>
    `);

    nameEl    = root.querySelector('.np-name');
    trackEl   = root.querySelector('.np-track');
    artEl     = root.querySelector('.np-art');
    presetEls = slotNodes;

    // Paint with whatever's already in the store (may be null on first
    // mount). The next poll tick / external update will refresh it.
    applyNowPlaying(store.state.speaker.nowPlaying);
    applyPresets(store.state.speaker.presets);

    bindVisibilityOnce();
    if (!document.hidden) startPolling();
    // Fire-and-forget: populate state.speaker.presets on first mount.
    // Skipped if the store already has them (e.g. user came back from
    // station detail after a successful assign).
    if (!store.state.speaker.presets) fetchPresetsOnce();
  },

  update(state, changedKey) {
    if (changedKey !== 'speaker') return;
    applyNowPlaying(state.speaker.nowPlaying);
    applyPresets(state.speaker.presets);
  },

  // Not part of the view interface yet (router doesn't call it), but
  // exposed for tests + future router-managed teardown. Idempotent.
  _teardown() {
    clearPoll();
    nameEl    = null;
    trackEl   = null;
    artEl     = null;
    presetEls = [];
  },
};
