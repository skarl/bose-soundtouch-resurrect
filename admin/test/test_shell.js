// Tests for app/shell.js — pill computation, activeTab routing rule,
// mini-player visibility, and the standby wake action.
//
// Mirrors the xmldom shim block from test_components.js so the shell
// can mount against a fake document without a real browser.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation } from '@xmldom/xmldom';

// --- DOM shim --------------------------------------------------------

const doc = new DOMImplementation().createDocument(null, null, null);
if (!doc.querySelector) {
  doc.querySelector = (sel) => {
    const all = doc.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const el = all.item(i);
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        const have = (el.getAttribute('class') || '').split(/\s+/);
        if (have.includes(cls)) return el;
      }
    }
    return null;
  };
}
if (!doc.documentElement) {
  const html = doc.createElement('html');
  doc.appendChild(html);
}
if (!doc.documentElement.dataset) {
  doc.documentElement.dataset = {};
}
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

if (!('hidden' in ElementProto)) {
  Object.defineProperty(ElementProto, 'hidden', {
    get() { return this.getAttribute('hidden') != null; },
    set(v) {
      if (v) this.setAttribute('hidden', '');
      else   this.removeAttribute('hidden');
    },
  });
}

if (!ElementProto.replaceChildren) {
  ElementProto.replaceChildren = function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (const n of nodes) {
      if (n == null) continue;
      this.appendChild(n);
    }
  };
}

// xmldom omits .className — back it with the `class` attribute so
// imperative `el.className = 'foo'` round-trips through getAttribute.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'className')) {
  Object.defineProperty(ElementProto, 'className', {
    get() { return this.getAttribute('class') || ''; },
    set(v) { this.setAttribute('class', String(v)); },
  });
}

// xmldom omits Element.dataset. Back it with data-* attributes so
// reads round-trip through getAttribute and writes via setAttribute.
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

function ev(type, init = {}) {
  return Object.assign({
    type,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  }, init);
}

// Window/location stub for hash-based tests. shell.js reads
// location.hash and addEventListener('hashchange').
const winListeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    if (!winListeners.has(type)) winListeners.set(type, new Set());
    winListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    if (winListeners.has(type)) winListeners.get(type).delete(fn);
  },
};
globalThis.location = { hash: '#/' };
function fireHashChange(nextHash) {
  globalThis.location.hash = nextHash;
  const set = winListeners.get('hashchange');
  if (set) for (const fn of set) fn();
}

// --- pure helpers ---------------------------------------------------

const { computePillState, tabForPath, shouldShowMini } = await import('../app/shell.js');

test('computePillState: WS live + playing → live', () => {
  const s = { ws: { mode: 'ws' }, speaker: { nowPlaying: { playStatus: 'PLAY_STATE' } } };
  assert.deepEqual(computePillState(s), { tone: 'live', text: 'live' });
});

test('computePillState: WS live + paused → paused', () => {
  const s = { ws: { mode: 'ws' }, speaker: { nowPlaying: { playStatus: 'PAUSE_STATE' } } };
  assert.deepEqual(computePillState(s), { tone: 'ok', text: 'paused' });
});

test('computePillState: WS live + STANDBY → standby', () => {
  const s = { ws: { mode: 'ws' }, speaker: { nowPlaying: { source: 'STANDBY' } } };
  assert.deepEqual(computePillState(s), { tone: 'ok', text: 'standby' });
});

test('computePillState: connecting overrides any playback state', () => {
  const s = { ws: { mode: 'connecting' }, speaker: { nowPlaying: { playStatus: 'PLAY_STATE' } } };
  assert.deepEqual(computePillState(s), { tone: 'warn', text: 'connecting' });
});

test('computePillState: reconnecting overrides standby', () => {
  const s = { ws: { mode: 'reconnecting' }, speaker: { nowPlaying: { source: 'STANDBY' } } };
  assert.deepEqual(computePillState(s), { tone: 'warn', text: 'reconnecting' });
});

test('computePillState: polling has its own tone', () => {
  const s = { ws: { mode: 'polling' }, speaker: { nowPlaying: { playStatus: 'PLAY_STATE' } } };
  assert.deepEqual(computePillState(s), { tone: 'ok', text: 'polling' });
});

test('computePillState: offline overrides everything', () => {
  const s = { ws: { mode: 'offline' }, speaker: { nowPlaying: { playStatus: 'PLAY_STATE' } } };
  assert.deepEqual(computePillState(s), { tone: 'danger', text: 'offline' });
});

test('computePillState: unknown ws mode falls back to offline', () => {
  const s = { ws: { mode: 'mauve' }, speaker: {} };
  assert.deepEqual(computePillState(s), { tone: 'danger', text: 'offline' });
});

// --- activeTab routing ---------------------------------------------

