// Favourites — admin-owned record of hearted stations and shows.
//
// Seams in this file are deliberately small. Three building blocks:
//
//   1. State helpers (pure): `indexOfFavorite`, `withFavoriteAdded`,
//      `withFavoriteRemoved`. Work on the array shape the CGI emits.
//      Pure list transforms so #127's reorder/edit slice can compose
//      with the toggle without forking the data shape.
//
//   2. `toggleFavorite(store, entry)` — the optimistic-toggle action.
//      Mirrors the optimistic pattern in `optimistic.js`: mutate state,
//      fire POST, roll back on rejection + toast. Used by the heart on
//      station-detail today; reusable by row-level hearts (#126) and the
//      favourites-tab pencil/trash (#128/#129) without modification.
//
//   3. `favoriteHeart({ getEntry, store })` — the heart toggle DOM
//      primitive. Subscribes to `state.speaker.favorites` and repaints
//      the filled / outline state on every change. Hidden when the id
//      isn't `^[sp]\d+$`. Exported separately so #126 can mount one per
//      row without re-implementing the click + paint dance.

import { showToast } from './toast.js';
import { favoritesReplace } from './api.js';
import { icon } from './icons.js';
import { isPlayableSid } from './tunein-sid.js';

// Match `^[sp]\d+$` — the favourites id grammar. station-detail also
// gates on this so the heart never appears on non-playable rows.
export function isFavoriteId(id) {
  if (typeof id !== 'string' || id.length < 2) return false;
  const first = id.charAt(0);
  if (first !== 's' && first !== 'p') return false;
  for (let i = 1; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

// indexOfFavorite — return the array index of `id` in the favourites
// list, or -1. null/undefined lists are treated as empty.
export function indexOfFavorite(list, id) {
  if (!Array.isArray(list)) return -1;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e && e.id === id) return i;
  }
  return -1;
}

// withFavoriteAdded — append the entry to a copy of `list` unless its id
// is already present. Returns the original list when the id is already
// there (no-op) so callers can `if (next !== list)` to detect a real
// change. Defensive on shape: missing fields collapse to empty strings.
export function withFavoriteAdded(list, entry) {
  const base = Array.isArray(list) ? list : [];
  if (!entry || typeof entry.id !== 'string') return base;
  if (indexOfFavorite(base, entry.id) >= 0) return base;
  const normalised = {
    id:   entry.id,
    name: typeof entry.name === 'string' ? entry.name : '',
    art:  typeof entry.art  === 'string' ? entry.art  : '',
    note: typeof entry.note === 'string' ? entry.note : '',
  };
  return base.concat([normalised]);
}

// withFavoriteRemoved — return a copy of `list` with the first entry
// matching `id` dropped. Returns the original list when nothing matched.
export function withFavoriteRemoved(list, id) {
  if (!Array.isArray(list)) return [];
  const idx = indexOfFavorite(list, id);
  if (idx < 0) return list;
  return list.slice(0, idx).concat(list.slice(idx + 1));
}

// spliceReorder — move the entry at `fromIdx` to the gap `toGap`. Gaps
// are numbered 0..length, where gap g sits before the row currently at
// index g (so gap 0 is "above the first row" and gap length is "below
// the last row"). The drag UI in #128 thinks in gaps because the drop
// indicator renders between rows; this helper translates a gap drop
// into the final array shape.
//
// Drops at the source's own gap (`fromIdx` or `fromIdx + 1`) are no-ops
// — both describe "release where you picked it up". The helper returns
// the original list reference in that case so callers can `if (next !==
// list)` to skip the POST.
//
// Pure: no DOM, no mutation. Tested directly in `test_favorites_drag.js`.
export function spliceReorder(list, fromIdx, toGap) {
  if (!Array.isArray(list)) return [];
  const n = list.length;
  if (!Number.isInteger(fromIdx) || fromIdx < 0 || fromIdx >= n) return list;
  if (!Number.isInteger(toGap)   || toGap   < 0 || toGap   >  n) return list;
  // No-op: dropping at the gap immediately before or after the source
  // leaves the entry in place.
  if (toGap === fromIdx || toGap === fromIdx + 1) return list;
  const next = list.slice();
  const [picked] = next.splice(fromIdx, 1);
  // Removing from `fromIdx` shifts every later index down by one, so
  // gaps strictly after the source need a -1 correction before insert.
  const insertAt = toGap > fromIdx ? toGap - 1 : toGap;
  next.splice(insertAt, 0, picked);
  return next;
}

