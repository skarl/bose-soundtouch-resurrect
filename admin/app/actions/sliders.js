import { store } from '../state.js';
import { postVolume, postBass, postBalance } from '../api.js';
import { recordOutgoing } from './ledger.js';

export function makeSliderController({ field, postFn, eventTag, targetProperty }) {
  const targetProp = targetProperty ?? `target${field[0].toUpperCase()}${field.slice(1)}`;
  let inFlight  = false;
  let queued    = null;
  let confirmed = null;

  async function flush(level) {
    inFlight = true;
    recordOutgoing(eventTag);
    try {
      await postFn(level);
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
    field,

    set(level) {
      store.update('speaker', (st) => {
        if (st.speaker[field] == null) return;
        st.speaker[field][targetProp] = level;
      });
      if (confirmed !== null && level === confirmed) return;
      if (inFlight) {
        queued = level;
        return;
      }
      flush(level);
    },

    adjust(delta) {
      const cur = store.state.speaker[field]?.[targetProp] ?? 0;
      const next = Math.max(0, Math.min(100, cur + delta));
      this.set(next);
    },

    confirm(actualValue) {
      confirmed = actualValue;
    },

    hasPending() {
      return inFlight || queued !== null;
    },
  };
}

const _volumeCtl  = makeSliderController({ field: 'volume',  postFn: postVolume,  eventTag: 'volume'  });
const _bassCtl    = makeSliderController({ field: 'bass',    postFn: postBass,    eventTag: 'bass',    targetProperty: 'targetBass'    });
const _balanceCtl = makeSliderController({ field: 'balance', postFn: postBalance, eventTag: 'balance', targetProperty: 'targetBalance' });

const BY_KIND = new Map([
  ['volume',  _volumeCtl],
  ['bass',    _bassCtl],
  ['balance', _balanceCtl],
]);

export function controllerFor(kind) {
  return BY_KIND.get(kind) || null;
}

export const volumeCtl  = _volumeCtl;
export const bassCtl    = _bassCtl;
export const balanceCtl = _balanceCtl;
