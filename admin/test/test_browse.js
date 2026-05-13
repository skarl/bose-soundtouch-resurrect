// Tests for app/views/browse.js — renderEntry() produces the polish-pass
// station-row layout for audio leaves and a browse-row for drillable
// section nodes. Mirrors the xmldom shim from test_components.js so the
// view can mount against a fake document.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc } from './fixtures/dom-shim.js';

const {
  renderEntry,
  renderOutline,
  filterRowEntries,
  _setActivePagersForTest,
  _setFilterInputForTest,
  _resetBrowseStateForTest,
  _ensureCoordinatorForTest,
  _applyDomFilterForTest,
  _renderShowLandingForTest,
} = await import('../app/views/browse.js');

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

// sessionStorage is needed by tunein-cache's defaultStorage; doc.body
// and doc.getElementById already come from the shared shim.
import { installSessionStorage } from './fixtures/dom-shim.js';
installSessionStorage();

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
  // The resolved station name rides along so the CGI can write it into
  // <itemName> on /select (drives the persistent mini-player label).
  // Regression guard for the #78 follow-up.
  assert.equal(payload.name, 'Radio Test');
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

// --- Issue #77: filter input + eager-serial auto-crawl + strap ------
//
// The view exposes a 3-line filter helper (`filterRowEntries`) and a
// module-local crawl coordinator. These tests pin the contract on
// both — they're added at the end of the file so the diff stays
// local to issue #77.

// Build a minimal drill-view DOM tree: section[data-view="browse"
// data-mode="drill"] wrapping a filter input + browse body. The body
// hosts however many `.browse-section` cards the caller asks for.
function buildDrillTree({ sections } = { sections: [] }) {
  const root = doc.createElement('section');
  root.setAttribute('data-view', 'browse');
  root.setAttribute('data-mode', 'drill');

  // Filter input — a real <input> the coordinator can read `value`
  // from. xmldom doesn't expose the `value` property natively, but
  // browse.js falls back to getAttribute('value') so we're covered.
  const input = doc.createElement('input');
  input.setAttribute('type', 'search');
  root.appendChild(input);

  const body = doc.createElement('div');
  body.className = 'browse-body';
  for (const key of sections) {
    const sec = doc.createElement('section');
    sec.className = 'browse-section';
    sec.setAttribute('data-section', key);
    const footer = doc.createElement('div');
    footer.className = 'browse-section__footer';
    sec.appendChild(footer);
    body.appendChild(sec);
  }
  root.appendChild(body);
  return { root, input, body };
}

// Build a synthetic outline page (visible audio rows + optional next
// cursor) the pager can consume verbatim.
function makePagerPage(ids, cursorUrl) {
  const body = ids.map((id) => ({
    element: 'outline',
    type: 'audio',
    text: `Station ${id}`,
    guide_id: id,
    URL: `http://opml.radiotime.com/Tune.ashx?id=${id}`,
    item: 'station',
  }));
  if (cursorUrl) {
    body.push({
      element: 'outline',
      type: 'link',
      text: 'More',
      URL: cursorUrl,
      key: 'nextStations',
    });
  }
  return { head: { title: 'X', status: '200' }, body };
}

// --- 1: filterRowEntries — the 3-line filter rule -------------------

test('filterRowEntries: matches case-insensitively across text/subtext/playing/current_track', () => {
  const rows = [
    { text: 'BBC Radio 6', subtext: 'London',  playing: 'Now Playing X', current_track: '' },
    { text: 'KEXP',        subtext: 'Seattle', playing: 'bbc segment',   current_track: '' },
    { text: 'NPR',         subtext: 'Boston',  playing: 'Track Z',       current_track: 'BBC News' },
    { text: 'France Inter',subtext: 'Paris',   playing: 'Le Show',       current_track: 'Pop Hit' },
  ];
  const matched = filterRowEntries(rows, 'bbc');
  // First three hit on different fields; France Inter has no `bbc`
  // anywhere and is excluded. Confirms the four-field coverage.
  const ids = matched.map((r) => r.text);
  assert.deepEqual(ids.sort(), ['BBC Radio 6', 'KEXP', 'NPR']);
});

test('filterRowEntries: empty query returns every row (full passthrough)', () => {
  const rows = [{ text: 'A' }, { text: 'B' }, { text: 'C' }];
  assert.deepEqual(filterRowEntries(rows, '').map((r) => r.text), ['A', 'B', 'C']);
});

test('filterRowEntries: rows with absent/non-string fields do not throw and do not match', () => {
  const rows = [
    { text: 'BBC' },
    { text: 'No match' },
    { text: null, subtext: undefined, playing: 42, current_track: { not: 'a string' } },
  ];
  const matched = filterRowEntries(rows, 'bbc');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].text, 'BBC');
});

test('filterRowEntries: query trims and lowercases', () => {
  const rows = [{ text: 'Radio Paradise' }, { text: 'KEXP' }];
  assert.deepEqual(filterRowEntries(rows, '  RADIO  ').map((r) => r.text), ['Radio Paradise']);
});

// --- 2: DOM filter toggles `is-filtered-out` ------------------------

