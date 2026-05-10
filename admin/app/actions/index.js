import {
  speakerKey,
  postSelect,
  postSelectLocalSource,
  postName,
  postSystemTimeout,
  postDSPMonoStereo,
  presetsAssign,
  previewStream as apiPreviewStream,
  postEnterBluetoothPairing,
  postClearBluetoothPaired,
  postRefreshAll,
  postSetZone,
  postAddZoneSlave,
  postRemoveZoneSlave,
} from '../api.js';
import { store } from '../state.js';
import { recordOutgoing, wasRecent } from './ledger.js';
import { controllerFor, volumeCtl, bassCtl, balanceCtl } from '../sliders.js';

function kindForKey(key) {
  if (/^PRESET_\d+$/.test(key)) return 'preset';
  return 'transport';
}

export function setVolume(level)  { volumeCtl.set(level); }
export function adjustVolume(delta) { volumeCtl.adjust(delta); }
export function toggleMute() { return pressKey('MUTE'); }

export function setBass(level)    { bassCtl.set(level); }
export function setBalance(level) { balanceCtl.set(level); }

export async function setDSPMonoStereo(mode) {
  recordOutgoing('dspMonoStereo');
  await postDSPMonoStereo(mode);
}

export async function pressKey(name) {
  recordOutgoing(kindForKey(name));
  await speakerKey(name, 'press');
  await speakerKey(name, 'release');
}

// Switch to a source from `state.speaker.sources`. Branches on the
// source's `isLocal` flag — local sources (AUX, BLUETOOTH) take a name
// via `/selectLocalSource`; streaming sources take a ContentItem via
// `/select`. Accepts the whole source object so callers don't need to
// know the wire shape.
export async function selectSource(src) {
  if (!src || !src.source) return;
  recordOutgoing('source');
  if (src.isLocal) {
    await postSelectLocalSource(src.source);
  } else {
    await postSelect({
      source: src.source,
      sourceAccount: src.sourceAccount || '',
    });
  }
}

// Recall a stored preset by its 1-based user-facing slot number (1..6).
// Reads the parsed preset from state and POSTs `/select` with the
// preset's stored ContentItem — Bo's firmware silently ignores
// `/key PRESET_N` and 400s on `/selectPreset`. Returns silently when
// the slot is empty or missing so callers don't need to pre-check.
export async function playPreset(slot) {
  const idx = Number(slot) - 1;
  if (!Number.isInteger(idx) || idx < 0) return;
  const presets = store.state.speaker.presets;
  const p = presets && presets[idx];
  if (!p || p.empty) return;
  recordOutgoing('preset', slot);
  await postSelect({
    source:        p.source,
    sourceAccount: p.sourceAccount || '',
    type:          p.type || '',
    location:      p.location || '',
  });
}

export async function storePreset(slot, payload) {
  return presetsAssign(slot, payload);
}

export async function previewStream(payload) {
  return apiPreviewStream(payload);
}

export async function setName(name) {
  recordOutgoing('settings');
  await postName(name);
}

export async function setSystemTimeout(seconds) {
  recordOutgoing('settings');
  await postSystemTimeout(seconds);
}

export async function enterBluetoothPairing() {
  recordOutgoing('bluetooth');
  await postEnterBluetoothPairing();
}

export async function clearBluetoothPaired() {
  recordOutgoing('bluetooth');
  await postClearBluetoothPaired();
}

export async function setZone(zone) {
  recordOutgoing('zone');
  await postSetZone(zone);
}

export async function addZoneSlave(zone) {
  recordOutgoing('zone');
  await postAddZoneSlave(zone);
}

export async function removeZoneSlave(zone) {
  recordOutgoing('zone');
  await postRemoveZoneSlave(zone);
}

export async function refreshAll() {
  recordOutgoing('settings');
  return postRefreshAll();
}

export { wasRecent };

export function hasPending(kind) {
  const ctl = controllerFor(kind);
  return ctl ? ctl.hasPending() : false;
}
