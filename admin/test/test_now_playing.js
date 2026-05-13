// Tests for app/views/now-playing.js — compact card + 3-col preset grid.
//
// Reuses the xmldom-based DOM shim pattern from test_shell.js, plus a
// few extras specific to the html`...` template tag (template.innerHTML
// → real DOM via xmldom's text/html parser; createTreeWalker for
// comment markers; NodeFilter constants).
//
// What we exercise:
//   - source switcher renders one button per READY source from state
//     (no hardcoded list)
//   - 3-column preset grid is present (.np-presets-grid)
//   - long-press on a preset navigates to #/preset/N
//   - equalizer carries data-state="playing" when nowPlaying is PLAY_STATE
//   - STANDBY swaps to the .np-asleep panel
//   - WS-driven re-render mutates the slider in place (focus survives)
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation, DOMParser } from '@xmldom/xmldom';

// --- DOM shim --------------------------------------------------------

const doc = new DOMImplementation().createDocument(null, null, null);

if (!doc.querySelector) {
  doc.querySelector = (sel) => queryOne(doc, sel);
}
if (!doc.querySelectorAll) {
  doc.querySelectorAll = (sel) => queryAll(doc, sel);
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
    evt.currentTarget = this;
    evt.target = evt.target || this;
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

if (!ElementProto.toggleAttribute) {
  ElementProto.toggleAttribute = function (name, force) {
    const has = this.getAttribute(name) != null;
    const want = force == null ? !has : !!force;
    if (want && !has) this.setAttribute(name, '');
    else if (!want && has) this.removeAttribute(name);
    return want;
  };
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

if (!('focus' in ElementProto)) {
  ElementProto.focus = function () {
    globalThis.__focus_target__ = this;
  };
}

// xmldom omits .className — back it with the `class` attribute so
// imperative `btn.className = 'foo'` round-trips through getAttribute.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'className')) {
  Object.defineProperty(ElementProto, 'className', {
    get() { return this.getAttribute('class') || ''; },
    set(v) { this.setAttribute('class', String(v)); },
  });
}

// xmldom omits .tabIndex — back it with the `tabindex` attribute.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'tabIndex')) {
  Object.defineProperty(ElementProto, 'tabIndex', {
    get() {
      const v = this.getAttribute('tabindex');
      return v == null ? -1 : Number(v);
    },
    set(v) { this.setAttribute('tabindex', String(v)); },
  });
}

// xmldom omits the .type / .disabled / .title getters/setters that the
// view's <button> creation routines rely on.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'type')) {
  Object.defineProperty(ElementProto, 'type', {
    get() { return this.getAttribute('type') || ''; },
    set(v) { this.setAttribute('type', String(v)); },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'disabled')) {
  Object.defineProperty(ElementProto, 'disabled', {
    get() { return this.getAttribute('disabled') != null; },
    set(v) {
      if (v) this.setAttribute('disabled', '');
      else   this.removeAttribute('disabled');
    },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'title')) {
  Object.defineProperty(ElementProto, 'title', {
    get() { return this.getAttribute('title') || ''; },
    set(v) { this.setAttribute('title', String(v)); },
  });
}

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
        has(_t, key) {
          if (typeof key !== 'string') return false;
          const attr = 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          return el.getAttribute(attr) != null;
        },
        deleteProperty(_t, key) {
          if (typeof key !== 'string') return true;
          const attr = 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          el.removeAttribute(attr);
          return true;
        },
      });
    },
  });
}

// --- style stand-in -------------------------------------------------
// xmldom elements have no .style; the view writes per-preset hue tokens
// via style.setProperty / style.removeProperty. Back it with a Map per
// element so reads round-trip; nothing actually paints.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'style')) {
  Object.defineProperty(ElementProto, 'style', {
    get() {
      const el = this;
      if (!el.__style__) {
        const props = new Map();
        el.__style__ = {
          setProperty(name, value) { props.set(name, String(value)); },
          getPropertyValue(name)   { return props.get(name) || ''; },
          removeProperty(name)     { props.delete(name); },
        };
      }
      return el.__style__;
    },
  });
}

