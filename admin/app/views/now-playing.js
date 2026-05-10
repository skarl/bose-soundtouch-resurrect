// now-playing — live home view.
// Art + station name + track/artist + source metadata + transport.
// REST polling runs as a fallback; the primary update path is the WS
// 'speaker' subscription wired by the view shell.
//
// Render strategy: mount() builds the DOM once; updaters mutate cached
// refs in place — never re-rendering. See admin/app/dom.js.

import { html, mount, defineView } from '../dom.js';
import { store } from '../state.js';
import { speakerNowPlaying, presetsList } from '../api.js';
import { setArt } from '../art.js';
import * as actions from '../actions/index.js';
import { vuDot, updateVuDot } from '../components.js';

const POLL_MS = 2000;
const PRESET_SLOTS = 6;
const LONG_PRESS_MS = 600;

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
  const type = np.item && np.item.type;
  if (type) parts.push(type);
  return parts.join(' · ');
}

export default defineView({
  mount(root, _store, _ctx, env) {
    const vuDotEl = vuDot();

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
          ${vuDotEl}
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

    const cardEl     = root.querySelector('.np-card');
    const artEl      = root.querySelector('.np-art');
    const nameEl     = root.querySelector('.np-name');
    const trackEl    = root.querySelector('.np-track');
    const metaEl     = root.querySelector('.np-meta');
    const transportEl = root.querySelector('.np-transport');
    const sourcesEl  = root.querySelector('.np-sources');
    const presetsEl  = root.querySelector('.np-presets');
    const asleepEl   = root.querySelector('.np-asleep');
    const volumeRowEl = root.querySelector('.np-volume');
    const sliderEl   = root.querySelector('.np-slider');
    const muteEl     = root.querySelector('.np-mute');

    // Long-press state — closure-local.
    let longPressTimer    = null;
    let longPressCancelled = false;

    function clearLongPress() {
      if (longPressTimer != null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
    env.onCleanup(clearLongPress);

    // Preset buttons — built once, mutated in place by applyPresets.
    const presetBtns = [];

    function syncPlayBtn(np) {
      const playing = np && np.playStatus === 'PLAY_STATE';
      btnPlay.textContent = playing ? '⏸' : '▶';
      btnPlay.title       = playing ? 'Pause' : 'Play';
      btnPlay.dataset.playing = playing ? '1' : '';
    }

    function applyVolume(vol) {
      const muted = vol && vol.muteEnabled;
      const level = vol ? vol.targetVolume : 0;
      // Only update slider if the value differs — avoid stomping on an
      // active drag (the user's thumb should stay under their finger).
      if (sliderEl.value !== String(level)) {
        sliderEl.value = String(level);
      }
      muteEl.textContent = muted ? '🔊̸' : '🔇';
      muteEl.title = muted ? 'Unmute' : 'Mute';
      muteEl.setAttribute('aria-pressed', muted ? 'true' : 'false');
      volumeRowEl.hidden = !vol;
    }

    function applyNowPlaying(np) {
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

    // Mutate only the DOM nodes for slots that changed. Compare previous
    // slot data (stored in dataset) against the new list so unaffected
    // buttons are left untouched — preserves :active state mid-press.
    function applyPresets(presets) {
      for (let i = 0; i < PRESET_SLOTS; i++) {
        const btn = presetBtns[i];
        if (!btn) continue;
        const p = presets && presets[i] ? presets[i] : null;
        const empty = !p || !!p.empty;

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

        const labelEl = btn.querySelector('.np-preset-name');
        const imgEl  = btn.querySelector('.np-preset-art');

        if (labelEl) labelEl.textContent = empty ? 'Empty' : newName;
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
      // Swallow the click that follows a long-press.
      if (longPressCancelled) {
        longPressCancelled = false;
        return;
      }
      if (!slot || btn.disabled) return;
      // Bo's firmware silently ignores `/key PRESET_N` press+release and
      // returns 400 on `/selectPreset`. The reliable recall path is
      // `/select` with the preset's stored ContentItem.
      const idx = Number(slot) - 1;
      const p = store.state.speaker.presets && store.state.speaker.presets[idx];
      if (!p || p.empty) return;
      try {
        await actions.selectPreset(Number(slot), {
          source:        p.source,
          sourceAccount: p.sourceAccount || '',
          type:          p.type || '',
          location:      p.location || '',
        });
      } catch (_err) {
        // Non-fatal — the next nowPlayingUpdated / nowSelectionUpdated
        // will confirm or deny the switch.
      }
    }

    function onPresetPointerDown(evt) {
      if (evt.button !== undefined && evt.button !== 0) return;
      const btn = evt.currentTarget;
      const slot = btn.dataset.slot;
      if (!slot || btn.disabled) return;
      clearLongPress();
      longPressCancelled = false;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        longPressCancelled = true;
        location.hash = `#/preset/${slot}`;
      }, LONG_PRESS_MS);
    }

    function onPresetPointerUp()     { clearLongPress(); }
    function onPresetPointerCancel() { clearLongPress(); }

    function onPresetContextMenu(evt) {
      evt.preventDefault();
      const btn = evt.currentTarget;
      const slot = btn.dataset.slot;
      if (!slot || btn.disabled) return;
      clearLongPress();
      longPressCancelled = false;
      location.hash = `#/preset/${slot}`;
    }

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

      const labelSpan = document.createElement('span');
      labelSpan.className = 'np-preset-name';
      labelSpan.textContent = 'Empty';
      btn.appendChild(labelSpan);

      btn.addEventListener('click', onPresetClick);
      btn.addEventListener('pointerdown',   onPresetPointerDown);
      btn.addEventListener('pointerup',     onPresetPointerUp);
      btn.addEventListener('pointercancel', onPresetPointerCancel);
      btn.addEventListener('contextmenu',   onPresetContextMenu);
      presetsEl.appendChild(btn);
      presetBtns.push(btn);
    }

    function applySourcePills(sources, activeSource) {
      const existing = sourcesEl.querySelectorAll('.np-source-pill');
      const sourcesArr = Array.isArray(sources) ? sources : [];

      if (existing.length !== sourcesArr.length) {
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

      const pills = sourcesEl.querySelectorAll('.np-source-pill');
      for (const pill2 of pills) {
        const src = pill2.dataset.source;
        const unavail = pill2.dataset.status === 'UNAVAILABLE';
        pill2.disabled = unavail;
        pill2.dataset.active = (src === activeSource) ? 'true' : 'false';
      }
    }

    async function onSourceClick(evt) {
      const btn = evt.currentTarget;
      const source = btn.dataset.source;
      const sourceAccount = btn.dataset.account || '';
      const isLocal = btn.dataset.local === 'true';
      try {
        if (isLocal) {
          await actions.selectLocalSource(source);
        } else {
          await actions.selectSource({ source, sourceAccount });
        }
      } catch (_err) {
        // Switch errors are non-fatal — the source pill state will
        // self-correct when the next nowPlaying update arrives.
      }
    }

    let keyInFlight = false;

    async function sendKey(key) {
      if (keyInFlight) return;
      keyInFlight = true;
      try {
        await actions.pressKey(key);
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

    const btns = root.querySelectorAll('.np-btn');
    const btnPrev = btns[0];
    const btnPlay = btns[1];
    const btnNext = btns[2];

    btnPrev.addEventListener('click', onPrev);
    btnPlay.addEventListener('click', onPlayPause);
    btnNext.addEventListener('click', onNext);

    sliderEl.addEventListener('input', () => {
      actions.setVolume(Number(sliderEl.value));
    });

    muteEl.addEventListener('click', () => { actions.toggleMute(); });

    // --- polling ----------------------------------------------------
    let pollTimer = null;
    let inFlight  = false;

    function clearPoll() {
      if (pollTimer != null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }
    env.onCleanup(clearPoll);

    async function pollOnce() {
      if (inFlight) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (env.signal.aborted) return;
      inFlight = true;
      try {
        const np = await speakerNowPlaying();
        if (env.signal.aborted) return;
        store.update('speaker', (s) => { s.speaker.nowPlaying = np; });
      } catch (_err) {
        // Network blip — leave previous state visible.
      } finally {
        inFlight = false;
        if (!env.signal.aborted && !document.hidden && pollTimer != null) {
          pollTimer = setTimeout(pollOnce, POLL_MS);
        }
      }
    }

    function startPolling() {
      if (pollTimer != null) return;
      if (env.signal.aborted) return;
      pollTimer = setTimeout(pollOnce, 0);
    }

    async function fetchPresetsOnce() {
      try {
        const envv = await presetsList();
        if (env.signal.aborted) return;
        if (envv && envv.ok && Array.isArray(envv.data)) {
          store.update('speaker', (s) => { s.speaker.presets = envv.data; });
        }
      } catch (_err) {
        // Non-fatal.
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        clearPoll();
      } else {
        startPolling();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    env.onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));

    // Paint synchronously from current store before polling lands.
    const sp = store.state.speaker;
    applyNowPlaying(sp.nowPlaying);
    applyVolume(sp.volume);
    applySourcePills(sp.sources, sp.nowPlaying && sp.nowPlaying.source);
    applyPresets(sp.presets);
    updateVuDot(vuDotEl, store.state);

    if (typeof document === 'undefined' || !document.hidden) startPolling();
    if (!store.state.speaker.presets) fetchPresetsOnce();

    return {
      speaker(state) {
        applyNowPlaying(state.speaker.nowPlaying);
        applyVolume(state.speaker.volume);
        const activeSource = state.speaker.nowPlaying && state.speaker.nowPlaying.source;
        applySourcePills(state.speaker.sources, activeSource);
        applyPresets(state.speaker.presets);
        updateVuDot(vuDotEl, state);
      },
    };
  },
});
