// see also: optimistic.js — discrete actions use that path instead
// Slider merge contract. A slider field is a value the speaker owns
// (actualXxx) and a target the user is dragging toward (targetXxx). The
// controller mediates between three event streams without yanking the
// thumb:
//   - set(level)            — local drag. Writes targetXxx optimistically,
//                             POSTs leading + trailing-coalesced.
//   - applyIncoming(state, value) — WS-derived value. When a POST is
//                             pending, keep our local targetXxx (the
//                             speaker's view is stale); otherwise accept
//                             the value verbatim. Either way, confirm
//                             actualXxx so a matching follow-up set() is
//                             a no-op.
//   - confirm(actualValue)  — gate against re-POSTing the level we are
//                             already at.
// hasPending() is the source of truth for "user is mid-drag" — every
// transitional state (in-flight POST, queued trailing edge) reports true.

import { store } from './state.js';
import { postVolume, postBass, postBalance } from './api.js';
import { recordOutgoing } from './actions/ledger.js';

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

  function hasPending() {
    return inFlight || queued !== null;
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

    hasPending,

    // Reconcile an incoming WS value into state.speaker[field]. While the
    // user has a queued/in-flight command, the speaker's targetXxx in the
    // event may still reflect the previous level — overwriting would yank
    // the slider thumb back. Keep our eager targetXxx; only update what
    // the speaker uniquely owns. Then confirm the actual value so a
    // matching follow-up set() is gated as a no-op.
    applyIncoming(state, value) {
      if (!value) return;
      const prev = state.speaker[field];
      if (prev && hasPending()) {
        state.speaker[field] = {
          ...value,
          [targetProp]: prev[targetProp],
        };
      } else {
        state.speaker[field] = value;
      }
      const actualKey = `actual${field[0].toUpperCase()}${field.slice(1)}`;
      if (value[actualKey] != null) confirmed = value[actualKey];
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
