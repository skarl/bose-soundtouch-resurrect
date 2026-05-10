import { store } from './state.js';
import { postVolume } from './api.js';
import { postKey } from './transport.js';
import { setVolumeConfirmFn } from './speaker-state.js';
import { recordOutgoing } from './io-ledger.js';

export function makeVolumeController({ store: s, postVolume: postVol, postKey: postK }) {
  let inFlight  = false;
  let queued    = null;
  let confirmed = null;

  async function flush(level) {
    inFlight = true;
    recordOutgoing('volume');
    try {
      await postVol(level);
    } finally {
      inFlight = false;
      if (queued !== null) {
        const next = queued;
        queued = null;
        await flush(next);
      }
    }
  }

  return {
    set(level) {
      s.update('speaker', (st) => {
        if (st.speaker.volume == null) return;
        st.speaker.volume.targetVolume = level;
      });
      if (confirmed !== null && level === confirmed) return;
      if (inFlight) {
        queued = level;
        return;
      }
      flush(level);
    },

    adjust(delta) {
      const cur = s.state.speaker.volume?.targetVolume ?? 0;
      const next = Math.max(0, Math.min(100, cur + delta));
      this.set(next);
    },

    toggleMute() {
      postK('MUTE');
    },

    confirm(actualVolume) {
      confirmed = actualVolume;
    },
  };
}

export const volumeController = makeVolumeController({ store, postVolume, postKey });
setVolumeConfirmFn((v) => volumeController.confirm(v));
