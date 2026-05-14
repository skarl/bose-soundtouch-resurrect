// outline-render — Browse.ashx outline → DOM rendering primitives.
//
// Owns the entry → row pipeline (renderEntry), the body → section
// pipeline (renderOutline, renderSection, renderFlatSection,
// renderCard), the related/pivot chip renderers, and the
// localCountry lift. The c=pbrowse liveShow / topics sections route
// through show-landing.js (renderLiveShowCard / renderTopicsCard);
// outline-render imports them so renderSection's existing dispatch
// stays unchanged.
//
// All drill-row hash composition runs through drillHashFor, which
// reads the module-local `_childCrumbs` set by browse.js (renderRoot
// / selectTab / renderDrill) before rendering. Tests poke
// _setChildCrumbsForTest to drive renderEntry without mounting a
// full view.

import { stationRow } from '../../components.js';
import { icon } from '../../icons.js';
import {
  canonicaliseBrowseUrl,
  extractDrillKey,
} from '../../tunein-url.js';
import { cache, TTL_LABEL, TTL_DRILL_HEAD } from '../../tunein-cache.js';
import {
  parentKey as tuneinParentKey,
  topicsKey as tuneinTopicsKey,
  topicNameKey as tuneinTopicNameKey,
  extractParentShowId,
} from '../../transport-state.js';
import {
  classifyOutline,
  normaliseRow,
  extractPivots,
} from '../../tunein-outline.js';
import {
  renderLiveShowCard,
  renderTopicsCard,
} from './show-landing.js';

// The crumb-token prefix that child links should embed in `from=...`.
// Set by renderDrill / selectTab before the row constructor runs, and
// read by drillHashFor() when composing each row's href. Module-local
// rather than thread-through-args so renderEntry's signature (which
// is exported and used by tests) stays stable.
let _childCrumbs = [];

// Browse.js drives the production setter — every drill mount pushes the
// stack for child rows here. Tests use _setChildCrumbsForTest below.
export function setChildCrumbs(crumbs) {
  _childCrumbs = Array.isArray(crumbs) ? crumbs.slice() : [];
}

// Test-only setter for the module-local crumb prefix. Production code
// drives _childCrumbs through renderRoot / selectTab / renderDrill;
// tests use this to assert renderEntry's href composition without
// having to mount a full view.
export function _setChildCrumbsForTest(crumbs) {
  _childCrumbs = Array.isArray(crumbs) ? crumbs.slice() : [];
}

// Current-page parts (#106). The pivot / related chip composers append
// THIS page's filters to the chip's own filter list so multi-filter
// drills stack cleanly (e.g. Bayreuth → +Country → +German lands on
// `?id=r101821&filter=g26,l170`). browse.js renderDrill sets this
// before rendering the outline; root view / tests clear it.
let _currentParts = null;

export function setCurrentParts(parts) {
  _currentParts = (parts && typeof parts === 'object') ? parts : null;
}

export function _setCurrentPartsForTest(parts) {
  _currentParts = (parts && typeof parts === 'object') ? parts : null;
}

// Compose the hash anchor for a drill row from its parts. Mirrors
// composeDrillUrl but emits the SPA-internal hash form. The keys are
// already plain strings; URLSearchParams handles encoding.
//
// `crumbs` is the prefix the child link should embed in `from=...`.
// Defaults to the module-level `_childCrumbs` so renderEntry callers
// don't need to pass it through. Empty arrays omit `from=` entirely.
//
// Multi-filter (#106): emits the joined wire form `filter=l109,g22`
// when `parts.filters: string[]` is non-empty. Falls back to the
// legacy single-string `parts.filter` for callers still on the old
// shape (e.g. tunein-outline pivots whose URL parsed to {filter:'…'}).
export function drillHashFor(parts, crumbs) {
  const qs = new URLSearchParams();
  if (parts.id)     qs.set('id', parts.id);
  if (parts.c)      qs.set('c', parts.c);
  const filterStr = joinFilters(parts);
  if (filterStr)    qs.set('filter', filterStr);
  if (parts.pivot)  qs.set('pivot', parts.pivot);
  if (parts.offset) qs.set('offset', parts.offset);
  const fromList = Array.isArray(crumbs) ? crumbs : _childCrumbs;
  const fromStr  = stringifyCrumbs(fromList);
  if (fromStr) qs.set('from', fromStr);
  return `#/browse?${qs.toString()}`;
}

