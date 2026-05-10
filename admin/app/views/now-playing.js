// now-playing — 0.3 full home view.
// Art + station name + track/artist + source metadata + transport.
// Reuses polling from 0.2 and adds WS-driven mutation via the
// 'speaker' subscription (set up by router for the #/ route).
//
// Render strategy: init() builds the DOM once; update() mutates cached
// refs in place — never re-renders. See admin/app/dom.js.

import { html, mount } from '../dom.js';
import { store, setPresets, setNowPlaying } from '../state.js';
import { speakerNowPlaying, presetsList, postVolume, postSelect, postSelectLocalSource } from '../api.js';
import { setArt } from '../art.js';
import { postKey, makeVolumeSender } from '../transport.js';
import { setVolumeConfirmFn } from '../ws.js';

const POLL_MS = 2000;
const PRESET_SLOTS = 6;

// Cached DOM refs — populated by init(), used by update().
let artEl      = null;
let nameEl     = null;
let trackEl    = null;
let metaEl     = null;
let cardEl     = null;
let asleepEl   = null;
let transportEl = null;
let sourcesEl  = null;
let presetsEl  = null;   // .np-presets container
let presetBtns = [];     // [btn0, btn1, …, btn5] — index = slot - 1
let btnPrev    = null;
let btnPlay    = null;
let btnNext    = null;
let sliderEl   = null;
let muteEl     = null;
let volumeRowEl = null;

// Volume sender — created once in init(); survives WS events.
let volumeSender = null;

// Polling state
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
    setNowPlaying(np);
  } catch (_err) {
    // Network blip — leave previous state visible.
  } finally {
    inFlight = false;
    if (!document.hidden && pollTimer != null) {
      pollTimer = setTimeout(pollOnce, POLL_MS);
    }
  }
}

async function fetchPresetsOnce() {
  try {
    const env = await presetsList();
    if (env && env.ok && Array.isArray(env.data)) {
      setPresets(env.data);
    }
  } catch (_err) {
    // Non-fatal.
  }
}

function startPolling() {
  if (pollTimer != null) return;
  pollTimer = setTimeout(pollOnce, 0);
}

function onVisibilityChange() {
  if (document.hidden) {
    clearPoll();
  } else if (nameEl) {
    startPolling();
  }
}

function bindVisibilityOnce() {
  if (visibilityBound) return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityBound = true;
}

// --- text helpers ---------------------------------------------------

function renderName(np) {
  if (!np) return '';
  return (np.item && np.item.name) || np.track || '';
}

// Deduplicate track vs artist vs station name (case-insensitive) and
// join with em-dash. TuneIn streams often put the current song in
// <artist> and the station tagline in <track> — render whatever is
// distinct and non-empty.
function pickTrackLine(np, stationName) {
  if (!np) return '';
  const norm = (s) => (typeof s === 'string' ? s.trim() : '');
  const station = (stationName || '').toLowerCase();
  const track  = norm(np.track);
  const artist = norm(np.artist);
  const useArtist = artist && artist.toLowerCase() !== station;
  const useTrack  = track && track.toLowerCase() !== station
                          && track.toLowerCase() !== artist.toLowerCase();
  const parts = [];
  if (useArtist) parts.push(artist);
  if (useTrack)  parts.push(track);
  return parts.join(' – ');
}

// "TUNEIN · 128 kbps · liveRadio" from the nowPlaying object.
// Fields are absent on STANDBY / AUX; returns '' rather than dots.
function pickMetaLine(np) {
  if (!np) return '';
  const parts = [];
  if (np.source && np.source !== 'STANDBY') parts.push(np.source);
  // ContentItem type carries the stream type (liveRadio, podcast, etc.)
  const type = np.item && np.item.type;
  if (type) parts.push(type);
  return parts.join(' · ');
}

// --- play-pause icon -----------------------------------------------

function syncPlayBtn(np) {
  if (!btnPlay) return;
  const playing = np && np.playStatus === 'PLAY_STATE';
  btnPlay.textContent = playing ? '⏸' : '▶';
  btnPlay.title       = playing ? 'Pause' : 'Play';
  btnPlay.dataset.playing = playing ? '1' : '';
}

// --- volume mutator -------------------------------------------------

function applyVolume(vol) {
  if (!sliderEl) return;
  const muted = vol && vol.muteEnabled;
  const level = vol ? vol.actualVolume : 0;
  // Only update slider if the value differs — avoid stomping on an
  // active drag (the user's thumb should stay under their finger).
  if (sliderEl.value !== String(level)) {
    sliderEl.value = String(level);
  }
  if (muteEl) {
    muteEl.textContent = muted ? '🔊̸' : '🔇';
    muteEl.title = muted ? 'Unmute' : 'Mute';
    muteEl.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }
  if (volumeRowEl) volumeRowEl.hidden = !vol;
}

// --- mutator --------------------------------------------------------