test('DOM filter: applies is-filtered-out to non-matching rows; clearing restores', () => {
  _resetBrowseStateForTest();
  const { root, input } = buildDrillTree({ sections: ['stations'] });
  const body = findFirstByClass(root, 'browse-body');
  const section = findAllBy(root, (el) => el.getAttribute('data-section') === 'stations')[0];
  // Build a card with three rows; renderEntry stashes _outline.
  const card = doc.createElement('div');
  card.className = 'browse-card';
  const rowsData = [
    { type: 'audio', guide_id: 's1', text: 'BBC One',  subtext: 'UK' },
    { type: 'audio', guide_id: 's2', text: 'NPR',      subtext: 'US' },
    { type: 'audio', guide_id: 's3', text: 'BBC Two',  subtext: 'UK' },
  ];
  const rowEls = rowsData.map((d) => {
    const el = renderEntry(d);
    card.appendChild(el);
    return el;
  });
  section.insertBefore(card, findFirstByClass(section, 'browse-section__footer'));

  _setFilterInputForTest(input);

  // Type "bbc" — only s1 and s3 survive.
  input.setAttribute('value', 'bbc');
  _applyDomFilterForTest(root);
  assert.equal(hasClass(rowEls[0], 'is-filtered-out'), false);
  assert.equal(hasClass(rowEls[1], 'is-filtered-out'), true, 'NPR is hidden under bbc filter');
  assert.equal(hasClass(rowEls[2], 'is-filtered-out'), false);

  // Clear the filter — every row visible again.
  input.setAttribute('value', '');
  _applyDomFilterForTest(root);
  for (const el of rowEls) assert.equal(hasClass(el, 'is-filtered-out'), false);

  _resetBrowseStateForTest();
  // Detach the tree we built so subsequent tests start clean.
  if (root.parentNode) root.parentNode.removeChild(root);
  void body;
});

// --- 3: Eager-serial coordinator section ordering -------------------

test('coordinator: walks sections serially — section 2 does not start until section 1 exhausts', async () => {
  _resetBrowseStateForTest();
  const { root, input, body } = buildDrillTree({ sections: ['local', 'stations'] });
  doc.documentElement.appendChild(root);

  // Track call order across the two pagers' loadMore calls.
  const callLog = [];

  // Section 1 ('local') — two pages, then exhausts.
  let localPages = 0;
  const localPager = makeStubPager('local', async () => {
    callLog.push(`local-${localPages + 1}`);
    localPages++;
    if (localPages === 1) {
      return { added: 2, exhausted: false };
    }
    return { added: 2, exhausted: true };
  });

  // Section 2 ('stations') — one page, then exhausts.
  let stationsPages = 0;
  const stationsPager = makeStubPager('stations', async () => {
    callLog.push(`stations-${stationsPages + 1}`);
    // Before the call, local must already have reported exhausted.
    assert.equal(localPager.exhausted, true,
      `stations.loadMore called before local exhausted; callLog=${callLog.join(',')}`);
    stationsPages++;
    return { added: 1, exhausted: true };
  });

  _setActivePagersForTest([localPager, stationsPager]);
  _setFilterInputForTest(input);
  input.setAttribute('value', 'bbc');

  await _ensureCoordinatorForTest();

  // Section 1 first (twice), then section 2 (once). No interleaving.
  assert.deepEqual(callLog, ['local-1', 'local-2', 'stations-1'],
    `serial ordering: ${callLog.join(', ')}`);

  _resetBrowseStateForTest();
  if (root.parentNode) root.parentNode.removeChild(root);
  void body;
});

// --- 4: Progress strap lifecycle ------------------------------------

test('strap: mounts on crawl start, unmounts when the section exhausts', async () => {
  _resetBrowseStateForTest();
  const { root, input, body } = buildDrillTree({ sections: ['local'] });
  doc.documentElement.appendChild(root);

  let pages = 0;
  let strapDuringFetch = null;
  const pager = makeStubPager('local', async () => {
    // Snapshot the strap state mid-fetch — it should be mounted by now.
    strapDuringFetch = findFirstByClass(body, 'browse-strap');
    pages++;
    return pages === 1
      ? { added: 1, exhausted: false }
      : { added: 1, exhausted: true };
  });

  _setActivePagersForTest([pager]);
  _setFilterInputForTest(input);
  input.setAttribute('value', 'bbc');

  await _ensureCoordinatorForTest();

  // Strap mounted at least once during the crawl.
  assert.ok(strapDuringFetch, 'strap mounts at the top of browse-body during the crawl');
  assert.ok(hasClass(strapDuringFetch, 'browse-strap'),
    'mounted element carries the .browse-strap class');

  // Strap removed once the section exhausted and there are no more
  // sections to crawl.
  const strapAfter = findFirstByClass(body, 'browse-strap');
  assert.equal(strapAfter, null, 'strap unmounts when the coordinator drains');

  _resetBrowseStateForTest();
  if (root.parentNode) root.parentNode.removeChild(root);
});

