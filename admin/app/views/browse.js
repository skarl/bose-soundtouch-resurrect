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

export default defineView({
  mount(root, _store, ctx) {
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

// Render a TuneIn outline tree. When the body is a single section with
// children, hoist its children to the top level so the user lands on
// the actual rows (not a section heading + nested rows). Returns the
// rendered row count for the caller's section header.
function renderOutline(body, json) {
  let items = Array.isArray(json && json.body) ? json.body : [];
  // Hoist a single wrapping section so the rows live in one card.
  if (items.length === 1 && Array.isArray(items[0].children) && items[0].children.length > 0) {
    items = items[0].children;
  }
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'browse-empty';
    p.textContent = 'Nothing here.';
    body.appendChild(p);
    return 0;
  }

  // Split into multi-section view vs single-card view. A multi-section
  // payload (each top entry has children) renders each section as its
  // own card; otherwise everything goes into one card.
  const sections = items.filter((e) => Array.isArray(e.children) && e.children.length > 0);
  const flats    = items.filter((e) => !Array.isArray(e.children) || e.children.length === 0);

  let count = 0;
  if (sections.length > 0) {
    for (const sec of sections) {
      count += sec.children.length;
      body.appendChild(renderSection(sec));
    }
  }
  if (flats.length > 0) {
    body.appendChild(renderCard(flats));
    count += flats.length;
  }
  return count;
}

function renderSection(entry) {
  const section = document.createElement('section');
  section.className = 'browse-section';
  const h = document.createElement('h2');
  h.className = 'section-h section-h--inline';
  const title = document.createElement('span');
  title.textContent = entry.text || '';
  const meta = document.createElement('span');
  meta.className = 'section-h__meta';
  meta.textContent = `${entry.children.length.toLocaleString()} ${pluralize(entry.children.length)}`;
  h.appendChild(title);
  h.appendChild(meta);
  section.appendChild(h);
  section.appendChild(renderCard(entry.children));
  return section;
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

// Public for tests. Each call returns ONE row element (.station-row for
// audio leaves, .browse-row for everything else).
export function renderEntry(entry) {
  // Audio leaves: full station card with art + meta + chevron.
  if (entry && entry.type === 'audio' && entry.guide_id) {
    return stationRow({
      sid:      entry.guide_id,
      name:     entry.text,
      art:      entry.image,
      location: entry.subtext,
      bitrate:  entry.bitrate,
      codec:    entry.formats,
    });
  }

  // Drillable section / link → .browse-row with id badge + label +
  // chevron. Non-resolvable entries become a disabled row. URL goes
  // through canonicaliseBrowseUrl so the language-tree rewrite
  // (§ 7.3) and the magic-param strip (§ 7.4) happen once, here, at
  // the seam where API-emitted URLs cross into client-emitted URLs.
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
  label.textContent = (entry && entry.text) || badgeText || '(unnamed)';
  row.appendChild(label);

  // Some Browse.ashx entries surface a count via current_track or
  // similar — leave it blank when absent rather than showing "0".
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

// Pick the drill parts for a link entry: prefer the canonicalised URL
// (which honours the language-tree rewrite); fall back to bare
// guide_id when the entry has no URL. Returns null if neither is
// usable — the caller renders a disabled row.
function drillPartsFor(entry) {
  if (!entry) return null;
  if (typeof entry.URL === 'string' && entry.URL !== '') {
    try {
      const canonical = canonicaliseBrowseUrl(entry.URL);
      const parts = extractDrillKey(canonical);
      if (parts.id || parts.c) return parts;
    } catch (_err) {
      // URL was malformed (e.g. colon-form lcode that the service
      // shouldn't even emit). Fall through and try guide_id.
    }
  }
  if (typeof entry.guide_id === 'string' && entry.guide_id !== '') {
    return { id: entry.guide_id };
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

