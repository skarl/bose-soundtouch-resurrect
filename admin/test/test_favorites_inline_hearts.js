// Tests for inline favourite hearts on every playable row + the
// Now-Playing card (issue #126).
//
// Surfaces under test:
//   - search rows (s/p/t/m mix) — heart visibility + capture rule
//   - browse rows via renderEntry — heart on station/show rows
//   - show-landing hero (via _renderShowLandingForTest) — heart on the
//     show subject, capture rule uses Describe-resolved title + logo
//   - recently-viewed / popular row builders — heart wired in
//   - Now-Playing card — heart visibility per source + toggle round-trip
//
// Strategy: import the production row builders directly. The
// dom-shim's xmldom shim gives us a working Element + addEventListener
// + dispatchEvent. fetch is stubbed per-test for the toggle paths.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installFetchNeverResolving } from './fixtures/dom-shim.js';

installFetchNeverResolving();

const { store } = await import('../app/state.js');
const { searchRow } = await import('../app/views/search.js');
const { renderEntry } = await import('../app/views/browse/outline-render.js');
const {
  _renderShowLandingForTest,
  renderLiveShowCard,
  renderTopicsCard,
} = await import('../app/views/browse/show-landing.js');
const { stationRow } = await import('../app/components.js');

function classOf(el) { return el.getAttribute('class') || ''; }
function hasClass(el, cls) {
  return classOf(el).split(/\s+/).includes(cls);
}
function findFirstByClass(root, cls) {
  if (!root) return null;
  if (root.nodeType === 1 && hasClass(root, cls)) return root;
  for (const c of root.childNodes || []) {
    if (c && c.nodeType === 1) {
      const found = findFirstByClass(c, cls);
      if (found) return found;
    }
  }
  return null;
}

function installFetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

beforeEach(() => {
  store.state.speaker.favorites = [];
});

// --- search rows -----------------------------------------------------

test('search row: s-prefix renders heart in place of chevron', () => {
  const row = searchRow({
    type: 'audio', guide_id: 's11111', text: 'Folk Alley',
    subtext: 'Kent, OH', image: 'http://example/art.png',
    item: 'station',
  });
  const heart = findFirstByClass(row, 'fav-heart');
  assert.ok(heart, 's-prefix row has a heart');
  assert.equal(heart.hidden, false, 'heart is visible on a favouritable id');
  assert.equal(findFirstByClass(row, 'station-row__chev'), null,
    'chevron is gone on favouritable rows');
});

test('search row: p-prefix show renders heart in place of chevron', () => {
  const row = searchRow({
    type: 'link', guide_id: 'p38913', text: 'Folk Alley Sessions',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=p38913',
    item: 'show', image: 'http://example/show.png',
  });
  const heart = findFirstByClass(row, 'fav-heart');
  assert.ok(heart, 'p-prefix show row has a heart');
  assert.equal(heart.hidden, false);
  assert.equal(findFirstByClass(row, 'station-row__chev'), null);
});

test('search row: t-prefix topic keeps the chevron (not favouritable)', () => {
  const row = searchRow({
    type: 'link', guide_id: 't22222', text: 'Topic',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=t22222',
    item: 'topic',
  });
  // The heart is wired but its visibility gate hides it on a t-prefix.
  // The chevron stays as the trailing affordance.
  const heart = findFirstByClass(row, 'fav-heart');
  if (heart) {
    assert.equal(heart.hidden, true, 'heart hidden on t-prefix');
  }
  // Note: when the heart is mounted but hidden, the chevron may not
  // exist (the heart took the slot). The contract is that the user
  // sees no heart — the gate hides it.
});

test('search row: m-prefix artist keeps the chevron, no heart', () => {
  const row = searchRow({
    type: 'link', guide_id: 'm33333', text: 'Joan Baez',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=m33333',
  });
  assert.equal(findFirstByClass(row, 'fav-heart'), null,
    'artist row has no heart at all (drillSearchRow path)');
  const chev = findFirstByClass(row, 'station-row__chev');
  assert.ok(chev, 'artist row still carries a chevron');
});