// replaceFavorites — write a hand-built next-list to the speaker, with
// optimistic state + rollback to the supplied snapshot on failure.
//
// Used by the favourites tab (#127) for edit-in-place save, optimistic
// delete, and undo-restore — each of which mutates the list in a shape
// that withFavoriteAdded / withFavoriteRemoved can't express alone (e.g.
// editing an entry's fields, restoring at a specific index).
//
// Behaviour:
//   1. Sets state.speaker.favorites = next + touch('speaker') so the UI
//      paints the optimistic state.
//   2. POSTs the next array.
//   3. On structured-error or transport throw, restores `prev`, touches
//      again, and surfaces a toast. The caller picks the toast prefix
//      via `errorLabel` ("Couldn't save favourite", "Couldn't delete
//      favourite", etc.) so toasts stay specific to the action.
//
// Returns the envelope on success, the envelope or a synthetic
// TRANSPORT envelope on failure (mirror of toggleFavorite).
export async function replaceFavorites(store, next, prev, errorLabel) {
  const safeNext = Array.isArray(next) ? next : [];
  const safePrev = Array.isArray(prev) ? prev : [];
  const label = typeof errorLabel === 'string' && errorLabel
    ? errorLabel
    : "Couldn't update favourites";

  store.state.speaker.favorites = safeNext;
  store.touch('speaker');

  let envelope;
  try {
    envelope = await favoritesReplace(safeNext);
  } catch (err) {
    store.state.speaker.favorites = safePrev;
    store.touch('speaker');
    const msg = (err && err.message) || 'transport error';
    showToast(`${label}: ${msg}`);
    return { ok: false, error: { code: 'TRANSPORT', message: msg } };
  }

  if (!envelope || envelope.ok !== true) {
    store.state.speaker.favorites = safePrev;
    store.touch('speaker');
    const code = (envelope && envelope.error && envelope.error.code) || 'UNKNOWN';
    showToast(`${label} (${code})`);
    return envelope || { ok: false, error: { code, message: '' } };
  }
  return envelope;
}

// toggleFavorite — optimistic add-or-remove with POST-side reconcile.
//
// store: the live observable store (state.js).
// entry: { id, name, art?, note? }. `id` is required; `name` falls back
//        to the id if missing so the persisted record always has a label.
//
// Behaviour:
//   1. Snapshot current state.speaker.favorites.
//   2. Apply the toggle locally and touch('speaker').
//   3. POST the new list. On structured-error or transport failure,
//      restore the snapshot, touch('speaker') again, surface a toast.
//
// Returns the response envelope on success, or a synthetic
// `{ ok:false, error:{code:'TRANSPORT', message}}` on transport throw
// so callers don't need to distinguish thrown vs structured failure.
export async function toggleFavorite(store, entry) {
  if (!entry || !isFavoriteId(entry.id)) {
    return { ok: false, error: { code: 'INVALID_ID', message: 'bad id' } };
  }
  const prev = Array.isArray(store.state.speaker.favorites)
    ? store.state.speaker.favorites.slice()
    : [];
  const isFav = indexOfFavorite(prev, entry.id) >= 0;
  const safeEntry = {
    id:   entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
    art:  typeof entry.art  === 'string' ? entry.art  : '',
    note: typeof entry.note === 'string' ? entry.note : '',
  };
  const next = isFav
    ? withFavoriteRemoved(prev, entry.id)
    : withFavoriteAdded(prev, safeEntry);
  store.state.speaker.favorites = next;
  store.touch('speaker');

  let envelope;
  try {
    envelope = await favoritesReplace(next);
  } catch (err) {
    store.state.speaker.favorites = prev;
    store.touch('speaker');
    const msg = (err && err.message) || 'transport error';
    showToast(`Couldn't update favourites: ${msg}`);
    return { ok: false, error: { code: 'TRANSPORT', message: msg } };
  }

  if (!envelope || envelope.ok !== true) {
    store.state.speaker.favorites = prev;
    store.touch('speaker');
    const code = (envelope && envelope.error && envelope.error.code) || 'UNKNOWN';
    showToast(`Couldn't update favourites (${code})`);
    return envelope || { ok: false, error: { code, message: '' } };
  }
  return envelope;
}

