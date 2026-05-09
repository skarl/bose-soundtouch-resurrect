// browse — TuneIn taxonomy browser.
//
// Two modes:
//   1. Root view (#/browse): three tabs (Genre / Location / Language).
//      Tab clicks fetch that subtree in-place; no route change.
//   2. Drill view (#/browse?id=<id>): fetches Browse.ashx?id=<id>,
//      renders children + a breadcrumb back to the root.
//
// Audio leaves render via stationCard() and link to #/station/sNNN.
// See admin/PLAN.md § View specs / browse and docs/tunein-api.md.

import { html, mount } from '../dom.js';
import { tuneinBrowse } from '../api.js';
import { stationCard } from '../components.js';

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

export default {
  init(root, _store, ctx) {
    const drillId = (ctx && ctx.query && ctx.query.id) || null;
    if (drillId) {
      renderDrill(root, drillId);
    } else {
      renderRoot(root);
    }
  },
  update(/* state, changedKey */) {
    // Browse is a static view: no store subscription. Re-entry via
    // hashchange runs init() again, which is the refresh path.
  },
};

// ---- root view (tabs) -----------------------------------------------

function renderRoot(root) {
  const tabsBar = document.createElement('nav');
  tabsBar.className = 'browse-tabs';
  tabsBar.setAttribute('aria-label', 'Browse categories');

  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('aria-live', 'polite');

  const buttons = TABS.map((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browse-tab';
    btn.dataset.tab = tab.key;
    btn.textContent = tab.label;
    btn.addEventListener('click', () => selectTab(tab, buttons, body));
    tabsBar.appendChild(btn);
    return btn;
  });

  mount(root, html`
    <section data-view="browse">
      <h1>Browse</h1>
      ${tabsBar}
      ${body}
    </section>
  `);

  selectTab(TABS[0], buttons, body);
}

function selectTab(tab, buttons, body) {
  for (const b of buttons) {
    const active = b.dataset.tab === tab.key;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  loadInto(body, tuneinBrowse(tab.params));
}

// ---- drill view (id=...) --------------------------------------------

function renderDrill(root, id) {
  const body = document.createElement('div');
  body.className = 'browse-body';
  body.setAttribute('aria-live', 'polite');

  mount(root, html`
    <section data-view="browse" data-mode="drill">
      <p class="breadcrumb"><a href="#/browse">&larr; Browse</a></p>
      <h1>${id}</h1>
      ${body}
    </section>
  `);

  loadInto(body, tuneinBrowse(id));
}

// ---- shared loader --------------------------------------------------

function loadInto(body, promise) {
  body.replaceChildren();
  body.appendChild(skeleton());
  promise
    .then((json) => {
      body.replaceChildren();
      renderOutline(body, json);
    })
    .catch((err) => {
      body.replaceChildren();
      body.appendChild(errorNode(err));
    });
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

// Render a TuneIn outline tree. Sections (entries with `children`) get
// a heading + nested list; flat entries render as link rows or station
// cards depending on type.
function renderOutline(body, json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'browse-empty';
    p.textContent = 'Nothing here.';
    body.appendChild(p);
    return;
  }
  for (const entry of items) {
    body.appendChild(renderEntry(entry));
  }
}

function renderEntry(entry) {
  if (Array.isArray(entry.children) && entry.children.length > 0) {
    const section = document.createElement('section');
    section.className = 'browse-section';
    const h = document.createElement('h2');
    h.textContent = entry.text || '';
    section.appendChild(h);
    const list = document.createElement('div');
    list.className = 'browse-list';
    for (const child of entry.children) list.appendChild(renderEntry(child));
    section.appendChild(list);
    return section;
  }

  if (entry.type === 'audio' && entry.guide_id) {
    return stationCard({
      sid:      entry.guide_id,
      name:     entry.text,
      art:      entry.image,
      location: entry.subtext,
      format:   entry.bitrate ? `${entry.bitrate} kbps` : entry.formats,
    });
  }

  // Default: drillable link. Extract id from the URL or the entry's
  // own guide_id; fall back to a non-clickable label for entries
  // TuneIn can return without a usable target (rare).
  const id = entry.guide_id || extractIdFromUrl(entry.URL);
  if (id) {
    const a = document.createElement('a');
    a.className = 'browse-link';
    a.href = `#/browse?id=${encodeURIComponent(id)}`;
    a.textContent = entry.text || id;
    return a;
  }

  const span = document.createElement('span');
  span.className = 'browse-link is-disabled';
  span.textContent = entry.text || '(unnamed)';
  return span;
}

function extractIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/[?&](?:id|c)=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
