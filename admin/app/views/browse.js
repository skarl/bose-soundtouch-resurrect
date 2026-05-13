// browse — TuneIn taxonomy browser. Owns the drill-view
// orchestration: root tabs, drill frame (back / trail / header /
// filter / body), crumb stack parsing + hydration, filter input mount,
// and lifecycle (disposing previous pagers on every navigation). Row
// → DOM rendering, "Load more" pagination, the eager-serial crawl
// coordinator, and the c=pbrowse show-landing body all live in the
// per-concern submodules under `./browse/`.
//
// Two modes:
//   1. Root view (#/browse): three-tab segmented control (Genre /
//      Location / Language). Tab click fetches that subtree in-place.
//   2. Drill view (#/browse?id=<id>, #/browse?c=music&filter=l109,
//      etc.): fetches Browse.ashx with the matching drill keys; the
//      URLs the API itself emits run through canonicaliseBrowseUrl
//      so the language-tree rewrite (§ 7.3) happens at the row → href
//      seam, not at fetch time.
//
// See admin/PLAN.md § View specs / browse and docs/tunein-api.md.

import { html, mount, defineView } from '../dom.js';
import { tuneinBrowse, tuneinDescribe } from '../api.js';
import { icon } from '../icons.js';
import {
  lcodeLabel,
  LCODES_LOADED_EVENT,
} from '../tunein-url.js';
import { cache, TTL_LABEL } from '../tunein-cache.js';

import {
  renderOutline,
  renderEntry,
  drillHashFor,
  setChildCrumbs,
  pluralize,
  skeleton,
  errorNode,
  _setChildCrumbsForTest,
} from './browse/outline-render.js';
import {
  loadShowLanding,
  _renderShowLandingForTest,
} from './browse/show-landing.js';
import {
  mountLoadMoreButtons,
  disposeActivePagers,
  setFilterInput,
  applyDomFilter,
  currentFilterQuery,
  ensureCoordinator,
  stopCoordinator,
  filterRowEntries,
  _setActivePagersForTest,
  _setFilterInputForTest,
  _resetBrowseStateForTest,
  _ensureCoordinatorForTest,
  _applyDomFilterForTest,
  _getCoordinatorForTest,
} from './browse/pager-crawl.js';

// Re-export the entry/render primitives + test hooks so existing
// callers (test_browse, test_browse_crumbs, test_tunein_pager,
// main.js) keep their imports stable across the split. The split is
// internal-only — every public surface of the original browse.js
// still resolves through this module.
export {
  renderOutline,
  renderEntry,
  filterRowEntries,
  mountLoadMoreButtons,
  _renderShowLandingForTest,
  _setChildCrumbsForTest,
  _setActivePagersForTest,
  _setFilterInputForTest,
  _resetBrowseStateForTest,
  _ensureCoordinatorForTest,
  _applyDomFilterForTest,
  _getCoordinatorForTest,
};

// Top-level tab → Browse.ashx parameter. Verified against the TuneIn
// API reference (docs/tunein-api.md § Categories worth knowing):
//   - Music genres live under `?c=music`
//   - Languages live under `?c=lang`
//   - Locations live under `?id=r0` (world root)
const TABS = [
  { key: 'genre',    label: 'Genre',    params: { c: 'music' } },
  { key: 'location', label: 'Location', params: { id: 'r0' }   },
  { key: 'language', label: 'Language', params: { c: 'lang' }  },
];

// Maximum depth of the URL crumb stack (`from=...`). Deeper than the
// deepest observed location-tree depth (5); see issue #74 notes. Any
// crumbs beyond this are dropped from the head of the stack.
const MAX_CRUMBS = 8;

// Maximum number of `Describe.ashx?id=<X>` calls in flight at once
// during cold-load label-fill. Matches MAX_CRUMBS so the worst case
// (a fully-deep shared URL with no cached labels) saturates in one
// wave.
const DESCRIBE_CONCURRENCY = 5;

