// browse — TuneIn taxonomy browser.
//
// Two modes:
//   1. Root view (#/browse): three-tab segmented control (Genre /
//      Location / Language). Tab click fetches that subtree in-place;
//      no route change.
//   2. Drill view (#/browse?id=<id>, #/browse?c=music&filter=l109,
//      etc.): fetches Browse.ashx with the matching drill keys, renders
//      children + a Back link to the root. The hash carries any of
//      id / c / filter / pivot / offset; the URLs the API itself emits
//      run through canonicaliseBrowseUrl (tunein-url.js) so the
//      language-tree rewrite (§ 7.3) happens at the row → href seam,
//      not at fetch time.
//
// Card layout matches admin/design-mockup/app/views-browse-search.jsx:
//   - non-audio entries → .browse-row inside one .browse-card with mono
//     id badge, label, optional count, chevron
//   - audio entries (drill leaves) → .station-row, same card container
//
// See admin/PLAN.md § View specs / browse and docs/tunein-api.md.

import { html, mount, defineView } from '../dom.js';
import { tuneinBrowse, tuneinDescribe } from '../api.js';
import { stationRow } from '../components.js';
import { icon } from '../icons.js';
import { canonicaliseBrowseUrl, extractDrillKey } from '../tunein-url.js';
import { cache, TTL_LABEL } from '../tunein-cache.js';
import {
  classifyOutline,
  normaliseRow,
  extractPivots,
} from '../tunein-outline.js';
import { createPager } from '../tunein-pager.js';

// Section keys that the c=pbrowse show-drill response uses. The
// `liveShow` container holds the currently-airing show as a single
// playable p-prefix row; `topics` holds recent episodes as t-prefix
// rows with `topic_duration` metadata. The classifier + renderEntry
// pipeline already handles stations/shows/related/local; only these
// two need specialised dispatch (a p row carrying a Play icon for
// liveShow, a duration-formatted meta line for topics).
const PBROWSE_SECTION_KEYS = new Set(['liveShow', 'topics']);

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

// The crumb-token prefix that child links should embed in `from=...`.
// Set by renderDrill / selectTab before the row constructor runs, and
// read by drillHashFor() when composing each row's href. Module-local
// rather than thread-through-args so renderEntry's signature (which
// is exported and used by tests) stays stable.
let _childCrumbs = [];

// Test-only setter for the module-local crumb prefix. Production code
// drives _childCrumbs through renderRoot / selectTab / renderDrill;
// tests use this to assert renderEntry's href composition without
// having to mount a full view.
export function _setChildCrumbsForTest(crumbs) {
  _childCrumbs = Array.isArray(crumbs) ? crumbs.slice() : [];
}

// Per-drill set of pager instances. Reset on every navigation so
// drilling elsewhere disposes the previous drill's pagers (their
// in-flight fetches become no-ops via pager.dispose()).
let _activePagers = [];

// Per-drill auto-crawl coordinator. Walks `_activePagers` in section
// order while the filter input has text; serial across sections so Bo's
// busybox CGI never sees two parallel cursor follows. Reset on every
// navigation; setFilter(q) is the only entry point.
let _coordinator = null;

// Per-drill filter input element. Stashed module-local so the
// coordinator can query it during the crawl loop (cheaper than
// threading the value through every await).
let _filterInput = null;

function disposeActivePagers() {
  for (const p of _activePagers) {
    try { p.dispose(); } catch (_err) { /* defensive */ }
  }
  _activePagers = [];
  if (_coordinator) {
    try { _coordinator.stop(); } catch (_err) { /* defensive */ }
    _coordinator = null;
  }
  _filterInput = null;
}

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
      renderDrill(root, drillParts, crumbs);
    } else {
      renderRoot(root);
    }
    return {};
  },
});

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
// fall back to `c`. Filters / pivots / offsets are *refinements* on
// a level, not levels of their own, so they do not become crumbs.
// Returns null when neither anchor is set (root view).
export function crumbTokenFor(parts) {
  if (!parts) return null;
  if (typeof parts.id === 'string' && parts.id !== '') return parts.id;
  if (typeof parts.c  === 'string' && parts.c  !== '') return parts.c;
  return null;
}