// Build a stub pager with the minimal surface the coordinator reads:
// status (with section + sectionCap), exhausted, pagesFetched, rows,
// loadMore(), dispose(). `step` is the user-supplied async function
// that decides what each loadMore returns; the wrapper flips
// `exhausted` and bumps `pagesFetched` based on the step's return.
function makeStubPager(section, step) {
  const state = {
    rows: [],
    exhausted: false,
    pagesFetched: 0,
    section,
    sectionCap: 50,
  };
  const pager = {
    get rows() { return state.rows; },
    get exhausted() { return state.exhausted; },
    get pagesFetched() { return state.pagesFetched; },
    get status() {
      return {
        section: state.section,
        scanned: state.pagesFetched,
        sectionCap: state.sectionCap,
        exhausted: state.exhausted,
      };
    },
    async loadMore() {
      if (state.exhausted) return { added: 0, exhausted: true };
      const r = await step();
      state.pagesFetched++;
      if (r && r.exhausted) state.exhausted = true;
      return r;
    },
    dispose() { state.exhausted = true; },
  };
  return pager;
}

// --- Slice #79: row-rendering polish (chips + tertiary + reliability) -

test('renderEntry: station with playing + distinct current_track renders two subtitle lines in the DOM', () => {
  const node = renderEntry({
    type:          'audio',
    guide_id:      's54321',
    text:          'Morning Wave',
    playing:       'Morning Wave Show',
    current_track: 'Artist - Title',
  });
  // Secondary line carries the show name (playing wins over subtext).
  const loc = findFirstByClass(node, 'station-row__loc');
  assert.ok(loc, 'secondary line present');
  assert.equal(loc.textContent, 'Morning Wave Show');
  // Tertiary line carries the current track and is its own element.
  const tertiary = findFirstByClass(node, 'station-row__tertiary');
  assert.ok(tertiary, 'tertiary subtitle line present');
  assert.equal(tertiary.textContent, 'Artist - Title');
});

test('renderEntry: station where current_track equals secondary renders only one subtitle line', () => {
  const node = renderEntry({
    type:          'audio',
    guide_id:      's54322',
    text:          'Loop Radio',
    subtext:       'Same string',
    current_track: 'Same string',
  });
  const tertiary = findFirstByClass(node, 'station-row__tertiary');
  assert.equal(tertiary, null,
    'no tertiary line when current_track collapses into secondary');
});

test('renderEntry: station with reliability:47 carries the red reliability badge', () => {
  const node = renderEntry({
    type:        'audio',
    guide_id:    's11111',
    text:        'Flaky FM',
    reliability: 47,
  });
  assert.equal(node.getAttribute('data-reliability-tier'), 'red',
    'row carries the red reliability tier as a data attribute');
  const badge = findFirstByClass(node, 'station-row__reliability');
  assert.ok(badge, 'reliability badge mounted');
  assert.equal(badge.getAttribute('data-tier'), 'red');
});

test('renderEntry: station with reliability:92 carries the green reliability tier', () => {
  const node = renderEntry({
    type:        'audio',
    guide_id:    's11112',
    text:        'Solid FM',
    reliability: 92,
  });
  assert.equal(node.getAttribute('data-reliability-tier'), 'green');
});

