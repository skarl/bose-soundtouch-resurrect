// now-playing-data — topic-cache coordination for the now-playing view.
//
// Sibling of views/now-playing.js (deliberately flat, not under a
// views/now-playing/ subfolder). Owns the data-flow concern the view
// previously inlined: walking Browse(c=topics) JSON, priming the topic
// caches, and resolving a topic id back to a human-readable label.
//
// The view imports these helpers; play-button.js writes the parent-show
// cache via the same key helpers in transport-state.js so the two
// agents stay in sync without sharing code.
//
// Everything here is a pure function over (json | topicId | np). No DOM
// touches, no store reads — callers thread the now-playing snapshot
// through `labelForTopic` so the data module is unit-testable without
// mounting the view.

import { tuneinBrowse } from '../api.js';
import { cache, TTL_DRILL_HEAD } from '../tunein-cache.js';
import { classifyOutline } from '../tunein-outline.js';
import {
  topicsKey,
  topicNameKey,
  extractGuideIdFromLocation,
} from '../transport-state.js';

// Pull the ordered list of topic guide_ids out of a Browse(c=topics)
// JSON body. The body shape is either a flat list of topic outlines
// or a single section container with `children` — handle both so the
// caller doesn't have to inspect the response. Filters to t-prefix
// rows (the only ones the firmware can resolve as a topic stream).
export function extractTopicIds(json) {
  const out = [];
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (Array.isArray(entry.children)) {
      for (const c of entry.children) visit(c);
      return;
    }
    // Filter on classification (drops cursors, pivots, tombstones)
    // AND on the t-prefix so a sibling station row in the same body
    // doesn't poison the topics list.
    const kind = classifyOutline(entry);
    const gid = typeof entry.guide_id === 'string' ? entry.guide_id : '';
    if (kind === 'topic' && /^t\d+$/.test(gid)) out.push(gid);
  };
  const body = json && Array.isArray(json.body) ? json.body : [];
  for (const e of body) visit(e);
  return out;
}

// #102: stash episode titles under tunein.topicname.<t<N>>. Same
// traversal shape as extractTopicIds, isolated here so the search-
// arrival path (lazyFetchTopicsList) gets the same priming the
// browse-view drill already does.
export function cacheTopicNames(json) {
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (Array.isArray(entry.children)) {
      for (const c of entry.children) visit(c);
      return;
    }
    const gid = typeof entry.guide_id === 'string' ? entry.guide_id : '';
    if (!/^t\d+$/.test(gid)) return;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (text) cache.set(topicNameKey(gid), text, TTL_DRILL_HEAD);
  };
  const body = json && Array.isArray(json.body) ? json.body : [];
  for (const e of body) visit(e);
}

// #102: Resolve the episode title for a /play call's `name` field.
// Source priority:
//   1. `tunein.topicname.<t<N>>` — primed by the browse view + the
//      lazy fetcher below; this is the canonical resolved title.
//   2. The firmware's own <itemName> if it's already on this topic
//      AND that name isn't itself the raw guide_id (defending
//      against a stale state written by an earlier sid-fallback).
// Falls back to the topic id as a last resort: #99 makes `name`
// structurally required on playGuideId, so we always return a
// string. The fallback is the known c9d8396 degrade (itemName
// surfaces the sid); the topic-name primer in the browse drill +
// the lazy fetcher below populate the cache so the fallback fires
// only on a never-drilled, never-fetched topic — vanishingly rare
// in practice.
//
// `np` is the now-playing snapshot the caller already has in hand —
// passed in rather than read from the store so this helper is pure
// and trivially unit-testable.
export function labelForTopic(topicId, np) {
  const cached = cache.get(topicNameKey(topicId));
  if (typeof cached === 'string' && cached) return cached;
  const location = np?.item?.location ?? null;
  const itemName = np?.item?.name ?? null;
  if (location
      && extractGuideIdFromLocation(location) === topicId
      && itemName
      && itemName !== topicId) {
    return itemName;
  }
  return topicId;
}

// Fan-out: lazy-fetch the topics list for `parentId` when it isn't
// already cached. Used by the Prev/Next path when the user arrived
// at a topic via search (no drill context). Idempotent — the cache
// entry survives until TTL_DRILL_HEAD expires.
export async function lazyFetchTopicsList(parentId) {
  const key = topicsKey(parentId);
  const cached = cache.get(key);
  if (Array.isArray(cached)) return cached;
  try {
    const body = await tuneinBrowse({ c: 'topics', id: parentId });
    const ids = extractTopicIds(body);
    // #102: lift episode titles from the same body into the
    // tunein.topicname.<t<N>> cache so the next Prev/Next can ship
    // `name` to /play. The browse view's primer already does this
    // on drill; this branch covers the search-arrival path.
    cacheTopicNames(body);
    if (ids.length >= 2) {
      cache.set(key, ids, TTL_DRILL_HEAD);
      return ids;
    }
    // Cache the empty / 1-entry result too so we don't refetch on
    // every click, but flag the buttons as disabled by writing a
    // sentinel (the classifier rejects length < 2 anyway).
    cache.set(key, ids, TTL_DRILL_HEAD);
    return ids;
  } catch (_err) {
    return [];
  }
}
