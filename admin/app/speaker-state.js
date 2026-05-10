// Speaker field registry. Owns the *what*: which speaker fields exist,
// how to fetch them (fetcher), how to parse them from a WS event (parseInline),
// how to apply them to state, and optional side-effects (afterApply).
//
// ws.js keeps the *how*: WebSocket lifecycle, reconnect, polling timer,
// and top-level XML routing.
//
// reconcile() and dispatch() mutate state.speaker[name] directly (not via
// store.update()) and call store.touch('speaker') once at the end so
// subscribers see one notification per cycle rather than one per field.

import {
  getSpeakerInfo,
  getNowPlaying,
  presetsList,
  getVolume,
  getSources,
  getNetworkInfo,
  getSystemTimeout,
  getBluetoothInfo,
  getBass,
  getBalance,
  getDSPMonoStereo,
  getRecents,
  getZone,
} from './api.js';
import {
  parseNowPlayingEl,
  parseVolumeEl,
  parseSourcesEl,
  parseBassEl,
  parseBalanceEl,
  parseRecentsEl,
  parseZoneEl,
} from './speaker-xml.js';
import { controllerFor as sliderControllerFor } from './sliders.js';

// Field entry shape:
//   name        — key in state.speaker
//   fetcher     — () => Promise<value>
//   eventTag?   — child tag inside <updates> that carries this field's event
//   parseInline — (el) => value | null. Null means hint-only: fall back to fetcher().
//   apply?      — (state, value) => void. Default: state.speaker[name] = value
//                 Slider fields (volume/bass/balance) delegate to the slider
//                 controller, which owns the apply-merge + confirm in one place.
export const FIELDS = [
  {
    name: 'info',
    fetcher: getSpeakerInfo,
    // No WS event for info — fetch-only.
  },
  {
    name: 'nowPlaying',
    fetcher: getNowPlaying,
    eventTag: 'nowPlayingUpdated',
    parseInline(el) {
      const nps = el.getElementsByTagName('nowPlaying');
      return nps && nps[0] ? parseNowPlayingEl(nps[0]) : null;
    },
  },
  {
    name: 'presets',
    fetcher: presetsList,
    eventTag: 'presetsUpdated',
    // Hint-only on Bo's firmware — no inline payload.
    parseInline() { return null; },
    // fetcher returns {ok, data} envelope rather than a bare value.
    apply(state, env) {
      if (env && env.ok && Array.isArray(env.data)) {
        state.speaker.presets = env.data;
      }
    },
  },
  {
    name: 'volume',
    fetcher: getVolume,
    eventTag: 'volumeUpdated',
    parseInline(el) {
      const vols = el.getElementsByTagName('volume');
      return vols && vols[0] ? parseVolumeEl(vols[0]) : null;
    },
    apply(state, value) { sliderControllerFor('volume').applyIncoming(state, value); },
  },
  {
    name: 'sources',
    fetcher: getSources,
    eventTag: 'sourcesUpdated',
    // Hint-only on Bo's firmware — no inline sources list.
    parseInline(el) {
      const lists = el.getElementsByTagName('sources');
      return lists && lists[0] ? parseSourcesEl(lists[0]) : null;
    },
  },
  // Settings-section fields wired by their respective sub-views.
  {
    name: 'bass',
    fetcher: getBass,
    eventTag: 'bassUpdated',
    parseInline(el) {
      const els = el.getElementsByTagName('bass');
      return els && els[0] ? parseBassEl(els[0]) : null;
    },
    apply(state, value) { sliderControllerFor('bass').applyIncoming(state, value); },
  },
  {
    name: 'balance',
    fetcher: getBalance,
    eventTag: 'balanceUpdated',
    parseInline(el) {
      const els = el.getElementsByTagName('balance');
      return els && els[0] ? parseBalanceEl(els[0]) : null;
    },
    apply(state, value) { sliderControllerFor('balance').applyIncoming(state, value); },
  },
  { name: 'dspMonoStereo', fetcher: getDSPMonoStereo },
  {
    name: 'zone',
    fetcher: getZone,
    eventTag: 'zoneUpdated',
    parseInline(el) {
      const zones = el.getElementsByTagName('zone');
      return zones && zones[0] ? parseZoneEl(zones[0]) : null;
    },
  },
  { name: 'bluetooth',     fetcher: getBluetoothInfo },
  // No reliable WS event for /networkInfo — connectionStateUpdated
  // covers the Wi-Fi flap separately (state.ws). Refetched on settings
  // view-entry; user-driven via the section's Refresh button.
  { name: 'network',       fetcher: getNetworkInfo },
  {
    name: 'recents',
    fetcher: getRecents,
    eventTag: 'recentsUpdated',
    parseInline(el) {
      const lists = el.getElementsByTagName('recents');
      return lists && lists[0] ? parseRecentsEl(lists[0]) : null;
    },
  },
  { name: 'systemTimeout',   fetcher: getSystemTimeout },
];

// Build a lookup map from eventTag → entry for dispatch().
const BY_TAG = new Map(FIELDS.filter((f) => f.eventTag).map((f) => [f.eventTag, f]));

// Apply a value to state using the entry's custom apply or the default.
function applyEntry(entry, state, value) {
  if (entry.apply) {
    entry.apply(state, value);
  } else {
    state.speaker[entry.name] = value;
  }
}

// Fetch all fields in parallel, apply fulfilled results, notify once.
// Partial failures are non-fatal — other fields still apply.
export async function reconcile(store) {
  const results = await Promise.allSettled(FIELDS.map((f) => f.fetcher()));
  for (let i = 0; i < FIELDS.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || r.value == null) continue;
    applyEntry(FIELDS[i], store.state, r.value);
  }
  store.touch('speaker');
}

// Dispatch a single child element of <updates> to the matching field.
// Calls store.touch('speaker') once per WS event.
export async function dispatch(envelopeChild, store) {
  const tag = envelopeChild.tagName;
  const entry = BY_TAG.get(tag);
  if (!entry) return;

  const inline = entry.parseInline ? entry.parseInline(envelopeChild) : null;
  if (inline != null) {
    applyEntry(entry, store.state, inline);
    store.touch('speaker');
  } else {
    // Hint-only: no inline data — fall back to fetcher().
    let value;
    try {
      value = await entry.fetcher();
    } catch (_err) {
      return;
    }
    if (value == null) return;
    applyEntry(entry, store.state, value);
    store.touch('speaker');
  }
}
