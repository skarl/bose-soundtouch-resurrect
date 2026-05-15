// Speaker field registry. Owns the *what*: which speaker fields exist,
// where to fetch them (path), what tag carries the payload (tag), how to
// parse the resolved element (parseEl), how to apply the value to state
// (apply), and the matching WS envelope child tag (eventTag).
//
// One row = one field, end-to-end. REST reconcile goes through
// api.js#xmlGet(field) — fetch apiBase + path → DOMParser → first <tag>
// → parseEl. The WS dispatch path locates the same <tag> inside the
// <eventTag> envelope child and feeds it to the same parseEl, so REST
// and WS converge on a single parser per field.
//
// ws.js keeps the *how*: WebSocket lifecycle, reconnect, polling timer,
// and top-level XML routing.
//
// reconcile() and dispatch() mutate state.speaker[name] directly (not via
// store.update()) and call store.touch('speaker') once at the end so
// subscribers see one notification per cycle rather than one per field.

import {
  xmlGet,
  presetsList,
  favoritesList,
} from './api.js';
import {
  parseNowPlayingEl,
  parseInfoEl,
  parseVolumeEl,
  parseSourcesEl,
  parseBassEl,
  parseBalanceEl,
  parseDSPMonoStereoEl,
  parseRecentsEl,
  parseZoneEl,
  parseNetworkInfoEl,
  parseBluetoothInfoEl,
  parseSystemTimeoutEl,
} from './speaker-xml.js';
import { controllerFor as sliderControllerFor } from './sliders.js';

// Field entry shape:
//   name        — key in state.speaker
//   path        — REST endpoint (suffix of apiBase) for xmlGet
//   tag         — first descendant tag inside the response (or envelope
//                 child) whose element parseEl consumes
//   parseEl     — (el) => value | null. Converted from a DOM element to
//                 the field's domain shape. Shared between REST and WS.
//   eventTag?   — child tag inside <updates> that carries this field's
//                 WS event. Omitted for fetch-only fields (info,
//                 bluetooth, systemTimeout, dspMonoStereo).
//   apply?      — (state, value) => void. Default: state.speaker[name] = value.
//                 Slider fields (volume/bass/balance) delegate to the
//                 slider controller, which owns the apply-merge + confirm
//                 in one place.
//   ledgerKind? — kind string used by actions/ledger.js for toast
//                 attribution. Defaults to `name`. Set explicitly when
//                 the ledger vocabulary diverges from the field name
//                 (e.g. sources → 'source').
//
// Two rows behave slightly outside the pure {path, tag, parseEl} pattern:
//   presets — JSON envelope from the presets CGI; keeps a custom
//             `fetcher` and bypasses xmlGet entirely. The WS hint
//             (presetsUpdated) carries no inline payload, so dispatch
//             falls back to that same fetcher.
//   network — XML row with `eventTag: 'connectionStateUpdated'`. The
//             firmware fires `<connectionStateUpdated/>` (empty) on Wi-Fi
//             link flips (associate / deassociate / IP change / signal
//             threshold). The envelope has no inline payload, so dispatch
//             falls back to xmlGet via the row's path/tag/parseEl.
export const FIELDS = [
  {
    name: 'info',
    path: '/speaker/info',
    tag: 'info',
    parseEl: parseInfoEl,
    // No WS event for info — fetch-only.
  },
  {
    name: 'nowPlaying',
    path: '/speaker/now_playing',
    tag: 'nowPlaying',
    parseEl: parseNowPlayingEl,
    eventTag: 'nowPlayingUpdated',
  },
  {
    name: 'presets',
    // Exception: JSON envelope, not XML. Uses a custom `fetcher` and
    // skips xmlGet. WS event is hint-only — dispatch refetches.
    fetcher: presetsList,
    eventTag: 'presetsUpdated',
    apply(state, env) {
      if (env && env.ok && Array.isArray(env.data)) {
        state.speaker.presets = env.data;
      }
    },
  },
  {
    // favourites — admin-owned, disjoint from firmware presets. No WS
    // event (the speaker firmware doesn't know about favourites), so
    // reconciliation is fetch-only: on app boot and on visibility-change
    // to visible. The POST round-trip updates state optimistically from
    // the caller; the GET path is the floor in case another tab
    // mutated the list.
    // see also: docs/adr/0003-favourites-stay-fetch-only.md
    name: 'favorites',
    fetcher: favoritesList,
    apply(state, env) {
      if (env && env.ok && Array.isArray(env.data)) {
        state.speaker.favorites = env.data;
      }
    },
  },
  {
    name: 'volume',
    path: '/speaker/volume',
    tag: 'volume',
    parseEl: parseVolumeEl,
    eventTag: 'volumeUpdated',
    apply(state, value) { sliderControllerFor('volume').applyIncoming(state, value); },
  },
  {
    name: 'sources',
    path: '/speaker/sources',
    tag: 'sources',
    parseEl: parseSourcesEl,
    eventTag: 'sourcesUpdated',
    ledgerKind: 'source',
  },
  // Settings-section fields wired by their respective sub-views.
  {
    name: 'bass',
    path: '/speaker/bass',
    tag: 'bass',
    parseEl: parseBassEl,
    eventTag: 'bassUpdated',
    apply(state, value) { sliderControllerFor('bass').applyIncoming(state, value); },
  },
  {
    name: 'balance',
    path: '/speaker/balance',
    tag: 'balance',
    parseEl: parseBalanceEl,
    eventTag: 'balanceUpdated',
    apply(state, value) { sliderControllerFor('balance').applyIncoming(state, value); },
  },
  {
    name: 'dspMonoStereo',
    path: '/speaker/DSPMonoStereo',
    tag: 'DSPMonoStereo',
    parseEl: parseDSPMonoStereoEl,
  },
  {
    name: 'zone',
    path: '/speaker/getZone',
    tag: 'zone',
    parseEl: parseZoneEl,
    eventTag: 'zoneUpdated',
  },
  {
    name: 'bluetooth',
    path: '/speaker/bluetoothInfo',
    tag: 'BluetoothInfo',
    parseEl: parseBluetoothInfoEl,
  },
  // network: XML row + WS hint. /networkInfo has no native inline event
  // payload, but the firmware emits <connectionStateUpdated/> whenever
  // the Wi-Fi link flips (associate, deassociate, IP change, signal
  // threshold). The envelope is empty, so dispatch's parseInline returns
  // null and the dispatch path falls through to xmlGet — same effect as
  // the pre-refactor parseInline-returns-null pattern.
  {
    name: 'network',
    path: '/speaker/networkInfo',
    tag: 'networkInfo',
    parseEl: parseNetworkInfoEl,
    eventTag: 'connectionStateUpdated',
  },
  {
    name: 'recents',
    path: '/speaker/recents',
    tag: 'recents',
    parseEl: parseRecentsEl,
    eventTag: 'recentsUpdated',
  },
  {
    name: 'systemTimeout',
    path: '/speaker/systemtimeout',
    tag: 'systemtimeout',
    parseEl: parseSystemTimeoutEl,
  },
];

