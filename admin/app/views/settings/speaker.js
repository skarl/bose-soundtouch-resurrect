import { html, mount, defineView } from '../../dom.js';
import { store } from '../../state.js';
import * as actions from '../../actions/index.js';

// Bo's firmware exposes no /systemtimeoutCapabilities; mirror the
// official app's set. Minutes; 0 = "Never".
const SLEEP_TIMER_OPTIONS = [
  { value: 0,   label: 'Never' },
  { value: 20,  label: '20 minutes' },
  { value: 60,  label: '1 hour' },
  { value: 90,  label: '90 minutes' },
  { value: 120, label: '2 hours' },
];

const NAME_DEBOUNCE_MS = 600;

export default defineView({
  mount(root) {
    mount(root, html`
      <div class="settings-speaker">
        <label class="settings-row">
          <span class="settings-label">Name</span>
          <input class="settings-name" type="text" maxlength="64" autocomplete="off" spellcheck="false">
        </label>

        <label class="settings-row">
          <span class="settings-label">Sleep timer</span>
          <select class="settings-sleep"></select>
        </label>

        <div class="settings-row settings-row--inline">
          <button class="settings-standby" type="button">Standby</button>
          <button class="settings-wake" type="button">Wake</button>
        </div>
      </div>
    `);

    const nameEl     = root.querySelector('.settings-name');
    const sleepEl    = root.querySelector('.settings-sleep');
    const standbyEl  = root.querySelector('.settings-standby');
    const wakeEl     = root.querySelector('.settings-wake');

    for (const o of SLEEP_TIMER_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(o.value);
      opt.textContent = o.label;
      sleepEl.appendChild(opt);
    }

    // Skip state-driven repaints while the user is editing — overwriting
    // `value` mid-keystroke yanks the caret.
    let nameDirty = false;
    let nameDebounce = null;

    function clearNameDebounce() {
      if (nameDebounce != null) {
        clearTimeout(nameDebounce);
        nameDebounce = null;
      }
    }

    async function commitName() {
      clearNameDebounce();
      const next = nameEl.value.trim();
      const cur  = (store.state.speaker.info && store.state.speaker.info.name) || '';
      if (!next || next === cur) {
        nameDirty = false;
        nameEl.value = cur;
        return;
      }
      nameDirty = false;
      try {
        await actions.setName(next);
        // No WS event for name; mirror locally so the header pill updates
        // without a full /info refetch.
        store.update('speaker', (s) => {
          if (!s.speaker.info) s.speaker.info = { name: next };
          else s.speaker.info = { ...s.speaker.info, name: next };
        });
      } catch (_err) {
        nameEl.value = cur;
      }
    }

    nameEl.addEventListener('input', () => {
      nameDirty = true;
      clearNameDebounce();
      nameDebounce = setTimeout(commitName, NAME_DEBOUNCE_MS);
    });
    nameEl.addEventListener('blur', commitName);
    nameEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        nameEl.blur();
      }
    });

    sleepEl.addEventListener('change', async () => {
      const minutes = Number(sleepEl.value);
      try {
        await actions.setSystemTimeout(minutes);
        store.update('speaker', (s) => {
          s.speaker.systemTimeout = { enabled: minutes > 0, minutes };
        });
      } catch (_err) {
        const cur = store.state.speaker.systemTimeout;
        sleepEl.value = String(cur ? cur.minutes : 0);
      }
    });

    standbyEl.addEventListener('click', () => {
      actions.standby().catch(() => {});
    });

    wakeEl.addEventListener('click', () => {
      actions.setPower('ON').catch(() => {});
    });

    function applyName(info) {
      const name = (info && info.name) || '';
      if (document.activeElement === nameEl || nameDirty) return;
      if (nameEl.value !== name) nameEl.value = name;
    }

    function applySleep(t) {
      const minutes = t ? t.minutes : 0;
      const want = String(minutes);
      // Unknown values would coerce to the first <option> — leave
      // the select alone rather than silently misrepresent.
      if (sleepEl.value !== want
          && SLEEP_TIMER_OPTIONS.some((o) => String(o.value) === want)) {
        sleepEl.value = want;
      }
    }

    function applyPower(np) {
      const standby = np && np.source === 'STANDBY';
      wakeEl.disabled    = !standby;
      standbyEl.disabled = !!standby;
    }

    const sp = store.state.speaker;
    applyName(sp.info);
    applySleep(sp.systemTimeout);
    applyPower(sp.nowPlaying);

    return {
      speaker(state) {
        applyName(state.speaker.info);
        applySleep(state.speaker.systemTimeout);
        applyPower(state.speaker.nowPlaying);
      },
    };
  },
});