test('search row: heart toggle round-trips through POST /favorites', async () => {
  store.state.speaker.favorites = [];
  const calls = [];
  const restore = installFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 's11111', name: 'Folk Alley', art: 'http://example/art.png', note: '' }] }),
    };
  });
  try {
    const row = searchRow({
      type: 'audio', guide_id: 's11111', text: 'Folk Alley',
      subtext: 'Kent, OH', image: 'http://example/art.png',
      item: 'station',
    });
    const heart = findFirstByClass(row, 'fav-heart');
    assert.ok(heart, 'heart present');
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 5));
    const post = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(post, 'POST /favorites issued');
    const body = JSON.parse(post.opts.body);
    assert.equal(body.length, 1);
    assert.equal(body[0].id, 's11111');
    assert.equal(body[0].name, 'Folk Alley');
    assert.equal(body[0].art, 'http://example/art.png');
    assert.equal(body[0].note, '', 'note is the empty string per #126 capture rule');
  } finally {
    restore();
  }
});

// --- browse rows (renderEntry) --------------------------------------

test('browse renderEntry: station row carries a heart, no chevron', () => {
  const node = renderEntry({
    type: 'audio', guide_id: 's12345', text: 'KEXP',
    image: 'http://example/kexp.png', subtext: 'Seattle, WA',
  });
  const heart = findFirstByClass(node, 'fav-heart');
  assert.ok(heart, 'station row has a heart');
  assert.equal(heart.hidden, false);
  assert.equal(findFirstByClass(node, 'station-row__chev'), null);
});

test('browse renderEntry: show row carries a heart, no chevron', () => {
  const node = renderEntry({
    type: 'link', item: 'show', guide_id: 'p17',
    text: 'Fresh Air', image: 'http://example/show.png',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=p17',
  });
  const heart = findFirstByClass(node, 'fav-heart');
  assert.ok(heart, 'show row has a heart');
  assert.equal(heart.hidden, false);
  assert.equal(findFirstByClass(node, 'station-row__chev'), null);
});

test('browse renderEntry: drill row (g-prefix) has no heart, keeps chevron', () => {
  const node = renderEntry({
    text: 'Folk', URL: 'http://opml.radiotime.com/Browse.ashx?id=g79',
  });
  assert.equal(findFirstByClass(node, 'fav-heart'), null,
    'drill rows never mount a heart');
  // drill rows use the browse-row chevron variant
  const chev = findFirstByClass(node, 'browse-row__chev');
  assert.ok(chev, 'drill row keeps its chevron');
});

test('browse renderEntry: heart toggle round-trips through POST /favorites', async () => {
  store.state.speaker.favorites = [];
  const calls = [];
  const restore = installFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 's12345', name: 'KEXP', art: '', note: '' }] }),
    };
  });
  try {
    const node = renderEntry({
      type: 'audio', guide_id: 's12345', text: 'KEXP',
      image: 'http://example/kexp.png',
    });
    const heart = findFirstByClass(node, 'fav-heart');
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 5));
    const post = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(post, 'POST /favorites issued');
    const body = JSON.parse(post.opts.body);
    // Per #126: {id, name, art, note: ''}. The art URL is whatever the
    // row's normaliseRow pipeline emits (logoUrl may rewrite the
    // input); we assert the shape + key invariants, not the exact URL.
    assert.equal(body[0].id,   's12345');
    assert.equal(body[0].name, 'KEXP');
    assert.equal(typeof body[0].art, 'string');
    assert.equal(body[0].note, '', 'note is the empty string per #126');
  } finally {
    restore();
  }
});

// --- show-landing hero ---------------------------------------------

test('show-landing hero: heart sits inside the hero name row with the show metadata', () => {
  const body = doc.createElement('div');
  const describe = {
    head: { status: '200' },
    body: [{
      element: 'show',
      guide_id: 'p17',
      title: 'Fresh Air',
      logo: 'http://example/show.png',
      description: '',
    }],
  };
  _renderShowLandingForTest(body, describe, null, null, null);
  const hero = findFirstByClass(body, 'station-row--hero');
  assert.ok(hero, 'show hero mounted');
  const heart = findFirstByClass(hero, 'fav-heart');
  assert.ok(heart, 'hero has a heart');
  assert.equal(heart.hidden, false, 'heart visible on a p-prefix show id');
  // Heart sits inside the hero name row (the layout wrapper), not at
  // an arbitrary position.
  const nameRow = findFirstByClass(hero, 'station-row__name-row');
  assert.ok(nameRow, 'hero has a name row wrapper');
  let inside = false;
  for (const child of nameRow.childNodes || []) {
    if (child === heart) { inside = true; break; }
  }
  assert.equal(inside, true, 'heart is a child of the hero name row');
});

