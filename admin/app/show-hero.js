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
import { createPlayButton } from './play-button.js';
import {
  appendMetaSeparator,
  genreChipEl,
  buildFavoriteHeart,
} from './row-internals.js';

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

  const heart = buildFavoriteHeart({ sid, name, art, favorite });
  if (heart) nameRow.appendChild(heart);

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