export default defineView({
  mount(root, _store, ctx) {
    // Tear down any pagers left over from the previous drill before
    // mounting fresh ones. Each navigation gets a clean slate; the
    // disposed pagers ignore late fetch resolutions.
    disposeActivePagers();
    const query = (ctx && ctx.query) || {};
    const drillParts = pickDrillParts(query);
    const crumbs = parseCrumbs(query.from);
    if (drillParts) {
      // Show-drill landing — the c=pbrowse query carries a program id
      // (p-prefix). Upstream's c=pbrowse endpoint is regionally gated
      // (returns "Invalid root category" with status:"400" from Bo's
      // egress; see issue #84). Dispatch to a Describe + Browse
      // (bare-id) composite so the user still lands on a meaningful
      // show page — title, host, description, location, genre — plus
      // any related sections (Genres / Networks) the bare-id Browse
      // returns. The *Now airing: <show>* link in stationRow (slice
      // #79) keeps composing c=pbrowse URLs; the dispatch here is the
      // only seam that needs the rewrite.
      if (isShowDrillParts(drillParts)) {
        renderShowLanding(root, drillParts, crumbs);
      } else {
        renderDrill(root, drillParts, crumbs);
      }
    } else {
      renderRoot(root);
    }
    return {};
  },
});

// True when the URL carries `c=pbrowse&id=p<digits>` — the route
// composed by stationRow's "Now airing: <show>" tertiary link and by
// any TuneIn outline whose `URL` field embeds the upstream show-drill
// shape. The id check guards against accidental drills where `c` is
// `pbrowse` but the id is some other prefix.
function isShowDrillParts(parts) {
  if (!parts || parts.c !== 'pbrowse') return false;
  return typeof parts.id === 'string' && /^p\d+$/.test(parts.id);
}

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

// Crumb token for a drill-parts object. The token is the value the
// user would land on if they clicked Back to this level: prefer `id`,
// fall back to `c`. When a `filter` accompanies the anchor we encode
// it as `<anchor>:<filter>` so two drills that share the same anchor
// but differ in their filter (e.g. the language tree, where every
// level emits `c=lang` or `c=music` with a different `filter=l<NNN>`)
// produce distinct, navigable crumbs (#89). pivots / offsets remain
// refinements that do not become crumbs.
// Returns null when neither anchor is set (root view).
export function crumbTokenFor(parts) {
  if (!parts) return null;
  let anchor = '';
  if (typeof parts.id === 'string' && parts.id !== '') anchor = parts.id;
  else if (typeof parts.c === 'string' && parts.c !== '') anchor = parts.c;
  if (!anchor) return null;
  if (typeof parts.filter === 'string' && parts.filter !== '') {
    return `${anchor}:${parts.filter}`;
  }
  return anchor;
}

// Inverse of crumbTokenFor: turn a crumb token back into the drill
// parts the user should land on. Heuristic:
//   - bare tokens matching /^[a-z]\d+$/ are guide_ids (`id=` anchor)
//   - bare tokens otherwise are category short names (`c=`)
//   - tokens with a `:filter` suffix attach the filter to whichever
//     anchor form applies (so `lang:l109` → `{c:'lang', filter:'l109'}`,
//     `c123:l109` → `{id:'c123', filter:'l109'}`)
export function partsFromCrumb(token) {
  if (typeof token !== 'string' || token === '') return null;
  const colonIdx = token.indexOf(':');
  let anchor = token;
  let filter = '';
  if (colonIdx >= 0) {
    anchor = token.slice(0, colonIdx);
    filter = token.slice(colonIdx + 1);
  }
  if (!anchor) return null;
  const parts = /^[a-z]\d+$/.test(anchor) ? { id: anchor } : { c: anchor };
  if (filter) parts.filter = filter;
  return parts;
}

// A drill URL can carry any of {id, c, filter, pivot, offset}. The
// presence of `id` or `c` is the load-bearing signal; the others
// modify the drill. Returns null when neither anchor is set (root
// view).
function pickDrillParts(query) {
  if (!query || (typeof query.id !== 'string' && typeof query.c !== 'string')) {
    return null;
  }
  const out = {};
  for (const key of ['id', 'c', 'filter', 'pivot', 'offset']) {
    if (typeof query[key] === 'string' && query[key] !== '') out[key] = query[key];
  }
  return out;
}

