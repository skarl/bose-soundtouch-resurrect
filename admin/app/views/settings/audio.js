// audio — settings sub-view: bass, balance, mono/stereo.
//
// Bass and balance ride the slider factory in app/actions/sliders.js
// (eager update + single in-flight + trailing coalesce). WS
// bassUpdated/balanceUpdated events mutate the slider thumb in place
// via the {speaker(state)} updater.
//
// Mono/stereo is a one-shot: the radio's change handler calls
// actions.setDSPMonoStereo and the next reconcile() / WS sweep refreshes
// state.speaker.dspMonoStereo.

import { html, mount, defineView } from '../../dom.js';
import { getBassCapabilities, getBalanceCapabilities } from '../../api.js';
import * as actions from '../../actions/index.js';

const BASS_FALLBACK    = { min: -9, max: 0,  def: 0 };
const BALANCE_FALLBACK = { min: -7, max: 7,  def: 0 };

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-audio">
        <div class="settings-row settings-row--bass">
          <label class="settings-row__label" for="settings-bass">Bass</label>
          <input class="settings-slider" id="settings-bass" type="range" step="1" disabled>
          <output class="settings-row__value" for="settings-bass"></output>
        </div>
        <div class="settings-row settings-row--balance">
          <label class="settings-row__label" for="settings-balance">Balance</label>
          <input class="settings-slider" id="settings-balance" type="range" step="1" disabled>
          <output class="settings-row__value" for="settings-balance"></output>
        </div>
        <fieldset class="settings-row settings-row--mono">
          <legend class="settings-row__label">Channel</legend>
          <label><input type="radio" name="settings-mono" value="stereo"> Stereo</label>
          <label><input type="radio" name="settings-mono" value="mono"> Mono</label>
        </fieldset>
      </div>
    `);

    const bassEl    = root.querySelector('#settings-bass');
    const bassOut   = root.querySelector('.settings-row--bass .settings-row__value');
    const balEl     = root.querySelector('#settings-balance');
    const balOut    = root.querySelector('.settings-row--balance .settings-row__value');
    const monoRadios = root.querySelectorAll('input[name="settings-mono"]');

    function applyBass(bass) {
      if (!bass) return;
      const level = bass.targetBass;
      if (typeof level !== 'number') return;
      if (bassEl.value !== String(level)) bassEl.value = String(level);
      bassOut.textContent = String(level);
    }

    function applyBalance(balance) {
      if (!balance) return;
      const level = balance.targetBalance;
      if (typeof level !== 'number') return;
      if (balEl.value !== String(level)) balEl.value = String(level);
      balOut.textContent = String(level);
    }

    function applyMono(dsp) {
      const mode = dsp && dsp.mode === 'mono' ? 'mono' : 'stereo';
      for (const r of monoRadios) {
        r.checked = (r.value === mode);
      }
    }

    bassEl.addEventListener('input', () => {
      const v = Number(bassEl.value);
      bassOut.textContent = String(v);
      actions.setBass(v);
    });

    balEl.addEventListener('input', () => {
      const v = Number(balEl.value);
      balOut.textContent = String(v);
      actions.setBalance(v);
    });

    for (const r of monoRadios) {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        actions.setDSPMonoStereo(r.value).catch(() => {
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

    // Paint synchronously from current store before fetchers land.
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
