// Tests for app/views/browse.js — renderEntry() produces the polish-pass
// station-row layout for audio leaves and a browse-row for drillable
// section nodes. Mirrors the xmldom shim from test_components.js so the
// view can mount against a fake document.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation } from '@xmldom/xmldom';

// --- DOM shim (lifted from test_components.js) ----------------------

const doc = new DOMImplementation().createDocument(null, null, null);
if (!doc.querySelector) doc.querySelector = () => null;
if (!doc.documentElement) {
  const html = doc.createElement('html');
  doc.appendChild(html);
}
if (!doc.documentElement.dataset) doc.documentElement.dataset = {};
globalThis.document = doc;

const _sample = doc.createElement('span');
const ElementProto = Object.getPrototypeOf(_sample);

if (!ElementProto.classList) {
  Object.defineProperty(ElementProto, 'classList', {
    get() {
      const el = this;
      return {
        add(...names) {
          const cur = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
          for (const n of names) if (!cur.includes(n)) cur.push(n);
          el.setAttribute('class', cur.join(' '));
        },
        remove(...names) {
          const cur = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
          el.setAttribute('class', cur.filter((c) => !names.includes(c)).join(' '));
        },
        contains(name) {
          return (el.getAttribute('class') || '').split(/\s+/).includes(name);
        },
        toggle(name, force) {
          const has = this.contains(name);
          const want = force == null ? !has : !!force;
          if (want && !has) this.add(name);
          else if (!want && has) this.remove(name);
          return want;
        },
      };
    },
  });
}

if (!ElementProto.addEventListener) {
  ElementProto.addEventListener = function () {};
}

// xmldom keeps className / href / src as JS-only properties; the
// production code (browse.js, art.js) writes via the property and our
// assertions read via getAttribute. Mirror property → attribute so
// both sides see the same value.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'className')) {
  Object.defineProperty(ElementProto, 'className', {
    get() { return this.getAttribute('class') || ''; },
    set(v) { this.setAttribute('class', String(v == null ? '' : v)); },
  });
}
for (const attr of ['href', 'src', 'alt']) {
  if (!Object.getOwnPropertyDescriptor(ElementProto, attr)) {
    Object.defineProperty(ElementProto, attr, {
      get() { return this.getAttribute(attr) || ''; },
      set(v) { this.setAttribute(attr, String(v == null ? '' : v)); },
    });
  }
}
// dataset Proxy: data-foo ↔ dataset.foo round-trip via attributes.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'dataset')) {
  Object.defineProperty(ElementProto, 'dataset', {
    get() {
      const el = this;
      return new Proxy({}, {
        get(_t, key) {
          if (typeof key !== 'string') return undefined;
          const attr = 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          const v = el.getAttribute(attr);
          return v == null ? undefined : v;
        },
        set(_t, key, value) {
          if (typeof key !== 'string') return true;
          const attr = 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          el.setAttribute(attr, String(value));
          return true;
        },
      });
    },
  });
}

const { renderEntry, renderOutline } = await import('../app/views/browse.js');

function classOf(el) { return el.getAttribute('class') || ''; }

function findFirstByClass(root, cls) {
  if (!root) return null;
  if (classOf(root).split(/\s+/).includes(cls)) return root;
  for (let i = 0; i < (root.childNodes || []).length; i++) {
    const n = root.childNodes[i];
    if (n && n.nodeType === 1) {
      const found = findFirstByClass(n, cls);
      if (found) return found;
    }
  }
  return null;
}

// Walk an element subtree collecting every element matching the
// predicate. The xmldom shim doesn't ship querySelectorAll, so the
// stacked-section tests use this helper.
function findAllBy(root, predicate) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1 && predicate(node)) out.push(node);
    for (const c of node.childNodes || []) walk(c);
  }
  walk(root);
  return out;
}

function hasClass(el, cls) {
  return classOf(el).split(/\s+/).includes(cls);
}

// --- audio-leaf rendering -------------------------------------------

test('renderEntry: audio leaf renders a station-row with art + name + meta + chevron', () => {
  const node = renderEntry({
    type:       'audio',
    guide_id:   's12345',
    text:       'Radio Paradise',
    image:      'http://example/art.png',
    subtext:    'California',
    genre_name: 'Eclectic',
    bitrate:    192,
    formats:    'mp3',
  });

  assert.equal(node.tagName, 'a');
  assert.ok(classOf(node).includes('station-row'));
  assert.equal(node.getAttribute('href'), '#/station/s12345');

  const art = findFirstByClass(node, 'station-art');
  assert.ok(art, 'art slot present');

  const nameEl = findFirstByClass(node, 'station-row__name');
  assert.equal(nameEl.textContent, 'Radio Paradise');

  const loc = findFirstByClass(node, 'station-row__loc');
  assert.equal(loc.textContent, 'California');

  const fmt = findFirstByClass(node, 'station-row__fmt');
  assert.equal(fmt.textContent, '192k MP3');

  const chev = findFirstByClass(node, 'station-row__chev');
  assert.ok(chev, 'chevron slot present');
});