// Resolve a parts object's filter list to the wire string `l109,g22`.
// Prefers `parts.filters: string[]` (the canonical multi-value form);
// falls back to the legacy `parts.filter: string`. Empty → ''.
function joinFilters(parts) {
  if (Array.isArray(parts.filters)) {
    const cleaned = parts.filters.filter((s) => typeof s === 'string' && s !== '');
    return cleaned.join(',');
  }
  if (typeof parts.filter === 'string' && parts.filter !== '') return parts.filter;
  return '';
}

// Return the canonical filter list for parts (always an array). See
// joinFilters; this is the same source-of-truth read but in array form.
function filtersOfParts(parts) {
  if (!parts) return [];
  if (Array.isArray(parts.filters)) {
    return parts.filters.filter((s) => typeof s === 'string' && s !== '');
  }
  if (typeof parts.filter === 'string' && parts.filter !== '') {
    return parts.filter.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// Local copy of stringifyCrumbs so drillHashFor doesn't pull in the
// full crumb module. Kept in sync with browse.js's exported version
// (single token: comma-joined, empty array → '').
function stringifyCrumbs(crumbs) {
  if (!Array.isArray(crumbs) || crumbs.length === 0) return '';
  return crumbs.join(',');
}

export function pluralize(n) {
  return n === 1 ? 'entry' : 'entries';
}

export function skeleton() {
  const p = document.createElement('p');
  p.className = 'browse-loading';
  p.textContent = 'Loading...';
  return p;
}

export function errorNode(err) {
  const p = document.createElement('p');
  p.className = 'browse-error';
  p.textContent = `Couldn't load this section: ${err.message}`;
  return p;
}

export function emptyNode(message) {
  const p = document.createElement('p');
  p.className = 'browse-empty';
  p.textContent = message;
  return p;
}

// Render a TuneIn outline tree. The pipeline is now classifier-led:
// each top-level body entry either contains its own `children` (a
// section — e.g. `local`/`stations`/`shows`/`related` on page 0) or
// is a row directly under the document root (a flat paginated page).
//
// Multi-section payload → each section becomes its own labelled
// card (header taken verbatim from the API's `text`, e.g.
// "Local Stations (2)", "Stations", "Shows", "Explore Folk").
// Flat payload → one card with no section header.
//
// Body-level emptiness (body:[] or a lone tombstone) is resolved
// upstream by tunein-drill.resolveBrowseDrill — those payloads never
// reach this function; the drill renderer paints emptyNode directly.
// Per-section emptiness inside a non-empty body is still handled here
// (a sectioned body can have one empty section alongside populated
// ones).
//
// Returns the total visible row count (cursors + pivots are excluded
// — they're meta, not rows the user reads through).
export function renderOutline(body, json) {
  const rawItems = Array.isArray(json && json.body) ? json.body : [];

  // Local Radio surface (issue #82): c=local responses include a
  // `key="localCountry"` link pointing at the corresponding r-prefix
  // country root. Lift it out of the row stream and surface it as a
  // prominent "Browse all of <country>" card above the audio list.
  // The localCountry row can sit either at body root (typical c=local
  // shape) or inside a section's children — handle both by walking
  // one level deep.
  const items = liftLocalCountry(rawItems, body, json);

  let total = 0;

  // Multi-section: every top entry that has children is its own
  // section. Children directly at the top level (no `.children`) are
  // a flat page — group them into one unlabelled card.
  const flatRows = [];
  for (const entry of items) {
    if (Array.isArray(entry.children) && entry.children.length > 0) {
      const rendered = renderSection(entry);
      if (rendered != null) {
        total += rendered.visibleCount;
        body.appendChild(rendered.element);
      }
    } else {
      flatRows.push(entry);
    }
  }
  if (flatRows.length > 0) {
    const rendered = renderFlatSection(flatRows);
    total += rendered.visibleCount;
    body.appendChild(rendered.element);
  }
  return total;
}

// Detect the `key="localCountry"` link in a Browse response, mount it
// as a prominent card at the top of the drill body, and return the
// row list with that entry filtered out so downstream renderers don't
// double-mount it. Search depth is one level: body[] root, then any
// section's `children`. Returns the original array unchanged when
// no localCountry row is found.
function liftLocalCountry(rawItems, body, json) {
  // Top-level scan first — c=local typically lays out the link as a
  // body-root sibling of the audio entries.
  for (let i = 0; i < rawItems.length; i++) {
    if (isLocalCountryEntry(rawItems[i])) {
      const card = renderLocalCountryCard(rawItems[i], json);
      if (card) body.appendChild(card);
      return rawItems.slice(0, i).concat(rawItems.slice(i + 1));
    }
  }
  // Section-children scan — some sectioned shapes nest the link
  // inside a `related`-like container. Drop it from the section's
  // children rather than the body[] so the section's other rows
  // still render normally.
  const out = rawItems.map((entry) => {
    if (!entry || !Array.isArray(entry.children)) return entry;
    const idx = entry.children.findIndex(isLocalCountryEntry);
    if (idx < 0) return entry;
    const card = renderLocalCountryCard(entry.children[idx], json);
    if (card) body.appendChild(card);
    const newKids = entry.children.slice(0, idx).concat(entry.children.slice(idx + 1));
    return { ...entry, children: newKids };
  });
  return out;
}

function isLocalCountryEntry(entry) {
  return !!entry && typeof entry === 'object' && entry.key === 'localCountry';
}

// Build the prominent "Browse all of <country>" card. Drills via the
// canonicalised URL (tunein-url.js stripping any magic params); the
// link is unclickable if the URL is missing or malformed (defensive
// — never seen in the wild but the response is service-emitted).
//
// The label prefers `entry.text` ("Germany"); if missing, the head
// title is the next-best signal. Final fallback is a bare "country
// root" so the affordance still surfaces.
function renderLocalCountryCard(entry, json) {
  const parts = drillPartsFor(entry);
  const drillable = parts != null;
  const card = document.createElement(drillable ? 'a' : 'span');
  card.className = drillable
    ? 'browse-local-country'
    : 'browse-local-country is-disabled';
  if (drillable) card.setAttribute('href', drillHashFor(parts));
  card.setAttribute('data-local-country', '1');

  const labelEl = document.createElement('span');
  labelEl.className = 'browse-local-country__label';
  const country = pickLocalCountryName(entry, json);
  labelEl.textContent = country
    ? `Browse all of ${country}`
    : 'Browse the country root';
  card.appendChild(labelEl);

  if (drillable) {
    const chev = document.createElement('span');
    chev.className = 'browse-local-country__chev';
    chev.appendChild(icon('arrow', 14));
    card.appendChild(chev);
  }
  return card;
}

function pickLocalCountryName(entry, json) {
  const t = entry && typeof entry.text === 'string' ? entry.text.trim() : '';
  if (t) return t;
  const headTitle = json && json.head && typeof json.head.title === 'string'
    ? json.head.title.trim()
    : '';
  // c=local responses use head.title="Local Radio" — useless as a
  // country name. Fall through to '' so the renderer picks the
  // generic affordance label.
  if (headTitle && !/^local radio$/i.test(headTitle)) return headTitle;
  return '';
}

// Render one API-emitted section as its own card. The section header
// reads the API's `text` verbatim (e.g. "Local Stations (2)" already
// includes a count, "Stations" does not — we don't second-guess the
// service). Pivot children (related section's `pivot*` rows) render
// as inline chips below the row list; cursor children (`next*`) are
// stripped — the cursor URL is captured for #76's pagination but
// nothing visible mounts in this slice.
//
// The section element carries `data-section` so the live-verification
// assertion (`document.querySelectorAll('[data-section]').length`)
// has a stable selector.
//
// Returns { element, visibleCount }. visibleCount counts rows the
// user sees — pivots and the cursor don't count.
export function renderSection(section) {
  const sectionKey = typeof section.key === 'string' ? section.key : '';
  const headerText = typeof section.text === 'string' ? section.text : '';

  const wrap = document.createElement('section');
  wrap.className = 'browse-section';
  wrap.setAttribute('data-section', sectionKey || 'unnamed');

  const h = document.createElement('h2');
  h.className = 'section-h section-h--inline';
  const title = document.createElement('span');
  title.className = 'section-h__title';
  title.textContent = headerText;
  h.appendChild(title);

  // Tail count meta — only emitted when the API hasn't already inlined
  // the count into the header text (e.g. "Local Stations (2)" already
  // has it; "Stations" doesn't).
  const visibleChildren = (section.children || []).filter((c) => {
    const t = classifyOutline(c);
    return t !== 'cursor' && t !== 'pivot' && t !== 'tombstone';
  });
  if (visibleChildren.length > 0 && !/\(\d+\)\s*$/.test(headerText)) {
    const meta = document.createElement('span');
    meta.className = 'section-h__meta';
    meta.textContent = `${visibleChildren.length.toLocaleString()} ${pluralize(visibleChildren.length)}`;
    h.appendChild(meta);
  }
  wrap.appendChild(h);

  // Row card. Show-drill sections (liveShow / topics) take a
  // specialised renderer: a liveShow's single p-prefix child needs the
  // Play icon (stationRow auto-attaches it for p/s/t guide_ids), and
  // topic rows need their duration formatted into the meta line.
  //
  // `related` is a special case: the section is curated cross-cuts
  // (pivots + canned nav links like `popular`, `localCountry`). Issue
  // #82 surfaces every visible child as a flat wrap-list of chips —
  // not stacked rows — so the section reads as a row of taps rather
  // than a list of full-width cards. The pivot-chips path below stays
  // disabled for `related` to avoid double-rendering.
  if (visibleChildren.length > 0) {
    if (sectionKey === 'liveShow') {
      wrap.appendChild(renderLiveShowCard(visibleChildren));
    } else if (sectionKey === 'topics') {
      wrap.appendChild(renderTopicsCard(visibleChildren));
    } else if (sectionKey === 'related') {
      wrap.appendChild(renderRelatedChips(section.children || []));
    } else {
      wrap.appendChild(renderCard(visibleChildren));
    }
  } else if (sectionKey === 'related') {
    // Pure-pivot related sections (visibleChildren empty because every
    // child classifies as 'pivot') still surface as chips.
    const onlyPivots = (section.children || []).filter((c) => {
      const t = classifyOutline(c);
      return t === 'pivot';
    });
    if (onlyPivots.length > 0) {
      wrap.appendChild(renderRelatedChips(section.children || []));
    }
  }

  // Pivot chips (any section other than `related` — the related path
  // above already folds pivots into its own chips wrap-list, so we
  // skip the dedicated pivot row there).
  if (sectionKey !== 'related') {
    const pivots = extractPivots(section);
    if (pivots.length > 0) {
      wrap.appendChild(renderPivotChips(pivots));
    }
  }

  // Footer placeholder for #76's "Load more" button. The cursor URL
  // is parked on the section node as a dataset attribute so #76 can
  // wire the button without a second classify pass.
  const cursorChild = (section.children || []).find((c) => classifyOutline(c) === 'cursor');
  const footer = document.createElement('div');
  footer.className = 'browse-section__footer';
  footer.setAttribute('data-section-footer', sectionKey || 'unnamed');
  if (cursorChild && typeof cursorChild.URL === 'string') {
    wrap.setAttribute('data-cursor-url', cursorChild.URL);
  }
  wrap.appendChild(footer);

  return { element: wrap, visibleCount: visibleChildren.length };
}

// Flat section — no header. Wraps the rows in a `.browse-section`
// for layout parity with the multi-section path so a paginated page
// 2 lays out identically to page 1 inside a section card. The
// `data-section="flat"` marker keeps the live-verification selector
// honest in the flat case too.
export function renderFlatSection(entries) {
  const visible = entries.filter((c) => {
    const t = classifyOutline(c);
    return t !== 'cursor' && t !== 'pivot' && t !== 'tombstone';
  });
  const wrap = document.createElement('section');
  wrap.className = 'browse-section';
  wrap.setAttribute('data-section', 'flat');

  // c=topics&id=p<N> drills surface as a flat body of t-prefix audio
  // outlines (no sectioned envelope). The Prev/Next classifier on the
  // now-playing view depends on the parent + topics-list cache being
  // primed before the user taps Play — the sectioned-only hook in
  // renderTopicsCard is unreachable on Bo's egress (c=pbrowse is gated;
  // see issue #84). Prime here so flat-body drills also feed the cache.
  // The helper filters internally — non-topic flat bodies write nothing.
  primeTuneinSkipCaches(visible);

  if (visible.length > 0) {
    wrap.appendChild(renderCard(visible));
  }

  const footer = document.createElement('div');
  footer.className = 'browse-section__footer';
  footer.setAttribute('data-section-footer', 'flat');
  wrap.appendChild(footer);

  // Capture the cursor URL on the section, same as the multi-section
  // path — #76 wires Load-more from this attribute.
  const cursorChild = entries.find((c) => classifyOutline(c) === 'cursor');
  if (cursorChild && typeof cursorChild.URL === 'string') {
    wrap.setAttribute('data-cursor-url', cursorChild.URL);
  }
  return { element: wrap, visibleCount: visible.length };
}

export function renderCard(entries) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const row = renderEntry(entries[i]);
    if (i === entries.length - 1) row.classList.add('is-last');
    card.appendChild(row);
  }
  return card;
}