// --- selector helpers (.foo / [data-bar="x"] / tag) ----------------
function matchSel(el, sel) {
  if (sel === '*') return el.nodeType === 1;
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return ((el.getAttribute && el.getAttribute('class')) || '').split(/\s+/).includes(cls);
  }
  // Match attribute selector like [data-foo="bar"]
  const attrSel = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
  if (attrSel) {
    const [, name, val] = attrSel;
    const got = el.getAttribute && el.getAttribute(name);
    if (val == null) return got != null;
    return got === val;
  }
  // Tag-name selector
  return el.nodeName && el.nodeName.toLowerCase() === sel.toLowerCase();
}
function queryAll(root, sel) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 1 && matchSel(node, sel)) out.push(node);
    const kids = node.childNodes;
    if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
  };
  walk(root);
  return out;
}
function queryOne(root, sel) {
  const list = queryAll(root, sel);
  return list[0] || null;
}

if (!ElementProto.querySelector) {
  ElementProto.querySelector = function (sel) { return queryOne(this, sel); };
}
if (!ElementProto.querySelectorAll) {
  ElementProto.querySelectorAll = function (sel) { return queryAll(this, sel); };
}

// --- template + tree walker -----------------------------------------
// dom.js' html`...` tag relies on:
//   document.createElement('template').innerHTML = src   (HTML parsing)
//   tpl.content.querySelectorAll('*')                    (already shimmed)
//   document.createTreeWalker(tpl.content, NodeFilter.SHOW_COMMENT)
// xmldom can parse `text/html` but doesn't emit a HTMLTemplateElement,
// so we hand-roll a template wrapper that defers to xmldom's parser.

const _origCreateElement = doc.createElement.bind(doc);
doc.createElement = function (name) {
  if (String(name).toLowerCase() === 'template') {
    return makeTemplateLike();
  }
  return _origCreateElement(name);
};

function makeTemplateLike() {
  const tpl = _origCreateElement('template');
  let _content = null;
  Object.defineProperty(tpl, 'innerHTML', {
    get() { return ''; },
    set(html) {
      // Wrap in a single root so xmldom's text/html parser has one
      // element to anchor to; we strip the wrapper afterwards.
      const wrapped = `<div>${html}</div>`;
      const parsed = new DOMParser().parseFromString(wrapped, 'text/html');
      const root = parsed.documentElement;
      // Build a fragment-like node that mirrors a DocumentFragment.
      const frag = _origCreateElement('div');
      // Move root's children into the fragment.
      while (root.firstChild) frag.appendChild(root.firstChild);
      _content = frag;
    },
  });
  Object.defineProperty(tpl, 'content', {
    get() { return _content || _origCreateElement('div'); },
  });
  return tpl;
}

globalThis.NodeFilter = { SHOW_COMMENT: 128 };
doc.createTreeWalker = function (root, _whatToShow) {
  // Walk the subtree once and stash comment nodes; nextNode() pops them.
  const comments = [];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 8) comments.push(node);
    const kids = node.childNodes;
    if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
  };
  walk(root);
  let i = 0;
  return {
    nextNode() { return i < comments.length ? comments[i++] : null; },
  };
};

// --- attributes iteration -------------------------------------------
// dom.js does `for (const attr of el.attributes)`. xmldom's NamedNodeMap
// has length + item(i) but isn't iterable by default — make it so.
const _attrsDescriptor = Object.getOwnPropertyDescriptor(ElementProto, 'attributes');
if (_attrsDescriptor && _attrsDescriptor.get) {
  const orig = _attrsDescriptor.get;
  Object.defineProperty(ElementProto, 'attributes', {
    get() {
      const nm = orig.call(this);
      if (!nm) return nm;
      if (typeof nm[Symbol.iterator] !== 'function') {
        nm[Symbol.iterator] = function* () {
          for (let i = 0; i < this.length; i++) yield this.item(i);
        };
      }
      return nm;
    },
  });
}