// Display label for the drill crumb — a compact form of the parts.
// `c=music&filter=l216` reads more usefully than just `music`. When
// the filter is an lcode (`l<NNN>`) and we have a cached language
// name for it, append the human form so end users get an at-a-glance
// translation of the otherwise opaque numeric filter (#90).
// Exported for unit testing — production callers stay inside this file.
export function crumbLabelFor(parts) {
  const segs = [];
  if (parts.id) segs.push(parts.id);
  if (parts.c)  segs.push(`c=${parts.c}`);
  if (parts.filter) segs.push(`filter=${parts.filter}`);
  if (parts.pivot)  segs.push(`pivot=${parts.pivot}`);
  if (parts.offset) segs.push(`offset=${parts.offset}`);
  let label = segs.join(' · ');
  if (typeof parts.filter === 'string' && /^l\d+$/.test(parts.filter)) {
    const name = lcodeLabel(parts.filter);
    if (name) label += ` (${name})`;
  }
  return label;
}

// ---- root view (segmented tabs) -------------------------------------

function renderRoot(root) {
  const tabsBar = document.createElement('div');
  tabsBar.className = 'browse-tabs';
  tabsBar.setAttribute('role', 'tablist');
  tabsBar.setAttribute('aria-label', 'Browse categories');

  const header = document.createElement('div');
  header.className = 'section-h browse-section-h';
  const headerLeft = document.createElement('span');
  headerLeft.className = 'section-h__title';
  const headerCount = document.createElement('span');
  headerCount.className = 'section-h__meta';
  header.appendChild(headerLeft);
  header.appendChild(headerCount);

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('aria-live', 'polite');

  const buttons = TABS.map((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browse-tab';
    btn.dataset.tab = tab.key;
    btn.textContent = tab.label;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => selectTab(tab, buttons, body, headerLeft, headerCount));
    tabsBar.appendChild(btn);
    return btn;
  });

  mount(root, html`
    <section data-view="browse">
      ${tabsBar}
      ${header}
      ${body}
    </section>
  `);

  // Root view has no parent crumbs — children embed an empty `from=`.
  setChildCrumbs([]);
  selectTab(TABS[0], buttons, body, headerLeft, headerCount);
}