test('tabForPath: top-level paths map to a tab', () => {
  assert.equal(tabForPath('/'),         'now');
  assert.equal(tabForPath('/search'),   'search');
  assert.equal(tabForPath('/browse'),   'browse');
  assert.equal(tabForPath('/settings'), 'settings');
});

test('tabForPath: station detail does NOT change activeTab', () => {
  assert.equal(tabForPath('/station/s12345'), null);
});

test('tabForPath: preset modal does NOT change activeTab', () => {
  assert.equal(tabForPath('/preset/3'), null);
});

// --- mini-player visibility ----------------------------------------

test('shouldShowMini: hidden on home (#/)', () => {
  assert.equal(shouldShowMini({ ws: { mode: 'ws' } }, '#/'), false);
});

test('shouldShowMini: hidden on preset modal', () => {
  assert.equal(shouldShowMini({ ws: { mode: 'ws' } }, '#/preset/2'), false);
});

test('shouldShowMini: visible on /browse with WS up', () => {
  assert.equal(shouldShowMini({ ws: { mode: 'ws' } }, '#/browse'), true);
});

test('shouldShowMini: visible on /search with polling fallback', () => {
  assert.equal(shouldShowMini({ ws: { mode: 'polling' } }, '#/search'), true);
});

test('shouldShowMini: hidden when offline', () => {
  assert.equal(shouldShowMini({ ws: { mode: 'offline' } }, '#/browse'), false);
});

test('shouldShowMini: visible on station detail', () => {
  assert.equal(shouldShowMini({ ws: { mode: 'ws' } }, '#/station/s9999'), true);
});

// --- mounted shell: routing rule + standby wake action -------------

// Build the four zones in the shimmed document so mountShell can find them.
function setupShellDOM() {
  // Wipe any prior shell.
  const html = doc.documentElement;
  while (html.firstChild) html.removeChild(html.firstChild);
  const body = doc.createElement('body');
  html.appendChild(body);

  const shell = doc.createElement('div');
  shell.setAttribute('class', 'shell');
  shell.setAttribute('data-vp', 'mobile');

  for (const cls of ['shell-rail', 'shell-header', 'shell-body', 'shell-mini', 'shell-tabs']) {
    const tag = cls === 'shell-tabs' ? 'nav'
      : cls === 'shell-body' ? 'main'
      : cls === 'shell-rail' ? 'aside'
      : 'div';
    const z = doc.createElement(tag);
    z.setAttribute('class', cls);
    if (cls === 'shell-mini') z.setAttribute('hidden', '');
    shell.appendChild(z);
  }
  body.appendChild(shell);
  return shell;
}

function makeStore(initial) {
  const KEYS = ['speaker', 'ws', 'ui', 'caches'];
  const subs = new Map(KEYS.map((k) => [k, new Set()]));
  return {
    state: initial,
    subscribe(key, fn) {
      if (!subs.has(key)) throw new Error(`unknown key: ${key}`);
      subs.get(key).add(fn);
      return () => subs.get(key).delete(fn);
    },
    touch(key) {
      for (const fn of subs.get(key)) fn(this.state, key);
    },
  };
}

