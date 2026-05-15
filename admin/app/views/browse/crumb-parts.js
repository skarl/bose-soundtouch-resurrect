// crumb-parts — the Crumb stack value type plus its label-resolution
// read-side. Pure: no DOM, no fetch, no api.js. The companion
// `crumb-renderer.js` owns the DOM pillbar + async label hydration that
// builds on these primitives.
//
// What lives here:
//   - Value type: `parts` (drill state) ↔ crumb token ↔ `from=…` stack.
//     parseCrumbs / stringifyCrumbs, crumbTokenFor / partsFromCrumb,
//     pickDrillParts, filtersOf / setFilters, MAX_CRUMBS.
//   - Label readers (no fetch): initialHeaderTitle, initialCrumbLabel,
//     initialFilterLabel, crumbLabelFor, backAriaLabel.
//   - URL composers: backHrefFor (pops the rightmost crumb).
//   - Tab-token override table: TAB_LABEL_BY_TOKEN.
//
// Only dependencies allowed by issue #124: tunein-cache.js (label cache
// reads) and tunein-url.js (lcodeLabel for the language catalogue).
// Anything that touches the DOM, kicks a Describe / Browse fetch, or
// patches a rendered crumb lives in `crumb-renderer.js`.

import { lcodeLabel } from '../../tunein-url.js';
import { cache } from '../../tunein-cache.js';

// Maximum depth of the URL crumb stack (`from=...`). Deeper than the
// deepest observed location-tree depth (5); see issue #74 notes. Any
// crumbs beyond this are dropped from the head of the stack.
export const MAX_CRUMBS = 8;

// Trail label override for the entry-point tab tokens. The first
// crumb on any rooted drill is the tab — the spec wants its label
// to read as the tab name (`Genre` / `Location` / `Language`), not
// the cached API title ("Music" / "By Location" / "By Language").
// Matched against the bare anchor portion of a crumb token; tokens
// with an `:lXXX` filter suffix fall through to the cache /
// catalogue path so e.g. `lang:l109` still resolves to "German".
export const TAB_LABEL_BY_TOKEN = Object.freeze({
  music: 'Genre',
  r0:    'Location',
  lang:  'Language',
});

// ---- value type: parts + crumb token --------------------------------

// Parse the comma-separated `from=` query parameter into an array of
// crumb tokens. Empty / missing input returns []. Trims, drops empty
// segments, caps to MAX_CRUMBS by keeping the tail (the most recent
// crumbs — the ones closest to the current node).
export function parseCrumbs(raw) {
  if (typeof raw !== 'string' || raw === '') return [];
  const segs = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return segs.length > MAX_CRUMBS ? segs.slice(segs.length - MAX_CRUMBS) : segs;
}

// Inverse of parseCrumbs: stringify the crumb array into a `from=`
// value. Returns '' for an empty array so callers can skip emitting
// the parameter entirely.
export function stringifyCrumbs(crumbs) {
  if (!Array.isArray(crumbs) || crumbs.length === 0) return '';
  return crumbs.join(',');
}

