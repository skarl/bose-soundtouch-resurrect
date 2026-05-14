// crumb-renderer — DOM + async hydration half of the Crumb stack
// module. The pure value type, parsing/emission, and label-resolution
// reads live in `./crumb-parts.js`; this file builds on those to
// render the pill bar (Back chevron + inline trail + filter badges)
// and to upgrade raw-token renderings to human-readable names once
// Describe / Browse resolves.
//
// What lives here:
//   - DOM builders: renderPillBar, renderCrumbTrail, renderFilterBadges,
//     renderFilterBadge (legacy single-filter shim), buildFilterBadge,
//     makeSeparator.
//   - Async label hydration: hydrateCrumbLabels, hydrateFilterLabel,
//     resolveLabelAndApply, patchTrailCrumb, patchBackAria.
//   - Small infrastructure: DESCRIBE_CONCURRENCY (concurrency cap for
//     the cold-load label-fill wave), cssEscape (defensive attribute
//     escape — CSS.escape isn't available under xmldom in tests).

import { tuneinBrowse, tuneinDescribe } from '../../api.js';
import { icon } from '../../icons.js';
import { lcodeLabel } from '../../tunein-url.js';
import { cache, TTL_LABEL } from '../../tunein-cache.js';

import { drillHashFor } from './outline-render.js';
import {
  TAB_LABEL_BY_TOKEN,
  backAriaLabel,
  backHrefFor,
  crumbTokenFor,
  filtersOf,
  initialCrumbLabel,
  initialFilterLabel,
  initialHeaderTitle,
  partsFromCrumb,
  setFilters,
} from './crumb-parts.js';

// Maximum number of `Describe.ashx?id=<X>` calls in flight at once
// during cold-load label-fill. Matches MAX_CRUMBS so the worst case
// (a fully-deep shared URL with no cached labels) saturates in one
// wave.
const DESCRIBE_CONCURRENCY = 5;

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
export function buildFilterBadge(filterToken, parts, filters, stack) {
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