function selectTab(tab, buttons, body, headerLeft, headerCount) {
  for (const b of buttons) {
    const active = b.dataset.tab === tab.key;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  // Each tab is a top-level entry: children's crumb stack starts with
  // just this tab's anchor token. setChildCrumbs hands the prefix off
  // to outline-render so renderEntry sees the correct value.
  const tabToken = crumbTokenFor(tab.params);
  setChildCrumbs(tabToken ? [tabToken] : []);
  headerLeft.textContent = tab.label;
  headerCount.textContent = '';
  loadInto(body, tuneinBrowse(tab.params), headerCount, null);
}

// ---- drill view (id=...) --------------------------------------------
//
// renderDrill (sectioned outline) and renderShowLanding (c=pbrowse)
// share a frame: back link, header (title + ID badge + count),
// optional crumb trail. The frame helper below renders both; each
// caller adds the bits that are specific to its mode (filter input
// for renderDrill; nothing extra for renderShowLanding) and hands
// the body off to its loader.

function buildDrillFrame(parts, crumbs) {
  const stack = Array.isArray(crumbs) ? crumbs.slice(0, MAX_CRUMBS) : [];

  const back = document.createElement('a');
  back.className = 'browse-back';
  back.href = backHrefFor(stack);
  back.appendChild(icon('back', 12));
  const backLabel = document.createElement('span');
  backLabel.textContent = ' Back';
  back.appendChild(backLabel);

  const header = document.createElement('div');
  header.className = 'section-h browse-section-h';
  const headerLeft = document.createElement('span');
  headerLeft.className = 'section-h__title browse-crumb';

  // Page header: title text + a muted ID badge for the verbatim parts.
  // The title starts as the cached label (if any) or the parts compact
  // form; loadInto upgrades it to head.title once the response lands.
  const currentToken = crumbTokenFor(parts);
  const titleEl = document.createElement('span');
  titleEl.className = 'browse-crumb__title';
  titleEl.textContent = initialHeaderTitle(parts, currentToken);
  headerLeft.appendChild(titleEl);

  const crumbId = document.createElement('span');
  crumbId.className = 'browse-crumb__id';
  crumbId.textContent = crumbLabelFor(parts);
  headerLeft.appendChild(crumbId);

  const headerCount = document.createElement('span');
  headerCount.className = 'section-h__meta';
  header.appendChild(headerLeft);
  header.appendChild(headerCount);

  // Optional crumb-trail strip: one anchor per ancestor in the stack.
  // Labels come from the cache; gaps are filled lazily via Describe
  // (see hydrateCrumbLabels). Omitted entirely when there are no
  // crumbs (we're at depth 1).
  const trail = stack.length > 0 ? renderCrumbTrail(stack) : null;

  // Child links embed the current crumb stack extended by the current
  // node's token. Capped at MAX_CRUMBS by trimming the head, preserving
  // the most recent crumbs (the path back to here).
  const childStack = currentToken ? [...stack, currentToken] : stack.slice();
  const trimmed = childStack.length > MAX_CRUMBS
    ? childStack.slice(childStack.length - MAX_CRUMBS)
    : childStack;

  return {
    stack, currentToken, titleEl, crumbId, headerCount, header, trail, back,
    childCrumbs: trimmed,
  };
}

function renderDrill(root, parts, crumbs) {
  const frame = buildDrillFrame(parts, crumbs);

  // Page-top filter input, always visible (not behind an icon).
  // Instant DOM filter on keystroke; 300ms-debounced auto-crawl
  // trigger drives the per-section pagers serially while the filter
  // has text.
  const filterWrap = renderFilterInput();
  setFilterInput(filterWrap._input);

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('aria-live', 'polite');

  mount(root, html`
    <section data-view="browse" data-mode="drill">
      <p class="breadcrumb">${frame.back}</p>
      ${frame.trail}
      ${filterWrap}
      ${frame.header}
      ${body}
    </section>
  `);

  setChildCrumbs(frame.childCrumbs);

  // Cold-load: any crumb whose label isn't already cached gets
  // hydrated in parallel (concurrency cap DESCRIBE_CONCURRENCY).
  // Updates the trail in-place as labels resolve.
  if (frame.trail) hydrateCrumbLabels(frame.stack, frame.trail);

  // Re-patch the filter-aware badge + breadcrumb anchors whenever the
  // lcode catalogue lands after this view mounted. The boot-time
  // Describe.ashx?c=languages fetch typically resolves within ~1 s of
  // app start; on a cold load straight into a deep language drill the
  // initial render happens first, so without this hook the user would
  // see `c=music · filter=l109` with no "(German)" suffix until the
  // next navigation. (#89, #90)
  registerLcodeRepatch(parts, frame.crumbId, frame.trail, frame.stack);

  // tuneinBrowse accepts a parts object as the c-style top-level form
  // (`{c: 'music', filter: 'l216'}`) or a bare id string. The c+filter
  // shape is the language-tree rewrite output (§ 7.3); pass parts
  // through verbatim.
  loadInto(body, tuneinBrowse(parts), frame.headerCount, {
    titleEl: frame.titleEl,
    crumbToken: frame.currentToken,
  });
}

// One-shot listener: when the lcode catalogue is broadcast as loaded,
// re-evaluate the drill-header badge and re-hydrate any crumb trail
// anchor whose token carries an unresolved language filter. `{ once:
// true }`; no teardown on view unmount because the DOM-patch is a
// no-op when the elements are gone.
function registerLcodeRepatch(parts, crumbIdEl, trailEl, stack) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const hasFilterableToken = (typeof parts.filter === 'string' && /^l\d+$/.test(parts.filter))
    || (Array.isArray(stack) && stack.some((tok) => /:l\d+$/.test(tok || '')));
  if (!hasFilterableToken) return;
  window.addEventListener(LCODES_LOADED_EVENT, () => {
    if (crumbIdEl && typeof crumbIdEl.textContent === 'string') {
      crumbIdEl.textContent = crumbLabelFor(parts);
    }
    if (trailEl) hydrateCrumbLabels(stack, trailEl);
  }, { once: true });
}

