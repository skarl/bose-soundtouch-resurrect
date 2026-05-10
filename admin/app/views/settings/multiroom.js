// multiroom — settings sub-view: zone state (master/member/standalone),
// member list with per-row remove, and an add-slave picker fed by the
// speaker's listMediaServers (filtered to Bose-marked entries).
//
// Master/member states are correct-by-construction — they read from
// state.speaker.zone, which the WS dispatch path keeps fresh on
// <zoneUpdated>. They cannot be exercised on a single-speaker setup.

import { html, mount, defineView } from '../../dom.js';
import { getZone, getListMediaServers } from '../../api.js';
import * as actions from '../../actions/index.js';

function speakerSelfDeviceID(state) {
  return (state.speaker.info && state.speaker.info.deviceID) || '';
}

function speakerSelfIp(state) {
  return (state.speaker.network && state.speaker.network.ipAddress) || '';
}

// The speaker's own /getZone response on the slave side names the
// master in attributes; on the master side, members include slaves only
// (master is implicit). Find a friendly name for the master (we know
// only a deviceID, so fall back to a short form of that).
function masterLabel(zone, state) {
  if (!zone || !zone.master) return '';
  const ownId = speakerSelfDeviceID(state);
  if (zone.master === ownId) return state.speaker.info ? state.speaker.info.name : 'this speaker';
  // Members may include the master (when the slave's /getZone echoes it back).
  const m = (zone.members || []).find((x) => x.deviceID === zone.master);
  if (m && m.ipAddress) return m.ipAddress;
  return zone.master;
}

