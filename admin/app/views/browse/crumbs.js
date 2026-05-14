// crumbs — the URL crumb stack as a self-contained module. Owns the
// `parts` value type (the canonical drill-state shape passed around the
// browser), the crumb token parser/emitter pair (parseCrumbs /
// stringifyCrumbs, crumbTokenFor / partsFromCrumb), the pill-bar
// renderer with its inline trail + filter badges (renderPillBar,
// renderCrumbTrail, renderFilterBadges, renderFilterBadge), and the
// async label hydration that upgrades raw-token renderings to
// human-readable names once Describe/Browse resolves (hydrateCrumbLabels,
// hydrateFilterLabel, patchTrailCrumb, patchBackAria,
// resolveLabelAndApply).
//
// The companion `views/browse.js` mounts the view; this module owns
// everything below the mount boundary that deals with crumb-state
// arithmetic.

import { tuneinBrowse, tuneinDescribe } from '../../api.js';
import { icon } from '../../icons.js';
import { lcodeLabel } from '../../tunein-url.js';
import { cache, TTL_LABEL } from '../../tunein-cache.js';

import { drillHashFor } from './outline-render.js';

// Maximum depth of the URL crumb stack (`from=...`). Deeper than the
// deepest observed location-tree depth (5); see issue #74 notes. Any
// crumbs beyond this are dropped from the head of the stack.
export const MAX_CRUMBS = 8;

// Maximum number of `Describe.ashx?id=<X>` calls in flight at once
// during cold-load label-fill. Matches MAX_CRUMBS so the worst case
// (a fully-deep shared URL with no cached labels) saturates in one
// wave.
const DESCRIBE_CONCURRENCY = 5;

