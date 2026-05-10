// Network — read-only.
// Displays the speaker's active interface (SSID, IP, hostname, MAC,
// signal). Wi-Fi reconfiguration is intentionally out of scope
// (admin/PLAN.md § Out of scope; SECURITY.md § LAN trust model).
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

function hostnameOf(info, net) {
  const name = (info && info.name) || (net && net.name) || '';
  if (!name) return '';
  // Hostnames don't tolerate spaces or unicode; the speaker UPnP
  // device-name allows both. Lowercase + replace whitespace with '-' so
  // the .local form looks like something you could actually paste into
  // a browser bar.
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-');
  return slug ? `${slug}.local` : '';
}

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-network" data-section="network">
        <div class="settings-row">
          <span class="settings-row__label">SSID</span>
          <span class="settings-row__control mono settings-network__ssid">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">IP address</span>
          <span class="settings-row__control mono settings-network__ip">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">Hostname</span>
          <span class="settings-row__control mono settings-network__host">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">MAC address</span>
          <span class="settings-row__control mono settings-network__mac">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">Signal</span>
          <span class="settings-row__control settings-network__signal">
            <span class="mono settings-network__signal-label">—</span>
            <span class="settings-network__signal-bars"></span>
          </span>
        </div>
      </div>
    `);

    const ssidEl    = root.querySelector('.settings-network__ssid');
    const ipEl      = root.querySelector('.settings-network__ip');
    const macEl     = root.querySelector('.settings-network__mac');
    const hostEl    = root.querySelector('.settings-network__host');
    const barsSlot  = root.querySelector('.settings-network__signal-bars');
    const labelEl   = root.querySelector('.settings-network__signal-label');

    function render(net, info) {
      ssidEl.textContent  = (net && net.ssid)       || '—';
      ipEl.textContent    = (net && net.ipAddress)  || '—';
      macEl.textContent   = (net && net.macAddress) || '—';
      hostEl.textContent  = hostnameOf(info, net) || '—';

      const lbl = signalLabel(net);
      labelEl.textContent = lbl || '—';

      const next = signalBars(net && net.signal);
      barsSlot.replaceChildren(next);
    }

    async function refresh() {
      try {
        const net = await getNetworkInfo();
        if (env.signal.aborted) return;
        store.update('speaker', (s) => { s.speaker.network = net; });
      } catch (_err) {
        // Network blip — keep the previously-rendered values.
      }
    }

    render(store.state.speaker.network, store.state.speaker.info);
    if (!store.state.speaker.network) refresh();

    return {
      speaker(state) { render(state.speaker.network, state.speaker.info); },
    };
  },
});