// --- input value descriptor -----------------------------------------
// xmldom treats <input value="…"> as a plain attribute, but the slider
// reads/writes the .value property. Shim: route value (get/set) to the
// `value` attribute on the underlying element.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'value')) {
  Object.defineProperty(ElementProto, 'value', {
    get() { return this.getAttribute('value') || ''; },
    set(v) { this.setAttribute('value', String(v)); },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'min')) {
  Object.defineProperty(ElementProto, 'min', {
    get() { return this.getAttribute('min') || ''; },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'max')) {
  Object.defineProperty(ElementProto, 'max', {
    get() { return this.getAttribute('max') || ''; },
  });
}

// --- HTMLImageElement props (.complete / .naturalWidth) -------------
// art.js → applyTint() reads imgElement.complete + .naturalWidth before
// scheduling the canvas sample. xmldom doesn't supply them; default to
// "not loaded" so the canvas read is bypassed (it would no-op anyway —
// document.querySelector('.np-view') exists in our shim, but there's
// no canvas getContext).
if (!Object.getOwnPropertyDescriptor(ElementProto, 'complete')) {
  Object.defineProperty(ElementProto, 'complete', { get() { return false; } });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'naturalWidth')) {
  Object.defineProperty(ElementProto, 'naturalWidth', { get() { return 0; } });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'src')) {
  Object.defineProperty(ElementProto, 'src', {
    get() { return this.getAttribute('src') || ''; },
    set(v) { this.setAttribute('src', String(v)); },
  });
}

// --- window / location / fetch stubs --------------------------------

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

// Stub fetch — every code path under polling / preset assign must not
// hit the network in tests. Resolves to a 'never' Promise so polling
// stays idle and never lands.
globalThis.fetch = () => new Promise(() => {});

// Stub timers we want to advance manually; the view uses raw setTimeout
// for long-press + polling. We leave the global setTimeout in place but
// manually flush the long-press timer by jumping forward.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// document.hidden + visibilitychange — present so the visibility hook
// installs without throwing.
Object.defineProperty(doc, 'hidden', { get() { return true; } });
doc.addEventListener = function () {};
doc.removeEventListener = function () {};

function ev(type, init = {}) {
  return Object.assign({
    type,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  }, init);
}

// --- imports under test ---------------------------------------------

const { store } = await import('../app/state.js');
const actions = await import('../app/actions/index.js');
const nowPlayingView = (await import('../app/views/now-playing.js')).default;

// Reset relevant store keys before each test.
function setSpeakerState(patch) {
  store.update('speaker', (s) => {
    Object.assign(s.speaker, {
      info: null,
      nowPlaying: null,
      presets: null,
      volume: null,
      sources: null,
    }, patch);
  });
}

function mountView() {
  const root = doc.createElement('section');
  const destroy = nowPlayingView.init(root, store, {});
  return { root, destroy };
}

// --- tests ----------------------------------------------------------

test('source switcher: renders one button per READY source from state', () => {
  setSpeakerState({
    sources: [
      { source: 'TUNEIN',   sourceAccount: '',         status: 'READY',       isLocal: false, displayName: 'TuneIn' },
      { source: 'AUX',      sourceAccount: 'AUX',      status: 'READY',       isLocal: true,  displayName: 'AUX' },
      { source: 'BLUETOOTH',sourceAccount: '',         status: 'UNAVAILABLE', isLocal: true,  displayName: 'Bluetooth' },
      { source: 'SPOTIFY',  sourceAccount: 'a-1',      status: 'READY',       isLocal: false, displayName: 'Spotify' },
      { source: 'AMAZON',   sourceAccount: 'amzn-1',   status: 'NOT_CONFIGURED', isLocal: false, displayName: 'Amazon' },
    ],
    nowPlaying: { source: 'SPOTIFY' },
  });

  const { root, destroy } = mountView();
  try {
    const pills = root.querySelectorAll('.np-source-pill');
    assert.equal(pills.length, 3, 'only the three READY sources render');
    const sources = pills.map((p) => p.getAttribute('data-source')).sort();
    assert.deepEqual(sources, ['AUX', 'SPOTIFY', 'TUNEIN']);
    const active = pills.find((p) => p.getAttribute('data-active') === 'true');
    assert.ok(active, 'the active pill is marked');
    assert.equal(active.getAttribute('data-source'), 'SPOTIFY');
  } finally {
    destroy();
  }
});

