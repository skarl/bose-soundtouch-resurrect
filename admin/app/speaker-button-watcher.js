// Speaker-button watcher. Subscribes to the store and fires "pressed on
// speaker" toasts when play/pause, source, or volume change in ways that
// don't match a recent ledger entry (i.e. the change originated on the
// hardware, not from the admin UI).
//
// Coupling here is to the store and the action ledger, not to the
// socket — keeping this separate from ws.js lets it be unit-tested with
// a fake store and makes the ws driver smaller.

import { ledgerKindForEventTag } from './speaker-state.js';
import { showToast } from './toast.js';
import { wasRecent } from './actions/index.js';

const SOURCE_KIND = ledgerKindForEventTag('sourcesUpdated');
const VOLUME_KIND = ledgerKindForEventTag('volumeUpdated');

const VOL_TOAST_COOLDOWN = 1500;

let watch = makeWatch();
let unsubscribe = null;

function makeWatch() {
  return {
    prevPlayStatus: null,
    prevSource:     null,
    prevVolume:     null,
    volToastTs:     0,
  };
}

function onSpeakerChange(state) {
  const np  = state.speaker.nowPlaying;
  const vol = state.speaker.volume;

  // --- play/pause change ---
  const ps = np && np.playStatus;
  if (ps !== watch.prevPlayStatus) {
    if (watch.prevPlayStatus !== null && (ps === 'PLAY_STATE' || ps === 'PAUSE_STATE')) {
      if (!wasRecent('transport')) {
        showToast('Play/Pause pressed on speaker');
      }
    }
    watch.prevPlayStatus = ps;
  }

  // --- source / selection change ---
  // Use source + item location as a compound key to distinguish preset changes.
  const sourceKey = np && np.source && np.source !== 'STANDBY'
    ? `${np.source}:${(np.item && np.item.location) || ''}`
    : null;
  if (sourceKey !== null && sourceKey !== watch.prevSource) {
    if (watch.prevSource !== null && !wasRecent(SOURCE_KIND) && !wasRecent('preset')) {
      showToast('Source switched on speaker');
    }
    watch.prevSource = sourceKey;
  } else if (sourceKey !== null) {
    watch.prevSource = sourceKey;
  }

  // --- volume change ---
  const av = vol && vol.actualVolume;
  if (typeof av === 'number' && av !== watch.prevVolume) {
    if (watch.prevVolume !== null && !wasRecent(VOLUME_KIND)) {
      const delta = Math.abs(av - watch.prevVolume);
      if (delta > 1) {
        const now = Date.now();
        if (now - watch.volToastTs > VOL_TOAST_COOLDOWN) {
          showToast('Volume changed on speaker');
          watch.volToastTs = now;
        }
      }
    }
    watch.prevVolume = av;
  }
}

export function attach(store) {
  if (unsubscribe) return;
  if (!store || typeof store.subscribe !== 'function') return;
  watch = makeWatch();
  const ret = store.subscribe('speaker', onSpeakerChange);
  // Some stores return an unsubscribe fn, others ignore the return.
  unsubscribe = typeof ret === 'function' ? ret : () => {};
}

export function detach() {
  if (unsubscribe) {
    try { unsubscribe(); } catch (_err) { /* noop */ }
    unsubscribe = null;
  }
  watch = makeWatch();
}