// Compose the crumb token for a drill-parts object — same shape as
// browse.js's exported `crumbTokenFor`, duplicated here to avoid an
// import cycle (browse.js imports from this module). Tokens are
// `<anchor>` for plain drills and `<anchor>:<f1>+<f2>+…` for
// filter-bearing drills (#106); null when no anchor.
function crumbTokenForParts(parts) {
  if (!parts) return null;
  const anchor = (typeof parts.id === 'string' && parts.id !== '')
    ? parts.id
    : (typeof parts.c === 'string' && parts.c !== '' ? parts.c : '');
  if (!anchor) return null;
  const filters = filtersOfParts(parts);
  if (filters.length > 0) {
    return `${anchor}:${filters.join('+')}`;
  }
  return anchor;
}

// primeLabelForEntry — stash a row / chip's resolved label under
// `tunein.label.<crumbToken>` so the next navigation paints the
// breadcrumb / page title instantly. Every drillable row already
// carries the target's human label (`entry.text` / `norm.primary` —
// the text the user is reading); writing that text to the cache costs
// nothing and turns the otherwise-blank `r101821` raw-token flash on
// first visit into an immediate "Bayreuth" paint.
//
// Skips when:
//   - the entry has no usable drill parts (no anchor → no crumb token)
//   - the entry has no usable label text
//
// Terminal-entity rule (#117): for `station` / `topic` rows — audio
// leaves whose `URL` is a `Tune.ashx?id=<sid>` form — strip filter
// context from the cache token. The TuneIn service echoes the
// parent cursor's scoping filter (e.g. `&filter=s` for "stations
// only") back into every emitted row URL, including the leaf Tune
// URLs where the filter has no functional meaning. Caching "Folk
// Alley" under both `s10001` (page-0 visit) and `s10001:s`
// (cursor-emitted page-1 visit) double-keys the same logical entity.
// The entity name is identified by `guide_id`, not by how the user
// arrived — so terminal entities cache under the bare anchor.
//
// Drill rows (categories / regions / shows) keep the combined token:
// `r101821:g26` ("Bayreuth · Country") is a distinct page from
// `r101821` ("Bayreuth"), with its own human label, so the filter
// IS load-bearing state for those.
//
// Never fires a fetch — every value comes from data already in hand.
export function primeLabelForEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (!text) return;
  const parts = drillPartsFor(entry);
  const kind = classifyOutline(entry);
  const token = (kind === 'station' || kind === 'topic')
    ? bareAnchorToken(parts)
    : crumbTokenForParts(parts);
  if (!token) return;
  cache.set(`tunein.label.${token}`, text, TTL_LABEL);
}