// Trail label override for the entry-point tab tokens. The first
// crumb on any rooted drill is the tab — the spec wants its label
// to read as the tab name (`Genre` / `Location` / `Language`), not
// the cached API title ("Music" / "By Location" / "By Language").
// Matched against the bare anchor portion of a crumb token; tokens
// with an `:lXXX` filter suffix fall through to the cache /
// catalogue path so e.g. `lang:l109` still resolves to "German".
const TAB_LABEL_BY_TOKEN = Object.freeze({
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

// Compose the Back-button href. Pops the rightmost crumb and navigates
// to it; the popped crumb keeps the remaining stack as its own `from=`.
// An empty stack lands at #/browse (the root tabs view).
export function backHrefFor(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return '#/browse';
  const head = stack.slice(0, -1);
  const tail = stack[stack.length - 1];
  const parts = partsFromCrumb(tail);
  if (!parts) return '#/browse';
  // Always pass the trimmed crumb stack explicitly so we don't pick up
  // a stale value of _childCrumbs (set later, after this Back-link is
  // built — but we want backHref deterministic regardless of order).
  return drillHashFor(parts, head);
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

// ---- pill bar + inline trail (top of every drill body) -------------
//
// The pill bar replaces the old standalone Back link + standalone
// crumb trail with a single horizontal row: a circular chevron-only
// Back affordance leads, followed by an inline breadcrumb
// `Browse › <Tab> › <Ancestor> › <Current>`. The current segment is
// the bolded, non-link tail; earlier segments stay anchors whose
// hashes match the ones the old trail emitted, so Back/forward
// history continues to pop the same stack.
//
// Composition for the trail:
//   1. literal `Browse` (entry-point anchor → `#/browse`)
//   2. one anchor per crumb in the stack — stack[0] gets the
//      TAB_LABEL_BY_TOKEN override when its bare anchor matches
//      a tab token (`music` / `r0` / `lang`); other crumbs read
//      from the cache / lcode catalogue / raw-token fallback
//      ladder.
//   3. the current node as a bolded non-link `<span>` with
//      `aria-current="page"`.

export function renderPillBar(parts, stack) {
  const bar = document.createElement('div');
  bar.className = 'browse-bar';

  // Back chevron — circular pill, glyph only. aria-label carries the
  // destination derived from backHrefFor (so it stays in sync with
  // the popped target). When the destination is the root tabs view,
  // we read "Back to Browse"; otherwise the destination crumb's
  // label is used.
  const back = document.createElement('a');
  back.className = 'browse-bar__back';
  back.href = backHrefFor(stack);
  back.setAttribute('aria-label', backAriaLabel(stack));
  // Marker for hydrateCrumbLabels to re-stamp the aria-label once the
  // destination crumb's title resolves.
  if (Array.isArray(stack) && stack.length > 0) {
    back.dataset.backToken = stack[stack.length - 1];
  }
  back.appendChild(icon('chevron-left', 16));
  bar.appendChild(back);

  const trail = renderCrumbTrail(stack, parts);
  bar.appendChild(trail);

  // Active-filter badges — mounted in-bar, peers to the trail (#104,
  // #106). One badge per filter in `parts.filters`; each carries the
  // resolved filter label + a × close affordance that navigates to the
  // same drill minus that filter only (the other filters + stack + id
  // are preserved).
  const badges = renderFilterBadges(parts, stack);
  for (const badge of badges) bar.appendChild(badge);

  // Sub-handle accessors for the drill frame (hydrateCrumbLabels
  // mutates the trail anchors + the back aria-label in place).
  bar._back = back;
  bar._trail = trail;
  // Back-compat: `_filter` points at the first badge so single-filter
  // callers keep working. Multi-filter callers should read `_badges`.
  bar._filter = badges[0] || null;
  bar._badges = badges;
  return bar;
}

// Build the active-filter badges for the pill bar. Returns an array
// (possibly empty) of badge nodes — one per filter in `parts.filters`.
// Each badge mounts as a peer of the trail inside the bar, carrying
// the resolved filter label and a trailing × close affordance that
// navigates to the same drill MINUS THIS ONE FILTER (the other
// filters + stack + primary anchor are preserved). When all filters
// are dropped, the URL reverts to the bare drill (#106).
//
// Label resolution order — same ladder hydrateCrumbLabels uses for
// trail anchors:
//   1. lcode catalogue for `lXXX` filters (instant, no fetch).
//   2. cache lookup `tunein.label.<filter>` (a previous Describe /
//      Browse landed and stashed the title).
//   3. raw token while a one-shot Describe / Browse runs in the
//      background; the badge text upgrades in place when the title
//      resolves.
export function renderFilterBadges(parts, stack) {
  const filters = filtersOf(parts);
  if (filters.length === 0) return [];
  const stackArr = Array.isArray(stack) ? stack : [];
  const out = [];
  for (const filterToken of filters) {
    out.push(buildFilterBadge(filterToken, parts, filters, stackArr));
  }
  return out;
}

// Build one badge node for `filterToken`, given the full filter list
// and current parts / stack so the × close anchor can drop only this
// filter while preserving the rest.
function buildFilterBadge(filterToken, parts, filters, stack) {
  const badge = document.createElement('span');
  badge.className = 'browse-bar__filter';
  badge.dataset.filterToken = filterToken;

  const label = document.createElement('span');
  label.className = 'browse-bar__filter-label';
  label.textContent = initialFilterLabel(filterToken);
  badge.appendChild(label);

  // × close affordance — anchor that navigates to the same drill with
  // this filter dropped (the others are preserved). When the last
  // filter is removed the URL reverts to the bare drill.
  const remaining = filters.filter((f) => f !== filterToken);
  const stripped = Object.assign({}, parts);
  setFilters(stripped, remaining);
  const close = document.createElement('a');
  close.className = 'browse-bar__filter-close';
  close.setAttribute('href', drillHashFor(stripped, stack));
  close.setAttribute('aria-label', 'Remove filter');
  close.appendChild(icon('x', 12));
  badge.appendChild(close);

  // Stash sub-handles for the hydrator to patch the label in place.
  badge._label = label;
  badge._close = close;

  // Kick off async label hydration when the initial label is still the
  // raw token (no cache hit, no catalogue hit). The hydrator writes the
  // resolved title back into the cache so subsequent navigations land
  // pre-resolved.
  if (label.textContent === filterToken) {
    hydrateFilterLabel(filterToken, badge);
  }

  return badge;
}

// Back-compat shim: legacy callers expect a single badge node (or
// null) for a single-filter drill. Wraps renderFilterBadges and
// returns its first element. New code should consume the array form
// directly via renderFilterBadges.
export function renderFilterBadge(parts, stack) {
  const badges = renderFilterBadges(parts, stack);
  return badges.length > 0 ? badges[0] : null;
}

// Pick the best already-known label for a filter token without any
// network work. Mirrors the trail's `initialCrumbLabel` ladder for the
// filter-only case: lcode catalogue for `lXXX`, then the cache, then
// the raw token as a last resort.
function initialFilterLabel(filterToken) {
  if (/^l\d+$/.test(filterToken)) {
    const name = lcodeLabel(filterToken);
    if (name) return name;
  }
  const cached = cache.get(`tunein.label.${filterToken}`);
  if (typeof cached === 'string' && cached !== '') return cached;
  return filterToken;
}

// One-shot label fetch for a filter token whose initial render is the
// raw form. Lcode tokens are catalogue-only; everything else (gNNN /
// cNNN / etc.) gets a Browse.ashx lookup, with Describe as a fallback
// for entity prefixes. The badge's label updates in place once the
// title resolves; failures stay silent (the raw token stays put).
export async function hydrateFilterLabel(filterToken, badge) {
  // Lcode catalogue is authoritative — never fall through to Describe
  // for `lXXX`. If it didn't resolve in initialFilterLabel and the
  // catalogue lands later, the LCODES_LOADED_EVENT listener (mounted
  // by renderDrill) re-patches the badge.
  if (/^l\d+$/.test(filterToken)) return;
  let title = '';
  try {
    if (/^[spt]\d+$/.test(filterToken)) {
      // Entity prefixes — Describe returns title in body[0].
      const json = await tuneinDescribe({ id: filterToken });
      const e = json && Array.isArray(json.body) && json.body[0];
      if (e) {
        if (typeof e.title === 'string' && e.title !== '') title = e.title;
        else if (typeof e.name === 'string' && e.name !== '') title = e.name;
      }
    } else {
      // Category / generic — Browse returns head.title.
      const parts = /^[a-z]\d+$/.test(filterToken)
        ? { id: filterToken }
        : { c: filterToken };
      const json = await tuneinBrowse(parts);
      const t = json && json.head && json.head.title;
      if (typeof t === 'string' && t !== '') title = t;
    }
  } catch (_err) {
    return;
  }
  if (!title) return;
  cache.set(`tunein.label.${filterToken}`, title, TTL_LABEL);
  if (badge && badge._label) badge._label.textContent = title;
}

// Build the inline trail inside the pill bar. Always leads with the
// literal `Browse` entry-point anchor; the bolded current segment is
// appended when `currentParts` is provided (the drill case). Tests
// can call with `currentParts = null` to render just the lineage —
// the legacy ancestor-only shape used by the old standalone trail.

export function renderCrumbTrail(stack, currentParts) {
  const trail = document.createElement('nav');
  trail.className = 'browse-bar__trail';
  trail.setAttribute('aria-label', 'Breadcrumb');

  // Defence-in-depth dedupe of consecutive identical tokens (#89). An
  // old URL pasted from an earlier session could carry
  // `from=lang,lang,lang` — render it as a single anchor rather than
  // three identical ones.
  const dedup = [];
  if (Array.isArray(stack)) {
    for (const token of stack) {
      if (dedup.length === 0 || dedup[dedup.length - 1] !== token) dedup.push(token);
    }
  }

  // Tail-dedupe against the current parts (#104). When the user clicks
  // an end-of-page filter chip, the link appends the current id to
  // `from=` AND keeps the same primary id (just adds `filter=…`). The
  // stack's last crumb is then the same node as the current segment;
  // rendering both produces a duplicated tail like
  //   Browse › Location › … › Bayreuth › **Bayreuth**
  // Two shapes count as a match:
  //   - bare equality (`r101821` === `r101821`)
  //   - the current token carries a filter while the stack tail does
  //     not — current `r101821:g26` and stack tail `r101821` refer to
  //     the same drill node. Drop the duplicate; the filter surface
  //     is the badge, not a trail anchor.
  if (currentParts && dedup.length > 0) {
    const curTok = crumbTokenFor(currentParts);
    if (curTok) {
      const tail = dedup[dedup.length - 1];
      const colon = curTok.indexOf(':');
      const curAnchor = colon >= 0 ? curTok.slice(0, colon) : curTok;
      if (tail === curTok || tail === curAnchor) dedup.pop();
    }
  }

  // 1. literal Browse anchor — every trail starts here.
  const browseA = document.createElement('a');
  browseA.className = 'browse-bar__crumb';
  browseA.setAttribute('href', '#/browse');
  browseA.dataset.crumbRole = 'root';
  browseA.textContent = 'Browse';
  trail.appendChild(browseA);

  // 2. one anchor per stack entry. stack[0] is the tab; its bare
  // anchor maps via TAB_LABEL_BY_TOKEN.
  for (let i = 0; i < dedup.length; i++) {
    trail.appendChild(makeSeparator());
    const token = dedup[i];
    const parts = partsFromCrumb(token);
    const a = document.createElement('a');
    a.className = 'browse-bar__crumb';
    a.dataset.crumbToken = token;
    if (i === 0) a.dataset.crumbPosition = 'first';
    if (parts) {
      a.href = drillHashFor(parts, dedup.slice(0, i));
    } else {
      a.className += ' is-disabled';
    }
    a.textContent = initialCrumbLabel(token, parts, i === 0);
    trail.appendChild(a);
  }

  // 3. current segment — bolded non-link tail. Skipped when no
  // current parts are supplied (the legacy ancestor-only shape).
  if (currentParts) {
    trail.appendChild(makeSeparator());
    const cur = document.createElement('span');
    cur.className = 'browse-bar__crumb is-current';
    cur.setAttribute('aria-current', 'page');
    // The current segment is the drill's title; it's a separate seam
    // from the cache labels (which are keyed by crumb token, not by
    // the current page). Read the same h1-equivalent text we use for
    // the page title row.
    const curToken = crumbTokenFor(currentParts);
    cur.textContent = initialHeaderTitle(currentParts, curToken);
    if (curToken) cur.dataset.crumbToken = curToken;
    trail.appendChild(cur);
  }

  return trail;
}

export function makeSeparator() {
  const sep = document.createElement('span');
  sep.className = 'browse-bar__sep';
  sep.setAttribute('aria-hidden', 'true');
  sep.textContent = '›'; // ›
  return sep;
}

// Pick the best already-known label for a crumb token without doing
// any network work. Order of preference for ancestors:
//   - tab-token override (only at stack[0] — the entry-point tab)
//   - cached label under `tunein.label.<token>` (from a previous
//     resolve)
//   - in-memory lcode catalogue (free for `<anchor>:l<NNN>` tokens)
//   - raw token fallback
// The async hydrateCrumbLabels path upgrades any token still
// rendered as raw once its Describe / Browse lookup completes.
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

// ---- hydration: resolve raw tokens to human-readable labels --------

// For every crumb in `stack` that lacks a cached label, fetch its
// label in parallel (cap DESCRIBE_CONCURRENCY) and patch the trail
// DOM in-place when the title arrives. Concurrency is bounded by
// waiting for the oldest pending request to settle before issuing
// the next one.
//
// Endpoint choice per token (the API doesn't expose a single "what
// is this thing called?" call):
//   - s / p / t prefix → Describe.ashx?id=<X>, title in body[0].
//     These are real entities; Describe is the entity-detail endpoint.
//   - everything else (g / c / r / l / m / a / n, plus plain words
//     like `music` / `talk` / `sports` / `lang`) → Browse.ashx?id=<X>
//     (or ?c=<X> for the plain-word case), title in head.title.
//     Describe returns an empty body for these prefixes, so it
//     can't serve as the label source. The issue text says "Describe",
//     but the verified-on-Bo behaviour is that Describe head has
//     {status} only; head.title comes from Browse. Pragmatic split.
//
// Tokens whose resolved title is blank stay rendered as raw IDs —
// the documented final fallback from the issue spec.
export async function hydrateCrumbLabels(stack, trailEl, backEl) {
  if (!Array.isArray(stack) || stack.length === 0) return;
  const todo = [];
  for (const token of stack) {
    if (!token) continue;
    if (typeof cache.get(`tunein.label.${token}`) === 'string') continue;
    todo.push(token);
  }
  if (todo.length === 0) return;

  const inFlight = new Set();
  for (const token of todo) {
    if (inFlight.size >= DESCRIBE_CONCURRENCY) {
      // Wait for any one to finish before issuing the next.
      await Promise.race(inFlight);
    }
    const p = resolveLabelAndApply(token, trailEl, backEl, stack).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  // Drain the remaining wave so failures surface in dev tools.
  await Promise.allSettled(Array.from(inFlight));
}

// Resolve a single crumb token to a human-readable label and patch
// the trail. Picks the appropriate endpoint per prefix; falls through
// silently when no label can be discovered.
export async function resolveLabelAndApply(token, trailEl, backEl, stack) {
  // Filter-bearing tokens (`<anchor>:l<NNN>`) resolve from the in-
  // memory lcode catalogue without any network round-trip (#89, #90).
  // We bypass the Describe / Browse fallbacks entirely — the
  // catalogue is authoritative for language names.
  const parts = partsFromCrumb(token);
  if (parts && typeof parts.filter === 'string' && /^l\d+$/.test(parts.filter)) {
    const name = lcodeLabel(parts.filter);
    if (name) {
      cache.set(`tunein.label.${token}`, name, TTL_LABEL);
      patchTrailCrumb(trailEl, token, name);
      patchBackAria(backEl, stack, token, name);
    }
    return;
  }

  let title = '';
  try {
    if (/^[spt]\d+$/.test(token)) {
      // Entity prefixes — Describe returns the canonical name in
      // body[0]. Stations use `name`; shows / topics use `title`.
      const json = await tuneinDescribe({ id: token });
      const e = json && Array.isArray(json.body) && json.body[0];
      if (e) {
        if (typeof e.title === 'string' && e.title !== '') title = e.title;
        else if (typeof e.name === 'string' && e.name !== '') title = e.name;
      }
    } else if (parts) {
      // Category prefixes + plain words — Browse returns head.title.
      // partsFromCrumb routes lowercase-letter+digit tokens through
      // `id=` and letters-only tokens through `c=`.
      const json = await tuneinBrowse(parts);
      const t = json && json.head && json.head.title;
      if (typeof t === 'string' && t !== '') title = t;
    }
  } catch (_err) {
    // Network error / non-200 — give up silently. The trail keeps
    // the raw-token rendering, which is the issue's documented
    // last-resort fallback.
    return;
  }
  if (!title) return;
  cache.set(`tunein.label.${token}`, title, TTL_LABEL);
  patchTrailCrumb(trailEl, token, title);
  patchBackAria(backEl, stack, token, title);
}

// Find the trail anchor for `token` and rewrite its textContent. The
// first-in-stack tab override stays sticky — we don't overwrite the
// tab label with whatever the API returns for its node.
export function patchTrailCrumb(trailEl, token, label) {
  if (!trailEl || typeof trailEl.querySelector !== 'function') return;
  const a = trailEl.querySelector(`[data-crumb-token="${cssEscape(token)}"]`);
  if (!a) return;
  // Skip if the rendered label already reflects the tab-token override
  // (stack[0] is allowed to read as `Genre` / `Location` / `Language`
  // — the cache write happens for the cold-load path but doesn't
  // overwrite the override visually).
  if (a.dataset && a.dataset.crumbPosition === 'first') {
    const parts = partsFromCrumb(token);
    const bareAnchor = parts && typeof parts.id === 'string'
      ? parts.id
      : (parts && typeof parts.c === 'string' ? parts.c : '');
    const isFilterBearing = parts && typeof parts.filter === 'string' && parts.filter !== '';
    if (!isFilterBearing && bareAnchor && TAB_LABEL_BY_TOKEN[bareAnchor]) return;
  }
  a.textContent = label;
}

// Re-stamp the Back chevron's aria-label when the destination crumb's
// label resolves. Only fires when the resolving token matches the
// last crumb in the stack (which is the popped destination). Honour
// the tab-token override for a single-crumb stack so the popped
// destination reads as "Back to Genre" rather than "Back to Music".
export function patchBackAria(backEl, stack, token, label) {
  if (!backEl) return;
  if (!Array.isArray(stack) || stack.length === 0) return;
  if (stack[stack.length - 1] !== token) return;
  if (stack.length === 1) {
    const parts = partsFromCrumb(token);
    const bareAnchor = parts && typeof parts.id === 'string'
      ? parts.id
      : (parts && typeof parts.c === 'string' ? parts.c : '');
    const isFilterBearing = parts && typeof parts.filter === 'string' && parts.filter !== '';
    if (!isFilterBearing && bareAnchor && TAB_LABEL_BY_TOKEN[bareAnchor]) return;
  }
  backEl.setAttribute('aria-label', `Back to ${label}`);
}

// CSS.escape isn't available in xmldom (test) and the crumb tokens are
// always [a-z0-9] anyway, but be defensive against any token shape the
// API might surface in future.
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) =>
    '\\' + ch.charCodeAt(0).toString(16) + ' ');
}