test('renderEntry: station with genre_id renders a clickable genre chip drilling into id=g<NN>', () => {
  const node = renderEntry({
    type:     'audio',
    guide_id: 's22222',
    text:     'Genre Station',
    genre_id: 'g79',
  });
  const chip = findFirstByClass(node, 'station-row__chip--genre');
  assert.ok(chip, 'genre chip mounted');
  assert.equal(chip.tagName, 'a');
  assert.equal(chip.getAttribute('data-genre-id'), 'g79');
  assert.match(chip.getAttribute('href'), /^#\/browse\?/);
  assert.match(chip.getAttribute('href'), /id=g79/);
});

test('renderEntry: station with show_id renders "Now airing: <track>" link drilling into pbrowse', () => {
  const node = renderEntry({
    type:          'audio',
    guide_id:      's33333',
    text:          'WXYZ FM',
    current_track: 'Morning Show with Jane',
    show_id:       'p12345',
  });
  const tertiary = findFirstByClass(node, 'station-row__tertiary');
  assert.ok(tertiary, 'tertiary line mounted');
  const prefix = findFirstByClass(tertiary, 'station-row__tertiary-prefix');
  assert.ok(prefix, 'tertiary line has "Now airing: " prefix');
  assert.match(prefix.textContent, /Now airing:/);
  const link = findFirstByClass(tertiary, 'station-row__show-link');
  assert.ok(link, 'show link mounted');
  assert.equal(link.tagName, 'a');
  assert.equal(link.getAttribute('data-show-id'), 'p12345');
  assert.equal(link.textContent, 'Morning Show with Jane');
  // The drill URL targets Browse.ashx?c=pbrowse&id=<show_id>, encoded
  // into the SPA hash form. #81 will render this as a real show drill.
  const href = link.getAttribute('href');
  assert.match(href, /^#\/browse\?/);
  assert.match(href, /c=pbrowse/);
  assert.match(href, /id=p12345/);
});

// --- Slice #81: c=pbrowse show drill (liveShow + topics) ------------
//
// The `c=pbrowse&id=p<N>` response is a section-keyed payload with
// some combination of `liveShow`, `topics`, and `stations`. The
// renderOutline pipeline must:
//   - mount the `liveShow` row inside a top section card with an
//     inline Play icon (stationRow auto-attaches Play for p-prefix
//     guide_ids from #78);
//   - mount each `topics` row with a Play icon (t-prefix auto-attach)
//     plus the formatted `topic_duration` on the meta line;
//   - render `stations` sections through the existing pipeline;
//   - never emit a preset-assign affordance on p- or t-prefix rows.

test('renderOutline (#81): p17 liveShow+topics fixture renders liveShow card on top + topics list', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-pbrowse.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  const total = renderOutline(body, fixture);

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  assert.deepEqual(
    sections.map((s) => s.getAttribute('data-section')),
    ['liveShow', 'topics'],
    'liveShow first, topics second',
  );

  // liveShow renders 1 row, topics renders 4. Total visible row count = 5.
  assert.equal(total, 5, `expected 5 rows total, got ${total}`);

  // liveShow has a single p-prefix row.
  const liveShowSection = sections[0];
  const liveShowRows = findAllBy(liveShowSection, (el) => hasClass(el, 'station-row'));
  assert.equal(liveShowRows.length, 1, 'liveShow renders exactly one row');
  assert.equal(liveShowRows[0].getAttribute('data-sid'), 'p17');

  // The liveShow row has a Play icon (auto-attached by stationRow for p-prefix).
  const liveShowPlay = findFirstByClass(liveShowRows[0], 'station-row__play');
  assert.ok(liveShowPlay, 'liveShow row has a Play icon (p-prefix)');
  assert.equal(liveShowPlay.getAttribute('role'), 'button');

  // topics renders 4 t-prefix rows, each with a Play icon.
  const topicsSection = sections[1];
  const topicRows = findAllBy(topicsSection, (el) => hasClass(el, 'station-row'));
  assert.equal(topicRows.length, 4, 'four episode rows');
  for (const row of topicRows) {
    const sid = row.getAttribute('data-sid') || '';
    assert.match(sid, /^t\d+$/, `topic row data-sid is a t-prefix: ${sid}`);
    const play = findFirstByClass(row, 'station-row__play');
    assert.ok(play, `topic row ${sid} has a Play icon`);
  }
});

test('renderOutline (#81): p17 topics rows surface topic_duration formatted on the meta line', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-pbrowse.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  renderOutline(body, fixture);

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') === 'topics');
  const topicRows = findAllBy(sections[0], (el) => hasClass(el, 'station-row'));

  // First episode in fixture: topic_duration "3600" (exactly 1h) → "1:00:00".
  // Second episode: topic_duration "3540" (59 min) → "59:00" — sub-hour
  // case takes the M:SS shorthand.
  // Third episode: topic_duration "3620" (1h 0m 20s) → "1:00:20".
  const firstLoc = findFirstByClass(topicRows[0], 'station-row__loc');
  assert.ok(firstLoc, 'first topic row has a location/meta chunk');
  assert.equal(firstLoc.textContent, '1:00:00');

  const secondLoc = findFirstByClass(topicRows[1], 'station-row__loc');
  assert.ok(secondLoc);
  assert.equal(secondLoc.textContent, '59:00');

  const thirdLoc = findFirstByClass(topicRows[2], 'station-row__loc');
  assert.ok(thirdLoc);
  assert.equal(thirdLoc.textContent, '1:00:20');
});

test('renderOutline (#81): p17 show-drill rows carry no preset-assign affordance', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-pbrowse.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  renderOutline(body, fixture);

  // Walk every p- or t-prefix row in the body and assert no descendant
  // carries a data-action="assign" attribute (or any preset-assign
  // marker class).
  const allRows = findAllBy(body, (el) => hasClass(el, 'station-row'));
  assert.ok(allRows.length > 0, 'rows rendered');
  for (const row of allRows) {
    const sid = row.getAttribute('data-sid') || '';
    assert.ok(/^[pt]\d+/.test(sid), `row is p/t-prefixed: ${sid}`);
    const assignNodes = findAllBy(row, (el) => {
      if (!el.getAttribute) return false;
      if (el.getAttribute('data-action') === 'assign') return true;
      const cls = el.getAttribute('class') || '';
      return /\b(?:preset-assign|assign-btn|station-row__assign)\b/.test(cls);
    });
    assert.equal(assignNodes.length, 0,
      `row ${sid} carries no preset-assign affordance`);
  }
});