test('source switcher: no hardcoded list — arbitrary sources flow through', () => {
  setSpeakerState({
    sources: [
      { source: 'RADIOPLAYER',         sourceAccount: '', status: 'READY', isLocal: false, displayName: 'Radioplayer' },
      { source: 'LOCAL_INTERNET_RADIO',sourceAccount: '', status: 'READY', isLocal: false, displayName: '' },
      { source: 'ALEXA',               sourceAccount: 'x',status: 'READY', isLocal: false, displayName: 'Alexa' },
    ],
  });

  const { root, destroy } = mountView();
  try {
    const pills = root.querySelectorAll('.np-source-pill');
    assert.equal(pills.length, 3, 'every READY source renders, even uncommon ones');
    // Empty displayName falls back to humanised key.
    const localRadio = pills.find((p) => p.getAttribute('data-source') === 'LOCAL_INTERNET_RADIO');
    assert.ok(localRadio, 'unknown sources still render a pill');
    assert.equal(localRadio.textContent, 'Local Internet Radio',
      'humaniseSourceKey kicks in when displayName is empty');
  } finally {
    destroy();
  }
});

test('preset cards: render in a 3-column grid container', () => {
  setSpeakerState({
    presets: Array.from({ length: 6 }, (_, i) => ({
      slot: i + 1,
      empty: false,
      itemName: `Station ${i + 1}`,
      source: 'TUNEIN',
      location: `s${1000 + i}`,
    })),
  });

  const { root, destroy } = mountView();
  try {
    const grid = root.querySelector('.np-presets-grid');
    assert.ok(grid, 'the new 3-col grid container is mounted');
    const presets = root.querySelectorAll('.np-preset');
    assert.equal(presets.length, 6, 'still six preset slots');
    // Each non-empty preset gets a deterministic hashHue token.
    const hue = presets[0].style.getPropertyValue('--np-preset-hue');
    assert.ok(/^\d+$/.test(hue), `--np-preset-hue should be a number, got ${hue}`);
  } finally {
    destroy();
  }
});

test('long-press on a preset navigates to #/preset/N', async () => {
  setSpeakerState({
    presets: [
      { slot: 1, empty: false, itemName: 'KEXP', source: 'TUNEIN', location: 's12345' },
      { slot: 2, empty: true },
      { slot: 3, empty: true },
      { slot: 4, empty: true },
      { slot: 5, empty: true },
      { slot: 6, empty: true },
    ],
  });

  globalThis.location.hash = '#/';

  const { root, destroy } = mountView();
  try {
    const preset1 = root.querySelector('.np-preset');
    preset1.dispatchEvent(ev('pointerdown', { button: 0 }));
    // The view fires location.hash assignment after LONG_PRESS_MS (600).
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(globalThis.location.hash, '#/preset/1', 'long-press routes to the modal');
  } finally {
    globalThis.location.hash = '#/';
    destroy();
  }
});

test('equalizer carries data-state="playing" only when nowPlaying is PLAY_STATE', () => {
  setSpeakerState({
    nowPlaying: { source: 'TUNEIN', item: { name: 'KEXP' }, playStatus: 'PAUSE_STATE' },
  });

  const { root, destroy } = mountView();
  try {
    const eq = root.querySelector('.equalizer');
    assert.ok(eq, 'the equalizer wrapper is mounted');
    assert.equal(eq.getAttribute('data-state'), null,
      'paused → no data-state attribute');

    store.update('speaker', (s) => {
      s.speaker.nowPlaying = { source: 'TUNEIN', item: { name: 'KEXP' }, playStatus: 'PLAY_STATE' };
    });
    assert.equal(eq.getAttribute('data-state'), 'playing',
      'play → data-state="playing" toggled in place');
  } finally {
    destroy();
  }
});

test('STANDBY: card hidden, asleep panel shown', () => {
  setSpeakerState({
    nowPlaying: { source: 'STANDBY' },
  });

  const { root, destroy } = mountView();
  try {
    const card = root.querySelector('.np-card');
    const asleep = root.querySelector('.np-asleep');
    assert.ok(card, 'card present');
    assert.ok(asleep, 'asleep panel present');
    assert.equal(card.hidden, true, 'card is hidden in STANDBY');
    assert.equal(asleep.hidden, false, 'asleep panel is shown');
  } finally {
    destroy();
  }
});

