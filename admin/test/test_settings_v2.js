// Tests for the settings v2 sections (#61) and the v2 polish pass:
//   - Appearance picker wires through theme.setTheme()
//   - Multi-room view renders the deferred-feature stub
//   - Bluetooth view shows the speaker MAC and Now-Playing connection
//   - Network view exposes signalBars()/signalBarsCount() and a 4-bar widget
//   - WS log ring buffer caps at 50 entries (FIFO trim)
//   - Settings shell renders seven cards in the agreed order
//   - Card headers are buttons that toggle aria-expanded on click
//   - No "Low-power standby", "Send notification", or "Factory reset" leaks
//     anywhere in the rendered settings tree
//
// Uses jsdom rather than @xmldom/xmldom because the views build DOM via
// the html`` tag, which depends on <template>.content + querySelectorAll
// + treeWalker. xmldom doesn't model any of those.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';

// --- jsdom bootstrap (must run before any view import) --------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const { window } = dom;

globalThis.window     = window;
globalThis.document   = window.document;
globalThis.Node       = window.Node;
globalThis.Element    = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.NodeFilter = window.NodeFilter;
globalThis.DOMParser  = window.DOMParser;
globalThis.localStorage = window.localStorage;
globalThis.matchMedia = (q) => window.matchMedia(q);
window.matchMedia = window.matchMedia || ((q) => ({
  media: q,
  matches: false,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
}));

// fetch stub — silences views that auto-fetch on mount.
globalThis.fetch = () => Promise.reject(new Error('fetch disabled in tests'));

// --- imports (after the bootstrap is fully installed) ----------------

const theme = await import('../app/theme.js');
const appearance = (await import('../app/views/settings/appearance.js')).default;
const multiroom  = (await import('../app/views/settings/multiroom.js')).default;
const bluetoothView = (await import('../app/views/settings/bluetooth.js')).default;
const networkMod = await import('../app/views/settings/network.js');
const settingsShell = (await import('../app/views/settings.js')).default;
// Bluetooth view reads from the module-singleton store rather than the
// store passed into mount(); seed real state so the renders see it.
const { store: realStore } = await import('../app/state.js');

const { signalBars, signalBarsCount } = networkMod;
const { dispatch } = await import('../app/ws.js');

// --- helpers --------------------------------------------------------

function makeStore(initial = {}) {
  const subs = new Map([
    ['speaker', new Set()],
    ['ws',      new Set()],
    ['ui',      new Set()],
    ['caches',  new Set()],
  ]);
  const state = {
    speaker: { info: null, nowPlaying: null, bluetooth: null, network: null,
               capabilities: null, recents: null, presets: null, volume: null,
               sources: null, bass: null, balance: null, dspMonoStereo: null,
               zone: null, systemTimeout: null },
    ws:      { connected: false, mode: 'offline', lastEvent: null, recentEvents: [] },
    ui:      {},
    caches:  {},
    ...initial,
  };
  const touched = [];
  return {
    state,
    subscribe(key, fn) { subs.get(key).add(fn); return () => subs.get(key).delete(fn); },
    touch(key) { touched.push(key); for (const fn of subs.get(key)) fn(state, key); },
    update(key, mut) { mut(state); for (const fn of subs.get(key)) fn(state, key); },
    set(key, value) { state[key] = value; for (const fn of subs.get(key)) fn(state, key); },
    _touched: touched,
  };
}

function makeRoot() {
  return document.createElement('div');
}

// --- Appearance section ---------------------------------------------

test('appearance: renders 4 picker buttons in cycle order', () => {
  localStorage.clear();
  theme.init();

  const root = makeRoot();
  const destroy = appearance.init(root, makeStore(), {});
  const buttons = root.querySelectorAll('button');
  assert.equal(buttons.length, 4);
  const labels = Array.from(buttons).map((b) => b.dataset.theme);
  assert.deepEqual(labels, ['auto', 'graphite', 'cream', 'terminal']);
  destroy();
});

test('appearance: clicking each option calls theme.setTheme(name)', () => {
  for (const name of ['graphite', 'cream', 'terminal', 'auto']) {
    localStorage.clear();
    theme.init();
    const root = makeRoot();
    const destroy = appearance.init(root, makeStore(), {});
    const target = root.querySelector(`button[data-theme="${name}"]`);
    target.click();
    assert.equal(theme.current().preference, name,
      `clicking ${name} sets theme preference to ${name}`);
    destroy();
  }
});

