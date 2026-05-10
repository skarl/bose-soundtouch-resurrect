// system — settings sub-view: firmware, model, device ID, MAC,
// capabilities, recents, resolver pill, refresh-stream-URLs button, and
// a 50-entry WS activity log.
//
// state.speaker.info is populated by speaker-state.js (no WS event).
// state.speaker.recents is the speaker's recently-played list, kept
// fresh by the recentsUpdated WS event.
// state.ws.recentEvents is a FIFO ring of every inbound WS frame
// (most-recent first); ws.js owns appending, this view just renders.

import { html, mount, defineView } from '../../dom.js';
import { getCapabilities } from '../../api.js';
import * as actions from '../../actions/index.js';
import { pill } from '../../components.js';

function formatMac(mac) {
  if (typeof mac !== 'string') return '';
  const hex = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 12) return mac;
  return hex.match(/.{2}/g).join(':');
}

// `/v1/playback/station/s12345` → "s12345" (TUNEIN station IDs).
function tuneinStationId(location) {
  if (typeof location !== 'string') return null;
  const m = location.match(/\/station\/(s\d+)$/);
  return m ? m[1] : null;
}

// Boolean-shaped capability flags get human-readable labels; the
// freeform <capabilities><capability name=…> list is appended after.
const CAP_FLAGS = [
  { key: 'dspMonoStereo',      label: 'Mono/Stereo DSP' },
  { key: 'lrStereoCapable',    label: 'L/R stereo pair' },
  { key: 'bcoresetCapable',    label: 'BCO reset' },
  { key: 'disablePowerSaving', label: 'Power-saving toggle' },
  { key: 'lightswitch',        label: 'Light switch' },
  { key: 'clockDisplay',       label: 'Clock display' },
];

