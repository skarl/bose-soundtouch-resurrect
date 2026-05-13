// transport-state — pure derivation helpers for the now-playing view's
// transport row. Two concerns live here, kept side by side so the
// classifier table stays adjacent to the consumer's mental model:
//
//   transportPhase(nowPlaying) → 'standby' | 'idle' | 'buffering' |
//                                'playing' | 'paused'
//     Maps the speaker's <playStatus> + selection state to the visual
//     state of the play/pause control. `idle` means the speaker isn't
//     in standby but no audio is selected (STOP_STATE / INVALID with
//     no item). `buffering` is any non-PLAY non-STANDBY state with a
//     selected item — the transient window between user tap and audio.
//
//   classifyPrevNext(nowPlaying, ctx) → { prev: bool, next: bool }
//     Returns the enabled state of the Prev / Next buttons. `ctx` is
//     `{ parentShowId, siblings }` resolved from tunein-cache by the
//     caller; the function itself is pure.
//
// Both helpers are deliberately framework-free: no DOM, no fetch, no
// store. The now-playing view, the mini-player, and the unit tests
// all call them directly.

// --- transportPhase -------------------------------------------------

// STANDBY wins over everything — when the speaker is asleep we want
// the idle "Play to wake" glyph, never a spinner. After that, only the
// explicit BUFFERING_STATE drives the loading glyph; STOP_STATE means
// the user (or the speaker, on a TUNEIN stream end) stopped the audio
// and the Play button must stay tappable so a resume is possible. For
// TUNEIN sources Bo does not emit PAUSE_STATE — a "pause" tap stops
// the stream and lands in STOP_STATE; treating STOP_STATE as paused
// (with a fresh Play glyph) is the resume-friendly contract.
export function transportPhase(np) {
  if (!np) return 'idle';
  if (np.source === 'STANDBY') return 'standby';

  const status = np.playStatus || '';
  if (status === 'PLAY_STATE')      return 'playing';
  if (status === 'BUFFERING_STATE') return 'buffering';

  // PAUSE_STATE and STOP_STATE both surface as 'paused' when an item
  // is selected — tapping Play resumes the stream (or restarts it for
  // TUNEIN after a STOP). Without an item there's nothing to resume,
  // so fall through to 'idle'.
  const hasItem = !!(np.item && (np.item.location || np.item.name));
  if (status === 'PAUSE_STATE' || status === 'STOP_STATE') {
    return hasItem ? 'paused' : 'idle';
  }
  return 'idle';
}

// --- prev/next classifier -------------------------------------------
//
// Bose firmware silently no-ops NEXT_TRACK / PREV_TRACK on any TUNEIN
// source (verified live against an `s`-prefix station + a `t`-prefix
// topic — see issue #88). The SPA owns enablement so the buttons
// never lie about what tapping them will do. Sources fan out via the
// table below; anything not listed is disabled.
//
//   ┌──────────────┬───────────────────────┬───────────────────────────┐
//   │ source       │ location prefix       │ behaviour                 │
//   ├──────────────┼───────────────────────┼───────────────────────────┤
//   │ TUNEIN       │ s<N> (station)        │ both disabled — no skip   │
//   │ TUNEIN       │ p<N> (live show)      │ both disabled — no skip   │
//   │ TUNEIN       │ t<N> (topic)          │ enabled iff parent show   │
//   │              │                       │ + cached siblings ≥ 2 and │
//   │              │                       │ neighbour exists in that  │
//   │              │                       │ direction; ends disable   │
//   │ BLUETOOTH    │ —                     │ both enabled — firmware   │
//   │ LOCAL_MUSIC  │ —                     │ both enabled — firmware   │
//   │ STORED_MUSIC │ —                     │ both enabled — firmware   │
//   │ UPNP         │ —                     │ both enabled — firmware   │
//   │ DEEZER       │ —                     │ both enabled — firmware   │
//   │ AMAZON       │ —                     │ both enabled — firmware   │
//   │ SPOTIFY      │ —                     │ both enabled — firmware   │
//   │ STANDBY      │ —                     │ both disabled             │
//   │ AUX          │ —                     │ both disabled (no tracks) │
//   │ INVALID_S…   │ —                     │ both disabled             │
//   │ (default)    │ —                     │ both disabled             │
//   └──────────────┴───────────────────────┴───────────────────────────┘
//
// "Firmware key path" sources keep the existing `actions.pressKey`
// call; the now-playing view branches on the classifier and only
// rewires Prev/Next when the result needs `/play` instead.

// Sources where the firmware reliably honours NEXT_TRACK / PREV_TRACK
// against the speaker's own queue. Verified for BLUETOOTH (#88); the
// rest follow the SoundTouch 10 source list and have queue semantics
// per Bose documentation. STANDBY and AUX are deliberately absent.
const FIRMWARE_KEY_SOURCES = new Set([
  'BLUETOOTH',
  'LOCAL_MUSIC',
  'STORED_MUSIC',
  'UPNP',
  'DEEZER',
  'AMAZON',
  'SPOTIFY',
  'BOSE_MUSIC',
  'PANDORA',
  'IHEART',
]);