// Anchor-only token (no filter suffix) — for caching terminal-entity
// labels whose identity is fully determined by their guide_id. See
// the #117 note on primeLabelForEntry.
function bareAnchorToken(parts) {
  if (!parts) return null;
  if (typeof parts.id === 'string' && parts.id !== '') return parts.id;
  if (typeof parts.c  === 'string' && parts.c  !== '') return parts.c;
  return null;
}

// primeLabelForChip — same idea as primeLabelForEntry, but tailored to
// chip semantics: filter-bearing chips' text labels the FILTER axis
// (e.g. "Country" for `?id=r101821&filter=g26`), not the combined
// node. So we write `tunein.label.<filter>` = chip text for the
// filter-bearing case, and `tunein.label.<crumbToken>` = chip text for
// plain drill chips. Writing the combined token from a filter-bearing
// chip would mislead the h1 / current-segment renderer.
//
// Multi-filter (#106): when a chip's parts carry multiple filters
// (rare — typical upstream pivot URLs emit one axis value per chip),
// the chip's text labels the last (newest) filter only. Earlier
// filters are inherited from the current page and already have their
// own cached labels.
export function primeLabelForChip(parts, label) {
  if (!parts || typeof label !== 'string') return;
  const text = label.trim();
  if (!text) return;
  const filters = filtersOfParts(parts);
  if (filters.length > 0) {
    const newFilter = filters[filters.length - 1];
    cache.set(`tunein.label.${newFilter}`, text, TTL_LABEL);
    return;
  }
  const token = crumbTokenForParts(parts);
  if (!token) return;
  cache.set(`tunein.label.${token}`, text, TTL_LABEL);
}

