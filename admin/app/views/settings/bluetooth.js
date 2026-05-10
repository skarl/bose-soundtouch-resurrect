import { html, mount, defineView } from '../../dom.js';
import { store } from '../../state.js';
import { getBluetoothInfo } from '../../api.js';
import * as actions from '../../actions/index.js';
import { confirm } from '../../components.js';

export default defineView({
  mount(root, _store, _ctx, env) {
    mount(root, html`
      <div class="bt-settings" data-section="bluetooth">
        <ul class="bt-paired" hidden></ul>
        <p class="bt-empty" hidden>No paired devices</p>
        <p class="bt-pairing-hint" hidden>Pairing mode active</p>
        <div class="bt-actions">
          <button class="bt-pair" type="button">Enter pairing mode</button>
          <button class="bt-clear" type="button">Clear paired devices</button>
        </div>
      </div>
    `);

    const listEl    = root.querySelector('.bt-paired');
    const emptyEl   = root.querySelector('.bt-empty');
    const hintEl    = root.querySelector('.bt-pairing-hint');
    const pairBtn   = root.querySelector('.bt-pair');
    const clearBtn  = root.querySelector('.bt-clear');

    function applyPaired(bt) {
      const paired = (bt && Array.isArray(bt.paired)) ? bt.paired : [];
      listEl.textContent = '';
      if (paired.length === 0) {
        listEl.hidden = true;
        emptyEl.hidden = false;
        return;
      }
      for (const dev of paired) {
        const li = document.createElement('li');
        li.className = 'bt-paired-item';

        const nameEl = document.createElement('span');
        nameEl.className = 'bt-paired-name';
        nameEl.textContent = dev.name || '(unnamed device)';

        const macEl = document.createElement('span');
        macEl.className = 'bt-paired-mac';
        macEl.textContent = dev.mac || '';

        li.appendChild(nameEl);
        if (dev.mac) li.appendChild(macEl);
        listEl.appendChild(li);
      }
      listEl.hidden = false;
      emptyEl.hidden = true;
    }

    async function refetch() {
      try {
        const bt = await getBluetoothInfo();
        if (env.signal.aborted) return;
        store.update('speaker', (s) => { s.speaker.bluetooth = bt; });
      } catch (_err) {
        // Network blip — keep prior list visible.
      }
    }

    pairBtn.addEventListener('click', async () => {
      if (pairBtn.disabled) return;
      pairBtn.disabled = true;
      try {
        await actions.enterBluetoothPairing();
        hintEl.hidden = false;
      } catch (_err) {
        // Non-fatal; user can retry.
      } finally {
        pairBtn.disabled = false;
      }
      await refetch();
      hintEl.hidden = true;
    });

    clearBtn.addEventListener('click', async () => {
      if (clearBtn.disabled) return;
      const ok = await confirm('Clear all paired Bluetooth devices?', {
        confirmLabel: 'Clear',
        danger: true,
      });
      if (!ok) return;
      clearBtn.disabled = true;
      try {
        await actions.clearBluetoothPaired();
      } catch (_err) {
        // Non-fatal.
      } finally {
        clearBtn.disabled = false;
      }
      hintEl.hidden = true;
      await refetch();
    });

    applyPaired(store.state.speaker.bluetooth);
    if (store.state.speaker.bluetooth == null) refetch();

    return {
      speaker(state) {
        applyPaired(state.speaker.bluetooth);
      },
    };
  },
});