test('renderEntry: long station name keeps the truncating .station-row__name class', () => {
  const node = renderEntry({
    type:     'audio',
    guide_id: 's00099',
    text:     'A Spectacularly Long Station Name That Should Truncate Cleanly On Small Screens',
  });
  const nameEl = findFirstByClass(node, 'station-row__name');
  assert.ok(classOf(nameEl).includes('station-row__name'),
    '.station-row__name carries the white-space:nowrap + ellipsis style');
});

test('renderEntry: audio leaf without bitrate omits the format chunk', () => {
  const node = renderEntry({
    type:     'audio',
    guide_id: 's00001',
    text:     'No bitrate',
    subtext:  'Earth',
  });
  assert.equal(findFirstByClass(node, 'station-row__fmt'), null);
  const loc = findFirstByClass(node, 'station-row__loc');
  assert.equal(loc.textContent, 'Earth');
});

// --- browse-row rendering (non-audio entries) ----------------------

test('renderEntry: drillable section renders a browse-row with id badge + label + chevron', () => {
  const node = renderEntry({
    text: 'Genre',
    URL:  'http://opml.radiotime.com/Browse.ashx?id=g22',
  });
  assert.equal(node.tagName, 'a');
  assert.ok(classOf(node).includes('browse-row'));
  // The hash anchor encodes only the drill keys (id/c/filter/...) —
  // render=json belongs on the network URL, not in the SPA route.
  assert.equal(node.getAttribute('href'), '#/browse?id=g22');

  const idBadge = findFirstByClass(node, 'browse-row__id');
  assert.equal(idBadge.textContent, 'g22');

  const label = findFirstByClass(node, 'browse-row__label');
  assert.equal(label.textContent, 'Genre');

  const chev = findFirstByClass(node, 'browse-row__chev');
  assert.ok(chev, 'chevron slot present');
});