test('renderOutline (#81): p4727070 stations+topics fixture renders stations normally + topics list', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p4727070-pbrowse.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  const total = renderOutline(body, fixture);

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  assert.deepEqual(
    sections.map((s) => s.getAttribute('data-section')),
    ['stations', 'topics'],
    'stations first, topics second',
  );
  assert.equal(total, 4, `expected 4 rows (2 stations + 2 topics), got ${total}`);

  // stations section: existing pipeline. Both rows are s-prefix with
  // Play icons (audio leaves).
  const stationsRows = findAllBy(sections[0], (el) => hasClass(el, 'station-row'));
  assert.equal(stationsRows.length, 2);
  for (const row of stationsRows) {
    const sid = row.getAttribute('data-sid') || '';
    assert.match(sid, /^s\d+$/);
    assert.ok(findFirstByClass(row, 'station-row__play'), `${sid} has Play icon`);
  }

  // topics section: t-prefix rows with Play icon + duration.
  const topicRows = findAllBy(sections[1], (el) => hasClass(el, 'station-row'));
  assert.equal(topicRows.length, 2);
  for (const row of topicRows) {
    const sid = row.getAttribute('data-sid') || '';
    assert.match(sid, /^t\d+$/);
    assert.ok(findFirstByClass(row, 'station-row__play'), `${sid} has Play icon`);
    const loc = findFirstByClass(row, 'station-row__loc');
    assert.ok(loc, `${sid} has a meta chunk for duration`);
    // 7200s → 2:00:00.
    assert.equal(loc.textContent, '2:00:00');
  }
});

test('renderOutline (#81): missing liveShow section renders gracefully (no top card)', async () => {
  // Hand-craft a c=pbrowse response that lacks the liveShow section —
  // the show isn't airing right now. Renders as topics-only.
  const fixture = {
    head: { title: 'Off-Air Show', status: '200' },
    body: [
      {
        element: 'outline',
        text: 'Episodes',
        key: 'topics',
        children: [
          {
            element: 'outline',
            type: 'link',
            text: 'Episode One',
            URL: 'http://opml.radiotime.com/Tune.ashx?id=t100000001',
            guide_id: 't100000001',
            item: 'topic',
            topic_duration: '1800',
          },
        ],
      },
    ],
  };

  const body = doc.createElement('div');
  const total = renderOutline(body, fixture);

  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].getAttribute('data-section'), 'topics');
  assert.equal(total, 1);

  // No liveShow section anywhere.
  const liveShowSections = findAllBy(body, (el) => el.getAttribute('data-section') === 'liveShow');
  assert.equal(liveShowSections.length, 0);
});

test('renderOutline (#81): topics row without topic_duration falls back to subtext on the meta line', () => {
  const fixture = {
    head: { title: 'Show', status: '200' },
    body: [
      {
        element: 'outline',
        text: 'Episodes',
        key: 'topics',
        children: [
          {
            element: 'outline',
            type: 'link',
            text: 'No-duration Episode',
            URL: 'http://opml.radiotime.com/Tune.ashx?id=t200000001',
            guide_id: 't200000001',
            item: 'topic',
            subtext: 'A description with no duration.',
          },
        ],
      },
    ],
  };
  const body = doc.createElement('div');
  renderOutline(body, fixture);
  const rows = findAllBy(body, (el) => hasClass(el, 'station-row'));
  assert.equal(rows.length, 1);
  const loc = findFirstByClass(rows[0], 'station-row__loc');
  // Falls back to the subtext when topic_duration is absent.
  assert.equal(loc.textContent, 'A description with no duration.');
});

// --- Slice #82: Local Radio surface, related-as-chips, lazy-img -----
// (The tiny-country annotation tests have been retired per issue #85
// — the live wire never carries the count signal those tests relied
// on; see the local-polish e2e spec for the live retirement guard.)

test('renderOutline (#82): c=local response lifts the localCountry link as a prominent card at the top', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const local = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/c-local-de.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  const total = renderOutline(body, local);

  // The country card mounts as the first child of body, ahead of any
  // section/audio row.
  const cards = findAllBy(body, (el) => hasClass(el, 'browse-local-country'));
  assert.equal(cards.length, 1, 'one localCountry card surfaces from c=local');
  const card = cards[0];
  // First-child-of-body ordering — the card sits above the audio list.
  assert.equal(body.childNodes[0], card,
    'localCountry card is the first element of the rendered drill');

  // Label reads "Browse all of <country>".
  const labelEl = findFirstByClass(card, 'browse-local-country__label');
  assert.ok(labelEl, 'label slot present');
  assert.equal(labelEl.textContent, 'Browse all of Germany',
    `expected "Browse all of Germany", got "${labelEl.textContent}"`);

  // The card drills via canonicalised URL — id=r100346 lands in the hash.
  assert.equal(card.tagName, 'a', 'card is a drillable anchor');
  const href = card.getAttribute('href') || '';
  assert.match(href, /^#\/browse\?/);
  assert.match(href, /id=r100346/, `country root id in hash, got: ${href}`);

  // The audio rows are still rendered — three stations in this fixture.
  const stationRows = findAllBy(body, (el) => hasClass(el, 'station-row'));
  assert.equal(stationRows.length, 3, 'three audio rows render below the country card');

  // The localCountry row itself is NOT mounted as a normal row (no
  // .browse-row with data-key="localCountry" leaks into the audio list).
  // The card is the only representation.
  assert.equal(total, 3, `total counts audio rows only, got ${total}`);
});

