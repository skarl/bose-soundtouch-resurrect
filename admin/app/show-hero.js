// showHero — the show-self / live-show "page subject" block.
//
// A stationRow is an <a>: tapping anywhere on the row drills to that
// row's detail view, which is the right contract for a listing entry.
// The show-landing's top card and the c=pbrowse liveShow card are
// *the page subject* — the row you're already looking at. A self-link
// is dead weight (tap → refresh the same drill, or worse, fall through
// the router's safety net). The primary affordance on the hero is the
// inline Play icon, not navigation.
//
// showHero produces the same visual contract as stationRow (art + name
// + secondary line + chips + inline Play for p/s/t) but on a <div>
// root, so the body has no href and tapping outside the chip + Play
// surfaces is a no-op. Chips and the Play button remain their own
// clickable targets.
//
// We deliberately keep the .station-row class on the root so the
// existing CSS (sizing, gap, hover background, focus outline) applies
// without a new ruleset. The .station-row--hero modifier is there for
// future divergence and as a CSS / test handle.

import { stationArt } from './components.js';
import { isPlayableSid } from './tunein-sid.js';
import { canonicaliseBrowseUrl } from './tunein-url.js';
import { createPlayButton } from './play-button.js';
import { favoriteHeart, isFavoriteId } from './favorites.js';

// Drill-only prefixes / unknown specs render nothing useful as a hero,
// but the caller is in charge of whether to mount one. We mirror the
// stationRow tolerance for missing fields (location/chips/etc.) so the
// hero degrades gracefully when Describe is sparse.
export function showHero({
  sid,
  name,
  art = '',
  location = '',
  chips,
  favorite,
} = {}) {
  const hero = document.createElement('div');
  hero.className = 'station-row station-row--hero';
  hero.dataset.sid = sid;

  hero.appendChild(stationArt({ url: art, name: name || sid, size: 40 }));

  const body = document.createElement('span');
  body.className = 'station-row__body';

  // Wrap the name + heart in a flex row so the heart sits next to the
  // title, mirroring the station-detail's `station-name-row` (#126).
  // When the sid isn't favouritable or no favourite handle was wired
  // in, the row collapses to just the name span.
  const nameRow = document.createElement('span');
  nameRow.className = 'station-row__name-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'station-row__name';
  nameEl.textContent = name || sid;
  nameRow.appendChild(nameEl);

  if (favorite && favorite.store && isFavoriteId(sid)) {
    const getEntry = typeof favorite.getEntry === 'function'
      ? favorite.getEntry
      : () => ({ id: sid, name: name || sid, art: art || '', note: '' });
    nameRow.appendChild(favoriteHeart({
      store: favorite.store,
      getEntry,
      onCleanup: favorite.onCleanup,
    }));
  }

  body.appendChild(nameRow);

  // --- secondary meta line (location · chips) -----------------------
  const meta = document.createElement('span');
  meta.className = 'station-row__meta';

  if (location) {
    const loc = document.createElement('span');
    loc.className = 'station-row__loc';
    loc.textContent = String(location);
    meta.appendChild(loc);
  }

  const genreChip = Array.isArray(chips)
    ? chips.find((c) => c && c.kind === 'genre')
    : null;
  if (genreChip) {
    if (meta.childNodes.length > 0) appendMetaSeparator(meta);
    meta.appendChild(genreChipEl(genreChip));
  }

  if (meta.childNodes.length > 0) body.appendChild(meta);

  hero.appendChild(body);

  if (isPlayableSid(sid)) {
    hero.appendChild(createPlayButton({ sid, label: name || sid }));
  }

  return hero;
}

// --- internal helpers --------------------------------------------------
//
// These mirror the private helpers inside components.js. They're
// duplicated here rather than re-exported because #87's contract is
// "do not add new exports to components.js"; the helpers are small
// and tied to the row's visual layout. A future refactor can hoist
// them into a shared internal module once both row + hero stabilise.

function appendMetaSeparator(meta) {
  const sep = document.createElement('span');
  sep.className = 'station-row__sep';
  sep.textContent = '·';
  meta.appendChild(sep);
}

function genreChipEl(chip) {
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
  // No outer anchor to bubble into on a hero, but keep the stop so the
  // hero stays drop-in compatible if a future container ever wraps it.
  a.addEventListener('click', (evt) => {
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
  });
  return a;
}

function browseUrlToHash(canonical) {
  const qIdx = canonical.indexOf('?');
  if (qIdx < 0) return '#/browse';
  const qs = new URLSearchParams(canonical.slice(qIdx + 1));
  qs.delete('render');
  const out = qs.toString();
  return out ? `#/browse?${out}` : '#/browse';
}

