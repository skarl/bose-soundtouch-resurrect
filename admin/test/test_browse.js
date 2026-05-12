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
  ElementProto.addEventListener = function (type, fn) {
    const map = this.__listeners__ || (this.__listeners__ = new Map());
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  ElementProto.removeEventListener = function (type, fn) {
    const map = this.__listeners__;
    if (map && map.has(type)) map.get(type).delete(fn);
  };
  ElementProto.dispatchEvent = function (evt) {
    const map = this.__listeners__;
    if (!map || !map.has(evt.type)) return true;
    for (const fn of map.get(evt.type)) {
      try { fn.call(this, evt); } catch (_e) { /* swallow */ }
    }
    return !evt.defaultPrevented;
  };
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
for (const attr of ['href', 'src', 'alt', 'id']) {
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

// --- Play icon on stationRow (issue #78) ----------------------------
//
// Tests cover only the new Play-icon click flow added by stationRow's
// extension. browse.js orchestration tests above stay untouched so #76
// (Load-more button mounting) can land without merge churn.

// Bottom-of-file shims for the things the Play handler needs at runtime.
// document.body is required by toast.showToast (it appends a container).
// sessionStorage is needed by tunein-cache's defaultStorage.
if (!doc.body) {
  const body = doc.createElement('body');
  doc.documentElement.appendChild(body);
  // Make doc.body resolve to the same node we just attached.
  Object.defineProperty(doc, 'body', { value: body, configurable: true });
}
if (!doc.getElementById) {
  doc.getElementById = function (id) {
    function walk(node) {
      if (!node) return null;
      if (node.nodeType === 1 && node.getAttribute && node.getAttribute('id') === id) return node;
      for (const c of node.childNodes || []) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    }
    return walk(doc);
  };
}
if (typeof globalThis.sessionStorage === 'undefined') {
  const m = new Map();
  globalThis.sessionStorage = {
    getItem(k)         { return m.has(k) ? m.get(k) : null; },
    setItem(k, v)      { m.set(k, String(v)); },
    removeItem(k)      { m.delete(k); },
    clear()            { m.clear(); },
  };
}
// xmldom's <span> doesn't expose offsetWidth; the toast nudges layout
// with `void node.offsetWidth`. A getter returning 0 is enough — we
// just need the property access to not throw.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'offsetWidth')) {
  Object.defineProperty(ElementProto, 'offsetWidth', { get() { return 0; } });
}

// Lazy import — tunein-cache + toast import lazily-bound globals we set up above.
const { cache: playCache } = await import('../app/tunein-cache.js');

function findPlayButton(row) {
  return findFirstByClass(row, 'station-row__play');
}

function dispatchClick(el) {
  const evt = {
    type: 'click',
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  if (typeof el.dispatchEvent === 'function') return el.dispatchEvent(evt);
  // Fallback for the xmldom shim path: pull registered click handlers
  // directly off __listeners__. The shim in test_components.js installs
  // exactly this storage shape.
  const map = el.__listeners__;
  if (map && map.get('click')) for (const fn of map.get('click')) fn.call(el, evt);
}

async function flushMicrotasks() {
  // Resolve any chained .then() handlers queued by the click. The
  // Play handler awaits fetch → res.json() → playGuideId → caller,
  // so we drain several macrotask ticks to be safe.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

test('stationRow: station (s-prefix) renders a Play button with 44x44 tap target', async () => {
  const node = renderEntry({
    type: 'audio',
    guide_id: 's12345',
    text: 'Test Station',
  });
  const play = findPlayButton(node);
  assert.ok(play, 'station row has a Play button');
  assert.equal(play.getAttribute('role'), 'button');
  assert.equal(play.getAttribute('data-tap'), '44');
  assert.match(play.getAttribute('aria-label') || '', /^Play Test Station on Bo$/);
});

test('stationRow: drill-only prefixes (g, c, r, m) get no Play button', async () => {
  for (const url of [
    'http://opml.radiotime.com/Browse.ashx?id=g22',
    'http://opml.radiotime.com/Browse.ashx?id=c424724',
  ]) {
    const node = renderEntry({ text: 'Drill', URL: url });
    assert.equal(findPlayButton(node), null, `no Play button on ${url}`);
  }
});

test('stationRow: clicking Play calls playGuideId, sets is-loading then clears, toasts success', async () => {
  // Mock fetch to intercept api.playGuideId. We test against the
  // station-row produced by renderEntry so this exercises the full
  // wiring path (audio leaf → stationRow → Play button click).
  const realFetch = globalThis.fetch;
  const calls = [];
  let resolveFetch;
  const pendingFetch = new Promise((res) => { resolveFetch = res; });
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return pendingFetch;
  };

  // Clear any cache state from earlier tests.
  playCache.invalidate('tunein.stream.s24862');

  const node = renderEntry({
    type: 'audio',
    guide_id: 's24862',
    text: 'Radio Test',
  });
  const play = findPlayButton(node);
  assert.ok(play, 'Play button mounted');

  dispatchClick(play);
  // Microtask: the handler enters, sets is-loading, awaits fetch.
  await Promise.resolve();
  assert.ok(
    (play.getAttribute('class') || '').includes('is-loading'),
    `Play button enters is-loading state, got: ${play.getAttribute('class')}`,
  );

  assert.equal(calls.length, 1, 'one fetch issued');
  assert.match(calls[0].url, /\/cgi-bin\/api\/v1\/play$/);
  assert.equal(calls[0].opts.method, 'POST');
  const payload = JSON.parse(calls[0].opts.body);
  assert.equal(payload.id, 's24862');
  // First-call has no cached URL.
  assert.equal(payload.url, undefined);

  // Resolve the CGI response with a stream URL.
  resolveFetch({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, url: 'http://stream.example/test.aac' }),
  });
  await flushMicrotasks();

  assert.ok(
    !(play.getAttribute('class') || '').includes('is-loading'),
    'Play button leaves is-loading after success',
  );

  // Toast appears in the doc body.
  const toastContainer = doc.getElementById('toast-container');
  assert.ok(toastContainer, 'toast container mounted on success');
  const toast = findFirstByClass(toastContainer, 'toast');
  assert.ok(toast, 'toast node attached');
  assert.equal(toast.textContent, 'Playing on Bo: Radio Test');

  // Cache persisted under the documented key.
  const cached = playCache.get('tunein.stream.s24862');
  assert.equal(cached, 'http://stream.example/test.aac');

  globalThis.fetch = realFetch;
  // Strip the toast so subsequent tests start clean.
  if (toastContainer.parentNode) toastContainer.parentNode.removeChild(toastContainer);
});