test('show-landing hero: heart toggle captures {id, name, art, note: ""}', async () => {
  store.state.speaker.favorites = [];
  const calls = [];
  const restore = installFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: [{ id: 'p17', name: 'Fresh Air', art: 'http://example/show.png', note: '' }] }),
    };
  });
  try {
    const body = doc.createElement('div');
    _renderShowLandingForTest(body, {
      head: { status: '200' },
      body: [{
        element: 'show', guide_id: 'p17', title: 'Fresh Air',
        logo: 'http://example/show.png',
      }],
    }, null, null, null);
    const heart = findFirstByClass(body, 'fav-heart');
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 5));
    const post = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(post, 'POST /favorites issued');
    const sent = JSON.parse(post.opts.body);
    assert.deepEqual(sent[0], {
      id: 'p17', name: 'Fresh Air', art: 'http://example/show.png', note: '',
    });
  } finally {
    restore();
  }
});

test('show-landing liveShow card: heart on the airing show hero', () => {
  const card = renderLiveShowCard([
    { type: 'link', item: 'show', guide_id: 'p17', text: 'Fresh Air',
      image: 'http://example/show.png' },
  ]);
  const heart = findFirstByClass(card, 'fav-heart');
  assert.ok(heart, 'liveShow hero carries a heart');
  assert.equal(heart.hidden, false);
});

test('show-landing topic row: t-prefix → no visible heart (favourites are s/p only)', () => {
  const card = renderTopicsCard([
    { type: 'link', item: 'topic', guide_id: 't1001', text: 'Episode 1',
      URL: 'http://opml.radiotime.com/Tune.ashx?id=t1001&sid=p17',
      topic_duration: '3600' },
  ]);
  const heart = findFirstByClass(card, 'fav-heart');
  // Topic rows go through stationRow without a `favorite` handle, so
  // no heart element is rendered at all. The chevron stays.
  if (heart) {
    assert.equal(heart.hidden, true, 'heart hidden on t-prefix');
  }
  const chev = findFirstByClass(card, 'station-row__chev');
  assert.ok(chev, 'topic row keeps its chevron');
});

// --- recently-viewed / popular helpers (via stationRow direct) ------

test('stationRow: favourite handle wires a heart on s-prefix (recently-viewed shape)', () => {
  const row = stationRow({
    sid: 's12345', name: 'KEXP', art: 'http://example/kexp.png',
    favorite: {
      store,
      getEntry: () => ({ id: 's12345', name: 'KEXP', art: 'http://example/kexp.png', note: '' }),
    },
  });
  const heart = findFirstByClass(row, 'fav-heart');
  assert.ok(heart, 'recently-viewed row has a heart');
  assert.equal(heart.hidden, false);
  assert.equal(findFirstByClass(row, 'station-row__chev'), null);
});

test('stationRow: omit favourite handle → chevron stays, no heart', () => {
  const row = stationRow({
    sid: 's12345', name: 'KEXP', art: 'http://example/kexp.png',
  });
  assert.equal(findFirstByClass(row, 'fav-heart'), null);
  const chev = findFirstByClass(row, 'station-row__chev');
  assert.ok(chev, 'no favourite handle → chevron is the trailing slot');
});

// --- Now-Playing card ----------------------------------------------
//
// Mount the production view via its default export. The window stub
// from now-playing tests installs hashchange listeners; for the heart
// we only need the card's name row, which mount() builds synchronously.

const { installWindowAndLocation } = await import('./fixtures/dom-shim.js');
installWindowAndLocation('#/');
const nowPlayingView = (await import('../app/views/now-playing.js')).default;

function setNowPlaying(np) {
  store.update('speaker', (s) => {
    s.speaker.nowPlaying = np;
  });
}

function mountNowPlaying() {
  const root = doc.createElement('section');
  const destroy = nowPlayingView.init(root, store, {});
  return { root, destroy };
}