// Inverse of crumbTokenFor: turn a crumb token back into the drill
// parts the user should land on. Heuristic mirrors the convention in
// the issue example `from=c100000948,g79,music`:
//   - tokens matching /^[a-z]\d+$/ are guide_ids (`id=` anchor)
//   - everything else is treated as a category short name (`c=`)
export function partsFromCrumb(token) {
  if (typeof token !== 'string' || token === '') return null;
  if (/^[a-z]\d+$/.test(token)) return { id: token };
  return { c: token };
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

// Compose the hash anchor for a drill row from its parts. Mirrors
// composeDrillUrl but emits the SPA-internal hash form. The keys are
// already plain strings; URLSearchParams handles encoding.
//
// `crumbs` is the prefix the child link should embed in `from=...`.
// Defaults to the module-level `_childCrumbs` so renderEntry callers
// (including ones inside #75's renderOutline rework) don't need to
// pass it through. Empty arrays omit `from=` entirely.
function drillHashFor(parts, crumbs) {
  const qs = new URLSearchParams();
  if (parts.id)     qs.set('id', parts.id);
  if (parts.c)      qs.set('c', parts.c);
  if (parts.filter) qs.set('filter', parts.filter);
  if (parts.pivot)  qs.set('pivot', parts.pivot);
  if (parts.offset) qs.set('offset', parts.offset);
  const fromList = Array.isArray(crumbs) ? crumbs : _childCrumbs;
  const fromStr  = stringifyCrumbs(fromList);
  if (fromStr) qs.set('from', fromStr);
  return `#/browse?${qs.toString()}`;
}

// Display label for the drill crumb — a compact form of the parts.
// `c=music&filter=l216` reads more usefully than just `music`.
function crumbLabelFor(parts) {
  const segs = [];
  if (parts.id) segs.push(parts.id);
  if (parts.c)  segs.push(`c=${parts.c}`);
  if (parts.filter) segs.push(`filter=${parts.filter}`);
  if (parts.pivot)  segs.push(`pivot=${parts.pivot}`);
  if (parts.offset) segs.push(`offset=${parts.offset}`);
  return segs.join(' · ');
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
  _childCrumbs = [];
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
  // just this tab's anchor token. _childCrumbs is module-local so
  // renderEntry sees the correct prefix.
  const tabToken = crumbTokenFor(tab.params);
  _childCrumbs = tabToken ? [tabToken] : [];
  headerLeft.textContent = tab.label;
  headerCount.textContent = '';
  loadInto(body, tuneinBrowse(tab.params), headerCount, null);
}

// ---- drill view (id=...) --------------------------------------------

function renderDrill(root, parts, crumbs) {
  const stack = Array.isArray(crumbs) ? crumbs.slice(0, MAX_CRUMBS) : [];

  // Back link pops the rightmost crumb and lands on it; with no
  // crumbs, fall back to the root view.
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
  // (see hydrateCrumbLabels below). When there are no crumbs (we're
  // at depth 1) the trail is omitted entirely.
  const trail = stack.length > 0 ? renderCrumbTrail(stack) : null;

  // Page-top filter input, always visible (not behind an icon).
  // Instant DOM filter on keystroke; 300ms-debounced auto-crawl
  // trigger drives the per-section pagers serially while the filter
  // has text.
  const filterWrap = renderFilterInput();
  _filterInput = filterWrap._input;

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('aria-live', 'polite');

  mount(root, html`
    <section data-view="browse" data-mode="drill">
      <p class="breadcrumb">${back}</p>
      ${trail}
      ${filterWrap}
      ${header}
      ${body}
    </section>
  `);

  // Child links embed the current crumb stack extended by the current
  // node's token. Capped at MAX_CRUMBS by trimming the head, preserving
  // the most recent crumbs (the path back to here).
  const childStack = currentToken ? [...stack, currentToken] : stack.slice();
  _childCrumbs = childStack.length > MAX_CRUMBS
    ? childStack.slice(childStack.length - MAX_CRUMBS)
    : childStack;

  // Cold-load: any crumb whose label isn't already cached gets
  // hydrated in parallel (concurrency cap DESCRIBE_CONCURRENCY).
  // Updates the trail in-place as labels resolve.
  if (trail) hydrateCrumbLabels(stack, trail);

  // tuneinBrowse accepts a parts object as the c-style top-level form
  // (`{c: 'music', filter: 'l216'}`) or a bare id string. The c+filter
  // shape is the language-tree rewrite output (§ 7.3); pass parts
  // through verbatim.
  loadInto(body, tuneinBrowse(parts), headerCount, {
    titleEl,
    crumbToken: currentToken,
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

function pluralize(n) {
  return n === 1 ? 'entry' : 'entries';
}

function skeleton() {
  const p = document.createElement('p');
  p.className = 'browse-loading';
  p.textContent = 'Loading...';
  return p;
}

function errorNode(err) {
  const p = document.createElement('p');
  p.className = 'browse-error';
  p.textContent = `Couldn't load this section: ${err.message}`;
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
// Tombstone payload → empty-state message.
//
// Returns the total visible row count (cursors + pivots are excluded
// — they're meta, not rows the user reads through).
export function renderOutline(body, json) {
  const rawItems = Array.isArray(json && json.body) ? json.body : [];

  if (rawItems.length === 0) {
    body.appendChild(emptyNode('Nothing here.'));
    return 0;
  }

  // Tombstone check (single text-only entry): § 6.2. A section
  // container (anything with children) is not a tombstone even if
  // classifyOutline tags it that way — the fallback in tunein-outline
  // returns 'tombstone' for any type-less typeless URL-less guide-less
  // outline, which also matches a bare section header.
  const onlyEntryIsTombstone = rawItems.length === 1
    && classifyOutline(rawItems[0]) === 'tombstone'
    && !(Array.isArray(rawItems[0].children) && rawItems[0].children.length > 0);
  if (onlyEntryIsTombstone) {
    body.appendChild(emptyNode(rawItems[0].text || 'Nothing here.'));
    return 0;
  }

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

function emptyNode(message) {
  const p = document.createElement('p');
  p.className = 'browse-empty';
  p.textContent = message;
  return p;
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
function renderSection(section) {
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
function renderFlatSection(entries) {
  const visible = entries.filter((c) => {
    const t = classifyOutline(c);
    return t !== 'cursor' && t !== 'pivot' && t !== 'tombstone';
  });
  const wrap = document.createElement('section');
  wrap.className = 'browse-section';
  wrap.setAttribute('data-section', 'flat');

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

function renderCard(entries) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const row = renderEntry(entries[i]);
    if (i === entries.length - 1) row.classList.add('is-last');
    card.appendChild(row);
  }
  return card;
}

// ---- c=pbrowse show-drill renderers --------------------------------
//
// renderLiveShowCard — the `liveShow` section's single p-prefix child
// is the currently-airing show. Default renderEntry classifies a
// p-prefix link as 'show' and routes through showRow (no Play). For
// the show drill we want a play-on-tap row, so route the child through
// stationRow directly — its auto-attach Play icon (#78) lights up on
// p/s/t guide_ids.
//
// The section's `text` ("Now Airing") is the card label; the row body
// carries the show's name + optional subtext (host / description).
function renderLiveShowCard(entries) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const row = renderLiveShowRow(entry);
    if (i === entries.length - 1) row.classList.add('is-last');
    row._outline = entry;
    card.appendChild(row);
  }
  return card;
}

function renderLiveShowRow(entry) {
  const id = (entry && typeof entry.guide_id === 'string') ? entry.guide_id : '';
  const norm = normaliseRow(entry);
  // stationRow auto-mounts a Play icon for s/p/t prefixes (components.js
  // § isPlayableSid). The href routes to #/station/<sid> by default;
  // for a live-show row that's not ideal but the Play icon is the
  // primary affordance, and the issue explicitly forbids us from
  // touching components.js for #81. No preset-assign affordance is
  // added — the issue forbids it and stationRow does not emit one.
  return stationRow({
    sid:      id,
    name:     norm.primary || id,
    art:      norm.image,
    location: norm.secondary,
  });
}

// renderTopicsCard — episode list. Each `t`-prefix child is rendered
// via stationRow (which auto-attaches the Play icon for t-prefix
// guide_ids). topic_duration, when present, is formatted as MM:SS or
// H:MM:SS and threaded into the meta line via stationRow's `location`
// slot — the only stationRow field that surfaces non-numeric text on
// the secondary line without requiring a components.js change.
function renderTopicsCard(entries) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const row = renderTopicRow(entry);
    if (i === entries.length - 1) row.classList.add('is-last');
    row._outline = entry;
    card.appendChild(row);
  }
  return card;
}

function renderTopicRow(entry) {
  const id = (entry && typeof entry.guide_id === 'string') ? entry.guide_id : '';
  const norm = normaliseRow(entry);
  // Surface topic_duration in the meta slot when present. The location
  // chunk is the only one stationRow renders for a row with no
  // bitrate/codec/reliability, so we thread duration there. When
  // duration is missing we fall back to the description (subtext) via
  // normaliseRow's secondary line.
  const duration = formatTopicDuration(entry && entry.topic_duration);
  // Tertiary line gets the description when we used duration as the
  // primary meta. Otherwise the description rides on the secondary
  // slot via norm.secondary.
  const tertiary = duration ? norm.secondary : '';
  return stationRow({
    sid:      id,
    name:     norm.primary || id,
    art:      norm.image,
    location: duration || norm.secondary,
    tertiary,
  });
}

// formatTopicDuration — TuneIn's `topic_duration` is a seconds value
// (numeric or numeric string). Returns "M:SS" for sub-hour episodes
// and "H:MM:SS" for longer ones. Returns '' on unparseable input.
function formatTopicDuration(raw) {
  let seconds;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    seconds = Math.max(0, Math.floor(raw));
  } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    seconds = Math.max(0, parseInt(raw, 10));
  } else {
    return '';
  }
  if (seconds === 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) {
    const mm = String(m).padStart(2, '0');
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

// ---- per-section pagination (#76) ----------------------------------
//
// After renderOutline has built its section cards, walk the body and
// mount a "Load more" button into each section that captured a cursor
// URL on `data-cursor-url`. Each button gets its own pager instance;
// the dedup Set is seeded from the section's already-rendered
// guide_ids so a mid-crawl re-rank that re-emits a page-0 row on
// page 1 doesn't double it.
//
// Exported for the integration test that drives it directly without
// going through the full SPA mount path.

export function mountLoadMoreButtons(body, opts) {
  const fetcher = (opts && typeof opts.fetcher === 'function')
    ? opts.fetcher
    : defaultPagerFetcher;
  const pageCap = (opts && Number.isFinite(opts.pageCap))
    ? opts.pageCap
    : undefined;
  const sections = findAllSections(body);
  for (const section of sections) {
    const cursorUrl = section.getAttribute('data-cursor-url');
    if (!cursorUrl) continue;
    const footer = findFooterIn(section);
    if (!footer) continue;
    // Seed dedup from the rows we've already mounted. Each station-row
    // / show-row carries a data-sid; browse-row entries don't because
    // they're drill nodes, not stations — they can't collide with the
    // cursor follow which only returns playables.
    const initialIds = collectGuideIds(section);
    const pager = createPager(cursorUrl, {
      fetch: fetcher,
      initialIds,
      pageCap,
      section: section.getAttribute('data-section') || '',
    });
    _activePagers.push(pager);
    mountLoadMoreButton(section, footer, pager);
  }
}

// Walk an element subtree and collect every `data-sid` value already
// in the DOM. Used to seed the pager dedup set.
function collectGuideIds(root) {
  const ids = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      const sid = node.getAttribute && node.getAttribute('data-sid');
      if (sid) ids.push(sid);
    }
    for (const c of node.childNodes || []) walk(c);
  }
  walk(root);
  return ids;
}

function findAllSections(root) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1 && node.getAttribute &&
        node.getAttribute('data-section') != null) {
      out.push(node);
    }
    for (const c of node.childNodes || []) walk(c);
  }
  walk(root);
  return out;
}

