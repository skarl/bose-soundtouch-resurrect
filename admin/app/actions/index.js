import {
  speakerKey,
  postSelect,
  postSelectLocalSource,
  presetsAssign,
  previewStream as apiPreviewStream,
} from '../api.js';
import { recordOutgoing, wasRecent } from './ledger.js';
import { controllerFor, volumeCtl } from './sliders.js';

function kindForKey(key) {
  if (/^PRESET_\d+$/.test(key)) return 'preset';
  return 'transport';
}

export function setVolume(level)  { volumeCtl.set(level); }
export function adjustVolume(delta) { volumeCtl.adjust(delta); }
export function toggleMute() { return pressKey('MUTE'); }

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

export { wasRecent };

export function hasPending(kind) {
  const ctl = controllerFor(kind);
  return ctl ? ctl.hasPending() : false;
}

export function _confirmSlider(kind, actualValue) {
  const ctl = controllerFor(kind);
  if (ctl) ctl.confirm(actualValue);
}
