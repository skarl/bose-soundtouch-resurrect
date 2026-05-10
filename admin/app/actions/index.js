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

export async function selectSource(contentItem) {
  recordOutgoing('source');
  await postSelect(contentItem);
}

export async function selectLocalSource(name) {
  recordOutgoing('source');
  await postSelectLocalSource(name);
}

export async function selectPreset(slot, contentItem) {
  recordOutgoing('preset', slot);
  await postSelect(contentItem);
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
