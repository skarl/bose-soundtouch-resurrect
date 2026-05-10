// Network — read-only.
// Displays the speaker's active interface (SSID, IP, MAC, signal). Wi-Fi
// reconfiguration is intentionally out of scope (admin/PLAN.md § Out of
// scope; SECURITY.md § LAN trust model).
//
// The speaker reports a coarse 5-bucket signal label, not a numeric
// dBm. We render both the label (so screen readers / search are happy)
// and a 4-bar visual mapped from the bucket so sighted users get a
// glanceable strength indicator.

import { html, mount, defineView } from '../../dom.js';
import { getNetworkInfo } from '../../api.js';

const SIGNAL_LABELS = {
  EXCELLENT_SIGNAL:    'Excellent',
  GOOD_SIGNAL:         'Good',
  MARGINAL_SIGNAL:     'Marginal',
  POOR_SIGNAL:         'Poor',
  NO_SIGNAL:           'None',
};

const SIGNAL_BARS = {
  EXCELLENT_SIGNAL: 4,
  GOOD_SIGNAL:      3,
  MARGINAL_SIGNAL:  2,
  POOR_SIGNAL:      1,
  NO_SIGNAL:        0,
};

export function signalBarsCount(label) {
  if (typeof label !== 'string') return 0;
  return Object.prototype.hasOwnProperty.call(SIGNAL_BARS, label)
    ? SIGNAL_BARS[label]
    : 0;
}

function signalLabel(net) {
  if (!net || !net.signal) return '';
  return SIGNAL_LABELS[net.signal] || net.signal;
}

// Build a 4-bar signal indicator. Each bar is a styled <span> so CSS
// drives the height/opacity ramp; data-fill="…" on the wrapper carries
// the count for both styling and tests.
export function signalBars(label) {
  const wrap = document.createElement('span');
  wrap.className = 'signal-bars';
  const count = signalBarsCount(label);
  wrap.dataset.fill = String(count);
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 1; i <= 4; i++) {
    const bar = document.createElement('span');
    bar.className = 'signal-bars__bar';
    if (i <= count) bar.dataset.on = 'true';
    wrap.appendChild(bar);
  }
  return wrap;
}

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-network" data-section="network">
        <dl class="settings-network__rows">
          <dt>SSID</dt><dd class="settings-network__ssid">—</dd>
          <dt>IP address</dt><dd class="settings-network__ip">—</dd>
          <dt>MAC address</dt><dd class="settings-network__mac">—</dd>
          <dt>Hostname</dt><dd class="settings-network__host">—</dd>
          <dt>Signal</dt>
          <dd class="settings-network__signal">
            <span class="settings-network__signal-bars"></span>
            <span class="settings-network__signal-label">—</span>
          </dd>
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
    const hostEl    = root.querySelector('.settings-network__host');
    const barsSlot  = root.querySelector('.settings-network__signal-bars');
    const labelEl   = root.querySelector('.settings-network__signal-label');
    const refreshEl = root.querySelector('.settings-network__refresh');

    function render(net, info) {
      ssidEl.textContent  = (net && net.ssid)       || '—';
      ipEl.textContent    = (net && net.ipAddress)  || '—';
      macEl.textContent   = (net && net.macAddress) || '—';
      // Bo reports the wifi interface name (wlan0/wlan1) rather than a
      // hostname; speaker name from /info is the closest user-friendly
      // identifier we have.
      hostEl.textContent  = (info && info.name)     || (net && net.name) || '—';

      const lbl = signalLabel(net);
      labelEl.textContent = lbl || '—';

      const next = signalBars(net && net.signal);
      barsSlot.replaceChildren(next);
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

    render(store.state.speaker.network, store.state.speaker.info);
    if (!store.state.speaker.network) refresh();

    return {
      speaker(state) { render(state.speaker.network, state.speaker.info); },
    };
  },
});