// Pull the prefix-letter + numeric tail out of a /v1/playback/... URL.
// Returns null when the location isn't a /v1/playback/... or doesn't
// carry an `<letter><digits>` tail. Used by both the classifier and
// the now-playing onPrev/onNext branch to read the active guide_id.
export function extractGuideIdFromLocation(location) {
  if (typeof location !== 'string' || !location) return null;
  // The location form is `/v1/playback/<station-or-topic>/<sid>` —
  // accept any tail segment matching `[spt]\d+`. We deliberately don't
  // constrain the second-to-last segment because the firmware uses
  // `station` for s/p/t alike.
  const m = location.match(/([spt])(\d+)(?:[/?]|$)/);
  if (!m) return null;
  return `${m[1]}${m[2]}`;
}

// classifyPrevNext(np, ctx) — returns { prev, next, mode }.
//   mode is one of:
//     'disabled'   — both buttons disabled (default safe path)
//     'firmware'   — both enabled, route through `actions.pressKey`
//     'topic-list' — Prev/Next walk a cached siblings list via /play
// The mode lets the view branch its click handlers without having to
// re-classify.
//
// ctx (optional, defaults to {}):
//   parentShowId — the `p<N>` id resolved from cache for the currently
//     playing topic. When missing on a t-prefix, the result is disabled.
//   siblings — ordered array of topic ids `[t<N>, ...]` for the parent
//     show. When length < 2, the result is disabled.
export function classifyPrevNext(np, ctx = {}) {
  if (!np) return { prev: false, next: false, mode: 'disabled' };

  const source = np.source || '';
  if (source === 'STANDBY') return { prev: false, next: false, mode: 'disabled' };

  if (FIRMWARE_KEY_SOURCES.has(source)) {
    return { prev: true, next: true, mode: 'firmware' };
  }

  if (source !== 'TUNEIN') {
    return { prev: false, next: false, mode: 'disabled' };
  }

  // TUNEIN — branch on the location prefix.
  const guideId = extractGuideIdFromLocation(np.item && np.item.location);
  if (!guideId) return { prev: false, next: false, mode: 'disabled' };

  const prefix = guideId.charAt(0);
  if (prefix === 's' || prefix === 'p') {
    // Live radio + live show have no skip semantics.
    return { prev: false, next: false, mode: 'disabled' };
  }
  if (prefix !== 't') {
    return { prev: false, next: false, mode: 'disabled' };
  }

  // Topic path — needs parent + siblings list with ≥ 2 entries.
  const parent = ctx.parentShowId || '';
  const siblings = Array.isArray(ctx.siblings) ? ctx.siblings : [];
  if (!parent || siblings.length < 2) {
    return { prev: false, next: false, mode: 'disabled' };
  }

  const idx = siblings.indexOf(guideId);
  if (idx < 0) {
    // The speaker is on a topic the cache doesn't know about — refuse
    // to enable rather than guess at neighbours. Defence-in-depth for
    // the case where the user got to the topic via search and we
    // lazy-fetched a partial / paged list.
    return { prev: false, next: false, mode: 'disabled' };
  }

  return {
    // The list is ordered as the API emits it (newest → oldest for
    // most podcasts). "Prev" in the UI sense means "previous in the
    // list as displayed", which for a podcast topics list is the next
    // item shown (older episode) — but the SPA renders the list in
    // the order the API gives us, so let the displayed order be the
    // contract: idx-1 is Prev, idx+1 is Next.
    prev: idx > 0,
    next: idx < siblings.length - 1,
    mode: 'topic-list',
    // Sibling ids the caller will pass to playGuideId. Returned so
    // the view doesn't have to re-index.
    prevId: idx > 0 ? siblings[idx - 1] : null,
    nextId: idx < siblings.length - 1 ? siblings[idx + 1] : null,
    currentId: guideId,
  };
}

// --- cache key helpers ---------------------------------------------
//
// The parent + topics-list keys are documented here so the cache write
// sites (components.js play icon, browse.js topics rendering) and the
// now-playing classifier can't drift apart.

// Parent show id, keyed by topic id. Value: `p<N>` string.
export function parentKey(topicId) {
  return `tunein.parent.${topicId}`;
}

// Ordered list of topic ids for a show, keyed by show id. Value:
// `[t<N>, ...]`. Persisted as a plain array of strings — the names
// don't matter to the classifier, only the ordering.
export function topicsKey(showId) {
  return `tunein.topics.${showId}`;
}

// extractParentShowId(outline) — pull the `sid=p<N>` parameter out of
// a topic outline's `URL` field. Topic rows in Browse and Search
// responses carry a `Tune.ashx?...&sid=p<N>` URL the firmware uses to
// resolve the topic's parent show. We mine the same value at row-
// render time and stash it under `tunein.parent.<t<N>>` so the
// now-playing Prev/Next classifier can answer "what show is this
// from?" without re-fetching. Returns null when the URL is missing or
// carries no usable `sid=p<N>` (legacy entries, search rows that
// emit a direct stream URL, etc.).
export function extractParentShowId(outline) {
  if (!outline || typeof outline !== 'object') return null;
  const url = typeof outline.URL === 'string' ? outline.URL : '';
  if (!url) return null;
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return null;
  // Walk the query manually rather than spinning a URLSearchParams —
  // the URL may be missing a scheme/host (raw Tune.ashx string).
  const qs = url.slice(qIdx + 1).split('&');
  for (const part of qs) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    if (k !== 'sid') continue;
    const v = decodeURIComponent(part.slice(eq + 1));
    if (/^p\d+$/.test(v)) return v;
  }
  return null;
}