// ---- show-landing view (c=pbrowse&id=p<N>) --------------------------
//
// The upstream `Browse.ashx?c=pbrowse&id=p<N>` endpoint is regionally
// gated; see show-landing.js for the curl evidence and the rewire
// rationale. The frame mirrors renderDrill minus the filter input —
// the show landing has no list tall enough to need filtering. The
// body is filled by loadShowLanding.
function renderShowLanding(root, parts, crumbs) {
  const frame = buildDrillFrame(parts, crumbs);

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('data-mode', 'show-landing');
  body.setAttribute('aria-live', 'polite');

  mount(root, html`
    <section data-view="browse" data-mode="show-landing">
      <p class="breadcrumb">${frame.back}</p>
      ${frame.trail}
      ${frame.header}
      ${body}
    </section>
  `);

  setChildCrumbs(frame.childCrumbs);

  if (frame.trail) hydrateCrumbLabels(frame.stack, frame.trail);

  loadShowLanding(body, parts.id, frame.headerCount, {
    titleEl: frame.titleEl,
    crumbToken: frame.currentToken,
  });
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
function initialHeaderTitle(parts, token) {
  if (token) {
    const cached = cache.get(`tunein.label.${token}`);
    if (typeof cached === 'string' && cached !== '') return cached;
  }
  return crumbLabelFor(parts);
}

// ---- shared loader --------------------------------------------------
//
// `head` is null for the root tabs view (where the section title is the
// tab name) or { titleEl, crumbToken } for drill view, in which case
// the loader upgrades titleEl to json.head.title and stashes the label
// in the cache under tunein.label.<crumbToken>.

function loadInto(body, promise, headerCount, head) {
  body.replaceChildren();
  body.appendChild(skeleton());
  if (headerCount) headerCount.textContent = '';
  promise
    .then((json) => {
      body.replaceChildren();
      const total = renderOutline(body, json);
      if (headerCount && total > 0) {
        headerCount.textContent = `${total.toLocaleString()} ${pluralize(total)}`;
      }
      const title = json && json.head && typeof json.head.title === 'string'
        ? json.head.title
        : '';
      if (head && head.titleEl && title) {
        head.titleEl.textContent = title;
      }
      if (head && head.crumbToken && title) {
        cache.set(`tunein.label.${head.crumbToken}`, title, TTL_LABEL);
      }
      // Mount one pager + Load-more button per section that came back
      // with a cursor URL parked on it by renderSection / renderFlatSection.
      mountLoadMoreButtons(body);
      // If the filter input already has text (e.g. user navigates with
      // a sticky filter), apply it to the freshly-rendered rows and
      // kick the coordinator. The DOM filter is cheap; skipping it
      // when the input is empty avoids a wasted walk.
      if (currentFilterQuery() !== '') {
        applyDomFilter();
        ensureCoordinator();
      }
    })
    .catch((err) => {
      body.replaceChildren();
      body.appendChild(errorNode(err));
    });
}

// ---- crumb trail (between Back link and section header) ------------
//
// One anchor per crumb in the stack, oldest → newest. Each anchor's
// href reconstructs the destination's own crumb stack: a click on
// crumb[i] lands on a page whose own `from=` is crumb[0..i].
// Labels come from the cache; unknown labels render as the raw token
// (which doubles as the ID badge fallback per the issue spec).

export function renderCrumbTrail(stack) {
  const trail = document.createElement('nav');
  trail.className = 'browse-trail';
  trail.setAttribute('aria-label', 'Breadcrumb');
  // Defence-in-depth dedupe of consecutive identical tokens (#89). The
  // emitter shouldn't produce them after the filter-aware crumbTokenFor
  // fix landed, but an old URL pasted from an earlier session could
  // still carry `from=lang,lang,lang` — render it as a single anchor
  // rather than three identical ones.
  const dedup = [];
  for (const token of stack) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== token) dedup.push(token);
  }
  for (let i = 0; i < dedup.length; i++) {
    const token = dedup[i];
    const parts = partsFromCrumb(token);
    const a = document.createElement('a');
    a.className = 'browse-trail__crumb';
    a.dataset.crumbToken = token;
    if (parts) {
      // Each ancestor's own crumb stack is the prefix up to (and not
      // including) itself, so a click on crumb[i] navigates to that
      // node with from=dedup[0..i-1].
      a.href = drillHashFor(parts, dedup.slice(0, i));
    } else {
      a.className += ' is-disabled';
    }
    a.textContent = initialCrumbLabel(token, parts);
    trail.appendChild(a);
  }
  return trail;
}