export default defineView({
  mount(root, store, _ctx, env) {
    mount(root, html`
      <div class="settings-multiroom" data-section="multiroom">
        <p class="settings-multiroom__status">—</p>

        <ul class="settings-multiroom__members" hidden></ul>

        <div class="settings-multiroom__leave" hidden>
          <button class="settings-multiroom__leave-btn" type="button">Leave zone</button>
        </div>

        <div class="settings-multiroom__add">
          <label class="settings-multiroom__add-label" for="settings-multiroom-pick">Add speaker</label>
          <select class="settings-multiroom__add-pick" id="settings-multiroom-pick"></select>
          <button class="settings-multiroom__add-btn" type="button">Add</button>
          <p class="settings-multiroom__add-empty" hidden>No other SoundTouch speakers found on the network</p>
        </div>
      </div>
    `);

    const statusEl   = root.querySelector('.settings-multiroom__status');
    const membersEl  = root.querySelector('.settings-multiroom__members');
    const leaveWrap  = root.querySelector('.settings-multiroom__leave');
    const leaveBtn   = root.querySelector('.settings-multiroom__leave-btn');
    const addWrap    = root.querySelector('.settings-multiroom__add');
    const pickEl     = root.querySelector('.settings-multiroom__add-pick');
    const addBtn     = root.querySelector('.settings-multiroom__add-btn');
    const addEmptyEl = root.querySelector('.settings-multiroom__add-empty');

    let peers = [];

    function renderPicker() {
      pickEl.textContent = '';
      const memberMacs = new Set(
        ((store.state.speaker.zone && store.state.speaker.zone.members) || [])
          .map((m) => (m.deviceID || '').toUpperCase()),
      );
      const available = peers.filter((p) => !memberMacs.has((p.mac || '').toUpperCase()));
      if (available.length === 0) {
        pickEl.hidden = true;
        addBtn.hidden = true;
        addEmptyEl.hidden = false;
        return;
      }
      for (const p of available) {
        const opt = document.createElement('option');
        opt.value = p.mac || p.ip;
        opt.textContent = p.name + (p.ip ? ` (${p.ip})` : '');
        opt.dataset.ip = p.ip || '';
        opt.dataset.mac = p.mac || '';
        pickEl.appendChild(opt);
      }
      pickEl.hidden = false;
      addBtn.hidden = false;
      addEmptyEl.hidden = true;
    }

    function render(zone, state) {
      const isStandalone = !zone || !zone.master || zone.members.length === 0;
      const ownId = speakerSelfDeviceID(state);
      const isMember = zone && zone.master && !zone.isMaster && zone.master !== ownId;
      const isMaster = zone && zone.isMaster;

      membersEl.textContent = '';

      if (isStandalone) {
        statusEl.textContent = 'This speaker is not in a multi-room zone';
        membersEl.hidden = true;
        leaveWrap.hidden = true;
        addWrap.hidden = false;
        renderPicker();
        return;
      }

      if (isMember) {
        statusEl.textContent = `Joined to ${masterLabel(zone, state)}'s zone`;
        membersEl.hidden = true;
        leaveWrap.hidden = false;
        addWrap.hidden = true;
        return;
      }

      if (isMaster) {
        const slaves = zone.members.filter((m) => m.deviceID !== ownId);
        statusEl.textContent = `Master of ${slaves.length} ${slaves.length === 1 ? 'speaker' : 'speakers'}`;
        for (const m of slaves) {
          const li = document.createElement('li');
          li.className = 'settings-multiroom__member';

          const label = document.createElement('span');
          label.className = 'settings-multiroom__member-label';
          label.textContent = m.deviceID + (m.ipAddress ? ` (${m.ipAddress})` : '');
          li.appendChild(label);

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'settings-multiroom__member-remove';
          btn.textContent = 'Remove';
          btn.addEventListener('click', () => removeMember(m));
          li.appendChild(btn);

          membersEl.appendChild(li);
        }
        membersEl.hidden = false;
        leaveWrap.hidden = true;
        addWrap.hidden = false;
        renderPicker();
        return;
      }

      // Fallback — should be unreachable given the branches above.
      statusEl.textContent = '—';
      membersEl.hidden = true;
      leaveWrap.hidden = true;
      addWrap.hidden = true;
    }

    function findPeer(value) {
      return peers.find((p) => (p.mac && p.mac === value) || (p.ip && p.ip === value));
    }

    async function refreshZone() {
      try {
        const zone = await getZone();
        if (env.signal.aborted) return;
        store.update('speaker', (s) => { s.speaker.zone = zone; });
      } catch (_err) {
        // Network blip — retain prior render.
      }
    }

    async function refreshPeers() {
      try {
        const list = await getListMediaServers();
        if (env.signal.aborted) return;
        peers = Array.isArray(list) ? list : [];
        render(store.state.speaker.zone, store.state);
      } catch (_err) {
        peers = [];
        render(store.state.speaker.zone, store.state);
      }
    }

    addBtn.addEventListener('click', async () => {
      if (addBtn.disabled) return;
      const opt = pickEl.options[pickEl.selectedIndex];
      if (!opt) return;
      const peer = findPeer(opt.value);
      if (!peer) return;

      const zone = store.state.speaker.zone;
      const ownId = speakerSelfDeviceID(store.state);
      const ownIp = speakerSelfIp(store.state);
      const newMember = { deviceID: peer.mac, ipAddress: peer.ip };

      addBtn.disabled = true;
      try {
        if (zone && zone.isMaster) {
          await actions.addZoneSlave({ master: ownId, members: [newMember] });
        } else {
          await actions.setZone({
            master: ownId,
            senderIPAddress: ownIp,
            members: [newMember],
          });
        }
        await refreshZone();
      } catch (_err) {
        // Non-fatal; user can retry.
      } finally {
        addBtn.disabled = false;
      }
    });

    leaveBtn.addEventListener('click', async () => {
      if (leaveBtn.disabled) return;
      const zone = store.state.speaker.zone;
      if (!zone || !zone.master) return;
      const ownId = speakerSelfDeviceID(store.state);
      const ownIp = speakerSelfIp(store.state);

      leaveBtn.disabled = true;
      try {
        await actions.removeZoneSlave({
          master: zone.master,
          members: [{ deviceID: ownId, ipAddress: ownIp }],
        });
        await refreshZone();
      } catch (_err) {
        // Non-fatal.
      } finally {
        leaveBtn.disabled = false;
      }
    });

    async function removeMember(m) {
      const zone = store.state.speaker.zone;
      if (!zone) return;
      try {
        await actions.removeZoneSlave({
          master: zone.master,
          members: [{ deviceID: m.deviceID, ipAddress: m.ipAddress }],
        });
        await refreshZone();
      } catch (_err) {
        // Non-fatal.
      }
    }

    render(store.state.speaker.zone, store.state);
    if (store.state.speaker.zone == null) refreshZone();
    refreshPeers();

    return {
      speaker(state) { render(state.speaker.zone, state); },
    };
  },
});
