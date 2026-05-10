import {
  speakerKey,
  postSelect,
  postSelectLocalSource,
  postName,
  postSystemTimeout,
  postStandby,
  postSetPower,
  postDSPMonoStereo,
  presetsAssign,
  previewStream as apiPreviewStream,
  postEnterBluetoothPairing,
  postClearBluetoothPaired,
} from '../api.js';
import { recordOutgoing, wasRecent } from './ledger.js';
import { controllerFor, volumeCtl, bassCtl, balanceCtl } from './sliders.js';

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

export async function standby() {
  recordOutgoing('transport');
  await postStandby();
}

export async function setPower(state) {
  recordOutgoing('transport');
  await postSetPower(state);
}

export async function enterBluetoothPairing() {
  recordOutgoing('bluetooth');
  await postEnterBluetoothPairing();
}

export async function clearBluetoothPaired() {
  recordOutgoing('bluetooth');
  await postClearBluetoothPaired();
}

export { wasRecent };

export function hasPending(kind) {
  const ctl = controllerFor(kind);
  return ctl ? ctl.hasPending() : false;
}

export function _confirmSlider(kind, actualValue) {
  const ctl = controllerFor(kind);
  if (ctl) ctl.confirm(actualValue);
}