test('appearance: active button reflects current preference on mount', () => {
  localStorage.clear();
  localStorage.setItem('admin.theme', 'cream');
  theme.init();

  const root = makeRoot();
  const destroy = appearance.init(root, makeStore(), {});
  const active = root.querySelectorAll('button[data-active="true"]');
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.theme, 'cream');
  destroy();
});

// --- Multi-room stub --------------------------------------------------

test('multiroom: renders one stub paragraph and nothing else interactive', () => {
  const root = makeRoot();
  const destroy = multiroom.init(root, makeStore(), {});

  assert.equal(root.querySelectorAll('button').length, 0);
  assert.equal(root.querySelectorAll('input').length, 0);
  assert.equal(root.querySelectorAll('select').length, 0);

  const ps = root.querySelectorAll('p');
  assert.equal(ps.length, 1, 'exactly one <p> of copy');
  assert.match(ps[0].textContent, /Multi-room requires a second SoundTouch/);
  assert.match(ps[0].textContent, /Not implemented in this release/);
  destroy();
});

// --- Bluetooth view ---------------------------------------------------

// Reset the module-singleton store between bluetooth tests — the
// bluetooth view reads state.speaker.{bluetooth,nowPlaying} directly off
// the imported singleton (it must, since refetch() needs to write back
// into the same store the rest of the app sees).
function resetRealSpeaker() {
  realStore.state.speaker.bluetooth  = null;
  realStore.state.speaker.nowPlaying = null;
}

test('bluetooth: MAC row populated from state.speaker.bluetooth.macAddress', () => {
  resetRealSpeaker();
  realStore.state.speaker.bluetooth = { macAddress: '0CB2B709F837' };

  const root = makeRoot();
  const destroy = bluetoothView.init(root, realStore, {});
  const macEl = root.querySelector('.bt-mac');
  // formatMac inserts colons every two hex digits.
  assert.equal(macEl.textContent, '0C:B2:B7:09:F8:37');
  destroy();
});

test('bluetooth: connection row says "Not connected" when source != BLUETOOTH', () => {
  resetRealSpeaker();
  realStore.state.speaker.bluetooth = { macAddress: '0CB2B709F837' };
  realStore.state.speaker.nowPlaying = { source: 'TUNEIN', connection: null };

  const root = makeRoot();
  const destroy = bluetoothView.init(root, realStore, {});
  const connectedEl = root.querySelector('.bt-connected');
  assert.equal(connectedEl.textContent, 'Not connected');
  destroy();
});

test('bluetooth: connection row reads deviceName when source=BLUETOOTH and CONNECTED', () => {
  resetRealSpeaker();
  realStore.state.speaker.bluetooth = { macAddress: '0CB2B709F837' };
  realStore.state.speaker.nowPlaying = {
    source: 'BLUETOOTH',
    connection: { deviceName: "Sven's iPhone", status: 'CONNECTED' },
  };

  const root = makeRoot();
  const destroy = bluetoothView.init(root, realStore, {});
  const connectedEl = root.querySelector('.bt-connected');
  assert.equal(connectedEl.textContent, "Sven's iPhone");
  destroy();
});

test('bluetooth: pair and clear buttons remain present', () => {
  resetRealSpeaker();
  realStore.state.speaker.bluetooth = { macAddress: '0CB2B709F837' };

  const root = makeRoot();
  const destroy = bluetoothView.init(root, realStore, {});
  const pairBtn  = root.querySelector('.bt-pair');
  const clearBtn = root.querySelector('.bt-clear');
  assert.ok(pairBtn,  'pair button present');
  assert.ok(clearBtn, 'clear button present');
  assert.equal(pairBtn.textContent,  'Enter pairing mode');
  assert.equal(clearBtn.textContent, 'Clear paired devices');
  destroy();
});

// --- Network signal bars ---------------------------------------------

test('signalBarsCount: each firmware label maps to its expected fill', () => {
  assert.equal(signalBarsCount('EXCELLENT_SIGNAL'), 4);
  assert.equal(signalBarsCount('GOOD_SIGNAL'),      3);
  assert.equal(signalBarsCount('MARGINAL_SIGNAL'),  2);
  assert.equal(signalBarsCount('POOR_SIGNAL'),      1);
  assert.equal(signalBarsCount('NO_SIGNAL'),        0);
  assert.equal(signalBarsCount('UNKNOWN'),          0);
  assert.equal(signalBarsCount(undefined),          0);
});

test('signalBars: returns a wrapper with 4 bars and data-fill set', () => {
  const wrap = signalBars('GOOD_SIGNAL');
  assert.equal(wrap.dataset.fill, '3');
  const bars = wrap.querySelectorAll('span');
  assert.equal(bars.length, 4);
  const filled = Array.from(bars).filter((b) => b.dataset.on === 'true').length;
  assert.equal(filled, 3);
});

