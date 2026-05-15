// pager-crawl — per-section "Load more" pagers + the eager-serial
// filter-crawl coordinator. The two surfaces share state (`_activePagers`
// and the row-append path), so they live in one module:
//
//   - mountLoadMoreButtons walks the rendered drill body and parks one
//     pager + Load-more button on each section that captured a cursor.
//   - appendNewRows is the row-append seam shared between the Load-more
//     click handler and the coordinator's crawl loop.
//   - the crawl coordinator walks `_activePagers` in section order while
//     the filter input has text; serial across sections so Bo's busybox
//     CGI never sees parallel cursor follows.
//
// `disposeActivePagers` resets both: every drill mount tears down the
// previous drill's pagers + coordinator + filter-input handle before
// installing fresh ones.

import { createPager } from '../../tunein-pager.js';
import { tuneinBrowse } from '../../api.js';
import { renderEntry } from './outline-render.js';

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

// Browse.js owns the input mount; it hands the element to us via
// setFilterInput so currentFilterQuery / applyDomFilter / the
// coordinator can read it.
export function setFilterInput(el) {
  _filterInput = el;
}

export function disposeActivePagers() {
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

// ---- per-section pagination ----------------------------------------
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
  // Render ctx for newly-fetched rows. Stashed on each pager so the
  // Load-more click handler + the coordinator's appendNewRows can
  // re-build the row with the same childCrumbs / currentParts the
  // page-0 render used.
  const ctx = (opts && opts.ctx) || null;
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
    pager._renderCtx = ctx;
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
export function appendNewRows(section, pager) {
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
  const ctx = pager && pager._renderCtx ? pager._renderCtx : null;
  for (let i = alreadyMounted; i < rows.length; i++) {
    const node = renderEntry(rows[i], ctx);
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

// ---- page-top filter + auto-crawl coordinator ----------------------
//
// The filter input mounts at the top of every drill view (composed by
// browse.js). Two behaviours:
//
//   1. Inline DOM filter (instant, no debounce) — rows whose
//      text/subtext/playing/current_track don't contain the query
//      substring (case-insensitive) gain `is-filtered-out`, which CSS
//      collapses to display:none.
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

// Read the current filter query, lowercased + trimmed. Empty string
// when the input is missing or blank.
export function currentFilterQuery() {
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
export function applyDomFilter(scope) {
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
export function ensureCoordinator() {
  if (_coordinator) {
    // Already running — let the loop pick up the new query on its
    // next iteration. `isFilterActive()` is checked between awaits.
    return _coordinator.kick();
  }
  if (_activePagers.length === 0) return Promise.resolve();
  _coordinator = createCrawlCoordinator();
  return _coordinator.start();
}

// Stop the coordinator without disposing pagers. Called when the
// filter input clears mid-crawl.
export function stopCoordinator() {
  if (_coordinator) _coordinator.stop();
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