test('renderOutline (#82): related section renders ALL children as chips, no stacked row cards', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/related-mixed.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  renderOutline(body, fixture);

  const relatedSection = findAllBy(body, (el) =>
    el.getAttribute('data-section') === 'related')[0];
  assert.ok(relatedSection, 'related section mounts');

  // No browse-card (stacked rows container) lives inside the related
  // section any more — the chips wrap-list replaces it.
  const cards = findAllBy(relatedSection, (el) => hasClass(el, 'browse-card'));
  assert.equal(cards.length, 0,
    'related section emits no stacked-rows card');

  // Chips wrap-list mounted.
  const wraps = findAllBy(relatedSection, (el) => hasClass(el, 'browse-related'));
  assert.equal(wraps.length, 1, 'one chip wrap-list mounted');
  const wrap = wraps[0];
  assert.ok(hasClass(wrap, 'browse-pivots'),
    'chips wrap reuses .browse-pivots layout class');

  // Four chips total: popular nav + 2 pivots + 1 drill child.
  const chips = findAllBy(wrap, (el) => hasClass(el, 'browse-pivot'));
  assert.equal(chips.length, 4, `four chips, got ${chips.length}`);

  // Each chip's class differs from station-row / browse-row (issue
  // acceptance: "different class than station rows").
  for (const chip of chips) {
    const cls = classOf(chip);
    assert.equal(cls.split(/\s+/).includes('station-row'), false,
      `chip class does not collide with station-row: "${cls}"`);
    assert.equal(cls.split(/\s+/).includes('browse-row'), false,
      `chip class does not collide with browse-row: "${cls}"`);
  }

  // Chip kinds tagged for tests + a11y.
  const kinds = chips.map((c) => c.getAttribute('data-chip-kind'));
  // Popular = nav, pivotLocation+pivotName = pivot, Bluegrass drill = drill.
  assert.deepEqual(kinds.sort(), ['drill', 'nav', 'pivot', 'pivot'],
    `chip kinds: ${kinds.join(', ')}`);

  // pivotLocation chip carries an axis attribute for CSS / a11y hooks.
  const pivotChip = chips.find((c) =>
    c.getAttribute('data-chip-kind') === 'pivot'
    && c.getAttribute('data-pivot-axis') === 'location');
  assert.ok(pivotChip, 'pivotLocation chip tagged with axis=location');
});

test('every <img> in the rendered drill DOM has loading="lazy" (issue #82)', async () => {
  // Folk fixture exercises both station-row art and show-row art —
  // every <img> that the browse pipeline emits should carry the
  // native lazy-load attribute.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const folk = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/c100000948-page0.tunein.json'), 'utf8'),
  );
  const body = doc.createElement('div');
  renderOutline(body, folk);

  const imgs = findAllBy(body, (el) => el.tagName === 'img');
  assert.ok(imgs.length > 0, 'fixture renders at least one image');
  for (const img of imgs) {
    assert.equal(img.getAttribute('loading'), 'lazy',
      `every <img> opts into native lazy-load — missing on src="${img.getAttribute('src')}"`);
  }
});

// --- Issue #84: c=pbrowse fallback — Describe + Browse(bare-id) ------
//
// `Browse.ashx?c=pbrowse&id=p<N>` is regionally gated from Bo's egress
// and returns `head.status="400"` with `body:[]`. The SPA's
// show-drill dispatch was rewired to use `Describe.ashx?id=p<N>` for
// the show landing card, plus `Browse.ashx?id=p<N>` (no c=pbrowse)
// for any related sections (Genres / Networks). The unit tests below
// drive _renderShowLandingForTest with the resolved fixtures so the
// rendering pipeline is exercised without faking fetch.

test('#84 show landing: Describe renders a show card with title, hosts, genre chip, description', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const describe = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
  );
  const browse = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-browse.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, browse, null, null);

  // The show-landing section is the first child.
  const landings = findAllBy(body, (el) => el.getAttribute('data-section') === 'showLanding');
  assert.equal(landings.length, 1, 'one show-landing section');

  // The card holds a station-row marked as a show landing.
  const showRow = findAllBy(landings[0], (el) => el.getAttribute('data-show-landing') === '1');
  assert.equal(showRow.length, 1, 'one show-landing row');
  assert.equal(showRow[0].getAttribute('data-sid'), 'p17');

  // Title text drives the row name.
  const name = findFirstByClass(showRow[0], 'station-row__name');
  assert.ok(name, 'show row has a name slot');
  assert.equal(name.textContent, 'Fresh Air');

  // Hosts populate the secondary line (location slot).
  const loc = findFirstByClass(showRow[0], 'station-row__loc');
  assert.ok(loc, 'show row has a meta location chunk for hosts');
  assert.equal(loc.textContent, 'Terry Gross');

  // Genre chip drills via canonical URL.
  const chip = findFirstByClass(showRow[0], 'station-row__chip--genre');
  assert.ok(chip, 'genre chip mounted from Describe.genre_id');
  assert.equal(chip.getAttribute('data-genre-id'), 'g168');

  // p-prefix auto-attaches a Play icon.
  const play = findFirstByClass(showRow[0], 'station-row__play');
  assert.ok(play, 'show row has an inline Play icon for the p-prefix guide_id');

  // The description block follows the row inside the same section.
  const desc = findFirstByClass(landings[0], 'browse-show-description');
  assert.ok(desc, 'description block mounted');
  // Multi-paragraph description splits into multiple <p> chunks.
  const paras = findAllBy(desc, (el) => el.tagName === 'p');
  assert.ok(paras.length >= 1, 'at least one description paragraph');
  assert.match(paras[0].textContent, /Peabody Award/,
    'first paragraph carries the Describe.description text');
});