test('renderEntry: language-tree row (Welsh) rewrites the broken-form URL into a c=music drill hash', () => {
  // The API itself emits `id=c424724&filter=l117` for Welsh in the
  // c=lang response; that URL returns the tombstone. canonicaliseBrowseUrl
  // rewrites it into `c=music&filter=l117`, which returns the music hub
  // (25 drillable genre links). The href must reflect the rewrite.
  const node = renderEntry({
    text: 'Welsh',
    URL:  'http://opml.radiotime.com/Browse.ashx?id=c424724&filter=l117',
  });
  assert.equal(node.tagName, 'a');
  const href = node.getAttribute('href');
  assert.match(href, /^#\/browse\?/);
  assert.match(href, /c=music/, `expected c=music in hash: ${href}`);
  assert.match(href, /filter=l117/, `expected filter=l117 in hash: ${href}`);
  assert.doesNotMatch(href, /id=c424724/, `expected id=c424724 to be rewritten away: ${href}`);
});

test('renderEntry: language-tree row preserves filter into the drill hash for Bashkir', () => {
  const node = renderEntry({
    text: 'Bashkir',
    URL:  'http://opml.radiotime.com/Browse.ashx?id=c424724&filter=l216',
  });
  const href = node.getAttribute('href');
  assert.match(href, /c=music/);
  assert.match(href, /filter=l216/);
});

test('renderEntry: browse-row count badge renders when station_count is set', () => {
  const node = renderEntry({
    text: 'Jazz',
    URL:  'http://opml.radiotime.com/Browse.ashx?id=g24',
    station_count: 38420,
  });
  const c = findFirstByClass(node, 'browse-row__count');
  assert.ok(c, 'count badge present');
  assert.equal(c.textContent, '38,420');
});

test('renderEntry: entry without a usable id falls back to a non-clickable label', () => {
  const node = renderEntry({ text: '(unnamed)' });
  assert.equal(node.tagName, 'span');
  assert.ok(classOf(node).includes('browse-row'));
  assert.ok(classOf(node).includes('is-disabled'));
});

// --- stacked sections: renderOutline against the Folk fixture ------

test('renderOutline: Folk fixture produces four distinct section cards in order', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const folk = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/c100000948-page0.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  const total = renderOutline(body, folk);

  // Four sections, distinguishable by data-section attribute.
  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  const keys = sections.map((s) => s.getAttribute('data-section'));
  assert.deepEqual(keys, ['local', 'stations', 'shows', 'related'],
    `expected four sections in order, got: ${keys.join(', ')}`);

  // Each section's header (h2) is the API's section text verbatim.
  const headerTexts = sections.map((s) => {
    const title = findFirstByClass(s, 'section-h__title');
    return title ? title.textContent : '';
  });
  assert.deepEqual(headerTexts,
    ['Local Stations (2)', 'Stations', 'Shows', 'Explore Folk']);

  // The sections whose header text doesn't already inline the count
  // (Stations / Shows / Explore Folk) carry a section-h__meta with
  // "<N> entries". "Local Stations (2)" already has "(2)" in the
  // title, so it does NOT get a meta count (avoids "(2) … 2 entries").
  // Counts in section meta are the *visible* row count — cursors
  // and pivots are stripped. Stations: 24 children include 1
  // nextStations cursor → 23 visible. Shows: 7 children include 1
  // nextShows cursor → 6 visible.
  const stationsMeta = findFirstByClass(sections[1], 'section-h__meta');
  assert.ok(stationsMeta, 'Stations section has a count meta');
  assert.match(stationsMeta.textContent, /\b23\b/, `expected 23 in Stations meta, got: ${stationsMeta.textContent}`);

  const showsMeta = findFirstByClass(sections[2], 'section-h__meta');
  assert.ok(showsMeta);
  assert.match(showsMeta.textContent, /\b6\b/);

  // "Local Stations (2)" embeds the count; no separate meta.
  const localMeta = findFirstByClass(sections[0], 'section-h__meta');
  assert.equal(localMeta, null, 'Local section reuses the inline (2) count');

  // Total returned counts visible rows only (cursors + pivots
  // excluded). Folk page-0: 2 local + 23 stations + 6 shows + 1
  // "Most Popular" nav in related = 32. pivotLocation is a chip.
  assert.equal(total, 32, `expected 32 visible rows, got ${total}`);

  // Pivots in the related section render as inline chips.
  const relatedSection = sections[3];
  const chips = findAllBy(relatedSection, (el) => hasClass(el, 'browse-pivot'));
  assert.ok(chips.length >= 1, 'related section has at least one pivot chip');

  // Every section has a footer slot for Slice #76's Load-more button.
  for (const section of sections) {
    const footer = findFirstByClass(section, 'browse-section__footer');
    assert.ok(footer, `section ${section.getAttribute('data-section')} has a footer slot`);
  }

  // Sections with cursors carry data-cursor-url for #76.
  assert.ok(sections[1].getAttribute('data-cursor-url'),
    'stations section captured the nextStations cursor URL');
  assert.ok(sections[2].getAttribute('data-cursor-url'),
    'shows section captured the nextShows cursor URL');
});

test('renderOutline: paginated page (flat list) renders one section card with cursor parked on it', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const page1 = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/c100000948-page1.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  renderOutline(body, page1);

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  assert.equal(sections.length, 1, 'flat page renders as one section');
  assert.equal(sections[0].getAttribute('data-section'), 'flat');
});

test('renderOutline: tombstone response renders an empty-state message', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tomb = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/c424724-l117-tombstone.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  const total = renderOutline(body, tomb);

  assert.equal(total, 0);
  const empty = findFirstByClass(body, 'browse-empty');
  assert.ok(empty, 'tombstone produces a .browse-empty message node');
  assert.equal(empty.textContent, 'No stations or shows available');
  // No section cards.
  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  assert.equal(sections.length, 0);
});

// --- segmented control: CSS contract -------------------------------

test('browse css: .browse-tabs is a sunken 3-tab segmented control', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const css = fs.readFileSync(path.resolve('admin/style.css'), 'utf8');
  const tabsRule = css.match(/^\.browse-tabs\s*\{([^}]+)\}/m);
  assert.ok(tabsRule, 'found .browse-tabs rule');
  // Sunken-track look: padded background sits behind active pill.
  assert.match(tabsRule[1], /\bbackground:\s*var\(--surface-hi\)/);
  assert.match(tabsRule[1], /\bborder-radius:\s*8px\b/);
  assert.match(tabsRule[1], /\bpadding:\s*3px\b/);

  const tabRule = css.match(/^\.browse-tab\s*\{([^}]+)\}/m);
  assert.ok(tabRule, 'found .browse-tab rule');
  assert.match(tabRule[1], /\bflex:\s*1\b/);
});
