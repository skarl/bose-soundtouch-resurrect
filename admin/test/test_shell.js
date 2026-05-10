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

  for (const cls of ['shell-header', 'shell-body', 'shell-mini', 'shell-tabs']) {
    const z = doc.createElement(cls === 'shell-tabs' ? 'nav' : (cls === 'shell-body' ? 'main' : 'div'));
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

  const tabs = shell.getElementsByTagName('nav').item(0);
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