test('routing rule: top-level paths update activeTab', async () => {
  setupShellDOM();
  globalThis.location.hash = '#/';
  const store = makeStore({
    speaker: { info: { name: 'Bo' }, nowPlaying: null },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  fireHashChange('#/browse');
  assert.equal(store.state.ui.activeTab, 'browse');

  fireHashChange('#/settings');
  assert.equal(store.state.ui.activeTab, 'settings');
});

test('routing rule: Browse → station detail does NOT change activeTab', async () => {
  setupShellDOM();
  globalThis.location.hash = '#/browse';
  const store = makeStore({
    speaker: { info: null, nowPlaying: null },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  fireHashChange('#/browse');
  assert.equal(store.state.ui.activeTab, 'browse', 'browse landing sets the tab');

  fireHashChange('#/station/s12345');
  assert.equal(store.state.ui.activeTab, 'browse', 'station detail leaves browse highlighted');
});

test('routing rule: tab bar hides entirely on preset modal', async () => {
  const shell = setupShellDOM();
  globalThis.location.hash = '#/';
  const store = makeStore({
    speaker: { info: null, nowPlaying: null },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  // Pick the outer .shell-tabs nav rather than the first tag match; the
  // rail aside also nests its own <nav> for keyboard semantics.
  const navs = shell.getElementsByTagName('nav');
  let tabs = null;
  for (let i = 0; i < navs.length; i++) {
    const cls = navs.item(i).getAttribute('class') || '';
    if (cls.includes('shell-tabs')) { tabs = navs.item(i); break; }
  }
  assert.ok(tabs, 'shell-tabs nav resolved');
  assert.equal(tabs.hidden, false, 'tabs visible on home');

  fireHashChange('#/preset/3');
  assert.equal(tabs.hidden, true, 'tabs hidden on preset modal');
});

test('mini player visibility: hidden on #/, visible on #/browse', async () => {
  const shell = setupShellDOM();
  globalThis.location.hash = '#/';
  const store = makeStore({
    speaker: { info: null, nowPlaying: { source: 'TUNEIN', item: { name: 'KEXP' }, playStatus: 'PLAY_STATE' } },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  const mini = doc.querySelector('.shell-mini');
  assert.equal(mini.hidden, true, 'hidden on home');

  fireHashChange('#/browse');
  assert.equal(mini.hidden, false, 'visible on browse');

  fireHashChange('#/preset/2');
  assert.equal(mini.hidden, true, 'hidden on preset modal');
});

test('side rail: card / nav / foot mount with speaker chrome', async () => {
  const shell = setupShellDOM();
  globalThis.location.hash = '#/';
  const store = makeStore({
    speaker: {
      info: { name: 'Bo', type: 'SoundTouch 10', firmwareVersion: '27.0.6' },
      nowPlaying: { playStatus: 'PLAY_STATE' },
      network: { name: 'bo-host', ipAddress: '192.168.178.36' },
    },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  const rail = shell.getElementsByTagName('aside').item(0);
  assert.ok(rail, 'rail aside exists');
  const card = rail.getElementsByTagName('*');
  let foundCard = false;
  let foundNav = false;
  let foundFoot = false;
  for (let i = 0; i < card.length; i++) {
    const cls = card.item(i).getAttribute('class') || '';
    if (cls.includes('shell-rail__card')) foundCard = true;
    if (cls.includes('shell-rail__nav'))  foundNav  = true;
    if (cls.includes('shell-rail__foot')) foundFoot = true;
  }
  assert.ok(foundCard, 'rail card rendered');
  assert.ok(foundNav,  'rail nav rendered');
  assert.ok(foundFoot, 'rail foot rendered');

  // Active tab from store drives the is-active class on the matching item.
  let activeCount = 0;
  for (let i = 0; i < card.length; i++) {
    const cls = card.item(i).getAttribute('class') || '';
    if (cls.includes('shell-rail__item') && cls.includes('is-active')) activeCount++;
  }
  assert.equal(activeCount, 1, 'exactly one rail item carries is-active');
});

test('mini player: standby tap fires actions.pressKey("POWER")', async () => {
  setupShellDOM();
  globalThis.location.hash = '#/browse';

  // actions.pressKey → api.speakerKey → fetch. Stub fetch so we can
  // assert POWER was issued without hitting the network. ES module
  // exports are read-only, so the seam has to be at fetch.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    calls.push(String(opts && opts.body));
    return { ok: true, status: 200 };
  };

  try {
    const store = makeStore({
      speaker: { info: null, nowPlaying: { source: 'STANDBY' } },
      ws: { mode: 'ws' },
      ui: { activeTab: 'now' },
      caches: {},
    });
    const { mountShell } = await import('../app/shell.js');
    mountShell(store);

    const body = doc.querySelector('.shell-mini').getElementsByTagName('button').item(0);
    body.dispatchEvent(ev('click'));
    // Allow the press+release await chain to drain.
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(calls.some((b) => b.includes('POWER')),
      `expected a POWER key body, got ${JSON.stringify(calls)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- mobile sticky-bottom: shell layout regression -----------------
//
// .shell must use height (not min-height) so the 1fr body row absorbs
// overflow inside .shell-body's own scroll container; otherwise mini +
// tabs scroll off-screen on mobile when the body content is tall.
// .shell-body needs min-height: 0 to let the grid row contain overflow.

test('shell css: .shell pins to viewport height, not min-height', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const css = fs.readFileSync(path.resolve('admin/style.css'), 'utf8');
  const shellRule = css.match(/^\.shell\s*\{([^}]+)\}/m);
  assert.ok(shellRule, 'found .shell rule');
  const body = shellRule[1];
  assert.ok(/\bheight:\s*100vh\b/.test(body),  'has height: 100vh');
  assert.ok(/\bheight:\s*100dvh\b/.test(body), 'has height: 100dvh fallback');
  assert.ok(!/\bmin-height:\s*100v?dh?\b/.test(body),
    '.shell must NOT use min-height for the viewport pin');
});

test('shell css: .shell-body declares min-height: 0 so overflow contains', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const css = fs.readFileSync(path.resolve('admin/style.css'), 'utf8');
  const rule = css.match(/^\.shell-body\s*\{([^}]+)\}/m);
  assert.ok(rule, 'found .shell-body rule');
  assert.ok(/\bmin-height:\s*0\b/.test(rule[1]),
    'shell-body needs min-height: 0 — the standard CSS-grid overflow gotcha');
});

test('index.html: mini and tabs come after body in DOM order (mobile pin)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const html = fs.readFileSync(path.resolve('admin/index.html'), 'utf8');
  const idxBody = html.indexOf('class="shell-body"');
  const idxMini = html.indexOf('class="shell-mini"');
  const idxTabs = html.indexOf('class="shell-tabs"');
  assert.ok(idxBody > 0 && idxMini > idxBody, 'mini after body');
  assert.ok(idxTabs > idxMini, 'tabs after mini');
});

// --- mini-player buffering glyph (#88) -----------------------------

function findMiniPlayBtn() {
  // The .shell-mini contains two <button> elements — body wrapper + play.
  // The play button is the one carrying the 'shell-mini__play' class.
  const mini = doc.querySelector('.shell-mini');
  const buttons = mini.getElementsByTagName('button');
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons.item(i);
    if ((b.getAttribute('class') || '').includes('shell-mini__play')) return b;
  }
  return null;
}

test('mini-player: BUFFERING_STATE renders the buffer glyph + data-phase', async () => {
  setupShellDOM();
  globalThis.location.hash = '#/browse';
  const store = makeStore({
    speaker: {
      info: null,
      nowPlaying: {
        source: 'TUNEIN',
        item: { name: 'Fresh Air', location: '/v1/playback/station/p17' },
        playStatus: 'BUFFERING_STATE',
      },
    },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  const playBtn = findMiniPlayBtn();
  assert.ok(playBtn, 'play button exists');
  assert.equal(playBtn.getAttribute('data-phase'), 'buffering',
    'data-phase="buffering" surfaces on the play control');
  assert.equal(playBtn.getAttribute('aria-busy'), 'true',
    'aria-busy is set for SR users');
  // Glyph is the 3-dot buffer icon — its child contains three <circle>s.
  const svg = playBtn.getElementsByTagName('svg').item(0);
  assert.ok(svg, 'svg glyph mounted');
  assert.equal(svg.getElementsByTagName('circle').length, 3,
    'buffer glyph renders three dots');
});

test('mini-player: PLAY_STATE renders pause glyph (data-phase=playing)', async () => {
  setupShellDOM();
  globalThis.location.hash = '#/browse';
  const store = makeStore({
    speaker: {
      info: null,
      nowPlaying: {
        source: 'TUNEIN',
        item: { name: 'KEXP', location: '/v1/playback/station/s12345' },
        playStatus: 'PLAY_STATE',
      },
    },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  const playBtn = findMiniPlayBtn();
  assert.equal(playBtn.getAttribute('data-phase'), 'playing');
  assert.equal(playBtn.getAttribute('aria-label'), 'Pause');
  assert.equal(playBtn.getAttribute('aria-busy'), null,
    'aria-busy cleared in playing phase');
  // pause glyph has two <rect>s.
  const svg = playBtn.getElementsByTagName('svg').item(0);
  assert.equal(svg.getElementsByTagName('rect').length, 2);
});

test('mini-player: STOP_STATE with no item → idle play glyph', async () => {
  setupShellDOM();
  globalThis.location.hash = '#/browse';
  const store = makeStore({
    speaker: {
      info: null,
      nowPlaying: {
        source: 'TUNEIN',
        item: { name: '', location: '' },
        playStatus: 'STOP_STATE',
      },
    },
    ws: { mode: 'ws' },
    ui: { activeTab: 'now' },
    caches: {},
  });
  const { mountShell } = await import('../app/shell.js');
  mountShell(store);

  const playBtn = findMiniPlayBtn();
  assert.equal(playBtn.getAttribute('data-phase'), 'idle');
  assert.equal(playBtn.getAttribute('aria-label'), 'Play');
});

test('mini-player: tap on buffering control is a no-op (re-entrancy guard)', async () => {
  setupShellDOM();
  globalThis.location.hash = '#/browse';

  // Stub fetch — any PRESS that escapes will hit this and increment calls.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    calls.push(String(opts && opts.body));
    return { ok: true, status: 200 };
  };

  try {
    const store = makeStore({
      speaker: {
        info: null,
        nowPlaying: {
          source: 'TUNEIN',
          item: { name: 'Fresh Air', location: '/v1/playback/station/p17' },
          playStatus: 'BUFFERING_STATE',
        },
      },
      ws: { mode: 'ws' },
      ui: { activeTab: 'now' },
      caches: {},
    });
    const { mountShell } = await import('../app/shell.js');
    mountShell(store);

    const playBtn = findMiniPlayBtn();
    playBtn.dispatchEvent(ev('click'));
    // Give the press/release await chain a beat — should fire nothing.
    await new Promise((r) => setTimeout(r, 10));

    const playPauseHits = calls.filter((b) => /PLAY|PAUSE/.test(b));
    assert.equal(playPauseHits.length, 0,
      `tap on buffering control must not emit a PLAY/PAUSE key, got ${JSON.stringify(playPauseHits)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