test('now-playing card: mono metadata pill rides next to the equalizer', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'KEXP', type: 'stationurl' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const metaRow = root.querySelector('.np-meta-row');
    assert.ok(metaRow, 'meta row container exists');
    const eq = metaRow.querySelector('.np-eq-slot');
    const meta = metaRow.querySelector('.np-meta');
    assert.ok(eq, 'equalizer slot present in meta row');
    assert.ok(meta, 'mono metadata pill present in meta row');
    assert.ok(meta.textContent.includes('TUNEIN'),
      `meta should include source key, got ${meta.textContent}`);
    assert.equal(meta.hidden, false,
      'meta pill is visible when nowPlaying carries source/type');
  } finally {
    destroy();
  }
});

test('preset cards: every cell carries a deterministic gradient hue', () => {
  setSpeakerState({
    presets: [
      { slot: 1, empty: false, itemName: 'KEXP', source: 'TUNEIN', location: 's1' },
      { slot: 2, empty: true },
      { slot: 3, empty: false, itemName: 'BBC 6', source: 'TUNEIN', location: 's2' },
      { slot: 4, empty: true },
      { slot: 5, empty: true },
      { slot: 6, empty: true },
    ],
  });

  const { root, destroy } = mountView();
  try {
    const presets = root.querySelectorAll('.np-preset');
    assert.equal(presets.length, 6, 'six preset cells');
    // Both occupied AND empty slots get a deterministic hue so the grid
    // stays visually consistent (empty cells are desaturated by CSS).
    for (let i = 0; i < presets.length; i++) {
      const hue = presets[i].style.getPropertyValue('--np-preset-hue');
      assert.ok(/^\d+$/.test(hue),
        `preset ${i + 1} should carry --np-preset-hue, got ${hue}`);
    }
    // Empty cells render no station-name string.
    const emptyCell = presets[1];
    const emptyName = emptyCell.querySelector('.np-preset-name');
    assert.equal(emptyName.textContent, '',
      'empty preset cell renders a blank label slot');
  } finally {
    destroy();
  }
});

test('actions.playPreset: returns silently when the slot is empty', async () => {
  setSpeakerState({
    presets: [
      { slot: 1, empty: true },
      { slot: 2, empty: true },
      { slot: 3, empty: true },
      { slot: 4, empty: true },
      { slot: 5, empty: true },
      { slot: 6, empty: true },
    ],
  });

  // fetch is stubbed to never resolve — if playPreset reaches the wire,
  // the await below will hang indefinitely. Resolving here proves it
  // short-circuited on the empty slot.
  const result = await actions.playPreset(1);
  assert.equal(result, undefined, 'empty slot resolves to undefined');

  // Out-of-range slot (no preset entry) likewise returns silently.
  setSpeakerState({ presets: null });
  const noPresets = await actions.playPreset(1);
  assert.equal(noPresets, undefined, 'missing presets list resolves to undefined');
});

// --- buffering glyph + Prev/Next classifier wiring (#88) ------------

test('np play button: BUFFERING_STATE → buffer glyph + data-phase="buffering"', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Fresh Air', location: '/v1/playback/station/p17' },
      playStatus: 'BUFFERING_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const btnPlay = root.querySelector('.np-btn--play');
    assert.ok(btnPlay, 'play button mounted');
    assert.equal(btnPlay.getAttribute('data-phase'), 'buffering');
    assert.equal(btnPlay.getAttribute('aria-busy'), 'true');
    // Buffer glyph has 3 circles (three-dot indicator).
    const svg = btnPlay.getElementsByTagName('svg').item(0);
    assert.equal(svg.getElementsByTagName('circle').length, 3,
      'buffer glyph: three circles');
  } finally {
    destroy();
  }
});