function applyNowPlaying(np) {
  if (!cardEl) return;

  const standby = np && np.source === 'STANDBY';
  cardEl.hidden    = standby;
  asleepEl.hidden  = !standby;
  transportEl.hidden = standby;

  if (standby) return;

  const name = renderName(np);
  nameEl.textContent  = name;
  trackEl.textContent = np ? pickTrackLine(np, name) : '';
  trackEl.toggleAttribute('hidden', !trackEl.textContent);
  metaEl.textContent  = np ? pickMetaLine(np) : '';
  metaEl.toggleAttribute('hidden', !metaEl.textContent);

  const artUrl = np && typeof np.art === 'string' && np.art.startsWith('http')
    ? np.art : '';
  setArt(artEl, artUrl, name);

  syncPlayBtn(np);
}

// --- preset card row -----------------------------------------------

// Mutate only the DOM nodes for slots that changed. Compare previous
// slot data (stored in dataset) against the new list so unaffected
// buttons are left untouched — preserves :active state mid-press.
function applyPresets(presets) {
  if (!presetBtns.length) return;
  for (let i = 0; i < PRESET_SLOTS; i++) {
    const btn = presetBtns[i];
    if (!btn) continue;
    const p = presets && presets[i] ? presets[i] : null;
    const empty = !p || !!p.empty;

    // Compare against the last-rendered values stored in dataset to
    // skip DOM writes when nothing changed (e.g. on unrelated updates).
    const newName = empty ? '' : (p.itemName || `Preset ${i + 1}`);
    const newArt  = (!empty && typeof p.art === 'string' && p.art.startsWith('http')) ? p.art : '';

    if (btn.dataset.renderedEmpty === String(empty)
        && btn.dataset.renderedName === newName
        && btn.dataset.renderedArt === newArt) {
      continue;
    }

    btn.dataset.renderedEmpty = String(empty);
    btn.dataset.renderedName  = newName;
    btn.dataset.renderedArt   = newArt;

    btn.disabled = empty;
    btn.classList.toggle('np-preset--empty', empty);

    const nameEl = btn.querySelector('.np-preset-name');
    const imgEl  = btn.querySelector('.np-preset-art');

    if (nameEl) nameEl.textContent = empty ? 'Empty' : newName;
    if (imgEl) {
      if (newArt) {
        imgEl.src = newArt;
        imgEl.removeAttribute('hidden');
      } else {
        imgEl.removeAttribute('src');
        imgEl.setAttribute('hidden', '');
      }
    }
  }
}

async function onPresetClick(evt) {
  const btn = evt.currentTarget;
  const slot = btn.dataset.slot;
  if (!slot || btn.disabled) return;
  try {
    await postKey(`PRESET_${slot}`);
  } catch (_err) {
    // Non-fatal — the next nowPlayingUpdated / nowSelectionUpdated will
    // confirm or deny the switch.
  }
}

// --- source picker pills -------------------------------------------

// Active source comes from state.speaker.nowPlaying.source.
// Render once on init (empty); mutate pill attributes on each update.
function applySourcePills(sources, activeSource) {
  if (!sourcesEl) return;

  const existing = sourcesEl.querySelectorAll('.np-source-pill');
  const sourcesArr = Array.isArray(sources) ? sources : [];

  if (existing.length !== sourcesArr.length) {
    // Sources list changed length — rebuild the pill row.
    sourcesEl.textContent = '';
    for (const src of sourcesArr) {
      const btn = document.createElement('button');
      btn.className = 'np-source-pill';
      btn.type = 'button';
      btn.dataset.source = src.source;
      btn.dataset.account = src.sourceAccount || '';
      btn.dataset.status = src.status;
      btn.dataset.local = src.isLocal ? 'true' : 'false';
      btn.textContent = src.displayName || src.source;
      btn.addEventListener('click', onSourceClick);
      sourcesEl.appendChild(btn);
    }
  }

  // Mutate active/disabled state on existing pill nodes.
  const pills = sourcesEl.querySelectorAll('.np-source-pill');
  for (const pill of pills) {
    const src = pill.dataset.source;
    const unavail = pill.dataset.status === 'UNAVAILABLE';
    pill.disabled = unavail;
    pill.dataset.active = (src === activeSource) ? 'true' : 'false';
  }
}

async function onSourceClick(evt) {
  const btn = evt.currentTarget;
  const source = btn.dataset.source;
  const sourceAccount = btn.dataset.account || '';
  const isLocal = btn.dataset.local === 'true';
  try {
    if (isLocal) {
      await postSelectLocalSource(source);
    } else {
      await postSelect({ source, sourceAccount });
    }
  } catch (_err) {
    // Switch errors are non-fatal — the source pill state will self-correct
    // when the next nowPlaying update arrives.
  }
}

// --- transport click handlers --------------------------------------

let keyInFlight = false;

async function sendKey(key) {
  if (keyInFlight) return;
  keyInFlight = true;
  try {
    await postKey(key);
  } finally {
    keyInFlight = false;
  }
}

function onPrev()  { sendKey('PREV_TRACK'); }
function onNext()  { sendKey('NEXT_TRACK'); }
function onPlayPause() {
  const np = store.state.speaker.nowPlaying;
  const playing = np && np.playStatus === 'PLAY_STATE';
  sendKey(playing ? 'PAUSE' : 'PLAY');
}