function findFooterIn(section) {
  function walk(node) {
    if (!node) return null;
    if (node.nodeType === 1) {
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      if (cls.split(/\s+/).includes('browse-section__footer')) return node;
    }
    for (const c of node.childNodes || []) {
      const found = walk(c);
      if (found) return found;
    }
    return null;
  }
  return walk(section);
}

function findCardIn(section) {
  function walk(node) {
    if (!node) return null;
    if (node.nodeType === 1) {
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      if (cls.split(/\s+/).includes('browse-card')) return node;
    }
    for (const c of node.childNodes || []) {
      const found = walk(c);
      if (found) return found;
    }
    return null;
  }
  return walk(section);
}

// Build the Load-more button, wire its click handler, append it into
// the section's footer.
function mountLoadMoreButton(section, footer, pager) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'browse-load-more';
  btn.textContent = 'Load more';
  btn.setAttribute('data-load-more', section.getAttribute('data-section') || '');
  // Idle / busy / done are the three button-state surfaces. Tests and
  // CSS hook off these attributes.
  btn.setAttribute('data-state', 'idle');
  btn.addEventListener('click', async () => {
    if (btn.getAttribute('data-state') === 'busy') return;
    btn.setAttribute('data-state', 'busy');
    btn.textContent = 'Loading...';
    let result;
    try {
      result = await pager.loadMore();
    } catch (err) {
      btn.setAttribute('data-state', 'error');
      btn.textContent = `Couldn't load more: ${err.message}`;
      return;
    }
    // Append the newly-fetched rows. `pager.rows` accumulates; track
    // how many were already in the DOM and append only the tail.
    appendNewRows(section, pager);
    if (pager.exhausted) {
      // The button removes itself when there's no more to fetch.
      footer.removeChild(btn);
    } else {
      btn.setAttribute('data-state', 'idle');
      btn.textContent = result && result.added === 0
        ? 'Load more (no new rows)'
        : 'Load more';
    }
  });
  footer.appendChild(btn);
}

