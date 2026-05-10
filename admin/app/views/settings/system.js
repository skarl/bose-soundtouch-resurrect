// system — settings sub-view: firmware, MAC, capabilities summary, recents.
//
// All read-only. The notifications gizmo (#43) lands inside the
// .settings-system__notif-slot container via mountChild in a later slice.
//
// state.speaker.info is populated by speaker-state.js (no WS event).
// state.speaker.recents is the speaker's recently-played list,
// kept fresh by the recentsUpdated WS event.

import { html, mount, defineView } from '../../dom.js';
import { getCapabilities } from '../../api.js';

// Firmware version strings on Bo look like
//   "27.0.6.46330.5043500 epdbuild.trunk.hepdswbld04.2022-08-04T11:20:29"
// — semantic-ish dotted version, then a whitespace-separated build tag.
// We surface "v27.0.6" plus the first build number (46330) so the row
// reads cleanly without leaking firmware vocabulary.
function formatFirmware(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const head = raw.trim().split(/\s+/)[0];
  const parts = head.split('.');
  const version = parts.slice(0, 3).join('.');
  const build   = parts[3];
  if (!version) return raw.trim();
  return build ? `v${version} (build ${build})` : `v${version}`;
}

// Bose firmware reports MAC as a 12-hex-digit blob (e.g. "0CB2B709F837").
// Insert colons for readability without mutating the source field.
function formatMac(mac) {
  if (typeof mac !== 'string') return '';
  const hex = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{2}/g).join(':');
}

// `/v1/playback/station/s12345` → "s12345" (TUNEIN station IDs).
// Anything else returns null so the row falls back to plain text.
function tuneinStationId(location) {
  if (typeof location !== 'string') return null;
  const m = location.match(/\/station\/(s\d+)$/);
  return m ? m[1] : null;
}

const CAP_FLAGS = [
  { key: 'dspMonoStereo',      label: 'Mono/Stereo DSP' },
  { key: 'lrStereoCapable',    label: 'L/R stereo pair' },
  { key: 'bcoresetCapable',    label: 'BCO reset' },
  { key: 'disablePowerSaving', label: 'Power-saving toggle' },
  { key: 'lightswitch',        label: 'Light switch' },
  { key: 'clockDisplay',       label: 'Clock display' },
];

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-system" data-section="system">
        <dl class="settings-system__rows">
          <dt>Firmware</dt><dd class="settings-system__firmware">—</dd>
          <dt>MAC address</dt><dd class="settings-system__mac">—</dd>
          <dt>Capabilities</dt>
          <dd>
            <ul class="settings-system__caps"></ul>
          </dd>
          <dt>Recents</dt>
          <dd>
            <ol class="settings-system__recents"></ol>
            <p class="settings-system__recents-empty" hidden>No recent items</p>
          </dd>
        </dl>
        <div class="settings-system__notif-slot"></div>
      </div>
    `);

    const firmwareEl    = root.querySelector('.settings-system__firmware');
    const macEl         = root.querySelector('.settings-system__mac');
    const capsEl        = root.querySelector('.settings-system__caps');
    const recentsEl     = root.querySelector('.settings-system__recents');
    const recentsEmptyEl = root.querySelector('.settings-system__recents-empty');

    function renderInfo(info) {
      const fw = formatFirmware(info && info.firmwareVersion);
      firmwareEl.textContent = fw || '—';
    }

    function renderMac(network, info) {
      // Prefer the active interface's MAC (matches what Network shows);
      // fall back to /info's deviceID if /networkInfo hasn't landed yet.
      const raw = (network && network.macAddress) || (info && info.deviceID) || '';
      macEl.textContent = formatMac(raw) || '—';
    }

    function renderCapabilities(caps) {
      capsEl.textContent = '';
      if (!caps) return;
      const flags = CAP_FLAGS.filter((f) => caps[f.key]);
      const named = Array.isArray(caps.capabilities) ? caps.capabilities : [];
      if (flags.length === 0 && named.length === 0) {
        const li = document.createElement('li');
        li.className = 'settings-system__caps-empty';
        li.textContent = 'No capabilities reported';
        capsEl.appendChild(li);
        return;
      }
      for (const f of flags) {
        const li = document.createElement('li');
        li.textContent = f.label;
        capsEl.appendChild(li);
      }
      for (const c of named) {
        const li = document.createElement('li');
        li.textContent = c.name;
        capsEl.appendChild(li);
      }
    }

    function renderRecents(recents) {
      recentsEl.textContent = '';
      const list = Array.isArray(recents) ? recents.slice(0, 5) : [];
      if (list.length === 0) {
        recentsEl.hidden = true;
        recentsEmptyEl.hidden = false;
        return;
      }
      for (const r of list) {
        const li = document.createElement('li');
        li.className = 'settings-system__recent';

        const sid = r.source === 'TUNEIN' ? tuneinStationId(r.location) : null;
        const labelText = r.itemName || r.location || r.source || '(unknown)';
        if (sid) {
          const a = document.createElement('a');
          a.href = `#/station/${sid}`;
          a.textContent = labelText;
          li.appendChild(a);
        } else {
          li.textContent = labelText;
        }

        if (r.source) {
          const tag = document.createElement('span');
          tag.className = 'settings-system__recent-source';
          tag.textContent = r.source;
          li.appendChild(tag);
        }
        recentsEl.appendChild(li);
      }
      recentsEl.hidden = false;
      recentsEmptyEl.hidden = true;
    }

    // Capabilities don't change at runtime, so fetch once on mount and
    // stash on store.speaker.capabilities for any later subscriber.
    (async () => {
      const cached = store.state.speaker.capabilities;
      if (cached) {
        renderCapabilities(cached);
        return;
      }
      try {
        const caps = await getCapabilities();
        if (env.signal.aborted) return;
        store.update('speaker', (s) => { s.speaker.capabilities = caps; });
      } catch (_err) {
        // Non-fatal — leave the row empty.
      }
    })();

    renderInfo(store.state.speaker.info);
    renderMac(store.state.speaker.network, store.state.speaker.info);
    renderCapabilities(store.state.speaker.capabilities);
    renderRecents(store.state.speaker.recents);

    return {
      speaker(state) {
        renderInfo(state.speaker.info);
        renderMac(state.speaker.network, state.speaker.info);
        renderCapabilities(state.speaker.capabilities);
        renderRecents(state.speaker.recents);
      },
    };
  },
});