// Mine each topic outline for its `sid=p<N>` parent + collect the
// ordered topic-id list. When at least one parent emerges (typical for
// `c=pbrowse&id=p<N>` and `c=topics&id=p<N>` responses, which share the
// same outline shape), write:
//   - one `tunein.parent.<t<N>>` per topic
//   - one `tunein.topics.<p<N>>` for the show (when the list has ≥1
//     entry — the classifier itself still requires ≥2 to enable skip)
// Tolerates rows with no URL (rare, but seen on hand-rolled fixtures).
export function primeTuneinSkipCaches(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  let parent = null;
  const ids = [];
  for (const entry of entries) {
    const gid = entry && typeof entry.guide_id === 'string' ? entry.guide_id : '';
    if (!/^t\d+$/.test(gid)) continue;
    ids.push(gid);
    const p = extractParentShowId(entry);
    if (p) {
      if (!parent) parent = p;
      cache.set(tuneinParentKey(gid), p, TTL_LABEL);
    }
    // #102: stash the resolved episode title so the now-playing skip
    // path can ship a `name` to /play instead of the raw guide_id.
    const text = entry && typeof entry.text === 'string' ? entry.text.trim() : '';
    if (text) cache.set(tuneinTopicNameKey(gid), text, TTL_LABEL);
  }
  if (parent && ids.length > 0) {
    cache.set(tuneinTopicsKey(parent), ids, TTL_DRILL_HEAD);
  }
}