test('stationRow: clicking Play with cached URL passes it to the CGI', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, url: 'http://stream.example/test.aac' }),
  });
  const realFetchAsync = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return realFetchAsync(url, opts);
  };

  // Prime the cache.
  playCache.set('tunein.stream.s55555', 'http://stream.example/cached.aac', 5 * 60_000);

  const node = renderEntry({
    type: 'audio',
    guide_id: 's55555',
    text: 'Cached Station',
  });
  dispatchClick(findPlayButton(node));
  await flushMicrotasks();

  assert.equal(calls.length, 1, 'one fetch issued');
  const payload = JSON.parse(calls[0].opts.body);
  assert.equal(payload.id, 's55555');
  assert.equal(payload.url, 'http://stream.example/cached.aac',
    'cached URL forwarded as `url` field');

  playCache.invalidate('tunein.stream.s55555');
  globalThis.fetch = realFetch;
  const tc = doc.getElementById('toast-container');
  if (tc && tc.parentNode) tc.parentNode.removeChild(tc);
});

test('stationRow: off-air response toasts the error and drops the cache entry', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error: 'off-air' }),
  });

  // Seed the cache so we can assert it's invalidated.
  playCache.set('tunein.stream.s77777', 'http://stale.example/x', 5 * 60_000);

  const node = renderEntry({
    type: 'audio',
    guide_id: 's77777',
    text: 'Dark Station',
  });
  const play = findPlayButton(node);
  dispatchClick(play);
  await flushMicrotasks();

  assert.equal(playCache.get('tunein.stream.s77777'), undefined,
    'stale cache entry invalidated on failure');

  const toastContainer = doc.getElementById('toast-container');
  const toast = findFirstByClass(toastContainer, 'toast');
  assert.ok(toast);
  assert.equal(toast.textContent, 'Off-air right now');

  globalThis.fetch = realFetch;
  if (toastContainer && toastContainer.parentNode) toastContainer.parentNode.removeChild(toastContainer);
});

test('stationRow: clicking the Play button does not navigate the row link', async () => {
  // The row body itself drills via href; the icon must preventDefault so
  // the user gets play-on-tap separation from drill-on-tap.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, url: 'http://stream.example/test.aac' }),
  });

  const node = renderEntry({
    type: 'audio',
    guide_id: 's99999',
    text: 'Sep Test',
  });
  const play = findPlayButton(node);

  // Capture the event default-prevented state via our local dispatcher.
  const evt = {
    type: 'click',
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  if (typeof play.dispatchEvent === 'function') play.dispatchEvent(evt);
  else {
    const map = play.__listeners__;
    if (map && map.get('click')) for (const fn of map.get('click')) fn.call(play, evt);
  }
  await flushMicrotasks();
  assert.equal(evt.defaultPrevented, true,
    'Play click preventDefaults so the parent <a> never navigates');

  playCache.invalidate('tunein.stream.s99999');
  globalThis.fetch = realFetch;
  const tc = doc.getElementById('toast-container');
  if (tc && tc.parentNode) tc.parentNode.removeChild(tc);
});