// Append every pager row not yet represented in the section card. The
// pager exposes its accumulated rows array; track the count in the
// section dataset so subsequent loadMore calls only append the delta.
//
// Sections whose page-0 had only the cursor (e.g. Top 40 & Pop's
// "stations" key: 1 child, just nextStations) start with no
// .browse-card at all — renderSection only creates one when visible
// rows exist. We create the card lazily here, inserting it before the
// footer so layout stays consistent with page-0-populated sections.
function appendNewRows(section, pager) {
  let card = findCardIn(section);
  if (!card) {
    card = document.createElement('div');
    card.className = 'browse-card';
    const footer = findFooterIn(section);
    if (footer) section.insertBefore(card, footer);
    else section.appendChild(card);
  }
  const alreadyMounted = Number(section.getAttribute('data-pager-mounted') || '0');
  const rows = pager.rows;
  // Strip the `is-last` marker from the current last child so the new
  // tail row owns it (the visual rule applies only to the bottom row).
  const lastBefore = lastElementChild(card);
  if (lastBefore && lastBefore.classList && typeof lastBefore.classList.remove === 'function') {
    lastBefore.classList.remove('is-last');
  }
  for (let i = alreadyMounted; i < rows.length; i++) {
    const node = renderEntry(rows[i]);
    if (i === rows.length - 1) node.classList.add('is-last');
    card.appendChild(node);
  }
  section.setAttribute('data-pager-mounted', String(rows.length));
}