test('#84 show landing: Browse(bare-id) Genres + Networks render as related sections below the card', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const describe = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
  );
  const browse = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-browse.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, browse, null, null);

  // After the show-landing section, the Genres + Networks sections
  // from Browse should be present.
  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  const keys = sections.map((s) => s.getAttribute('data-section'));
  assert.deepEqual(keys, ['showLanding', 'genres', 'affiliates'],
    'showLanding first, then Genres, then Networks');

  // Genres section carries the four drill rows from the fixture.
  const genresSection = sections[1];
  const genreRows = findAllBy(genresSection, (el) => hasClass(el, 'browse-row'));
  assert.equal(genreRows.length, 4, 'four genre drill rows');
});

test('#84 show landing: missing Describe show element renders a graceful empty-state', () => {
  const describeEmpty = { head: { status: '200' }, body: [] };
  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describeEmpty, null, null, null);

  // No show-landing section emitted.
  const landings = findAllBy(body, (el) => el.getAttribute('data-section') === 'showLanding');
  assert.equal(landings.length, 0);

  // Empty-state message surfaces.
  const empty = findFirstByClass(body, 'browse-empty');
  assert.ok(empty, 'empty-state message mounted when Describe is empty');
  assert.match(empty.textContent, /aren.t available/);
});

test('#84 show landing: empty Browse body still renders the show card (Browse is best-effort)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const describe = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
  );
  // p4727070-style: Browse returns 200 with body:[].
  const browseEmpty = { head: { title: 'Fresh Air', status: '200' }, body: [] };

  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, browseEmpty, null, null);

  // Show card still mounts even when Browse(bare-id) returns nothing.
  const landings = findAllBy(body, (el) => el.getAttribute('data-section') === 'showLanding');
  assert.equal(landings.length, 1);
  // No other sections (no related genres/affiliates available).
  const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
  assert.equal(sections.length, 1);
});

test('#84 show landing: null Browse (fetch failed) still renders the show card', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const describe = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  // null Browse = network failure swallowed by loadShowLanding's
  // best-effort .catch(). The body still gets the show card.
  _renderShowLandingForTest(body, describe, null, null, null);

  const landings = findAllBy(body, (el) => el.getAttribute('data-section') === 'showLanding');
  assert.equal(landings.length, 1);
});

// --- Issue #87: show landing hero is not a stationRow ------------------
//
// `renderShowLandingCard` (#84) and `renderLiveShowCard` (#81) used to
// mount the show-self card via stationRow — an anchor primitive
// designed for listing rows. The card is the page subject, not a
// drillable entry: tapping the body has no useful destination (and a
// self-link is dead weight even with #86's router fix). #87 swaps both
// call sites onto showHero, a non-anchor primitive with the same
// visual treatment plus the inline Play icon for p/s/t guide_ids.

test('#87 show landing hero: root is a non-anchor element with no href', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const describe = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, null);

  const heroes = findAllBy(body, (el) => el.getAttribute('data-show-landing') === '1');
  assert.equal(heroes.length, 1, 'one show-landing hero');
  const hero = heroes[0];

  assert.notEqual(hero.tagName, 'a',
    'show-landing hero is not an <a> — the page subject has no drill target');
  assert.equal(hero.getAttribute('href'), null,
    'show-landing hero has no href on the body — the play icon is the primary affordance');
  // We deliberately keep .station-row on the hero so the existing CSS
  // (sizing, gap, hover background) applies without a new ruleset.
  // .station-row--hero is the modifier that flags this as a hero.
  assert.ok(hasClass(hero, 'station-row'), 'hero reuses the station-row sizing CSS');
  assert.ok(hasClass(hero, 'station-row--hero'), 'hero carries the --hero modifier class');
});

test('#87 show landing hero: renders art + name + secondary line + chip + Play icon', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const describe = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, null);

  const hero = findAllBy(body, (el) => el.getAttribute('data-show-landing') === '1')[0];
  assert.ok(hero, 'hero present');

  const art = findFirstByClass(hero, 'station-art');
  assert.ok(art, 'art slot mounted');

  const name = findFirstByClass(hero, 'station-row__name');
  assert.ok(name, 'name slot mounted');
  assert.equal(name.textContent, 'Fresh Air');

  const loc = findFirstByClass(hero, 'station-row__loc');
  assert.ok(loc, 'secondary line mounted');
  assert.equal(loc.textContent, 'Terry Gross');

  const chip = findFirstByClass(hero, 'station-row__chip--genre');
  assert.ok(chip, 'genre chip mounted');
  assert.equal(chip.getAttribute('data-genre-id'), 'g168');
  // Chip remains a clickable anchor even though the hero body is not.
  assert.equal(chip.tagName, 'a', 'chip stays an anchor — only the outer body loses its anchor');

  const play = findFirstByClass(hero, 'station-row__play');
  assert.ok(play, 'p-prefix guide_id auto-attaches the inline Play icon');
});