// favoriteHeart({ getEntry, store, sizePx, onCleanup? }) — heart toggle
// primitive. `getEntry` is called at click time (so the caller can
// resolve the live name/art after async metadata lands) and on every
// repaint (so the visibility gate honours the latest id).
//
// The returned element is a <button> that:
//   - is `hidden` whenever getEntry()?.id doesn't match ^[sp]\d+$
//   - paints `.is-filled` / `.is-empty` based on the current favourites
//     list, subscribing to 'speaker' for re-paints
//   - on click, calls toggleFavorite() with the freshest entry
//
// Subscriptions auto-detach via the optional `onCleanup` register
// (defineView's env.onCleanup) so the button doesn't leak in a route
// transition. Callers that don't pass onCleanup own the unsubscribe.
//
// The CSS hooks (.fav-heart, .is-filled, .is-empty) are styled in
// style.css; this module only sets classes.
export function favoriteHeart({ getEntry, store, sizePx = 22, onCleanup } = {}) {
  if (typeof getEntry !== 'function' || !store) {
    throw new Error('favoriteHeart: getEntry + store are required');
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fav-heart';
  btn.dataset.testFav = '1';
  btn.appendChild(icon('heart', sizePx));

  let busy = false;

  function currentEntry() {
    try { return getEntry() || null; }
    catch (_err) { return null; }
  }

  function paint() {
    const entry = currentEntry();
    const id = entry && entry.id;
    const eligible = typeof id === 'string' && isFavoriteId(id);
    btn.hidden = !eligible;
    if (!eligible) {
      btn.setAttribute('aria-hidden', 'true');
      btn.setAttribute('tabindex', '-1');
      return;
    }
    btn.removeAttribute('aria-hidden');
    btn.removeAttribute('tabindex');
    const list = (store.state && store.state.speaker && store.state.speaker.favorites) || [];
    const isFav = indexOfFavorite(list, id) >= 0;
    btn.classList.toggle('is-filled', isFav);
    btn.classList.toggle('is-empty', !isFav);
    btn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
    btn.setAttribute('aria-label', isFav ? 'Remove from favourites' : 'Add to favourites');
    btn.setAttribute('title', isFav ? 'Remove from favourites' : 'Add to favourites');
  }

  async function onClick(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    if (busy) return;
    const entry = currentEntry();
    if (!entry || !isFavoriteId(entry.id)) return;
    busy = true;
    btn.classList.add('is-busy');
    btn.disabled = true;
    try {
      await toggleFavorite(store, entry);
    } finally {
      busy = false;
      btn.classList.remove('is-busy');
      btn.disabled = false;
      // Paint defensively after the toggle in case the speaker
      // subscription hasn't fired yet (e.g. tests without a live store).
      paint();
    }
  }

  btn.addEventListener('click', onClick);

  paint();
  const unsub = store.subscribe ? store.subscribe('speaker', paint) : null;
  if (typeof onCleanup === 'function' && typeof unsub === 'function') {
    onCleanup(unsub);
  }
  btn.repaint = paint;
  btn.unsubscribe = unsub || (() => {});
  return btn;
}

// Re-export the id-shape predicate from tunein-sid for callers that
// already think in terms of "playable" — favourites accept the same
// `s` / `p` prefix grammar that the play-button gates on.
export { isPlayableSid as isFavoritableSid };