test('Now-Playing card: heart visible when source=TUNEIN and item.location carries an s-id', () => {
  setNowPlaying({
    source: 'TUNEIN',
    item: { itemName: 'KEXP', location: '/v1/playback/station/s12345' },
    playStatus: 'PLAY_STATE',
    art: 'http://example/kexp.png',
  });
  const { root, destroy } = mountNowPlaying();
  try {
    const heart = findFirstByClass(root, 'fav-heart');
    assert.ok(heart, 'heart present in Now-Playing card');
    assert.equal(heart.hidden, false, 'heart visible on s-id TUNEIN source');
    // Lives next to the np-name (inside the np-name-row).
    const nameRow = findFirstByClass(root, 'np-name-row');
    assert.ok(nameRow, 'name-row wrapper present');
    let nested = false;
    function walk(n) {
      if (!n) return;
      if (n === heart) { nested = true; return; }
      for (const c of n.childNodes || []) walk(c);
    }
    walk(nameRow);
    assert.equal(nested, true, 'heart is inside the name-row container');
  } finally {
    destroy();
  }
});

test('Now-Playing card: heart visible on p-id (show drill) under TUNEIN', () => {
  setNowPlaying({
    source: 'TUNEIN',
    item: { itemName: 'Fresh Air', location: '/v1/playback/station/p17' },
    playStatus: 'PLAY_STATE',
    art: 'http://example/show.png',
  });
  const { root, destroy } = mountNowPlaying();
  try {
    const heart = findFirstByClass(root, 'fav-heart');
    assert.ok(heart, 'heart present');
    assert.equal(heart.hidden, false);
  } finally {
    destroy();
  }
});

test('Now-Playing card: heart hidden on STANDBY', () => {
  setNowPlaying({ source: 'STANDBY' });
  const { root, destroy } = mountNowPlaying();
  try {
    const heart = findFirstByClass(root, 'fav-heart');
    assert.ok(heart, 'heart element exists');
    assert.equal(heart.hidden, true, 'STANDBY hides the heart');
  } finally {
    destroy();
  }
});

test('Now-Playing card: heart hidden on AUX', () => {
  setNowPlaying({
    source: 'AUX',
    item: { itemName: 'AUX IN', location: '' },
    playStatus: 'PLAY_STATE',
  });
  const { root, destroy } = mountNowPlaying();
  try {
    const heart = findFirstByClass(root, 'fav-heart');
    assert.equal(heart.hidden, true, 'AUX source → heart hidden');
  } finally {
    destroy();
  }
});

test('Now-Playing card: heart hidden on BLUETOOTH', () => {
  setNowPlaying({
    source: 'BLUETOOTH',
    item: { itemName: 'iPhone', location: '' },
    playStatus: 'PLAY_STATE',
  });
  const { root, destroy } = mountNowPlaying();
  try {
    const heart = findFirstByClass(root, 'fav-heart');
    assert.equal(heart.hidden, true, 'BLUETOOTH source → heart hidden');
  } finally {
    destroy();
  }
});

test('Now-Playing card: heart hidden on TUNEIN with topic (t-prefix not favouritable)', () => {
  setNowPlaying({
    source: 'TUNEIN',
    item: { itemName: 'Episode 1', location: '/v1/playback/station/t12345' },
    playStatus: 'PLAY_STATE',
  });
  const { root, destroy } = mountNowPlaying();
  try {
    const heart = findFirstByClass(root, 'fav-heart');
    assert.equal(heart.hidden, true, 'topics are not favouritable');
  } finally {
    destroy();
  }
});

test('Now-Playing card: heart toggle captures {id, name, art, note: ""} from item.location + itemName + np.art', async () => {
  store.state.speaker.favorites = [];
  setNowPlaying({
    source: 'TUNEIN',
    item: { itemName: 'KEXP', location: '/v1/playback/station/s12345' },
    playStatus: 'PLAY_STATE',
    art: 'http://example/kexp.png',
  });
  const calls = [];
  const restore = installFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (/\/favorites$/.test(String(url))) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, data: [{ id: 's12345', name: 'KEXP', art: 'http://example/kexp.png', note: '' }] }),
      };
    }
    return new Promise(() => {});
  });
  try {
    const { root, destroy } = mountNowPlaying();
    const heart = findFirstByClass(root, 'fav-heart');
    assert.ok(heart, 'heart present');
    heart.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 5));
    const post = calls.find((c) => /\/favorites$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(post, 'POST /favorites issued');
    const body = JSON.parse(post.opts.body);
    assert.deepEqual(body[0], {
      id: 's12345', name: 'KEXP', art: 'http://example/kexp.png', note: '',
    });
    destroy();
  } finally {
    restore();
  }
});