// Pivot chips render inline below the related section. Each chip is
// an anchor whose href goes through canonicaliseBrowseUrl so the
// language-tree rewrite (§ 7.3) and magic-param strip (§ 7.4) happen
// once at the seam.
//
// Multi-filter (#106): when the current page already carries filters,
// the chip's filter is APPENDED to the existing list rather than
// replacing it — so chaining `Bayreuth → +Country → +German` lands on
// `?id=r101821&filter=g26,l170`. The chip's URL-derived parts hold the
// new filter axis (typically one value); the merge happens at href
// composition time, the label-cache prime stays keyed on the new
// filter only (`primeLabelForChip` writes the bare filter key).
export function renderPivotChips(pivots) {
  const wrap = document.createElement('div');
  wrap.className = 'browse-pivots';
  for (const pivot of pivots) {
    const parts = drillPartsForUrl(pivot.url);
    const chip = document.createElement(parts ? 'a' : 'span');
    chip.className = parts ? 'browse-pivot' : 'browse-pivot is-disabled';
    if (parts) chip.setAttribute('href', drillHashFor(mergeFiltersFromCurrent(parts)));
    chip.textContent = pivot.label || `pivot=${pivot.axis}`;
    chip.setAttribute('data-pivot-axis', pivot.axis);
    // Issue #105: pivot chips' text labels the axis value (e.g.
    // "Country" for a filter-bearing chip, "Bayreuth" for a plain
    // drill chip). primeLabelForChip picks the right cache key — the
    // bare filter (axis value) when the chip is filter-bearing.
    if (parts) primeLabelForChip(parts, pivot.label);
    wrap.appendChild(chip);
  }
  return wrap;
}

// Merge the current page's filters into a chip's parts so chaining
// refinement chips stacks rather than replaces. Pure: returns a fresh
// parts object, never mutates input. New filters from the chip are
// appended after the current page's filters (deduped — TuneIn's
// upstream accepts repeats but emitting the same filter twice is just
// noise on the wire).
function mergeFiltersFromCurrent(chipParts) {
  if (!_currentParts) return chipParts;
  const current = filtersOfParts(_currentParts);
  if (current.length === 0) return chipParts;
  const chipFilters = filtersOfParts(chipParts);
  const seen = new Set();
  const merged = [];
  for (const f of current.concat(chipFilters)) {
    if (typeof f !== 'string' || f === '' || seen.has(f)) continue;
    seen.add(f);
    merged.push(f);
  }
  const out = Object.assign({}, chipParts);
  // Reset filter fields then re-stamp from the merged list.
  delete out.filter;
  delete out.filters;
  if (merged.length > 0) {
    out.filters = merged;
    out.filter  = merged.join(',');
  }
  return out;
}

