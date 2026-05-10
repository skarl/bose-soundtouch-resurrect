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
  parseNowPlayingEl,
  getVolume,
  parseVolumeEl,
  getSources,
  parseSourcesEl,
} from './api.js';

// Registered confirmFn for volume — injected by now-playing.js after it
// creates its volume sender. Called by volume's afterApply.
let volumeConfirmFn = null;
export function setVolumeConfirmFn(fn) { volumeConfirmFn = fn; }

// Registered "is the user currently committing a volume change?" probe.
// volume.js wires its hasPending() in here. Used by volume's apply to
// avoid overwriting the user's eager targetVolume with a stale WS one
// during fast drags (the speaker reports the previous target until our
// queued POST resolves).
let volumePendingFn = null;
export function setVolumePendingFn(fn) { volumePendingFn = fn; }

// Field entry shape:
//   name        — key in state.speaker
//   fetcher     — () => Promise<value>
//   eventTag?   — child tag inside <updates> that carries this field's event
//   parseInline — (el) => value | null. Null means hint-only: fall back to fetcher().
//   apply?      — (state, value) => void. Default: state.speaker[name] = value
//   afterApply? — (value) => void. Optional side-effect (volume WS confirm).
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
    apply(state, value) {
      if (!value) return;
      const prev = state.speaker.volume;
      // While the user has a queued/in-flight volume command, the WS
      // event's targetVolume may still reflect the previous level —
      // overwriting would yank the slider thumb back. Keep our eager
      // targetVolume; only update what the speaker uniquely owns.
      if (prev && volumePendingFn && volumePendingFn()) {
        state.speaker.volume = {
          ...value,
          targetVolume: prev.targetVolume,
        };
      } else {
        state.speaker.volume = value;
      }
    },
    afterApply(value) {
      if (volumeConfirmFn && value) volumeConfirmFn(value.actualVolume);
    },
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
    if (entry.afterApply) entry.afterApply(inline);
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
    if (entry.afterApply) entry.afterApply(value);
  }
}