test('#87 show landing hero: clicking Play calls playGuideId (mock) and toasts success', async () => {
  // Re-use the same fetch-mock pattern as the stationRow Play test.
  const realFetch = globalThis.fetch;
  const calls = [];
  let resolveFetch;
  const pendingFetch = new Promise((res) => { resolveFetch = res; });
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return pendingFetch;
  };

  playCache.invalidate('tunein.stream.p17');

  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const describe = JSON.parse(
      fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
    );

    const body = doc.createElement('div');
    _renderShowLandingForTest(body, describe, null, null, null);

    const hero = findAllBy(body, (el) => el.getAttribute('data-show-landing') === '1')[0];
    const play = findFirstByClass(hero, 'station-row__play');
    assert.ok(play, 'Play button mounted on the hero');

    dispatchClick(play);
    await Promise.resolve();
    assert.ok(
      (play.getAttribute('class') || '').includes('is-loading'),
      'hero Play button enters is-loading state',
    );

    assert.equal(calls.length, 1, 'one /play POST issued');
    assert.match(calls[0].url, /\/cgi-bin\/api\/v1\/play$/);
    assert.equal(calls[0].opts.method, 'POST');
    const payload = JSON.parse(calls[0].opts.body);
    assert.equal(payload.id, 'p17');
    // #91 regression guard: hero Play must pass the resolved label
    // (not the cached URL, not undefined) so <itemName> on /select
    // shows the show name in the mini-player.
    assert.equal(payload.name, 'Fresh Air');

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: 'http://stream.example/p17.aac' }),
    });
    await flushMicrotasks();

    assert.ok(
      !(play.getAttribute('class') || '').includes('is-loading'),
      'hero Play button leaves is-loading after success',
    );
  } finally {
    globalThis.fetch = realFetch;
    playCache.invalidate('tunein.stream.p17');
  }
});

// --- #88 skip-cache priming on the topics drill --------------------

test('#88 topics drill primes tunein.parent.<t> and tunein.topics.<p> caches', () => {
  // A synthetic c=pbrowse-shaped body: one section with key="topics"
  // and three topic outlines that all carry a Tune.ashx URL with
  // `sid=p17`. renderOutline walks the section, hits renderTopicsCard,
  // and primes both caches as a side effect.
  const json = {
    head: { status: '200' },
    body: [
      {
        text: 'Recent Episodes',
        key: 'topics',
        children: [
          {
            type: 'link', item: 'topic', guide_id: 't1001', text: 'Episode 1',
            URL: 'http://opml.radiotime.com/Tune.ashx?id=t1001&sid=p17&render=json',
          },
          {
            type: 'link', item: 'topic', guide_id: 't1002', text: 'Episode 2',
            URL: 'http://opml.radiotime.com/Tune.ashx?id=t1002&sid=p17&render=json',
          },
          {
            type: 'link', item: 'topic', guide_id: 't1003', text: 'Episode 3',
            URL: 'http://opml.radiotime.com/Tune.ashx?id=t1003&sid=p17&render=json',
          },
        ],
      },
    ],
  };

  const body = doc.createElement('div');
  renderOutline(body, json);

  // Assert the cache writes landed.
  return import('../app/tunein-cache.js').then((tc) => {
    assert.equal(tc.cache.get('tunein.parent.t1001'), 'p17');
    assert.equal(tc.cache.get('tunein.parent.t1002'), 'p17');
    assert.equal(tc.cache.get('tunein.parent.t1003'), 'p17');
    assert.deepEqual(tc.cache.get('tunein.topics.p17'), ['t1001', 't1002', 't1003']);
    // Cleanup for downstream tests.
    tc.cache.invalidate('tunein.parent.t1001');
    tc.cache.invalidate('tunein.parent.t1002');
    tc.cache.invalidate('tunein.parent.t1003');
    tc.cache.invalidate('tunein.topics.p17');
  });
});

test('#87 show landing hero: chip click stays an anchor with the canonical genre drill href', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const describe = JSON.parse(
    fs.readFileSync(path.resolve('admin/test/fixtures/api/p17-describe.tunein.json'), 'utf8'),
  );

  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, null);

  const hero = findAllBy(body, (el) => el.getAttribute('data-show-landing') === '1')[0];
  const chip = findFirstByClass(hero, 'station-row__chip--genre');
  assert.ok(chip, 'chip mounted');
  // Chip is its own clickable target — tapping it drills to the genre
  // even though the surrounding hero body has no anchor.
  assert.equal(chip.tagName, 'a');
  assert.match(chip.getAttribute('href'), /^#\/browse\?/);
  assert.match(chip.getAttribute('href'), /id=g168/);
});
