// Network — read-only.
// Displays the speaker's active interface (SSID, IP, MAC, signal).
// Wi-Fi reconfiguration is intentionally out of scope (admin/PLAN.md §
// Out of scope; SECURITY.md § LAN trust model).

import { html, mount, defineView } from '../../dom.js';
import { getNetworkInfo } from '../../api.js';

// Speaker reports a coarse signal bucket, not a numeric dBm. Rendering
// the raw token would leak firmware vocabulary into the UI.
const SIGNAL_LABELS = {
  EXCELLENT_SIGNAL:    'Excellent',
  GOOD_SIGNAL:         'Good',
  MARGINAL_SIGNAL:     'Marginal',
  POOR_SIGNAL:         'Poor',
  NO_SIGNAL:           'None',
};

function signalLabel(net) {
  if (!net || !net.signal) return '';
  return SIGNAL_LABELS[net.signal] || net.signal;
}

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-network" data-section="network">
        <dl class="settings-network__rows">
          <dt>SSID</dt><dd class="settings-network__ssid">—</dd>
          <dt>IP address</dt><dd class="settings-network__ip">—</dd>
          <dt>MAC address</dt><dd class="settings-network__mac">—</dd>
          <dt>Signal</dt><dd class="settings-network__signal">—</dd>
        </dl>
        <div class="settings-network__actions">
          <button class="settings-network__refresh" type="button">Refresh</button>
        </div>
        <p class="settings-network__note">
          Network reconfiguration is not exposed by this admin UI. The
          speaker's local API has no authentication on a trusted LAN —
          see <a href="../SECURITY.md">SECURITY.md</a>.
        </p>
      </div>
    `);

    const ssidEl    = root.querySelector('.settings-network__ssid');
    const ipEl      = root.querySelector('.settings-network__ip');
    const macEl     = root.querySelector('.settings-network__mac');
    const signalEl  = root.querySelector('.settings-network__signal');
    const refreshEl = root.querySelector('.settings-network__refresh');

    function render(net) {
      ssidEl.textContent   = (net && net.ssid)       || '—';
      ipEl.textContent     = (net && net.ipAddress)  || '—';
      macEl.textContent    = (net && net.macAddress) || '—';
      signalEl.textContent = signalLabel(net)        || '—';
    }

    async function refresh() {
      refreshEl.disabled = true;
      try {
        const net = await getNetworkInfo();
        if (env.signal.aborted) return;
        store.update('speaker', (s) => { s.speaker.network = net; });
      } catch (_err) {
        // Network blip — keep the previously-rendered values.
      } finally {
        if (!env.signal.aborted) refreshEl.disabled = false;
      }
    }

    refreshEl.addEventListener('click', refresh);

    render(store.state.speaker.network);
    if (!store.state.speaker.network) refresh();

    return {
      speaker(state) { render(state.speaker.network); },
    };
  },
});