test('np play button: PLAY_STATE → pause glyph, data-phase="playing"', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'KEXP', location: '/v1/playback/station/s12345' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const btnPlay = root.querySelector('.np-btn--play');
    assert.equal(btnPlay.getAttribute('data-phase'), 'playing');
    assert.equal(btnPlay.getAttribute('aria-busy'), null);
    const svg = btnPlay.getElementsByTagName('svg').item(0);
    assert.equal(svg.getElementsByTagName('rect').length, 2,
      'pause glyph: two rects');
  } finally {
    destroy();
  }
});

test('np play button: STOP_STATE with no item → data-phase="idle", play glyph', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: '', location: '' },
      playStatus: 'STOP_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const btnPlay = root.querySelector('.np-btn--play');
    assert.equal(btnPlay.getAttribute('data-phase'), 'idle');
    const svg = btnPlay.getElementsByTagName('svg').item(0);
    // Play glyph is a single polygon.
    assert.equal(svg.getElementsByTagName('polygon').length, 1);
  } finally {
    destroy();
  }
});

test('np play button: tap during BUFFERING is a no-op (re-entrancy guard)', async () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Fresh Air', location: '/v1/playback/station/p17' },
      playStatus: 'BUFFERING_STATE',
    },
  });

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    calls.push(String(opts && opts.body));
    return { ok: true, status: 200 };
  };

  const { root, destroy } = mountView();
  try {
    const btnPlay = root.querySelector('.np-btn--play');
    btnPlay.dispatchEvent(ev('click'));
    await new Promise((r) => setTimeout(r, 10));
    const playPauseHits = calls.filter((b) => /PLAY|PAUSE/.test(b));
    assert.equal(playPauseHits.length, 0,
      `tapping the buffering control must not emit a PLAY/PAUSE key, got ${JSON.stringify(playPauseHits)}`);
  } finally {
    globalThis.fetch = realFetch;
    destroy();
  }
});

test('np Prev/Next: TUNEIN station → both disabled (no skip)', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'SWR3', location: '/v1/playback/station/s24896' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const btnPrev = root.querySelector('.np-btn--prev');
    const btnNext = root.querySelector('.np-btn--next');
    assert.equal(btnPrev.disabled, true, 'Prev disabled for station');
    assert.equal(btnNext.disabled, true, 'Next disabled for station');
  } finally {
    destroy();
  }
});

test('np Prev/Next: TUNEIN show (p-prefix) → both disabled', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Fresh Air', location: '/v1/playback/station/p17' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const btnPrev = root.querySelector('.np-btn--prev');
    const btnNext = root.querySelector('.np-btn--next');
    assert.equal(btnPrev.disabled, true);
    assert.equal(btnNext.disabled, true);
  } finally {
    destroy();
  }
});

test('np Prev/Next: BLUETOOTH → both enabled (firmware-key path)', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'BLUETOOTH',
      item: { name: 'iPhone', location: '' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const btnPrev = root.querySelector('.np-btn--prev');
    const btnNext = root.querySelector('.np-btn--next');
    assert.equal(btnPrev.disabled, false, 'Prev enabled for BLUETOOTH');
    assert.equal(btnNext.disabled, false, 'Next enabled for BLUETOOTH');
    assert.equal(btnPrev.getAttribute('data-transport-mode'), 'firmware');
  } finally {
    destroy();
  }
});

test('np Prev/Next: STANDBY → both disabled', () => {
  setSpeakerState({
    nowPlaying: { source: 'STANDBY' },
  });

  const { root, destroy } = mountView();
  try {
    const btnPrev = root.querySelector('.np-btn--prev');
    const btnNext = root.querySelector('.np-btn--next');
    assert.equal(btnPrev.disabled, true);
    assert.equal(btnNext.disabled, true);
  } finally {
    destroy();
  }
});

