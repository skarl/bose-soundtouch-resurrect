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
import { tuneinBrowse } from '../api.js';
import { stationRow } from '../components.js';
import { icon } from '../icons.js';
import { canonicaliseBrowseUrl, extractDrillKey } from '../tunein-url.js';

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
    const query = (ctx && ctx.query) || {};
    const drillParts = pickDrillParts(query);
    if (drillParts) {
      renderDrill(root, drillParts);
    } else {
      renderRoot(root);
    }
    return {};
  },
});

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
function drillHashFor(parts) {
  const qs = new URLSearchParams();
  if (parts.id)     qs.set('id', parts.id);
  if (parts.c)      qs.set('c', parts.c);
  if (parts.filter) qs.set('filter', parts.filter);
  if (parts.pivot)  qs.set('pivot', parts.pivot);
  if (parts.offset) qs.set('offset', parts.offset);
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

  selectTab(TABS[0], buttons, body, headerLeft, headerCount);
}

function selectTab(tab, buttons, body, headerLeft, headerCount) {
  for (const b of buttons) {
    const active = b.dataset.tab === tab.key;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  headerLeft.textContent = tab.label;
  headerCount.textContent = '';
  loadInto(body, tuneinBrowse(tab.params), headerCount);
}

// ---- drill view (id=...) --------------------------------------------

function renderDrill(root, parts) {
  const back = document.createElement('a');
  back.className = 'browse-back';
  back.href = '#/browse';
  back.appendChild(icon('back', 12));
  const backLabel = document.createElement('span');
  backLabel.textContent = ' Back';
  back.appendChild(backLabel);

  const header = document.createElement('div');
  header.className = 'section-h browse-section-h';
  const headerLeft = document.createElement('span');
  headerLeft.className = 'section-h__title browse-crumb';
  const crumbId = document.createElement('span');
  crumbId.className = 'browse-crumb__id';
  crumbId.textContent = crumbLabelFor(parts);
  headerLeft.appendChild(crumbId);
  const headerCount = document.createElement('span');
  headerCount.className = 'section-h__meta';
  header.appendChild(headerLeft);
  header.appendChild(headerCount);

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('aria-live', 'polite');

  mount(root, html`
    <section data-view="browse" data-mode="drill">
      <p class="breadcrumb">${back}</p>
      ${header}
      ${body}
    </section>
  `);

  // tuneinBrowse accepts a parts object as the c-style top-level form
  // (`{c: 'music', filter: 'l216'}`) or a bare id string. The c+filter
  // shape is the language-tree rewrite output (§ 7.3); pass parts
  // through verbatim.
  loadInto(body, tuneinBrowse(parts), headerCount);
}

// ---- shared loader --------------------------------------------------

function loadInto(body, promise, headerCount) {
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

