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
import { ledgerKindForField } from '../speaker-state.js';
import { runOptimistic } from '../optimistic.js';

// Hardware-key kinds aren't fields — 'preset' and 'transport' have no FIELDS
// row, so the mapping stays here.
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
  recordOutgoing(ledgerKindForField('dspMonoStereo'));
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
//
// Optimistic: rewrites `nowPlaying.source` eagerly so the active pill
// flips under the user's finger. On POST rejection the previous
// nowPlaying is restored and an error toast is surfaced. The matching
// <nowPlayingUpdated> / <sourcesUpdated> WS event reconciles on success
// via the normal dispatch pipeline.
export async function selectSource(src) {
  if (!src || !src.source) return;
  recordOutgoing(ledgerKindForField('sources'));
  await runOptimistic({
    snapshot: () => store.state.speaker.nowPlaying,
    apply: () => {
      const prev = store.state.speaker.nowPlaying || {};
      store.state.speaker.nowPlaying = {
        ...prev,
        source: src.source,
        sourceAccount: src.sourceAccount || '',
        // Clear track-level metadata so the pre-existing title/artist
        // doesn't flash next to the new source pill while the speaker
        // catches up. The next nowPlayingUpdated will repopulate.
        item: null,
        track: '',
        artist: '',
        art: '',
      };
    },
    post: () => src.isLocal
      ? postSelectLocalSource(src.source)
      : postSelect({ source: src.source, sourceAccount: src.sourceAccount || '' }),
    rollback: (prev) => { store.state.speaker.nowPlaying = prev; },
    errorMessage: `Couldn’t switch to ${src.displayName || src.source}`,
  });
}

// Recall a stored preset by its 1-based user-facing slot number (1..6).
// Reads the parsed preset from state and POSTs `/select` with the
// preset's stored ContentItem — Bo's firmware silently ignores
// `/key PRESET_N` and 400s on `/selectPreset`. Returns silently when
// the slot is empty or missing so callers don't need to pre-check.
//
// Optimistic: rewrites `nowPlaying` with a synthetic record carrying
// the preset's contentItem fields so the active-preset highlight in
// the grid flips immediately. On POST rejection the previous
// nowPlaying is restored and an error toast is surfaced.
export async function playPreset(slot) {
  const idx = Number(slot) - 1;
  if (!Number.isInteger(idx) || idx < 0) return;
  const presets = store.state.speaker.presets;
  const p = presets && presets[idx];
  if (!p || p.empty) return;
  recordOutgoing('preset', slot);
  await runOptimistic({
    snapshot: () => store.state.speaker.nowPlaying,
    apply: () => {
      const prev = store.state.speaker.nowPlaying || {};
      store.state.speaker.nowPlaying = {
        ...prev,
        source:        p.source,
        sourceAccount: p.sourceAccount || '',
        item: {
          source:        p.source,
          sourceAccount: p.sourceAccount || '',
          type:          p.type || '',
          location:      p.location || '',
          name:          p.itemName || '',
        },
        track:  '',
        artist: '',
        art:    typeof p.art === 'string' ? p.art : '',
      };
    },
    post: () => postSelect({
      source:        p.source,
      sourceAccount: p.sourceAccount || '',
      type:          p.type || '',
      location:      p.location || '',
    }),
    rollback: (prev) => { store.state.speaker.nowPlaying = prev; },
    errorMessage: `Preset ${slot} failed`,
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
  recordOutgoing(ledgerKindForField('bluetooth'));
  await postEnterBluetoothPairing();
}

export async function clearBluetoothPaired() {
  recordOutgoing(ledgerKindForField('bluetooth'));
  await postClearBluetoothPaired();
}

export async function setZone(zone) {
  recordOutgoing(ledgerKindForField('zone'));
  await postSetZone(zone);
}

export async function addZoneSlave(zone) {
  recordOutgoing(ledgerKindForField('zone'));
  await postAddZoneSlave(zone);
}

export async function removeZoneSlave(zone) {
  recordOutgoing(ledgerKindForField('zone'));
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