// Render every visible child of a `related` section as a flat wrap-
// list of chips (issue #82). Mixes `pivot*` rows, `popular`/
// `localCountry` nav rows, and any drill/show/station children into
// one row — the section reads as a quick set of jumps rather than a
// list of stacked rows. Cursors and tombstones are skipped; URLs go
// through canonicaliseBrowseUrl via drillPartsForUrl so the
// language-tree rewrite happens once at the seam.
//
// Chips reuse the `.browse-pivot` class so CSS treats them the same
// as the pivot chips that already shipped — visual parity, no extra
// stylesheet entries. Each chip carries `data-chip-kind` (pivot /
// nav / drill / station / show) so tests can target by intent.
export function renderRelatedChips(children) {
  const wrap = document.createElement('div');
  wrap.className = 'browse-pivots browse-related';
  for (const entry of children || []) {
    const kind = classifyOutline(entry);
    if (kind === 'cursor' || kind === 'tombstone') continue;
    const parts = drillPartsFor(entry);
    const chip = document.createElement(parts ? 'a' : 'span');
    chip.className = parts ? 'browse-pivot' : 'browse-pivot is-disabled';
    // Multi-filter (#106): refinement chips append to the current
    // page's filters so chaining filter chips stacks rather than
    // replaces. Plain drill chips (no filter axis) pass through
    // unchanged.
    if (parts) chip.setAttribute('href', drillHashFor(mergeFiltersFromCurrent(parts)));
    chip.setAttribute('data-chip-kind', kind);
    if (kind === 'pivot') {
      const k = typeof entry.key === 'string' ? entry.key : '';
      const axis = k.startsWith('pivot') ? k.slice('pivot'.length).toLowerCase() : '';
      if (axis) chip.setAttribute('data-pivot-axis', axis);
    }
    const text = (entry && typeof entry.text === 'string') ? entry.text : '';
    chip.textContent = text || (parts && (parts.id || parts.c)) || '(unnamed)';
    // Issue #105: prime the label cache from the chip's text. For
    // filter-bearing chips the text labels the filter axis; for plain
    // drill chips it labels the target node. primeLabelForChip picks
    // the right key.
    if (parts && text) primeLabelForChip(parts, text);
    wrap.appendChild(chip);
  }
  return wrap;
}

// Public for tests. Returns ONE row element shaped by the entry's
// classification:
//
//   station / topic — .station-row (full art + meta + chevron)
//   show           — .station-row (same shape — shows are playable)
//   drill          — .browse-row (id badge + label + chevron)
//   pivot          — .browse-pivot (rendered separately as chips,
//                    but the helper is reachable for completeness)
//   nav            — .browse-row (acts like a drill — a curated
//                    sibling jump)
//   cursor / tombstone — disabled label (these should be filtered
//                    out before renderEntry is called; we still
//                    render something sensible if a caller passes
//                    one in)
export function renderEntry(entry) {
  const kind = classifyOutline(entry);
  const norm = normaliseRow(entry);

  let node;
  if (kind === 'station' || kind === 'topic') {
    node = stationRow({
      sid:      norm.id || entry.guide_id || '',
      name:     norm.primary,
      art:      norm.image,
      location: norm.secondary,
      bitrate:  entry && entry.bitrate,
      codec:    entry && entry.formats,
      tertiary: norm.tertiary,
      badges:   norm.badges,
      chips:    norm.chips,
    });
  } else if (kind === 'show') {
    // Shows are drill-into-detail, not direct play. Reuse stationRow
    // for layout parity but the URL goes through the drill hash.
    node = showRow(entry, norm);
  } else if (kind === 'tombstone') {
    node = disabledRow(norm.primary || '(unavailable)');
  } else {
    // drill / pivot / nav / cursor all fall through to the
    // browse-row shape. Pivot/cursor entries shouldn't reach here in
    // the multi-section path (they're stripped or chip-rendered) but
    // we keep the fallback honest.
    node = drillRow(entry, norm, kind);
  }
  // Stash the raw outline so the page-top filter can match against
  // text / subtext / playing / current_track without a re-classify
  // pass. Property (not attribute) so the wire format stays clean.
  node._outline = entry;
  // Issue #105: prime the label cache from this row's drill target.
  // The row's text is the human label of the node it links into; one
  // cache write here means the next navigation paints the breadcrumb
  // current-segment instantly instead of flashing the raw token.
  // Skipped for tombstones (no drill) inside the helper.
  primeLabelForEntry(entry);
  return node;
}

