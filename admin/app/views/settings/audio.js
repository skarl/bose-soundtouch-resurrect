// audio — settings sub-view: bass, balance, mono/stereo.
//
// Bass and balance ride the slider factory in app/sliders.js
// (eager update + single in-flight + trailing coalesce). WS
// bassUpdated/balanceUpdated events mutate the slider thumb in place
// via the {speaker(state)} updater.
//
// Mono/stereo is wired as a two-button toggle. The button's change
// handler calls actions.setDSPMonoStereo and the next reconcile() / WS
// sweep refreshes state.speaker.dspMonoStereo.

import { html, mount, defineView } from '../../dom.js';
import { getBassCapabilities, getBalanceCapabilities } from '../../api.js';
import * as actions from '../../actions/index.js';
import { formatBassValueText, formatBalanceValueText } from '../../a11y.js';

const BASS_FALLBACK    = { min: -9, max: 0,  def: 0 };
const BALANCE_FALLBACK = { min: -7, max: 7,  def: 0 };

function formatBass(level) {
  if (typeof level !== 'number' || !Number.isFinite(level)) return '';
  if (level > 0) return `+${level}`;
  return String(level);
}

function formatBalance(level) {
  if (typeof level !== 'number' || !Number.isFinite(level)) return '';
  if (level === 0) return 'C';
  return level < 0 ? `L${-level}` : `R${level}`;
}

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-audio">
        <div class="settings-row settings-row--slider settings-row--bass">
          <label class="settings-row__label" for="settings-bass">Bass</label>
          <span class="settings-row__control">
            <input class="settings-slider" id="settings-bass" type="range" step="1" disabled>
            <output class="settings-row__value mono" for="settings-bass"></output>
          </span>
        </div>
        <div class="settings-row settings-row--slider settings-row--balance">
          <label class="settings-row__label" for="settings-balance">Balance</label>
          <span class="settings-row__control">
            <input class="settings-slider" id="settings-balance" type="range" step="1" disabled>
            <output class="settings-row__value mono" for="settings-balance"></output>
          </span>
        </div>
        <div class="settings-row settings-row--mono">
          <span class="settings-row__label">Mono / stereo</span>
          <span class="settings-row__control settings-toggle" role="radiogroup" aria-label="Channel mode">
            <button class="settings-btn settings-toggle__opt" type="button" data-mode="stereo">Stereo</button>
            <button class="settings-btn settings-toggle__opt" type="button" data-mode="mono">Mono</button>
          </span>
        </div>
      </div>
    `);

    const bassEl    = root.querySelector('#settings-bass');
    const bassOut   = root.querySelector('.settings-row--bass .settings-row__value');
    const balEl     = root.querySelector('#settings-balance');
    const balOut    = root.querySelector('.settings-row--balance .settings-row__value');
    const monoBtns  = root.querySelectorAll('.settings-toggle__opt');

    function applyBass(bass) {
      if (!bass) return;
      const level = bass.targetBass;
      if (typeof level !== 'number') return;
      if (bassEl.value !== String(level)) bassEl.value = String(level);
      bassOut.textContent = formatBass(level);
      bassEl.setAttribute('aria-valuetext',
        formatBassValueText(level, Number(bassEl.min) || BASS_FALLBACK.min, Number(bassEl.max) || BASS_FALLBACK.max));
    }

    function applyBalance(balance) {
      if (!balance) return;
      const level = balance.targetBalance;
      if (typeof level !== 'number') return;
      if (balEl.value !== String(level)) balEl.value = String(level);
      balOut.textContent = formatBalance(level);
      balEl.setAttribute('aria-valuetext',
        formatBalanceValueText(level, Number(balEl.min) || BALANCE_FALLBACK.min, Number(balEl.max) || BALANCE_FALLBACK.max));
    }

    function applyMono(dsp) {
      const mode = dsp && dsp.mode === 'mono' ? 'mono' : 'stereo';
      for (const b of monoBtns) {
        const active = b.dataset.mode === mode;
        b.dataset.active = active ? 'true' : 'false';
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    bassEl.addEventListener('input', () => {
      const v = Number(bassEl.value);
      bassOut.textContent = formatBass(v);
      bassEl.setAttribute('aria-valuetext',
        formatBassValueText(v, Number(bassEl.min) || BASS_FALLBACK.min, Number(bassEl.max) || BASS_FALLBACK.max));
      actions.setBass(v);
    });

    balEl.addEventListener('input', () => {
      const v = Number(balEl.value);
      balOut.textContent = formatBalance(v);
      balEl.setAttribute('aria-valuetext',
        formatBalanceValueText(v, Number(balEl.min) || BALANCE_FALLBACK.min, Number(balEl.max) || BALANCE_FALLBACK.max));
      actions.setBalance(v);
    });

    for (const b of monoBtns) {
      b.addEventListener('click', () => {
        const mode = b.dataset.mode;
        // Optimistic paint — keeps the toggle from flickering between
        // commit and the next WS sweep.
        applyMono({ mode });
        actions.setDSPMonoStereo(mode).catch(() => {
          // Non-fatal — next reconcile() will resync from the speaker.
        });
      });
    }

    // Capabilities define slider min/max. Fetch once per view mount;
    // fall back to documented defaults if the speaker is unreachable so
    // the UI still works.
    (async () => {
      try {
        const caps = await getBassCapabilities();
        if (env.signal.aborted) return;
        const min = caps && typeof caps.bassMin === 'number' ? caps.bassMin : BASS_FALLBACK.min;
        const max = caps && typeof caps.bassMax === 'number' ? caps.bassMax : BASS_FALLBACK.max;
        bassEl.min = String(min);
        bassEl.max = String(max);
        bassEl.disabled = false;
      } catch (_err) {
        bassEl.min = String(BASS_FALLBACK.min);
        bassEl.max = String(BASS_FALLBACK.max);
        bassEl.disabled = false;
      }
      applyBass(store.state.speaker.bass);
    })();

    (async () => {
      try {
        const caps = await getBalanceCapabilities();
        if (env.signal.aborted) return;
        const min = caps && typeof caps.balanceMin === 'number' ? caps.balanceMin : BALANCE_FALLBACK.min;
        const max = caps && typeof caps.balanceMax === 'number' ? caps.balanceMax : BALANCE_FALLBACK.max;
        balEl.min = String(min);
        balEl.max = String(max);
        balEl.disabled = false;
      } catch (_err) {
        balEl.min = String(BALANCE_FALLBACK.min);
        balEl.max = String(BALANCE_FALLBACK.max);
        balEl.disabled = false;
      }
      applyBalance(store.state.speaker.balance);
    })();

    applyBass(store.state.speaker.bass);
    applyBalance(store.state.speaker.balance);
    applyMono(store.state.speaker.dspMonoStereo);

    return {
      speaker(state) {
        applyBass(state.speaker.bass);
        applyBalance(state.speaker.balance);
        applyMono(state.speaker.dspMonoStereo);
      },
    };
  },
});
