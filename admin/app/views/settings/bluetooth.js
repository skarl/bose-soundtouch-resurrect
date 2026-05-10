// bluetooth — settings sub-view.
//
// Bo's firmware exposes only the speaker's own MAC via /bluetoothInfo
// (verified with iPhone actively paired — no <pairedList> ever
// materialises). The active connection lives on /now_playing's
// <connectionStatusInfo> element when source=BLUETOOTH; otherwise the
// "Currently connected" row reads "Not connected".
//
// Pairing-mode and clear-paired actions remain — clear is one-shot from
// the speaker's side; the confirm dialog acknowledges that no list is
// shown so the user knows what they're signing off on.

import { html, mount, defineView } from '../../dom.js';
import { store } from '../../state.js';
import { getBluetoothInfo } from '../../api.js';
import * as actions from '../../actions/index.js';
import { confirm } from '../../components.js';

function formatMac(mac) {
  if (typeof mac !== 'string') return '';
  const hex = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{2}/g).join(':');
}

function connectedDevice(np) {
  if (!np || np.source !== 'BLUETOOTH') return null;
  const c = np.connection;
  if (!c || c.status !== 'CONNECTED') return null;
  return c.deviceName || '(unnamed device)';
}

export default defineView({
  mount(root, _store, _ctx, env) {
    mount(root, html`
      <div class="bt-settings settings-bluetooth" data-section="bluetooth">
        <div class="settings-actions bt-actions">
          <button class="settings-btn bt-pair" type="button">Enter pairing mode</button>
          <button class="settings-btn bt-clear" type="button">Clear paired devices</button>
        </div>
        <p class="bt-pairing-hint" hidden>Pairing mode active</p>
        <div class="settings-row">
          <span class="settings-row__label">Bluetooth MAC</span>
          <span class="settings-row__control mono bt-mac">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">Currently connected</span>
          <span class="settings-row__control bt-connected">Not connected</span>
        </div>
      </div>
    `);

    const macEl       = root.querySelector('.bt-mac');
    const connectedEl = root.querySelector('.bt-connected');
    const hintEl      = root.querySelector('.bt-pairing-hint');
    const pairBtn     = root.querySelector('.bt-pair');
    const clearBtn    = root.querySelector('.bt-clear');

    function applyMac(bt) {
      const raw = (bt && bt.macAddress) || '';
      macEl.textContent = formatMac(raw) || '—';
    }

    function applyConnection(np) {
      const dev = connectedDevice(np);
      connectedEl.textContent = dev || 'Not connected';
      if (dev) connectedEl.classList.remove('settings-muted');
      else connectedEl.classList.add('settings-muted');
    }

    async function refetch() {
      try {
        const bt = await getBluetoothInfo();
        if (env.signal.aborted) return;
        store.update('speaker', (s) => { s.speaker.bluetooth = bt; });
      } catch (_err) {
        // Network blip — keep prior MAC visible.
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
      const ok = await confirm(
        'Clear all paired Bluetooth devices? Bo does not expose the paired-devices ' +
        'list, so this will silently forget every device the speaker has stored.',
        { confirmLabel: 'Clear', danger: true },
      );
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

    applyMac(store.state.speaker.bluetooth);
    applyConnection(store.state.speaker.nowPlaying);
    if (store.state.speaker.bluetooth == null) refetch();

    return {
      speaker(state) {
        applyMac(state.speaker.bluetooth);
        applyConnection(state.speaker.nowPlaying);
      },
    };
  },
});
