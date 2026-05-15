// browse — TuneIn taxonomy browser. Owns the drill-view
// orchestration: root tabs, drill frame (back / trail / header /
// filter / body), filter input mount, and lifecycle (disposing
// previous pagers on every navigation). Row → DOM rendering,
// "Load more" pagination, the eager-serial crawl coordinator, and
// the c=pbrowse show-landing body all live in the per-concern
// submodules under `./browse/`. The crumb-stack value type +
// renderers + hydrators are split between `./browse/crumb-parts.js`
// (pure value type + label-resolution reads) and
// `./browse/crumb-renderer.js` (DOM pillbar + async label hydration).
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
import { tuneinBrowse } from '../api.js';
import { lcodeLabel, LCODES_LOADED_EVENT } from '../tunein-url.js';
import { cache, TTL_LABEL } from '../tunein-cache.js';
import { resolveBrowseDrill } from '../tunein-drill.js';

import {
  renderOutline,
  renderEntry,
  pluralize,
  skeleton,
  errorNode,
  emptyNode,
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
import {
  MAX_CRUMBS,
  parseCrumbs,
  stringifyCrumbs,
  crumbTokenFor,
  partsFromCrumb,
  pickDrillParts,
  filtersOf,
  crumbLabelFor,
  backHrefFor,
  initialHeaderTitle,
} from './browse/crumb-parts.js';
import {
  renderPillBar,
  renderCrumbTrail,
  renderFilterBadge,
  renderFilterBadges,
  hydrateCrumbLabels,
  patchTrailCrumb,
} from './browse/crumb-renderer.js';

// Re-export the entry/render primitives + crumb helpers + test hooks
// so existing callers (test_browse, test_browse_crumbs,
// test_tunein_pager, main.js) keep their imports stable across the
// split. The split is internal-only — every public surface of the
// original browse.js still resolves through this module.
export {
  renderOutline,
  renderEntry,
  filterRowEntries,
  mountLoadMoreButtons,
  parseCrumbs,
  stringifyCrumbs,
  crumbTokenFor,
  partsFromCrumb,
  crumbLabelFor,
  backHrefFor,
  renderPillBar,
  renderCrumbTrail,
  renderFilterBadge,
  renderFilterBadges,
  _renderShowLandingForTest,
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
  // just this tab's anchor token. The ctx threads the prefix into
  // outline-render so renderEntry composes child hrefs correctly.
  const tabToken = crumbTokenFor(tab.params);
  const ctx = {
    childCrumbs: tabToken ? [tabToken] : [],
    currentParts: null,
  };
  headerLeft.textContent = tab.label;
  headerCount.textContent = '';
  loadInto(body, tuneinBrowse(tab.params), headerCount, null, ctx);
}

// ---- drill view (id=...) --------------------------------------------
//
// renderDrill (sectioned outline) and renderShowLanding (c=pbrowse)
// share a frame. Top of the drill body is a single pill-bar that
// folds the old standalone Back link + standalone crumb trail into
// one row: a circular chevron-only Back affordance leads, followed
// by an inline trail `Browse › <Tab> › <Ancestor> › <Current>`
// where the trailing segment is the bolded, non-link current node.
// Below the bar sits the page title (h1 + small muted <sid> suffix);
// below that a thin count strap (kept for loadInto's total-count
// write). Each caller (renderDrill / renderShowLanding) adds the
// mode-specific bits (filter input for renderDrill).

function buildDrillFrame(parts, crumbs) {
  const stack = Array.isArray(crumbs) ? crumbs.slice(0, MAX_CRUMBS) : [];
  const currentToken = crumbTokenFor(parts);

  // Pill bar: circular chevron Back + inline trail.
  const bar = renderPillBar(parts, stack);

  // Page title row: h1 (resolved name) + small muted sid suffix.
  // titleEl starts as the cached label (or compact parts form);
  // loadInto upgrades it to head.title once the response lands.
  const titleRow = document.createElement('div');
  titleRow.className = 'browse-title-row';
  const titleEl = document.createElement('h1');
  titleEl.className = 'browse-title';
  titleEl.textContent = initialHeaderTitle(parts, currentToken);
  const crumbId = document.createElement('span');
  crumbId.className = 'browse-title__sid';
  crumbId.textContent = crumbLabelFor(parts);
  titleRow.appendChild(titleEl);
  titleRow.appendChild(crumbId);

  // Thin count strap below the title — keeps the .section-h__meta
  // slot loadInto writes the total-entry count into. Title + sid are
  // gone (they're in the h1 above); the strap stays so the user gets
  // an at-a-glance "N entries" cue under the page title.
  const header = document.createElement('div');
  header.className = 'section-h browse-section-h';
  const headerCount = document.createElement('span');
  headerCount.className = 'section-h__meta';
  header.appendChild(headerCount);

  // Child links embed the current crumb stack extended by the current
  // node's token. Capped at MAX_CRUMBS by trimming the head, preserving
  // the most recent crumbs (the path back to here).
  const childStack = currentToken ? [...stack, currentToken] : stack.slice();
  const trimmed = childStack.length > MAX_CRUMBS
    ? childStack.slice(childStack.length - MAX_CRUMBS)
    : childStack;

  return {
    stack, currentToken, titleEl, crumbId, headerCount, header,
    bar, titleRow,
    // Sub-handles for hydrateCrumbLabels + Back-link aria-label patch.
    trailEl: bar._trail,
    backEl:  bar._back,
    childCrumbs: trimmed,
  };
}

function renderDrill(root, parts, crumbs) {
  const frame = buildDrillFrame(parts, crumbs);

  // Render context for the outline pipeline. childCrumbs is the stack
  // child rows embed in `from=…`; currentParts hands THIS page's
  // filters to the refinement-chip composer so chaining stacks rather
  // than replaces (#106).
  const ctx = {
    childCrumbs: frame.childCrumbs,
    currentParts: parts,
  };

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
      ${frame.bar}
      ${frame.titleRow}
      ${filterWrap}
      ${frame.header}
      ${body}
    </section>
  `);

  // Cold-load: any crumb whose label isn't already cached gets
  // hydrated in parallel (concurrency cap DESCRIBE_CONCURRENCY).
  // Updates the trail in-place as labels resolve, and re-stamps the
  // Back-link aria-label when the popped-target's label resolves.
  if (frame.trailEl) hydrateCrumbLabels(frame.stack, frame.trailEl, frame.backEl);

  // Re-patch the filter-aware badge + breadcrumb anchors whenever the
  // lcode catalogue lands after this view mounted. The boot-time
  // Describe.ashx?c=languages fetch typically resolves within ~1 s of
  // app start; on a cold load straight into a deep language drill the
  // initial render happens first, so without this hook the user would
  // see `c=music · filter=l109` with no "(German)" suffix until the
  // next navigation. (#89, #90)
  registerLcodeRepatch(parts, frame.crumbId, frame.trailEl, frame.stack, frame.backEl, frame.bar && frame.bar._filter);

  // One-shot drill — the seam owns the fetch policy: transport throws,
  // structured-error envelopes, the head.status non-200 + body:[] case
  // (c=pbrowse on Bo's egress, etc.), and the canonical empty / single-
  // tombstone shapes all collapse to a tagged DrillResult. The renderer
  // here is the thin shell that paints each kind. parts pass through
  // verbatim — the seam consumes the c-style top-level form
  // (`{c:'music', filter:'l216'}`) or a bare-id form the same way
  // tuneinBrowse does.
  loadDrillBody(body, parts, frame.headerCount, {
    titleEl: frame.titleEl,
    crumbToken: frame.currentToken,
    trailEl: frame.trailEl,
  }, ctx);
}

// loadDrillBody — drill-specific body loader. Reads the seam's
// classified DrillResult and paints exactly one of three outcomes;
// the renderOutline branch keeps the success-path side-effects the
// original loadInto carried (header count, title upgrade, crumb-label
// cache write, Load-more wiring, sticky-filter rehydration).
function loadDrillBody(body, parts, headerCount, head, ctx) {
  body.replaceChildren();
  body.appendChild(skeleton());
  if (headerCount) headerCount.textContent = '';
  resolveBrowseDrill(parts)
    .then((r) => {
      body.replaceChildren();
      if (r.kind === 'error') {
        body.appendChild(errorNode(r.error));
        return;
      }
      if (r.kind === 'empty') {
        body.appendChild(emptyNode(r.message));
        return;
      }
      const json = r.json;
      const total = renderOutline(body, json, ctx);
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
        // Also refresh the trail's current-crumb segment so the bolded
        // tail matches the h1 (was rendering as the raw sid until
        // Describe resolved). The patcher is a no-op when the trail
        // isn't mounted.
        if (head.trailEl) patchTrailCrumb(head.trailEl, head.crumbToken, title);
      }
      // Mount one pager + Load-more button per section that came back
      // with a cursor URL parked on it by renderSection / renderFlatSection.
      // Hand the same ctx to the pager so paginated rows get the same
      // childCrumbs / currentParts as the page-0 render.
      mountLoadMoreButtons(body, { ctx });
      // If the filter input already has text (e.g. user navigates with
      // a sticky filter), apply it to the freshly-rendered rows and
      // kick the coordinator.
      if (currentFilterQuery() !== '') {
        applyDomFilter();
        ensureCoordinator();
      }
    })
    .catch((err) => {
      // Defence: resolveBrowseDrill is structured to never reject — every
      // transport throw collapses into kind:'error'. A reject here would
      // be a programmer error in the seam itself; render an error node
      // rather than leaving the skeleton mounted.
      body.replaceChildren();
      body.appendChild(errorNode(err));
    });
}

// One-shot listener: when the lcode catalogue is broadcast as loaded,
// re-evaluate the drill-header badge and re-hydrate any crumb trail
// anchor whose token carries an unresolved language filter. `{ once:
// true }`; no teardown on view unmount because the DOM-patch is a
// no-op when the elements are gone.
function registerLcodeRepatch(parts, crumbIdEl, trailEl, stack, backEl, filterBar) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const filters = filtersOf(parts);
  const hasFilterableToken = filters.some((f) => /^l\d+$/.test(f))
    || (Array.isArray(stack) && stack.some((tok) => /:l\d+(?:\+|$)/.test(tok || '') || /:l\d+/.test(tok || '')));
  if (!hasFilterableToken) return;
  window.addEventListener(LCODES_LOADED_EVENT, () => {
    if (crumbIdEl && typeof crumbIdEl.textContent === 'string') {
      crumbIdEl.textContent = crumbLabelFor(parts);
    }
    if (trailEl) hydrateCrumbLabels(stack, trailEl, backEl);
    // Active-filter badges: when a filter is an lcode, re-resolve the
    // badge label from the freshly-loaded catalogue. The bar carries
    // one badge per filter (#106); each exposes `._badges[]` for the
    // hydrator.
    if (filterBar && Array.isArray(filterBar._badges)) {
      for (const badge of filterBar._badges) {
        if (!badge || !badge._label) continue;
        const tok = badge.dataset && badge.dataset.filterToken;
        if (typeof tok === 'string' && /^l\d+$/.test(tok)) {
          const name = lcodeLabel(tok);
          if (name) badge._label.textContent = name;
        }
      }
    }
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

  // Show-landing isn't a filterable drill, but the related sections
  // it mounts are real drill rows — they need the child crumb prefix
  // and currentParts so chip / row hrefs compose correctly.
  const ctx = {
    childCrumbs: frame.childCrumbs,
    currentParts: parts,
  };

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('data-mode', 'show-landing');
  body.setAttribute('aria-live', 'polite');

  mount(root, html`
    <section data-view="browse" data-mode="show-landing">
      ${frame.bar}
      ${frame.titleRow}
      ${frame.header}
      ${body}
    </section>
  `);

  if (frame.trailEl) hydrateCrumbLabels(frame.stack, frame.trailEl, frame.backEl);

  loadShowLanding(body, parts.id, frame.headerCount, {
    titleEl: frame.titleEl,
    crumbToken: frame.currentToken,
  }, ctx);
}

// ---- shared loader --------------------------------------------------
//
// `head` is null for the root tabs view (where the section title is the
// tab name) or { titleEl, crumbToken } for drill view, in which case
// the loader upgrades titleEl to json.head.title and stashes the label
// in the cache under tunein.label.<crumbToken>.

function loadInto(body, promise, headerCount, head, ctx) {
  body.replaceChildren();
  body.appendChild(skeleton());
  if (headerCount) headerCount.textContent = '';
  promise
    .then((json) => {
      body.replaceChildren();
      const total = renderOutline(body, json, ctx);
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
        // Also refresh the trail's current-crumb segment so the
        // bolded tail matches the h1 (was rendering as the raw sid
        // until Describe resolved). The patcher is a no-op when the
        // trail isn't mounted.
        if (head.trailEl) patchTrailCrumb(head.trailEl, head.crumbToken, title);
      }
      // Mount one pager + Load-more button per section that came back
      // with a cursor URL parked on it by renderSection / renderFlatSection.
      mountLoadMoreButtons(body, { ctx });
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