// Build a lookup map from eventTag → entry for dispatch().
const BY_TAG = new Map(FIELDS.filter((f) => f.eventTag).map((f) => [f.eventTag, f]));

const BY_NAME = new Map(FIELDS.map((f) => [f.name, f]));

function kindOf(entry) {
  return entry.ledgerKind || entry.name;
}

// Returns null when no entry matches — callers fall back to an explicit
// literal for ledger kinds that don't correspond to a single speaker field
// ('preset', 'transport', 'settings').
export function ledgerKindForField(name) {
  const entry = BY_NAME.get(name);
  return entry ? kindOf(entry) : null;
}

export function ledgerKindForEventTag(tag) {
  const entry = BY_TAG.get(tag);
  return entry ? kindOf(entry) : null;
}

// Apply a value to state using the entry's custom apply or the default.
function applyEntry(entry, state, value) {
  if (entry.apply) {
    entry.apply(state, value);
  } else {
    state.speaker[entry.name] = value;
  }
}

// Fetch a field using xmlGet for XML rows; defer to the row's custom
// fetcher (e.g. presets) when there's no path/tag/parseEl triple.
function fetchEntry(entry) {
  if (typeof entry.fetcher === 'function') return entry.fetcher();
  return xmlGet(entry);
}

// Fetch all fields in parallel, apply fulfilled results, notify once.
// Partial failures are non-fatal — other fields still apply.
export async function reconcile(store) {
  const results = await Promise.allSettled(FIELDS.map((f) => fetchEntry(f)));
  for (let i = 0; i < FIELDS.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || r.value == null) continue;
    applyEntry(FIELDS[i], store.state, r.value);
  }
  store.touch('speaker');
}

// Refresh one field by name. Same shape as the hint-only fallback in
// dispatch(): fetch via the row's fetcher (or xmlGet), swallow rejection
// and null payloads, apply and notify once on success. Returns nothing —
// callers observe the new value via the store subscription.
export async function reconcileField(store, fieldName) {
  const entry = BY_NAME.get(fieldName);
  if (!entry) return;
  let value;
  try { value = await fetchEntry(entry); } catch (_err) { return; }
  if (value == null) return;
  applyEntry(entry, store.state, value);
  store.touch('speaker');
}

// Locate the first descendant element matching the entry's `tag` inside
// the envelope child and parse it. Returns null when the envelope is
// hint-only (no inline payload) so dispatch() can fall back to fetch.
function parseInline(entry, envelopeChild) {
  if (!entry.tag || typeof entry.parseEl !== 'function') return null;
  const els = envelopeChild.getElementsByTagName(entry.tag);
  if (!els || !els[0]) return null;
  return entry.parseEl(els[0]);
}

// Dispatch a single child element of <updates> to the matching field.
// Calls store.touch('speaker') once per WS event.
export async function dispatch(envelopeChild, store) {
  const tag = envelopeChild.tagName;
  const entry = BY_TAG.get(tag);
  if (!entry) return;

  const inline = parseInline(entry, envelopeChild);
  if (inline != null) {
    applyEntry(entry, store.state, inline);
    store.touch('speaker');
  } else {
    // Hint-only: no inline data — fall back to a refetch.
    let value;
    try {
      value = await fetchEntry(entry);
    } catch (_err) {
      return;
    }
    if (value == null) return;
    applyEntry(entry, store.state, value);
    store.touch('speaker');
  }
}
