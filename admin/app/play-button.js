// createPlayButton — the inline play widget the SPA mounts on every
// playable row (stationRow's auto-attach) and on the show-landing hero.
// Single source of truth for the click + keyboard contract: busy
// guard, topic-parent cache priming, stream-cache stash, /play call,
// toast routing.
//
// `label` is required at construction time. The api.playGuideId wrapper
// throws on a missing label too (#99 second half), but raising here
// catches the bug at row-render time rather than waiting for the
// first user tap.

import { playGuideId } from './api.js';
import { cache, TTL_STREAM, TTL_LABEL } from './tunein-cache.js';
import { parentKey as tuneinParentKey, extractParentShowId } from './transport-state.js';
import { cgiErrorMessage } from './error-messages.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';

// playSid({ sid, label, parentOutline? }) — shared play action for the
// inline play button and any other caller (e.g. the favourites tab's
// row body, which acts as a play target on tap). Centralises the
// cache-priming + cache-stash + toast routing so callers don't drift.
//
// Returns a Promise<void>. Failures are surfaced via toast; no envelope
// is bubbled up because callers don't need to branch on it. `busy`
// guarding is the caller's responsibility — this function does not
// debounce on its own.
export async function playSid({ sid, label, parentOutline } = {}) {
  if (typeof sid !== 'string' || !sid) return;
  if (typeof label !== 'string' || !label) return;

  // Issue #88: prime the parent-show cache the moment a topic plays.
  if (sid.charAt(0) === 't' && parentOutline) {
    const parent = extractParentShowId(parentOutline);
    if (parent) cache.set(tuneinParentKey(sid), parent, TTL_LABEL);
  }

  const cacheKey = `tunein.stream.${sid}`;
  const cached = cache.get(cacheKey);

  try {
    const result = await playGuideId(sid, label, cached);
    if (result && result.ok) {
      if (typeof result.url === 'string' && result.url) {
        cache.set(cacheKey, result.url, TTL_STREAM);
      }
      showToast(`Playing on Bo: ${label}`);
    } else {
      cache.invalidate(cacheKey);
      showToast(cgiErrorMessage(result));
    }
  } catch (_err) {
    cache.invalidate(cacheKey);
    showToast('Could not reach Bo');
  }
}

export function createPlayButton({ sid, label } = {}) {
  if (typeof sid !== 'string' || !sid) {
    throw new Error('createPlayButton: sid is required');
  }
  if (typeof label !== 'string' || !label) {
    throw new Error('createPlayButton: label is required');
  }

  const btn = document.createElement('span');
  btn.className = 'station-row__play';
  btn.setAttribute('role', 'button');
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('aria-label', `Play ${label} on Bo`);
  btn.setAttribute('data-tap', '44');

  btn.appendChild(icon('play', 20));

  let busy = false;

  async function trigger(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    if (busy) return;
    busy = true;
    btn.classList.add('is-loading');

    // The outline is stashed on the parent node by the render path; when
    // absent (hand-crafted callers, tests) playSid skips the topic-parent
    // cache write silently.
    const parentOutline = sid.charAt(0) === 't'
      ? (btn.parentNode && btn.parentNode._outline) || null
      : null;

    try {
      await playSid({ sid, label, parentOutline });
    } finally {
      btn.classList.remove('is-loading');
      busy = false;
    }
  }

  btn.addEventListener('click', trigger);
  btn.addEventListener('keydown', (evt) => {
    if (evt && (evt.key === ' ' || evt.key === 'Enter')) trigger(evt);
  });

  return btn;
}