// Helpers for the `filters` array shape. Always returns a fresh array
// of trimmed non-empty strings. Tolerates legacy callers still passing
// `parts.filter` as a single string (or a pre-joined comma list).
export function filtersOf(parts) {
  if (!parts) return [];
  if (Array.isArray(parts.filters)) {
    return parts.filters.filter((s) => typeof s === 'string' && s !== '');
  }
  if (typeof parts.filter === 'string' && parts.filter !== '') {
    return parts.filter.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// Joined-string view of filtersOf — the wire form `l109,g22`. Prefers
// `parts.filters: string[]` (the canonical multi-value form); falls
// back to the legacy `parts.filter: string` verbatim. Empty → ''.
export function joinFilters(parts) {
  if (!parts) return '';
  if (Array.isArray(parts.filters)) {
    const cleaned = parts.filters.filter((s) => typeof s === 'string' && s !== '');
    return cleaned.join(',');
  }
  if (typeof parts.filter === 'string' && parts.filter !== '') return parts.filter;
  return '';
}

// Stash a `filters: string[]` (and back-compat `filter: string`) on a
// parts object. Empty arrays drop both fields so the URL composer emits
// the bare drill (no `filter=` param).
export function setFilters(parts, list) {
  const cleaned = (Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s !== '');
  if (cleaned.length > 0) {
    parts.filters = cleaned;
    parts.filter  = cleaned.join(',');
  } else {
    delete parts.filters;
    delete parts.filter;
  }
  return parts;
}

// Crumb token for a drill-parts object. The token is the value the
// user would land on if they clicked Back to this level: prefer `id`,
// fall back to `c`. When filters accompany the anchor we encode them
// as `<anchor>:<f1>+<f2>+…` so two drills that share the same anchor
// but differ in their filters (e.g. the language tree, where every
// level emits `c=lang` or `c=music` with a different `filter=l<NNN>`)
// produce distinct, navigable crumbs (#89, #106). pivots / offsets
// remain refinements that do not become crumbs.
// Returns null when neither anchor is set (root view).
export function crumbTokenFor(parts) {
  if (!parts) return null;
  let anchor = '';
  if (typeof parts.id === 'string' && parts.id !== '') anchor = parts.id;
  else if (typeof parts.c === 'string' && parts.c !== '') anchor = parts.c;
  if (!anchor) return null;
  const filters = filtersOf(parts);
  if (filters.length > 0) {
    return `${anchor}:${filters.join('+')}`;
  }
  return anchor;
}

// Inverse of crumbTokenFor: turn a crumb token back into the drill
// parts the user should land on. Heuristic:
//   - bare tokens matching /^[a-z]\d+$/ are guide_ids (`id=` anchor)
//   - bare tokens otherwise are category short names (`c=`)
//   - tokens with a `:f1+f2+…` suffix attach N filters to whichever
//     anchor form applies (so `lang:l109` → `{c:'lang', filters:['l109']}`,
//     `r101821:g26+l170` → `{id:'r101821', filters:['g26','l170']}`)
export function partsFromCrumb(token) {
  if (typeof token !== 'string' || token === '') return null;
  const colonIdx = token.indexOf(':');
  let anchor = token;
  let filterRaw = '';
  if (colonIdx >= 0) {
    anchor = token.slice(0, colonIdx);
    filterRaw = token.slice(colonIdx + 1);
  }
  if (!anchor) return null;
  const parts = /^[a-z]\d+$/.test(anchor) ? { id: anchor } : { c: anchor };
  if (filterRaw) {
    const list = filterRaw.split('+').map((s) => s.trim()).filter(Boolean);
    setFilters(parts, list);
  }
  return parts;
}

// A drill URL can carry any of {id, c, filter, pivot, offset}. The
// presence of `id` or `c` is the load-bearing signal; the others
// modify the drill. The URL's `filter=` may be comma-separated values
// (multi-filter wire shape, #106); the resulting parts object carries
// `filters: string[]` plus back-compat `filter: string`. Returns null
// when neither anchor is set (root view).
export function pickDrillParts(query) {
  if (!query || (typeof query.id !== 'string' && typeof query.c !== 'string')) {
    return null;
  }
  const out = {};
  for (const key of ['id', 'c', 'pivot', 'offset']) {
    if (typeof query[key] === 'string' && query[key] !== '') out[key] = query[key];
  }
  if (typeof query.filter === 'string' && query.filter !== '') {
    const list = query.filter.split(',').map((s) => s.trim()).filter(Boolean);
    setFilters(out, list);
  }
  return out;
}

// Display label for the drill crumb — a compact form of the parts.
// `c=music&filter=l216` reads more usefully than just `music`. When
// the filter is an lcode (`l<NNN>`) and we have a cached language
// name for it, append the human form so end users get an at-a-glance
// translation of the otherwise opaque numeric filter (#90). With
// multi-filter drills (#106) the comma-joined wire value is shown;
// a single-lcode filter still resolves to its language name.
export function crumbLabelFor(parts) {
  const segs = [];
  const filters = filtersOf(parts);
  const filterStr = filters.join(',');
  if (parts.id) segs.push(parts.id);
  if (parts.c)  segs.push(`c=${parts.c}`);
  if (filterStr) segs.push(`filter=${filterStr}`);
  if (parts.pivot)  segs.push(`pivot=${parts.pivot}`);
  if (parts.offset) segs.push(`offset=${parts.offset}`);
  let label = segs.join(' · ');
  if (filters.length === 1 && /^l\d+$/.test(filters[0])) {
    const name = lcodeLabel(filters[0]);
    if (name) label += ` (${name})`;
  }
  return label;
}

// Pure URL composer for the SPA-internal drill hash. Mirrors
// outline-render's drillHashFor but takes the crumb prefix explicitly
// instead of reading the module-level `_childCrumbs` — this is the
// pure surface backHrefFor needs (crumb-parts.js may not depend on
// outline-render.js, which is DOM-bound).
function drillHash(parts, crumbs) {
  const qs = new URLSearchParams();
  if (parts.id)     qs.set('id', parts.id);
  if (parts.c)      qs.set('c', parts.c);
  const filters = filtersOf(parts);
  if (filters.length > 0) qs.set('filter', filters.join(','));
  if (parts.pivot)  qs.set('pivot', parts.pivot);
  if (parts.offset) qs.set('offset', parts.offset);
  const fromStr = stringifyCrumbs(crumbs);
  if (fromStr) qs.set('from', fromStr);
  return `#/browse?${qs.toString()}`;
}

// Compose the Back-button href. Pops the rightmost crumb and navigates
// to it; the popped crumb keeps the remaining stack as its own `from=`.
// An empty stack lands at #/browse (the root tabs view).
export function backHrefFor(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return '#/browse';
  const head = stack.slice(0, -1);
  const tail = stack[stack.length - 1];
  const parts = partsFromCrumb(tail);
  if (!parts) return '#/browse';
  return drillHash(parts, head);
}

// Initial page-header title before the API response arrives. Prefer
// the cached label for this node's token; fall back to crumbLabelFor
// so the user sees *something* during the load.
//
// Filter-bearing tokens (`<anchor>:<filter>`) try the bare anchor too:
// the page IS the anchor node (just filtered), so a cached title for
// `r101821` should surface as the h1 / current-crumb text for the
// `r101821:g26` drill too. The filter surface is the badge, not the
// title.
export function initialHeaderTitle(parts, token) {
  if (token) {
    const cached = cache.get(`tunein.label.${token}`);
    if (typeof cached === 'string' && cached !== '') return cached;
    const colon = token.indexOf(':');
    if (colon > 0) {
      const bare = token.slice(0, colon);
      const cachedBare = cache.get(`tunein.label.${bare}`);
      if (typeof cachedBare === 'string' && cachedBare !== '') return cachedBare;
    }
  }
  return crumbLabelFor(parts);
}

// Pick the best already-known label for a crumb token without doing
// any network work. Order of preference for ancestors:
//   - tab-token override (only at stack[0] — the entry-point tab)
//   - cached label under `tunein.label.<token>` (from a previous
//     resolve)
//   - in-memory lcode catalogue (free for `<anchor>:l<NNN>` tokens)
//   - raw token fallback
// The async hydrateCrumbLabels path (in crumb-renderer) upgrades any
// token still rendered as raw once its Describe / Browse lookup
// completes.
export function initialCrumbLabel(token, parts, isFirstInStack) {
  // The first crumb in the stack is the entry-point tab — render it
  // with the tab's display label (`Genre` / `Location` / `Language`)
  // rather than the cached API title ("Music" / "By Location" / "By
  // Language"). Filter-bearing tokens (`lang:lXXX`) intentionally
  // fall through to the catalogue path so they read as the language
  // name, not "Language".
  if (isFirstInStack) {
    const bareAnchor = parts && typeof parts.id === 'string'
      ? parts.id
      : (parts && typeof parts.c === 'string' ? parts.c : '');
    const isFilterBearing = parts && typeof parts.filter === 'string' && parts.filter !== '';
    if (!isFilterBearing && bareAnchor && TAB_LABEL_BY_TOKEN[bareAnchor]) {
      return TAB_LABEL_BY_TOKEN[bareAnchor];
    }
  }
  const cached = cache.get(`tunein.label.${token}`);
  if (typeof cached === 'string' && cached !== '') return cached;
  if (parts && typeof parts.filter === 'string' && /^l\d+$/.test(parts.filter)) {
    const name = lcodeLabel(parts.filter);
    if (name) return name;
  }
  return token;
}

// Pick the best already-known label for a filter token without any
// network work. Mirrors the trail's `initialCrumbLabel` ladder for the
// filter-only case: lcode catalogue for `lXXX`, then the cache, then
// the raw token as a last resort.
export function initialFilterLabel(filterToken) {
  if (/^l\d+$/.test(filterToken)) {
    const name = lcodeLabel(filterToken);
    if (name) return name;
  }
  const cached = cache.get(`tunein.label.${filterToken}`);
  if (typeof cached === 'string' && cached !== '') return cached;
  return filterToken;
}

// Compose the Back chevron's aria-label from the popped destination.
// Empty stack → root tabs view ("Back to Browse"). Otherwise the
// destination is the last crumb in the stack; prefer the resolved
// label (cache / catalogue) and fall back to the raw token.
export function backAriaLabel(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return 'Back to Browse';
  const destToken = stack[stack.length - 1];
  if (!destToken) return 'Back to Browse';
  const destParts = partsFromCrumb(destToken);
  // The last crumb in the stack is the trail's tail-before-current —
  // it's an ancestor, not the entry-point tab, so isFirstInStack is
  // only relevant when stack length is 1.
  const label = initialCrumbLabel(destToken, destParts, stack.length === 1);
  return `Back to ${label}`;
}