// --- view lifecycle -------------------------------------------------

export default {
  init(root) {
    mount(root, html`
      <section class="np-view" data-view="now-playing">
        <div class="np-card">
          <div class="np-art-wrap">
            <img class="np-art" alt="">
          </div>
          <div class="np-text">
            <h1 class="np-name"></h1>
            <p class="np-track" hidden></p>
            <p class="np-meta" hidden></p>
          </div>
        </div>
        <div class="np-transport">
          <button class="np-btn" type="button" title="Previous" aria-label="Previous track">&#x23EE;</button>
          <button class="np-btn np-btn--play" type="button" title="Play" aria-label="Play">&#x25B6;</button>
          <button class="np-btn" type="button" title="Next" aria-label="Next track">&#x23ED;</button>
        </div>
        <div class="np-volume" hidden>
          <span class="np-vol-icon" aria-hidden="true">&#x1F50A;</span>
          <input class="np-slider" type="range" min="0" max="100" step="1" aria-label="Volume">
          <button class="np-mute" type="button" title="Mute" aria-pressed="false">&#x1F507;</button>
        </div>
        <div class="np-sources"></div>
        <div class="np-presets"></div>
        <div class="np-asleep" hidden>
          <p>Speaker is asleep</p>
          <p class="np-asleep-hint">Press Play to wake it up.</p>
        </div>
      </section>
    `);

    cardEl     = root.querySelector('.np-card');
    artEl      = root.querySelector('.np-art');
    nameEl     = root.querySelector('.np-name');
    trackEl    = root.querySelector('.np-track');
    metaEl     = root.querySelector('.np-meta');
    transportEl = root.querySelector('.np-transport');
    sourcesEl  = root.querySelector('.np-sources');
    presetsEl  = root.querySelector('.np-presets');
    asleepEl   = root.querySelector('.np-asleep');
    volumeRowEl = root.querySelector('.np-volume');
    sliderEl   = root.querySelector('.np-slider');
    muteEl     = root.querySelector('.np-mute');

    // Build 6 preset buttons init-once; mutated in place by applyPresets().
    presetBtns = [];
    for (let i = 0; i < PRESET_SLOTS; i++) {
      const btn = document.createElement('button');
      btn.className = 'np-preset np-preset--empty';
      btn.type = 'button';
      btn.dataset.slot = String(i + 1);
      btn.disabled = true;

      const num = document.createElement('span');
      num.className = 'np-preset-num';
      num.textContent = String(i + 1);
      btn.appendChild(num);

      const img = document.createElement('img');
      img.className = 'np-preset-art';
      img.alt = '';
      img.setAttribute('hidden', '');
      btn.appendChild(img);

      const label = document.createElement('span');
      label.className = 'np-preset-name';
      label.textContent = 'Empty';
      btn.appendChild(label);

      btn.addEventListener('click', onPresetClick);
      presetsEl.appendChild(btn);
      presetBtns.push(btn);
    }

    const btns = root.querySelectorAll('.np-btn');
    btnPrev = btns[0];
    btnPlay = btns[1];
    btnNext = btns[2];

    btnPrev.addEventListener('click', onPrev);
    btnPlay.addEventListener('click', onPlayPause);
    btnNext.addEventListener('click', onNext);

    // Build the volume sender and wire its confirm callback into ws.js so
    // volumeUpdated events suppress redundant outbound POSTs.
    volumeSender = makeVolumeSender(postVolume);
    setVolumeConfirmFn(volumeSender.confirm);

    sliderEl.addEventListener('input', () => {
      const level = Number(sliderEl.value);
      // Eager local feedback: update targetVolume so the thumb stays live.
      if (store.state.speaker.volume) {
        store.state.speaker.volume.targetVolume = level;
      }
      volumeSender.setVolume(level);
    });

    muteEl.addEventListener('click', () => { postKey('MUTE'); });

    const sp = store.state.speaker;
    applyNowPlaying(sp.nowPlaying);
    applyVolume(sp.volume);
    applySourcePills(sp.sources, sp.nowPlaying && sp.nowPlaying.source);
    applyPresets(sp.presets);

    bindVisibilityOnce();
    if (!document.hidden) startPolling();
    if (!store.state.speaker.presets) fetchPresetsOnce();
  },

  update(state, changedKey) {
    if (changedKey !== 'speaker') return;
    applyNowPlaying(state.speaker.nowPlaying);
    applyVolume(state.speaker.volume);
    const activeSource = state.speaker.nowPlaying && state.speaker.nowPlaying.source;
    applySourcePills(state.speaker.sources, activeSource);
    applyPresets(state.speaker.presets);
  },

  _teardown() {
    clearPoll();
    cardEl = artEl = nameEl = trackEl = metaEl = null;
    transportEl = sourcesEl = presetsEl = asleepEl = null;
    btnPrev = btnPlay = btnNext = null;
    sliderEl = muteEl = volumeRowEl = null;
    presetBtns = [];
    volumeSender = null;
    setVolumeConfirmFn(null);
  },
};