test('signalBars: 0-bar bucket renders 4 bars, none filled', () => {
  const wrap = signalBars('NO_SIGNAL');
  assert.equal(wrap.dataset.fill, '0');
  const bars = wrap.querySelectorAll('span');
  assert.equal(Array.from(bars).filter((b) => b.dataset.on === 'true').length, 0);
});

// --- WS recent-events ring buffer ------------------------------------

test('ws.recentEvents: ring buffer trims to 50 entries (FIFO)', () => {
  const store = makeStore();
  for (let i = 0; i < 60; i++) {
    dispatch('<userActivityUpdate/>', store);
  }
  assert.equal(store.state.ws.recentEvents.length, 50);
  assert.equal(store.state.ws.recentEvents[0].tag, 'userActivityUpdate');
});

test('ws.recentEvents: most-recent entry is first (LIFO unshift)', () => {
  const store = makeStore();
  dispatch('<userActivityUpdate/>',     store);
  dispatch('<volume>10</volume>',       store);
  dispatch('<presetsUpdated/>',         store);
  assert.equal(store.state.ws.recentEvents[0].tag, 'presetsUpdated');
  assert.equal(store.state.ws.recentEvents[1].tag, 'volume');
  assert.equal(store.state.ws.recentEvents[2].tag, 'userActivityUpdate');
});

test('ws.recentEvents: malformed payload still gets logged', () => {
  const store = makeStore();
  dispatch('<not valid xml', store);
  assert.equal(store.state.ws.recentEvents.length, 1);
  assert.equal(store.state.ws.recentEvents[0].tag, '(unparsed)');
});

// --- Settings shell ---------------------------------------------------

test('settings shell: renders seven cards in the agreed order', () => {
  const store = makeStore();
  const root = makeRoot();
  const destroy = settingsShell.init(root, store, {});
  const cards = root.querySelectorAll('.settings-card');
  assert.equal(cards.length, 7, 'seven top-level cards');
  const ids = Array.from(cards).map((c) => c.dataset.section);
  assert.deepEqual(ids, [
    'appearance', 'speaker', 'audio', 'bluetooth',
    'multiroom',  'network', 'system',
  ]);
  destroy();
});

test('settings shell: only Appearance is open by default', () => {
  const store = makeStore();
  const root = makeRoot();
  const destroy = settingsShell.init(root, store, {});
  const cards = root.querySelectorAll('.settings-card');
  const openIds = Array.from(cards)
    .filter((c) => c.dataset.open === 'true')
    .map((c) => c.dataset.section);
  assert.deepEqual(openIds, ['appearance']);
  destroy();
});

test('settings shell: clicking a header toggles aria-expanded', () => {
  const store = makeStore();
  const root = makeRoot();
  const destroy = settingsShell.init(root, store, {});
  const networkHeader = root.querySelector('.settings-card[data-section="network"] .settings-card__header');
  assert.equal(networkHeader.getAttribute('aria-expanded'), 'false');
  networkHeader.click();
  assert.equal(networkHeader.getAttribute('aria-expanded'), 'true');
  networkHeader.click();
  assert.equal(networkHeader.getAttribute('aria-expanded'), 'false');
  destroy();
});

test('settings shell: no low-power-standby / notification / factory-reset leaks', () => {
  resetRealSpeaker();
  realStore.state.speaker.bluetooth = { macAddress: '0CB2B709F837' };

  const store = makeStore();
  const root = makeRoot();
  // Mount the shell against the real store so sub-views read live state.
  const destroy = settingsShell.init(root, realStore, {});

  // Open every card so all sub-views actually render their bodies.
  for (const header of root.querySelectorAll('.settings-card__header')) {
    if (header.getAttribute('aria-expanded') !== 'true') header.click();
  }

  const text = root.textContent.toLowerCase();
  assert.ok(!text.includes('low-power'),    'no "low-power" copy');
  assert.ok(!text.includes('low power'),    'no "low power" copy');
  assert.ok(!text.includes('notification'), 'no notification UI');
  assert.ok(!text.includes('factory reset'), 'no factory reset UI');

  // Confirm there's also no Multi-room interactive controls.
  const mrBody = root.querySelector('.settings-card[data-section="multiroom"] .settings-card__body');
  assert.equal(mrBody.querySelectorAll('button, input, select').length, 0,
    'multi-room body has no interactive controls');

  destroy();
});
