// now-playing — live home view. Composite tinted card carrying art +
// mono metadata pill + title/track + transport on top, with the volume
// row separated by a hairline border below. Source switcher card +
// 3-up gradient preset grid follow.
//
// REST polling runs as a fallback; the primary update path is the WS
// 'speaker' subscription wired by the view shell.
//
// Render strategy: mount() builds the DOM once; updaters mutate cached
// refs in place — never re-rendering. See admin/app/dom.js.

import { html, mount, defineView } from '../dom.js';
import { store } from '../state.js';
import { speakerNowPlaying, presetsList } from '../api.js';
import { setArt } from '../art.js';
import { hashHue } from '../tint.js';
import * as actions from '../actions/index.js';
import { equalizer, slider } from '../components.js';
import { icon } from '../icons.js';
import { formatVolumeValueText, rovingFocus } from '../a11y.js';

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

// Title-case an UPPER_SNAKE source key when the parser didn't supply a
// displayName (some firmware payloads ship empty <sourceItem> bodies).
function humaniseSourceKey(key) {
  return String(key || '')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default defineView({
  mount(root, _store, _ctx, env) {
    const eqEl = equalizer({ playing: false });

    const volumeSlider = slider({
      min: 0,
      max: 100,
      value: 0,
      step: 1,
      ariaLabel: 'Volume',
      throttleMs: 50,
      onChange: (v) => actions.setVolume(v),
    });
    volumeSlider.classList.add('np-slider');

    mount(root, html`
      <section class="np-view" data-view="now-playing">
        <div class="np-card">
          <div class="np-card__top">
            <div class="np-art-wrap">
              <img class="np-art" alt="" loading="lazy">
            </div>
            <div class="np-body">
              <div class="np-text">
                <div class="np-meta-row">
                  <span class="np-eq-slot" aria-hidden="true"></span>
                  <span class="np-meta" hidden></span>
                </div>
                <h1 class="np-name"></h1>
                <p class="np-track" aria-live="polite" hidden></p>
              </div>
              <div class="np-transport">
                <button class="np-btn np-btn--prev" type="button" title="Previous" aria-label="Previous track"></button>
                <button class="np-btn np-btn--play" type="button" title="Play" aria-label="Play"></button>
                <button class="np-btn np-btn--next" type="button" title="Next" aria-label="Next track"></button>
              </div>
            </div>
          </div>
          <div class="np-volume" hidden>
            <button class="np-mute" type="button" title="Mute" aria-pressed="false" aria-label="Mute"></button>
            <span class="np-slider-slot"></span>
            <span class="np-vol-value" aria-hidden="true">0</span>
          </div>
        </div>
        <div class="np-source-card">
          <div class="np-section-h">
            <span>Source</span>
            <span class="np-section-h__meta np-source-current"></span>
          </div>
          <div class="np-sources" role="toolbar" aria-label="Sources"></div>
        </div>
        <div class="np-presets">
          <div class="np-section-h">
            <span>Presets</span>
            <span class="np-section-h__hint">tap to play · long-press to replace</span>
          </div>
          <div class="np-presets-grid" role="toolbar" aria-label="Presets"></div>
        </div>
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
    const sourcesEl  = root.querySelector('.np-sources');
    const sourceCurEl = root.querySelector('.np-source-current');
    const presetsEl  = root.querySelector('.np-presets-grid');
    const asleepEl   = root.querySelector('.np-asleep');
    const volumeRowEl = root.querySelector('.np-volume');
    const muteEl     = root.querySelector('.np-mute');
    const eqSlot     = root.querySelector('.np-eq-slot');
    const sliderSlot = root.querySelector('.np-slider-slot');
    const volValueEl = root.querySelector('.np-vol-value');
    const btnPrev = root.querySelector('.np-btn--prev');
    const btnPlay = root.querySelector('.np-btn--play');
    const btnNext = root.querySelector('.np-btn--next');

    eqSlot.appendChild(eqEl);
    sliderSlot.appendChild(volumeSlider);
    btnPrev.appendChild(icon('prev', 16));
    btnNext.appendChild(icon('next', 16));
    const playIconRef = { node: icon('play', 16) };
    btnPlay.appendChild(playIconRef.node);
    const muteIconRef = { node: icon('vol', 14) };
    muteEl.appendChild(muteIconRef.node);

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

    const presetBtns = [];

    function syncPlayBtn(np) {
      const playing = np && np.playStatus === 'PLAY_STATE';
      const next = playing ? icon('pause', 16) : icon('play', 16);
      btnPlay.replaceChild(next, playIconRef.node);
      playIconRef.node = next;
      btnPlay.title = playing ? 'Pause' : 'Play';
      btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      btnPlay.dataset.playing = playing ? '1' : '';
    }

    function applyVolume(vol) {
      const muted = vol && vol.muteEnabled;
      const level = vol ? vol.targetVolume : 0;
      // Only update slider if the value differs — avoid stomping on an
      // active drag (the user's thumb should stay under their finger).
      if (volumeSlider.value !== String(level)) {
        volumeSlider.setValue(level);
      }
      volumeSlider.setAttribute('aria-valuetext',
        formatVolumeValueText(level, Number(volumeSlider.max) || 100, !!muted));
      muteEl.title = muted ? 'Unmute' : 'Mute';
      muteEl.setAttribute('aria-pressed', muted ? 'true' : 'false');
      muteEl.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
      // Mute icon swaps between vol / mute glyph.
      const muteNext = icon(muted ? 'mute' : 'vol', 14);
      muteEl.replaceChild(muteNext, muteIconRef.node);
      muteIconRef.node = muteNext;
      volValueEl.textContent = muted ? 'MUTED' : String(level);
      volumeRowEl.hidden = !vol;
    }

    function applyNowPlaying(np) {
      const standby = np && np.source === 'STANDBY';
      cardEl.hidden     = standby;
      asleepEl.hidden   = !standby;
      // Transport sits inside the card now; hiding the card hides it.

      eqEl.setPlaying(!!(np && np.playStatus === 'PLAY_STATE'));

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
    function applyPresets(presets, activeContent) {
      for (let i = 0; i < PRESET_SLOTS; i++) {
        const btn = presetBtns[i];
        if (!btn) continue;
        const p = presets && presets[i] ? presets[i] : null;
        const empty = !p || !!p.empty;

        const newName = empty ? '' : (p.itemName || `Preset ${i + 1}`);
        const isActive = !empty && activeContent
          && activeContent.source === p.source
          && (activeContent.location || '') === (p.location || '')
          && (activeContent.sourceAccount || '') === (p.sourceAccount || '');

        if (btn.dataset.renderedEmpty === String(empty)
            && btn.dataset.renderedName === newName
            && btn.dataset.renderedActive === String(!!isActive)) {
          continue;
        }

        btn.dataset.renderedEmpty  = String(empty);
        btn.dataset.renderedName   = newName;
        btn.dataset.renderedActive = String(!!isActive);

        btn.disabled = empty;
        btn.classList.toggle('np-preset--empty', empty);
        btn.dataset.active = isActive ? 'true' : 'false';
        btn.setAttribute('aria-label',
          empty ? `Preset ${i + 1}, empty` : `Preset ${i + 1}, ${newName}`);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');

        // Per-slot deterministic gradient. hashHue keeps the colour
        // stable across reloads so all six render simultaneously
        // without scheduling six concurrent canvas reads. Empty slots
        // still get a deterministic hue (keyed on the slot) so the
        // grid reads as six placeholder tiles rather than blank squares.
        const hueKey = empty ? `preset-${i + 1}` : newName;
        btn.style.setProperty('--np-preset-hue', String(hashHue(hueKey)));

        const labelEl = btn.querySelector('.np-preset-name');
        if (labelEl) labelEl.textContent = empty ? '' : newName;
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
      try {
        await actions.playPreset(Number(slot));
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

    // Shift+Enter opens the reassign modal — keyboard parity with the
    // pointer long-press / contextmenu paths. Plain Enter / Space falls
    // through to the default <button> click (recall preset).
    function onPresetKeydown(evt) {
      const btn = evt.currentTarget;
      const slot = btn.dataset.slot;
      if (evt.key === 'Enter' && evt.shiftKey && slot && !btn.disabled) {
        evt.preventDefault();
        location.hash = `#/preset/${slot}`;
        return;
      }
      const newIdx = rovingFocus(presetBtns.length, presetBtns.indexOf(btn), evt.key);
      if (newIdx !== presetBtns.indexOf(btn) && newIdx >= 0) {
        evt.preventDefault();
        for (const b of presetBtns) b.tabIndex = -1;
        presetBtns[newIdx].tabIndex = 0;
        presetBtns[newIdx].focus();
      }
    }

    for (let i = 0; i < PRESET_SLOTS; i++) {
      const btn = document.createElement('button');
      btn.className = 'np-preset np-preset--empty';
      btn.type = 'button';
      btn.dataset.slot = String(i + 1);
      btn.disabled = true;
      // Roving tabindex: only the first preset is in the tab order. Arrow
      // keys move focus within the row; Tab leaves to the next control.
      btn.tabIndex = i === 0 ? 0 : -1;

      const num = document.createElement('span');
      num.className = 'np-preset-num';
      num.textContent = '0' + (i + 1);
      btn.appendChild(num);

      const eq = document.createElement('span');
      eq.className = 'np-preset-eq';
      eq.setAttribute('aria-hidden', 'true');
      eq.appendChild(equalizer({ playing: true }));
      btn.appendChild(eq);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'np-preset-name';
      labelSpan.textContent = '';
      btn.appendChild(labelSpan);

      btn.addEventListener('click', onPresetClick);
      btn.addEventListener('pointerdown',   onPresetPointerDown);
      btn.addEventListener('pointerup',     onPresetPointerUp);
      btn.addEventListener('pointercancel', onPresetPointerCancel);
      btn.addEventListener('contextmenu',   onPresetContextMenu);
      btn.addEventListener('keydown',       onPresetKeydown);
      presetsEl.appendChild(btn);
      presetBtns.push(btn);
    }

    function applySourcePills(sources, activeSource) {
      const ready = (Array.isArray(sources) ? sources : [])
        .filter((s) => s && s.status === 'READY');

      const existing = sourcesEl.querySelectorAll('.np-source-pill');

      // Re-render only when the set of READY sources actually changes —
      // the cheap signature is "source|account" per row, joined.
      const sigNew = ready.map((s) => `${s.source}|${s.sourceAccount || ''}`).join(',');
      const sigOld = sourcesEl.dataset.sig || '';

      if (sigNew !== sigOld || existing.length !== ready.length) {
        sourcesEl.textContent = '';
        for (const src of ready) {
          const btn = document.createElement('button');
          btn.className = 'np-source-pill';
          btn.type = 'button';
          btn.dataset.source = src.source;
          btn.dataset.account = src.sourceAccount || '';
          btn.dataset.local = src.isLocal ? 'true' : 'false';
          const label = src.displayName && src.displayName.trim()
            ? src.displayName.trim()
            : humaniseSourceKey(src.source);
          btn.textContent = label;
          btn.setAttribute('aria-label', label);
          btn.addEventListener('click', onSourceClick);
          sourcesEl.appendChild(btn);
        }
        sourcesEl.dataset.sig = sigNew;
      }

      const pills = sourcesEl.querySelectorAll('.np-source-pill');
      for (const pill2 of pills) {
        const src = pill2.dataset.source;
        pill2.dataset.active = (src === activeSource) ? 'true' : 'false';
        pill2.setAttribute('aria-pressed', src === activeSource ? 'true' : 'false');
      }

      if (sourceCurEl) sourceCurEl.textContent = activeSource || '';
    }

    async function onSourceClick(evt) {
      const btn = evt.currentTarget;
      const source = btn.dataset.source;
      const sourceAccount = btn.dataset.account || '';
      // Look up the live source object from state — keeps the wire
      // shape (isLocal, etc.) inside actions.selectSource. Falls back
      // to a synthesised object reconstructed from dataset if the
      // sources list has gone stale between render and click.
      const sources = store.state.speaker.sources || [];
      const src = sources.find((s) =>
        s && s.source === source && (s.sourceAccount || '') === sourceAccount,
      ) || { source, sourceAccount, isLocal: btn.dataset.local === 'true' };
      try {
        await actions.selectSource(src);
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

    btnPrev.addEventListener('click', onPrev);
    btnPlay.addEventListener('click', onPlayPause);
    btnNext.addEventListener('click', onNext);

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
    applyPresets(sp.presets, sp.nowPlaying && sp.nowPlaying.item);

    if (typeof document === 'undefined' || !document.hidden) startPolling();
    if (!store.state.speaker.presets) fetchPresetsOnce();

    return {
      speaker(state) {
        applyNowPlaying(state.speaker.nowPlaying);
        applyVolume(state.speaker.volume);
        const activeSource = state.speaker.nowPlaying && state.speaker.nowPlaying.source;
        applySourcePills(state.speaker.sources, activeSource);
        applyPresets(state.speaker.presets, state.speaker.nowPlaying && state.speaker.nowPlaying.item);
      },
    };
  },
});