test('np Prev/Next: TUNEIN topic with cached parent + ≥2 siblings → enabled', async () => {
  // Prime the cache before mounting so syncPrevNext picks it up.
  const tc = await import('../app/tunein-cache.js');
  tc.cache.set('tunein.parent.t200', 'p17', tc.TTL_LABEL);
  tc.cache.set('tunein.topics.p17', ['t100', 't200', 't300'], tc.TTL_DRILL_HEAD);

  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Episode 2', location: '/v1/playback/station/t200' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    const btnPrev = root.querySelector('.np-btn--prev');
    const btnNext = root.querySelector('.np-btn--next');
    assert.equal(btnPrev.disabled, false, 'Prev enabled mid-list');
    assert.equal(btnNext.disabled, false, 'Next enabled mid-list');
    assert.equal(btnPrev.getAttribute('data-transport-mode'), 'topic-list');
  } finally {
    tc.cache.invalidate('tunein.parent.t200');
    tc.cache.invalidate('tunein.topics.p17');
    destroy();
  }
});

test('np Prev/Next: topic at first index → Prev disabled, Next enabled', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.set('tunein.parent.t100', 'p17', tc.TTL_LABEL);
  tc.cache.set('tunein.topics.p17', ['t100', 't200', 't300'], tc.TTL_DRILL_HEAD);

  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Episode 1', location: '/v1/playback/station/t100' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    assert.equal(root.querySelector('.np-btn--prev').disabled, true);
    assert.equal(root.querySelector('.np-btn--next').disabled, false);
  } finally {
    tc.cache.invalidate('tunein.parent.t100');
    tc.cache.invalidate('tunein.topics.p17');
    destroy();
  }
});

test('np Prev/Next: topic at last index → Next disabled, Prev enabled', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.set('tunein.parent.t300', 'p17', tc.TTL_LABEL);
  tc.cache.set('tunein.topics.p17', ['t100', 't200', 't300'], tc.TTL_DRILL_HEAD);

  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Episode 3', location: '/v1/playback/station/t300' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    assert.equal(root.querySelector('.np-btn--prev').disabled, false);
    assert.equal(root.querySelector('.np-btn--next').disabled, true);
  } finally {
    tc.cache.invalidate('tunein.parent.t300');
    tc.cache.invalidate('tunein.topics.p17');
    destroy();
  }
});

test('np Prev/Next: topic with cached parent but only 1 sibling → disabled', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.set('tunein.parent.t100', 'p38913', tc.TTL_LABEL);
  tc.cache.set('tunein.topics.p38913', ['t100'], tc.TTL_DRILL_HEAD);

  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Only', location: '/v1/playback/station/t100' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    assert.equal(root.querySelector('.np-btn--prev').disabled, true,
      'Prev disabled when topics list has 1 entry');
    assert.equal(root.querySelector('.np-btn--next').disabled, true,
      'Next disabled when topics list has 1 entry');
  } finally {
    tc.cache.invalidate('tunein.parent.t100');
    tc.cache.invalidate('tunein.topics.p38913');
    destroy();
  }
});

test('np Prev/Next: topic without cached parent → disabled (defence-in-depth)', () => {
  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Orphan', location: '/v1/playback/station/t999' },
      playStatus: 'PLAY_STATE',
    },
  });

  const { root, destroy } = mountView();
  try {
    assert.equal(root.querySelector('.np-btn--prev').disabled, true);
    assert.equal(root.querySelector('.np-btn--next').disabled, true);
  } finally {
    destroy();
  }
});

test('np Prev/Next: topic-list tap calls /play with neighbour id', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.set('tunein.parent.t200', 'p17', tc.TTL_LABEL);
  tc.cache.set('tunein.topics.p17', ['t100', 't200', 't300'], tc.TTL_DRILL_HEAD);

  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Episode 2', location: '/v1/playback/station/t200' },
      playStatus: 'PLAY_STATE',
    },
  });

  // Capture fetch calls; resolve /play with ok:true.
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: 'http://example/stream.mp3' }),
    };
  };

  const { root, destroy } = mountView();
  try {
    const btnNext = root.querySelector('.np-btn--next');
    assert.equal(btnNext.disabled, false, 'Next is enabled mid-list');
    btnNext.dispatchEvent(ev('click'));
    // Drain the await chain.
    await new Promise((r) => setTimeout(r, 30));
    const playCalls = calls.filter((c) => /\/play\b/.test(c.url));
    assert.ok(playCalls.length >= 1,
      `expected at least one /play POST, got ${JSON.stringify(calls.map((c) => c.url))}`);
    const body = String(playCalls[0].body || '');
    assert.ok(body.includes('"id":"t300"'),
      `Next should /play the t300 neighbour, body=${body}`);
    // The topic-list path must NOT also fire a NEXT_TRACK key.
    const keyCalls = calls.filter((c) => /NEXT_TRACK|PREV_TRACK/.test(String(c.body || '')));
    assert.equal(keyCalls.length, 0,
      'topic-list path intercepts the firmware key entirely');
  } finally {
    globalThis.fetch = realFetch;
    tc.cache.invalidate('tunein.parent.t200');
    tc.cache.invalidate('tunein.topics.p17');
    destroy();
  }
});