// Show rows reuse the station-row layout (art + name + secondary line
// + chevron) but route to a browse-drill hash, since shows are an
// `id=p<NNN>` browse target rather than a direct stream.
function showRow(entry, norm) {
  const id = norm.id || (entry && entry.guide_id) || '';
  const row = document.createElement('a');
  row.className = 'station-row';
  // Shows live under Browse.ashx — drill, don't tune.
  const parts = drillPartsFor(entry) || (id ? { id } : null);
  row.setAttribute('href', parts ? drillHashFor(parts) : '#');
  if (id) row.setAttribute('data-sid', id);

  // Inline the station-row internals so we don't pull in stationRow's
  // tuning-anchor assumption. Reuses the same CSS classes for visual
  // parity with station rows.
  const art = document.createElement('span');
  art.className = 'station-art';
  art.setAttribute('style', 'width:40px;height:40px');
  if (norm.image) {
    const img = document.createElement('img');
    img.className = 'station-art__img';
    img.setAttribute('loading', 'lazy');
    img.setAttribute('src', norm.image);
    img.setAttribute('alt', norm.primary || id || '');
    art.appendChild(img);
  }
  row.appendChild(art);

  const body = document.createElement('span');
  body.className = 'station-row__body';
  const nameEl = document.createElement('span');
  nameEl.className = 'station-row__name';
  nameEl.textContent = norm.primary || id || '';
  body.appendChild(nameEl);
  if (norm.secondary) {
    const meta = document.createElement('span');
    meta.className = 'station-row__meta';
    const loc = document.createElement('span');
    loc.className = 'station-row__loc';
    loc.textContent = norm.secondary;
    meta.appendChild(loc);
    body.appendChild(meta);
  }
  row.appendChild(body);

  const chev = document.createElement('span');
  chev.className = 'station-row__chev';
  chev.appendChild(icon('arrow', 14));
  row.appendChild(chev);
  return row;
}

// Drill row: id badge + label + optional count + chevron. URL goes
// through canonicaliseBrowseUrl so the language-tree rewrite
// (§ 7.3) and magic-param strip (§ 7.4) happen once, at the seam
// where API-emitted URLs cross into client-emitted URLs.
function drillRow(entry, norm, _kind) {
  const drillParts = drillPartsFor(entry);
  const drillable = drillParts != null;
  const row = document.createElement(drillable ? 'a' : 'span');
  row.className = drillable ? 'browse-row' : 'browse-row is-disabled';
  if (drillable) row.setAttribute('href', drillHashFor(drillParts));

  const badgeText = drillParts
    ? (drillParts.id || (drillParts.c ? `c=${drillParts.c}` : ''))
    : '';

  const idBadge = document.createElement('span');
  idBadge.className = 'browse-row__id';
  idBadge.textContent = badgeText;
  row.appendChild(idBadge);

  const label = document.createElement('span');
  label.className = 'browse-row__label';
  label.textContent = norm.primary || badgeText || '(unnamed)';
  row.appendChild(label);

  // Some Browse.ashx entries surface a child count via count /
  // station_count / item_count. When present, render the
  // right-aligned count badge. Country rows on the live r-list
  // wire do NOT emit any of these keys (verified end-to-end via
  // Bo's CGI proxy against r0 → Europe → r101312 / r100373 /
  // r100290 / r101274 / r100346 — see issue #85), so this branch
  // mainly fires for genre / podcast nodes that do carry counts.
  const count = countOf(entry);
  if (count != null) {
    const c = document.createElement('span');
    c.className = 'browse-row__count';
    c.textContent = count.toLocaleString();
    row.appendChild(c);
  }

  if (drillable) {
    const chev = document.createElement('span');
    chev.className = 'browse-row__chev';
    chev.appendChild(icon('arrow', 14));
    row.appendChild(chev);
  }
  return row;
}

function disabledRow(text) {
  const span = document.createElement('span');
  span.className = 'browse-row is-disabled';
  const label = document.createElement('span');
  label.className = 'browse-row__label';
  label.textContent = text;
  span.appendChild(label);
  return span;
}

// Pick the drill parts for a link entry: prefer the canonicalised URL
// (which honours the language-tree rewrite); fall back to bare
// guide_id when the entry has no URL. Returns null if neither is
// usable — the caller renders a disabled row.
export function drillPartsFor(entry) {
  if (!entry) return null;
  const urlParts = drillPartsForUrl(entry.URL);
  if (urlParts) return urlParts;
  if (typeof entry.guide_id === 'string' && entry.guide_id !== '') {
    return { id: entry.guide_id };
  }
  return null;
}

// drillPartsForUrl — same logic as drillPartsFor's URL branch, but
// for callers that only hold a URL string (pivot chips). Returns
// null when the URL is empty, malformed, or yields no drill keys.
export function drillPartsForUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return null;
  try {
    const canonical = canonicaliseBrowseUrl(rawUrl);
    const parts = extractDrillKey(canonical);
    if (parts.id || parts.c) return parts;
  } catch (_err) {
    // Fall through.
  }
  return null;
}

function countOf(entry) {
  if (!entry) return null;
  // TuneIn occasionally uses these keys for child counts.
  for (const k of ['count', 'station_count', 'item_count']) {
    const v = entry[k];
    if (typeof v === 'number' && v > 0) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}