// Pick the best already-known label for a crumb token without doing
// any network work. Order of preference: cached label under
// `tunein.label.<token>` (from a previous resolve), in-memory lcode
// catalogue (free for `<anchor>:l<NNN>` tokens), then raw token. The
// async hydrateCrumbLabels path upgrades any token still rendered as
// raw once its Describe / Browse lookup completes.
function initialCrumbLabel(token, parts) {
  const cached = cache.get(`tunein.label.${token}`);
  if (typeof cached === 'string' && cached !== '') return cached;
  if (parts && typeof parts.filter === 'string' && /^l\d+$/.test(parts.filter)) {
    const name = lcodeLabel(parts.filter);
    if (name) return name;
  }
  return token;
}

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
async function hydrateCrumbLabels(stack, trailEl) {
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
    const p = resolveLabelAndApply(token, trailEl).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  // Drain the remaining wave so failures surface in dev tools.
  await Promise.allSettled(Array.from(inFlight));
}

// Resolve a single crumb token to a human-readable label and patch
// the trail. Picks the appropriate endpoint per prefix; falls through
// silently when no label can be discovered.
async function resolveLabelAndApply(token, trailEl) {
  // Filter-bearing tokens (`<anchor>:l<NNN>`) resolve from the in-
  // memory lcode catalogue without any network round-trip (#89, #90).
  // We bypass the Describe / Browse fallbacks entirely — the
  // catalogue is authoritative for language names.
  const parts = partsFromCrumb(token);
  if (parts && typeof parts.filter === 'string' && /^l\d+$/.test(parts.filter)) {
    const name = lcodeLabel(parts.filter);
    if (name) {
      cache.set(`tunein.label.${token}`, name, TTL_LABEL);
      if (trailEl && typeof trailEl.querySelector === 'function') {
        const a = trailEl.querySelector(`[data-crumb-token="${cssEscape(token)}"]`);
        if (a) a.textContent = name;
      }
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
  // Patch the trail in-place. The trail DOM was built before this
  // request started, so locate the crumb anchor by its data attribute.
  if (!trailEl || typeof trailEl.querySelector !== 'function') return;
  const a = trailEl.querySelector(`[data-crumb-token="${cssEscape(token)}"]`);
  if (a) a.textContent = title;
}

// CSS.escape isn't available in xmldom (test) and the crumb tokens are
// always [a-z0-9] anyway, but be defensive against any token shape the
// API might surface in future.
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) =>
    '\\' + ch.charCodeAt(0).toString(16) + ' ');
}

// ---- page-top filter input ----------------------------------------
//
// The filter input mounts at the top of every drill view. Two
// behaviours, both delegated to pager-crawl.js:
//
//   1. Inline DOM filter (instant, no debounce) — rows whose
//      text/subtext/playing/current_track don't contain the query
//      substring (case-insensitive) gain `is-filtered-out`.
//
//   2. Eager-serial auto-crawl (300ms debounced trigger) — kicks the
//      pager-crawl coordinator while the filter has text; stops it
//      when the input clears.

const FILTER_DEBOUNCE_MS = 300;

// Build the filter input UI. Returns the wrapper element with the
// inner <input> stashed on `._input` for the caller (renderDrill) to
// register with pager-crawl via setFilterInput.
function renderFilterInput() {
  const wrap = document.createElement('div');
  wrap.className = 'browse-filter';
  const input = document.createElement('input');
  input.setAttribute('type', 'search');
  input.setAttribute('class', 'browse-filter__input');
  input.setAttribute('placeholder', 'Filter rows… (e.g. bbc)');
  input.setAttribute('aria-label', 'Filter rows');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');

  // Debounce timer for the auto-crawl trigger. The DOM filter itself
  // is instant — no debounce — so typing feels responsive.
  let debounce = null;
  const onInput = () => {
    applyDomFilter();
    if (debounce != null) {
      try { clearTimeout(debounce); } catch (_e) { /* ignored */ }
    }
    debounce = setTimeout(() => {
      debounce = null;
      const q = currentFilterQuery();
      if (q === '') {
        // Filter cleared — stop any active crawl mid-page.
        stopCoordinator();
      } else {
        // Filter has text — make sure the coordinator is running.
        ensureCoordinator();
      }
    }, FILTER_DEBOUNCE_MS);
  };
  if (typeof input.addEventListener === 'function') {
    input.addEventListener('input', onInput);
    input.addEventListener('change', onInput);
  }
  wrap.appendChild(input);
  wrap._input = input;
  return wrap;
}