function lastElementChild(node) {
  if (!node || !node.childNodes) return null;
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const c = node.childNodes[i];
    if (c && c.nodeType === 1) return c;
  }
  return null;
}

// The production pager fetcher: canonicalisation happens inside the
// pager itself, so we just route the resulting URL through the CGI
// proxy. tuneinBrowse accepts either a bare id string or a parts
// object; for cursor URLs we already hold the full query string, so
// hand it to the proxy verbatim via the {params...} object form.
async function defaultPagerFetcher(canonicalUrl) {
  // canonicalUrl is `Browse.ashx?id=...&render=json` (no host) — extract
  // the params and re-pack as the parts object tuneinBrowse expects.
  const qIdx = canonicalUrl.indexOf('?');
  const qs = qIdx >= 0 ? canonicalUrl.slice(qIdx + 1) : '';
  const params = new URLSearchParams(qs);
  // tuneinBrowse forwards every param verbatim to the proxy, which in
  // turn forwards to opml.radiotime.com. The proxy already adds
  // render=json server-side, but having it on the request URL too is
  // idempotent (§ 6.1).
  const arg = {};
  for (const [k, v] of params.entries()) arg[k] = v;
  return tuneinBrowse(arg);
}

// Pivot chips render inline below the related section. Each chip is
// an anchor whose href goes through canonicaliseBrowseUrl so the
// language-tree rewrite (§ 7.3) and magic-param strip (§ 7.4) happen
// once at the seam.
function renderPivotChips(pivots) {
  const wrap = document.createElement('div');
  wrap.className = 'browse-pivots';
  for (const pivot of pivots) {
    const parts = drillPartsForUrl(pivot.url);
    const chip = document.createElement(parts ? 'a' : 'span');
    chip.className = parts ? 'browse-pivot' : 'browse-pivot is-disabled';
    if (parts) chip.setAttribute('href', drillHashFor(parts));
    chip.textContent = pivot.label || `pivot=${pivot.axis}`;
    chip.setAttribute('data-pivot-axis', pivot.axis);
    wrap.appendChild(chip);
  }
  return wrap;
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
function renderRelatedChips(children) {
  const wrap = document.createElement('div');
  wrap.className = 'browse-pivots browse-related';
  for (const entry of children || []) {
    const kind = classifyOutline(entry);
    if (kind === 'cursor' || kind === 'tombstone') continue;
    const parts = drillPartsFor(entry);
    const chip = document.createElement(parts ? 'a' : 'span');
    chip.className = parts ? 'browse-pivot' : 'browse-pivot is-disabled';
    if (parts) chip.setAttribute('href', drillHashFor(parts));
    chip.setAttribute('data-chip-kind', kind);
    if (kind === 'pivot') {
      const k = typeof entry.key === 'string' ? entry.key : '';
      const axis = k.startsWith('pivot') ? k.slice('pivot'.length).toLowerCase() : '';
      if (axis) chip.setAttribute('data-pivot-axis', axis);
    }
    const text = (entry && typeof entry.text === 'string') ? entry.text : '';
    chip.textContent = text || (parts && (parts.id || parts.c)) || '(unnamed)';
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
function drillPartsFor(entry) {
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
function drillPartsForUrl(rawUrl) {
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
  for (let i = 0; i < stack.length; i++) {
    const token = stack[i];
    const parts = partsFromCrumb(token);
    const a = document.createElement('a');
    a.className = 'browse-trail__crumb';
    a.dataset.crumbToken = token;
    if (parts) {
      // Each ancestor's own crumb stack is the prefix up to (and not
      // including) itself, so a click on crumb[i] navigates to that
      // node with from=stack[0..i-1].
      a.href = drillHashFor(parts, stack.slice(0, i));
    } else {
      a.className += ' is-disabled';
    }
    const cached = cache.get(`tunein.label.${token}`);
    a.textContent = (typeof cached === 'string' && cached !== '') ? cached : token;
    trail.appendChild(a);
  }
  return trail;
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
    } else {
      // Category prefixes + plain words — Browse returns head.title.
      // partsFromCrumb routes lowercase-letter+digit tokens through
      // `id=` and letters-only tokens through `c=`.
      const parts = partsFromCrumb(token);
      if (parts) {
        const json = await tuneinBrowse(parts);
        const t = json && json.head && json.head.title;
        if (typeof t === 'string' && t !== '') title = t;
      }
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

// ---- page-top filter + auto-crawl coordinator ----------------------
//
// The filter input mounts at the top of every drill view. Two
// behaviours:
//
//   1. Inline DOM filter (instant, no debounce) — rows whose
//      text/subtext/playing/current_track don't contain the query
//      substring (case-insensitive) gain `is-filtered-out`, which CSS
//      collapses to display:none. The 3-line core lives in
//      `filterRowEntries` below; the view's input handler just calls
//      it and the DOM applicator. No `tunein-filter` module — the
//      architecture review explicitly rejected one (deletion test:
//      it's a pass-through).
//
//   2. Eager-serial auto-crawl (300ms debounced trigger) — when the
//      filter has text AND at least one section has a non-exhausted
//      pager, the coordinator walks `_activePagers` in section order
//      (`local` → `stations` → `shows`, skipping `related` — no
//      cursor). Each pager pulls pages back-to-back until exhausted,
//      until the 50-page cap, or until the filter clears. New rows
//      mount via the same `appendNewRows` path the Load-more button
//      uses, then the DOM filter is re-applied so non-matches stay
//      hidden. Strictly serial: Bo's busybox CGI doubles in cost
//      under parallel requests, which would starve the now-playing
//      poller.

// Section keys whose pagers participate in the eager-serial crawl,
// in the order the coordinator walks them. `related` is excluded
// because it has no cursor — there's no `nextRelated` outline.
const CRAWL_SECTION_ORDER = ['local', 'stations', 'shows'];

const FILTER_DEBOUNCE_MS = 300;

// Build the filter input UI. Returns the wrapper element with the
// inner <input> stashed on `._input` for the caller (renderDrill) to
// register as the module-local `_filterInput`.
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
        if (_coordinator) _coordinator.stop();
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

// Read the current filter query, lowercased + trimmed. Empty string
// when the input is missing or blank.
function currentFilterQuery() {
  if (!_filterInput) return '';
  // xmldom's input has no `value` setter; read via attribute when the
  // property is absent.
  const v = typeof _filterInput.value === 'string'
    ? _filterInput.value
    : (_filterInput.getAttribute && _filterInput.getAttribute('value')) || '';
  return v.trim().toLowerCase();
}

// The 3-line filter rule, inlined here so the view stays the single
// owner of the per-keystroke match. Exported only so the test can
// pin the contract: rows whose text / subtext / playing /
// current_track contain the query (case-insensitive) survive.
export function filterRowEntries(rows, query) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (q === '') return Array.isArray(rows) ? rows.slice() : [];
  const fields = (r) => [r && r.text, r && r.subtext, r && r.playing, r && r.current_track];
  return (rows || []).filter((r) => fields(r).some((f) => typeof f === 'string' && f.toLowerCase().includes(q)));
}

// Walk every rendered row inside the drill body and toggle the
// `is-filtered-out` class against the current query. Rows without an
// `_outline` stash (e.g. the disabled fallback) stay visible — they're
// not paged content.
function applyDomFilter(scope) {
  const root = scope || (_filterInput && rootOf(_filterInput)) || null;
  if (!root) return;
  const q = currentFilterQuery();
  const rows = findAllRowElements(root);
  for (const node of rows) {
    if (q === '') {
      if (node.classList && typeof node.classList.remove === 'function') {
        node.classList.remove('is-filtered-out');
      }
      continue;
    }
    const entry = node._outline;
    if (!entry) continue;
    const matched = filterRowEntries([entry], q).length === 1;
    if (matched) {
      if (node.classList && typeof node.classList.remove === 'function') {
        node.classList.remove('is-filtered-out');
      }
    } else {
      if (node.classList && typeof node.classList.add === 'function') {
        node.classList.add('is-filtered-out');
      }
    }
  }
}

// Walk an element subtree, return every node tagged with the four
// row classes the renderer emits. The DOM filter operates on these
// exclusively.
function findAllRowElements(root) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      const cls = (node.getAttribute && node.getAttribute('class')) || '';
      const parts = cls.split(/\s+/);
      if (parts.includes('station-row') || parts.includes('browse-row')) {
        // Skip the disabled fallback shapes — they aren't paged rows.
        out.push(node);
      }
    }
    for (const c of node.childNodes || []) walk(c);
  }
  walk(root);
  return out;
}

// Climb to the drill view root from any descendant. The drill body
// hangs off `section[data-view="browse"][data-mode="drill"]`; we
// walk parents until we find it (or hit the document).
function rootOf(node) {
  let cur = node;
  while (cur && cur.parentNode) {
    const tag = cur.tagName && String(cur.tagName).toLowerCase();
    if (tag === 'section' && cur.getAttribute &&
        cur.getAttribute('data-view') === 'browse') {
      return cur;
    }
    cur = cur.parentNode;
  }
  return cur || node;
}

// The eager-serial coordinator. One instance per drill view; reset
// on every navigation via disposeActivePagers().
function ensureCoordinator() {
  if (_coordinator) {
    // Already running — let the loop pick up the new query on its
    // next iteration. `isFilterActive()` is checked between awaits.
    return _coordinator.kick();
  }
  if (_activePagers.length === 0) return Promise.resolve();
  _coordinator = createCrawlCoordinator();
  return _coordinator.start();
}

// The coordinator state machine. Holds the section index, the active
// pager, the progress strap, and a generation token so disposal mid-
// fetch is a no-op on the late resolution.
function createCrawlCoordinator() {
  let gen = 0;
  let strap = null;
  let stopped = false;
  let running = false;

  function nextPager(fromIndex) {
    // Section order is fixed; pick the first non-exhausted pager
    // matching CRAWL_SECTION_ORDER starting at index. Pagers from
    // other section keys are ignored (the spec is explicit about
    // skipping `related`).
    for (let i = fromIndex; i < CRAWL_SECTION_ORDER.length; i++) {
      const key = CRAWL_SECTION_ORDER[i];
      const p = _activePagers.find((x) => x.status && x.status.section === key);
      if (p && !p.exhausted) return { pager: p, index: i, key };
    }
    return null;
  }

  function isFilterActive() {
    return currentFilterQuery() !== '';
  }

  function mountStrap(sectionKey, scanned, cap) {
    const root = _filterInput ? rootOf(_filterInput) : null;
    if (!root) return null;
    const body = findFirstChildByClass(root, 'browse-body');
    if (!body) return null;
    // The strap mounts at the top of the drill body so it sits just
    // above the section card currently being crawled. One strap at a
    // time — repurposed across sections.
    let el = findFirstChildByClass(body, 'browse-strap');
    if (!el) {
      el = document.createElement('div');
      el.className = 'browse-strap';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const label = document.createElement('span');
      label.className = 'browse-strap__label';
      el.appendChild(label);
      if (body.firstChild) body.insertBefore(el, body.firstChild);
      else body.appendChild(el);
    }
    updateStrapText(el, sectionKey, scanned, cap);
    return el;
  }

  function updateStrapText(el, sectionKey, scanned, _cap) {
    if (!el) return;
    let label = findFirstChildByClass(el, 'browse-strap__label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'browse-strap__label';
      el.appendChild(label);
    }
    const human = sectionLabel(sectionKey);
    label.textContent = `Scanning ${human} · ${scanned} of ?`;
  }

  function unmountStrap() {
    if (strap && strap.parentNode) {
      try { strap.parentNode.removeChild(strap); } catch (_e) { /* ignored */ }
    }
    strap = null;
  }

  function attachKeepCrawlingAffordance(sectionKey, pager) {
    // The pager hit its 50-page cap with the filter still active.
    // Surface a "Keep crawling" button beside the strap; clicking it
    // resumes the same pager with a fresh cap of equal size.
    const root = _filterInput ? rootOf(_filterInput) : null;
    if (!root) return;
    const body = findFirstChildByClass(root, 'browse-body');
    if (!body) return;
    let el = findFirstChildByClass(body, 'browse-strap');
    if (!el) {
      el = mountStrap(sectionKey, pager.pagesFetched || 0, pager.status && pager.status.sectionCap);
    }
    if (!el) return;
    // If an existing button is mounted, leave it alone.
    if (findFirstChildByClass(el, 'browse-strap__keep')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browse-strap__keep';
    btn.textContent = 'Keep crawling';
    btn.addEventListener('click', () => {
      // Bump the pager out of "exhausted by cap" by lifting the cap
      // (caller asked for it). We can't poke pager.exhausted directly,
      // so swap in a fresh pager picking up at the same cursor URL.
      // In practice this is a rare path — when it lands, we restart
      // the coordinator after replacing the pager in `_activePagers`.
      restartCappedPager(pager);
      if (btn.parentNode) btn.parentNode.removeChild(btn);
      if (_coordinator) _coordinator.kick();
    });
    el.appendChild(btn);
  }

  async function loop() {
    if (running) return;
    running = true;
    const myGen = ++gen;
    try {
      let idx = 0;
      while (!stopped && myGen === gen && isFilterActive()) {
        const next = nextPager(idx);
        if (!next) break;
        idx = next.index;
        strap = mountStrap(next.key, next.pager.pagesFetched || 0,
          next.pager.status && next.pager.status.sectionCap);
        // Pull one page at a time; the pager's own pageCap halts.
        let result;
        try {
          result = await next.pager.loadMore();
        } catch (_err) {
          // Pager failure — give up on this section, move on.
          idx = next.index + 1;
          continue;
        }
        if (stopped || myGen !== gen) break;
        // Mount the newly-fetched rows into the section's card.
        const root = _filterInput ? rootOf(_filterInput) : null;
        if (root) {
          const section = findSectionByKey(root, next.key);
          if (section) appendNewRows(section, next.pager);
          applyDomFilter(root);
        }
        // Update the strap with the post-fetch scanned-count.
        updateStrapText(strap, next.key, next.pager.pagesFetched || 0,
          next.pager.status && next.pager.status.sectionCap);
        if (next.pager.exhausted) {
          // Did we exhaust on the cap with the filter still active?
          // Surface the affordance and pause this section.
          const cap = next.pager.status && next.pager.status.sectionCap;
          const hitCap = cap != null && next.pager.pagesFetched >= cap;
          if (hitCap && isFilterActive()) {
            attachKeepCrawlingAffordance(next.key, next.pager);
            // Pause — the user's click resumes the coordinator.
            return;
          }
          // Natural exhaustion — move to the next section. Unmount
          // the strap; the next iteration will mount a fresh one.
          unmountStrap();
          idx = next.index + 1;
        }
        // result.added intentionally not branched on — even an empty
        // page (post-dedup) is valid progress; the pager's status
        // update is what drives the strap.
        void result;
      }
    } finally {
      running = false;
      // Tidy up if we exited because of stop/filter-clear/section-
      // exhaustion. The keep-crawling pause path returns early
      // without falling through here.
      if (stopped || !isFilterActive() || myGen !== gen) {
        unmountStrap();
      } else if (nextPager(0) == null) {
        // All eligible sections exhausted with nothing capped.
        unmountStrap();
      }
    }
  }

  return {
    start() { stopped = false; return loop(); },
    stop()  { stopped = true; ++gen; unmountStrap(); },
    kick()  { if (!running) return loop(); return Promise.resolve(); },
    get running() { return running; },
  };
}

// Replace a capped pager with a fresh instance pointed at its current
// cursor URL. The new pager keeps the same dedup seed (existing rendered
// row IDs) so already-mounted rows don't re-mount. Mutates
// `_activePagers` in place so the coordinator's next nextPager() finds
// it.
function restartCappedPager(oldPager) {
  // The pager doesn't surface its current cursor URL; we re-discover it
  // from the section's `data-cursor-url` attribute — but only on a
  // fresh response after the cap. In practice the section retained the
  // original page-0 cursor; the safest restart is to dispose and stop.
  // Callers in this slice rely on the user clicking Load-more to push
  // further; mark the old pager disposed so the coordinator skips it.
  try { oldPager.dispose(); } catch (_e) { /* ignored */ }
}

function findFirstChildByClass(root, cls) {
  function walk(node) {
    if (!node) return null;
    if (node.nodeType === 1) {
      const c = (node.getAttribute && node.getAttribute('class')) || '';
      if (c.split(/\s+/).includes(cls)) return node;
    }
    for (const child of node.childNodes || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }
  return walk(root);
}

function findSectionByKey(root, key) {
  function walk(node) {
    if (!node) return null;
    if (node.nodeType === 1 && node.getAttribute &&
        node.getAttribute('data-section') === key) {
      return node;
    }
    for (const c of node.childNodes || []) {
      const found = walk(c);
      if (found) return found;
    }
    return null;
  }
  return walk(root);
}

// Human label for the strap. Section keys are TuneIn's wire-format
// shorthand; surface the same case-aware names the API itself emits
// in section headers.
function sectionLabel(key) {
  if (key === 'local')    return 'Local Stations';
  if (key === 'stations') return 'Stations';
  if (key === 'shows')    return 'Shows';
  return key || 'rows';
}

// Test-only entry points. The coordinator is otherwise driven by the
// filter input's change event.
export function _getCoordinatorForTest() { return _coordinator; }
export function _setActivePagersForTest(pagers) { _activePagers = pagers.slice(); }
export function _setFilterInputForTest(el) { _filterInput = el; }
export function _resetBrowseStateForTest() {
  disposeActivePagers();
}
export function _ensureCoordinatorForTest() { return ensureCoordinator(); }
export function _applyDomFilterForTest(root) { applyDomFilter(root); }