function formatTs(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '';
  const d = new Date(ts);
  // HH:MM:SS.mmm — local time, fixed-width for the mono log.
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// The resolver lives behind the same admin httpd as this SPA, on
// localhost:8181 from the speaker's perspective. We don't probe it —
// rendering "RUNNING" reflects the deploy contract, not a live status.
const RESOLVER_PORT = 8181;

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-system" data-section="system">
        <div class="settings-row">
          <span class="settings-row__label">Firmware</span>
          <span class="settings-row__control mono settings-system__firmware">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">Model</span>
          <span class="settings-row__control settings-system__model">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">Device ID</span>
          <span class="settings-row__control mono settings-system__deviceid">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">MAC address</span>
          <span class="settings-row__control mono settings-system__mac">—</span>
        </div>
        <div class="settings-row settings-row--wrap">
          <span class="settings-row__label">Capabilities</span>
          <span class="settings-row__control mono settings-system__caps">—</span>
        </div>
        <div class="settings-row settings-row--wrap">
          <span class="settings-row__label">Recents</span>
          <span class="settings-row__control settings-system__recents">—</span>
        </div>
        <div class="settings-row">
          <span class="settings-row__label">Resolver</span>
          <span class="settings-row__control settings-system__resolver"></span>
        </div>

        <div class="settings-actions">
          <button class="settings-btn settings-system__refresh-btn" type="button">
            Refresh stream URLs
          </button>
          <span class="settings-system__refresh-spinner" hidden aria-hidden="true"></span>
        </div>
        <div class="settings-system__refresh-result" hidden></div>

        <details class="settings-system__ws-log ws-log">
          <summary class="ws-log__summary">WebSocket activity</summary>
          <ol class="ws-log__list" aria-live="off"></ol>
          <p class="ws-log__empty" hidden>No events received yet.</p>
        </details>
      </div>
    `);

    const firmwareEl    = root.querySelector('.settings-system__firmware');
    const modelEl       = root.querySelector('.settings-system__model');
    const macEl         = root.querySelector('.settings-system__mac');
    const devIdEl       = root.querySelector('.settings-system__deviceid');
    const capsEl        = root.querySelector('.settings-system__caps');
    const recentsEl     = root.querySelector('.settings-system__recents');
    const resolverEl    = root.querySelector('.settings-system__resolver');
    const refreshBtn    = root.querySelector('.settings-system__refresh-btn');
    const refreshSpinner = root.querySelector('.settings-system__refresh-spinner');
    const refreshResult = root.querySelector('.settings-system__refresh-result');
    const wsLogList     = root.querySelector('.ws-log__list');
    const wsLogEmpty    = root.querySelector('.ws-log__empty');

    // Resolver pill is built once and updated only if we ever start
    // probing health (we don't today).
    const resolverPill = pill({ tone: 'live', pulse: true, text: 'RUNNING' });
    const resolverPort = document.createElement('span');
    resolverPort.className = 'mono';
    resolverPort.textContent = `:${RESOLVER_PORT}`;
    resolverEl.appendChild(resolverPill);
    resolverEl.appendChild(resolverPort);

    function renderInfo(info) {
      const fw = (info && info.firmwareVersion) || '';
      firmwareEl.textContent = fw.trim() || '—';
      modelEl.textContent = (info && info.type) || '—';
      devIdEl.textContent = (info && info.deviceID) || '—';
    }

    function renderMac(network, info) {
      const raw = (network && network.macAddress) || (info && info.deviceID) || '';
      macEl.textContent = formatMac(raw) || '—';
    }

    function renderCapabilities(caps) {
      if (!caps) {
        capsEl.textContent = '—';
        return;
      }
      const flags = CAP_FLAGS.filter((f) => caps[f.key]).map((f) => f.label);
      const named = Array.isArray(caps.capabilities)
        ? caps.capabilities.map((c) => c.name).filter(Boolean)
        : [];
      const all = [...flags, ...named];
      capsEl.textContent = all.length === 0 ? '—' : all.join(', ');
    }

    function renderRecents(recents) {
      recentsEl.textContent = '';
      const list = Array.isArray(recents) ? recents.slice(0, 5) : [];
      if (list.length === 0) {
        recentsEl.classList.add('settings-muted');
        recentsEl.textContent = 'No recent items';
        return;
      }
      recentsEl.classList.remove('settings-muted');
      const ol = document.createElement('ol');
      ol.className = 'settings-system__recents-list';
      for (const r of list) {
        const li = document.createElement('li');
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
        ol.appendChild(li);
      }
      recentsEl.appendChild(ol);
    }

    function renderWsLog(events) {
      const list = Array.isArray(events) ? events : [];
      wsLogList.textContent = '';
      if (list.length === 0) {
        wsLogList.hidden = true;
        wsLogEmpty.hidden = false;
        return;
      }
      for (const e of list) {
        const li = document.createElement('li');
        li.className = 'ws-log__item';

        const ts = document.createElement('span');
        ts.className = 'ws-log__ts';
        ts.textContent = formatTs(e.ts);

        const tag = document.createElement('span');
        tag.className = 'ws-log__tag';
        tag.textContent = e.tag || '(no tag)';

        li.appendChild(ts);
        li.appendChild(tag);
        wsLogList.appendChild(li);
      }
      wsLogList.hidden = false;
      wsLogEmpty.hidden = true;
    }

    function renderRefreshResult(envelope) {
      refreshResult.textContent = '';
      refreshResult.hidden = false;

      if (!envelope || envelope.ok !== true || !envelope.data) {
        const p = document.createElement('p');
        p.className = 'settings-system__refresh-error';
        const msg = envelope && envelope.error && envelope.error.message
          ? envelope.error.message
          : 'Refresh failed';
        p.textContent = msg;
        refreshResult.appendChild(p);
        return;
      }

      const d = envelope.data;
      const updated   = Array.isArray(d.updated)   ? d.updated   : [];
      const unchanged = Array.isArray(d.unchanged) ? d.unchanged : [];
      const failed    = Array.isArray(d.failed)    ? d.failed    : [];

      const summary = document.createElement('p');
      summary.className = 'settings-system__refresh-summary';
      summary.textContent =
        `${updated.length} updated, ${unchanged.length} unchanged, ${failed.length} failed`;
      refreshResult.appendChild(summary);

      const dl = document.createElement('dl');
      dl.className = 'settings-system__refresh-rows';

      function row(label, items) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        dl.appendChild(dt);
        const dd = document.createElement('dd');
        if (items.length === 0) {
          dd.textContent = '—';
        } else if (typeof items[0] === 'string') {
          dd.textContent = items.join(', ');
        } else {
          for (const f of items) {
            const div = document.createElement('div');
            div.className = 'settings-system__refresh-fail';
            div.textContent = `${f.sid}: ${f.error}`;
            dd.appendChild(div);
          }
        }
        dl.appendChild(dd);
      }
      row('Updated',   updated);
      row('Unchanged', unchanged);
      row('Failed',    failed);

      refreshResult.appendChild(dl);
    }

    refreshBtn.addEventListener('click', async () => {
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      refreshSpinner.hidden = false;
      refreshResult.hidden = true;
      try {
        const envelope = await actions.refreshAll();
        if (env.signal.aborted) return;
        renderRefreshResult(envelope);
      } catch (err) {
        if (env.signal.aborted) return;
        renderRefreshResult({
          ok: false,
          error: { message: err && err.message ? err.message : 'Refresh failed' },
        });
      } finally {
        refreshBtn.disabled = false;
        refreshSpinner.hidden = true;
      }
    });

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
        // Non-fatal — leave the row at em-dash.
      }
    })();

    renderInfo(store.state.speaker.info);
    renderMac(store.state.speaker.network, store.state.speaker.info);
    renderCapabilities(store.state.speaker.capabilities);
    renderRecents(store.state.speaker.recents);
    renderWsLog(store.state.ws && store.state.ws.recentEvents);

    return {
      speaker(state) {
        renderInfo(state.speaker.info);
        renderMac(state.speaker.network, state.speaker.info);
        renderCapabilities(state.speaker.capabilities);
        renderRecents(state.speaker.recents);
      },
      ws(state) {
        renderWsLog(state.ws && state.ws.recentEvents);
      },
    };
  },
});
