// Shared internals for stationRow (components.js) and showHero
// (show-hero.js). Both views render the same visual primitives — meta
// separator dot, clickable genre chip, browse-URL → SPA-hash converter,
// and the favourite-eligibility heart-mount — so the helpers live in one
// place rather than being copy-paired between the two modules.
//
// Kept out of components.js because it carries no public surface: these
// are renderer details, not row primitives. show-hero and components
// import from here directly.

import { canonicaliseBrowseUrl } from './tunein-url.js';
import { favoriteHeart, isFavoriteId } from './favorites.js';

// Append a "·" dot to a meta line. Used between each segment of the
// chip-and-meta row so location/bitrate/reliability/genre never collide
// when they line up.
export function appendMetaSeparator(metaEl) {
  const sep = document.createElement('span');
  sep.className = 'station-row__sep';
  sep.textContent = '·';
  metaEl.appendChild(sep);
}

// genreChipEl — small clickable pill that drills into the genre.
// The href is composed via canonicaliseBrowseUrl so the URL passes
// through the language-tree rewrite and the magic-param strip; the
// resulting `Browse.ashx?id=g<NN>&render=json` is then translated
// into the SPA hash form (#/browse?id=g<NN>).
export function genreChipEl(chip) {
  const id = chip && typeof chip.id === 'string' ? chip.id : '';
  if (!id) {
    const stub = document.createElement('span');
    stub.className = 'station-row__chip station-row__chip--genre is-disabled';
    return stub;
  }
  let drillHash;
  try {
    const browseUrl = canonicaliseBrowseUrl(`Browse.ashx?id=${encodeURIComponent(id)}`);
    drillHash = browseUrlToHash(browseUrl);
  } catch (_err) {
    drillHash = `#/browse?id=${encodeURIComponent(id)}`;
  }
  const a = document.createElement('a');
  a.className = 'station-row__chip station-row__chip--genre';
  a.setAttribute('href', drillHash);
  a.setAttribute('data-chip-kind', 'genre');
  a.setAttribute('data-genre-id', id);
  a.textContent = id;
  // The chip is its own click target inside the row anchor; the row
  // itself drills to the station's detail view, the chip drills to
  // the genre. Stop the click bubbling so the row's href doesn't fire.
  a.addEventListener('click', (evt) => {
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
  });
  return a;
}

// Convert a canonical `Browse.ashx?...&render=json` URL into the SPA
// hash form. Drops the path + render param; preserves drill keys.
export function browseUrlToHash(canonicalUrl) {
  const qIdx = canonicalUrl.indexOf('?');
  if (qIdx < 0) return '#/browse';
  const qs = new URLSearchParams(canonicalUrl.slice(qIdx + 1));
  qs.delete('render');
  const out = qs.toString();
  return out ? `#/browse?${out}` : '#/browse';
}

// buildFavoriteHeart — returns a favouriteHeart button when the sid is
// favouritable AND a favourite-store handle is wired in; otherwise
// returns null so the caller can fall through to its own affordance
// (chevron on stationRow, no extra node on showHero).
//
// `favorite: { store, getEntry?, onCleanup? }`. When `getEntry` is
// omitted, the entry shape is built from the static row fields:
//   { id: sid, name: name || sid, art: art || '', note: '' }
// The `getEntry` override exists for callers that want to resolve a
// live name/art at click time (e.g. now-playing).
export function buildFavoriteHeart({ sid, name, art = '', favorite } = {}) {
  if (!favorite || !favorite.store || !isFavoriteId(sid)) return null;
  const getEntry = typeof favorite.getEntry === 'function'
    ? favorite.getEntry
    : () => ({ id: sid, name: name || sid, art: art || '', note: '' });
  return favoriteHeart({
    store: favorite.store,
    getEntry,
    onCleanup: favorite.onCleanup,
  });
}
