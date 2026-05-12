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

function disposeActivePagers() {
  for (const p of _activePagers) {
    try { p.dispose(); } catch (_err) { /* defensive */ }
  }
  _activePagers = [];
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

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('aria-live', 'polite');

  mount(root, html`
    <section data-view="browse" data-mode="drill">
      <p class="breadcrumb">${back}</p>
      ${trail}
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
  const items = Array.isArray(json && json.body) ? json.body : [];

  if (items.length === 0) {
    body.appendChild(emptyNode('Nothing here.'));
    return 0;
  }

  // Tombstone check (single text-only entry): § 6.2.
  if (items.length === 1 && classifyOutline(items[0]) === 'tombstone') {
    body.appendChild(emptyNode(items[0].text || 'Nothing here.'));
    return 0;
  }

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

  // Row card.
  if (visibleChildren.length > 0) {
    wrap.appendChild(renderCard(visibleChildren));
  }

  // Pivot chips (related section in practice — but we don't filter by
  // section name; anywhere the API emits `pivot*` children gets chips).
  const pivots = extractPivots(section);
  if (pivots.length > 0) {
    wrap.appendChild(renderPivotChips(pivots));
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

  if (kind === 'station' || kind === 'topic') {
    return stationRow({
      sid:      norm.id || entry.guide_id || '',
      name:     norm.primary,
      art:      norm.image,
      location: norm.secondary,
      bitrate:  entry && entry.bitrate,
      codec:    entry && entry.formats,
    });
  }

  if (kind === 'show') {
    // Shows are drill-into-detail, not direct play. Reuse stationRow
    // for layout parity but the URL goes through the drill hash.
    return showRow(entry, norm);
  }

  if (kind === 'tombstone') {
    return disabledRow(norm.primary || '(unavailable)');
  }

  // drill / pivot / nav / cursor all fall through to the
  // browse-row shape. Pivot/cursor entries shouldn't reach here in
  // the multi-section path (they're stripped or chip-rendered) but
  // we keep the fallback honest.
  return drillRow(entry, norm, kind);
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

  // Some Browse.ashx entries surface a child count via station_count /
  // count / item_count.
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