test('np Prev/Next: lazy-fetches topics list when parent cached but list missing', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.set('tunein.parent.t200', 'p17', tc.TTL_LABEL);
  // No topics list cached — the skip handler should lazy-fetch.
  tc.cache.invalidate('tunein.topics.p17');

  setSpeakerState({
    nowPlaying: {
      source: 'TUNEIN',
      item: { name: 'Episode 2', location: '/v1/playback/station/t200' },
      playStatus: 'PLAY_STATE',
    },
  });

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, body: opts && opts.body });
    if (u.includes('/tunein/browse') && u.includes('c=topics')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          head: { status: '200' },
          body: [
            { type: 'link', item: 'topic', guide_id: 't100',
              URL: 'Tune.ashx?id=t100&sid=p17' },
            { type: 'link', item: 'topic', guide_id: 't200',
              URL: 'Tune.ashx?id=t200&sid=p17' },
            { type: 'link', item: 'topic', guide_id: 't300',
              URL: 'Tune.ashx?id=t300&sid=p17' },
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: 'http://example/stream.mp3' }),
    };
  };

  // Initial mount: Prev/Next disabled because no list cached. Force-
  // enable for the click by writing a transient list — the test's job
  // is to verify the lazy refetch fires when the cache empties between
  // syncs. Simpler path: stage a Prev with the cache primed, then
  // delete the topics list right before click. The button stays
  // enabled (state set at sync) but the click handler must refetch.
  tc.cache.set('tunein.topics.p17', ['t100', 't200', 't300'], tc.TTL_DRILL_HEAD);

  const { root, destroy } = mountView();
  try {
    // Drop the topics list to force the lazy refetch path inside onSkip.
    tc.cache.invalidate('tunein.topics.p17');

    const btnNext = root.querySelector('.np-btn--next');
    btnNext.dispatchEvent(ev('click'));
    await new Promise((r) => setTimeout(r, 30));

    const topicsCalls = calls.filter((c) => c.url.includes('c=topics') && c.url.includes('p17'));
    assert.ok(topicsCalls.length >= 1,
      'lazy fetch fires when the topics list isn\'t cached at click time');
  } finally {
    globalThis.fetch = realFetch;
    tc.cache.invalidate('tunein.parent.t200');
    tc.cache.invalidate('tunein.topics.p17');
    destroy();
  }
});

test('volume slider: WS-driven re-render mutates in place (focus survives)', () => {
  setSpeakerState({
    volume: { targetVolume: 30, actualVolume: 30, muteEnabled: false },
  });

  const { root, destroy } = mountView();
  try {
    const sliderBefore = root.querySelector('.np-slider');
    assert.ok(sliderBefore, 'slider is mounted');
    assert.equal(sliderBefore.value, '30');

    // Simulate user focus and a WS volume update.
    sliderBefore.focus();
    assert.equal(globalThis.__focus_target__, sliderBefore, 'focus tracker is set');

    store.update('speaker', (s) => {
      s.speaker.volume = { targetVolume: 55, actualVolume: 55, muteEnabled: false };
    });

    const sliderAfter = root.querySelector('.np-slider');
    assert.equal(sliderAfter, sliderBefore,
      'WS update mutates the same slider node — never replaces it');
    assert.equal(sliderAfter.value, '55', 'value updated in place');
    assert.equal(globalThis.__focus_target__, sliderBefore,
      'focus reference still points at the original slider node');
  } finally {
    destroy();
  }
});
