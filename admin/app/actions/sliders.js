import { store } from '../state.js';
import { postVolume } from '../api.js';
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

const _volumeCtl  = makeSliderController({ field: 'volume',  postFn: postVolume,        eventTag: 'volume'  });
const _bassCtl    = makeSliderController({ field: 'bass',    postFn: _unimplemented('bass'),    eventTag: 'bass'    });
const _balanceCtl = makeSliderController({ field: 'balance', postFn: _unimplemented('balance'), eventTag: 'balance' });

const BY_KIND = new Map([
  ['volume',  _volumeCtl],
  ['bass',    _bassCtl],
  ['balance', _balanceCtl],
]);

function _unimplemented(name) {
  return async () => { throw new Error(`${name} POST not wired (lands in #34)`); };
}

export function controllerFor(kind) {
  return BY_KIND.get(kind) || null;
}

export const volumeCtl = _volumeCtl;
