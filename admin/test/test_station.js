// Tests for app/views/station.js — the v2 station-detail re-skin (#60).
//
// Covers the new layout:
//   - 3×2 preset grid (6 cells) replaces the inline 6-button row
//   - cells show slot number, occupant name, optional genre tag
//   - full-width gradient Play CTA replaces the per-stream audition
//     buttons; preserves the existing previewStream callsite
//   - probe-state branching (playable / gated / dark) untouched
//   - no debug strings ("/mnt/nv/resolver/", "writes to") leak into the DOM
//
// Strategy: stub the network surface (globalThis.fetch + probe deps) so
// the view runs end-to-end without touching anything real. The view is
// driven via its public defineView shell so subscriptions and cleanup
// also exercise the production wiring.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation } from '@xmldom/xmldom';

// ---------------------------------------------------------------------
// DOM shim. xmldom doesn't ship classList, dataset, querySelector*,
// addEventListener, or NodeFilter — patch just enough on Element/Document
// for the view to mount and the test to inspect the result.

const doc = new DOMImplementation().createDocument(null, null, null);
if (!doc.documentElement) {
  const html = doc.createElement('html');
  doc.appendChild(html);
}
if (!doc.documentElement.dataset) doc.documentElement.dataset = {};
const _body = doc.createElement('body');
doc.documentElement.appendChild(_body);
doc.body = _body;
doc.getElementById = function (id) {
  function walk(n) {
    if (n.nodeType === 1 && n.getAttribute && n.getAttribute('id') === id) return n;
    const kids = n.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const hit = walk(kids[i]);
      if (hit) return hit;
    }
    return null;
  }
  return walk(doc.documentElement);
};
globalThis.document = doc;

// NodeFilter constants — html`` walks comments via createTreeWalker.
if (typeof globalThis.NodeFilter === 'undefined') {
  globalThis.NodeFilter = { SHOW_COMMENT: 0x80 };
}
// Constructor reference — html`` checks `value instanceof Node`.
const _probe = doc.createElement('div');
let _NodeProto = Object.getPrototypeOf(_probe);
while (_NodeProto && _NodeProto !== Object.prototype) {
  // walk up to the lowest prototype that owns nodeType — that's the
  // closest thing xmldom has to a Node base class.
  if (Object.getOwnPropertyDescriptor(_NodeProto, 'nodeType')) break;
  _NodeProto = Object.getPrototypeOf(_NodeProto);
}
if (typeof globalThis.Node === 'undefined') {
  globalThis.Node = function Node() {};
  globalThis.Node.prototype = _NodeProto || Object.prototype;
}

const _sample = doc.createElement('span');
const ElementProto = Object.getPrototypeOf(_sample);

// xmldom doesn't expose .className/.id/.disabled/.type/.textContent
// setters that mirror their attributes. Patch them so the view's
// imperative DOM construction works.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'id')) {
  Object.defineProperty(ElementProto, 'id', {
    get() { return this.getAttribute('id') || ''; },
    set(v) { this.setAttribute('id', String(v)); },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'className')) {
  Object.defineProperty(ElementProto, 'className', {
    get() { return this.getAttribute('class') || ''; },
    set(v) { this.setAttribute('class', String(v)); },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'disabled')) {
  Object.defineProperty(ElementProto, 'disabled', {
    get() { return this.hasAttribute && this.hasAttribute('disabled'); },
    set(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute && this.removeAttribute('disabled'); },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'type')) {
  Object.defineProperty(ElementProto, 'type', {
    get() { return this.getAttribute('type') || ''; },
    set(v) { this.setAttribute('type', String(v)); },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'href')) {
  Object.defineProperty(ElementProto, 'href', {
    get() { return this.getAttribute('href') || ''; },
    set(v) { this.setAttribute('href', String(v)); },
  });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'style')) {
  Object.defineProperty(ElementProto, 'style', {
    get() {
      const el = this;
      return new Proxy({}, {
        set(_t, prop, val) {
          // Naive serialization: collect all proxied sets into the
          // single `style` attribute, kebab-cased and joined with ; .
          const cur = parseStyle(el.getAttribute('style') || '');
          cur[String(prop)] = String(val);
          el.setAttribute('style', stringifyStyle(cur));
          return true;
        },
        get(_t, prop) {
          const cur = parseStyle(el.getAttribute('style') || '');
          return cur[String(prop)] || '';
        },
      });
    },
  });
}
function parseStyle(s) {
  const out = {};
  for (const part of String(s).split(';')) {
    const [k, ...rest] = part.split(':');
    if (!k || !rest.length) continue;
    const camel = k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = rest.join(':').trim();
  }
  return out;
}
function stringifyStyle(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}: ${v}`)
    .join('; ');
}

if (!Object.getOwnPropertyDescriptor(ElementProto, 'textContent')) {
  // xmldom usually has it, but defend the lookup just in case.
  Object.defineProperty(ElementProto, 'textContent', {
    get() {
      let out = '';
      const walk = (n) => {
        if (n.nodeType === 3) out += n.nodeValue || '';
        const k = n.childNodes || [];
        for (let i = 0; i < k.length; i++) walk(k[i]);
      };
      walk(this);
      return out;
    },
    set(v) {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.appendChild(doc.createTextNode(String(v == null ? '' : v)));
    },
  });
}

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

if (!ElementProto.dataset) {
  Object.defineProperty(ElementProto, 'dataset', {
    get() {
      const el = this;
      return new Proxy({}, {
        get(_t, key)   { return el.getAttribute('data-' + camelToKebab(key)) || undefined; },
        set(_t, key, v) { el.setAttribute('data-' + camelToKebab(key), String(v)); return true; },
      });
    },
  });
}

function camelToKebab(s) {
  return String(s).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
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

// xmldom omits insertAdjacentElement; the view uses 'afterend'.
if (!ElementProto.insertAdjacentElement) {
  ElementProto.insertAdjacentElement = function (where, el) {
    if (where === 'afterend') {
      if (this.parentNode) {
        if (this.nextSibling) this.parentNode.insertBefore(el, this.nextSibling);
        else this.parentNode.appendChild(el);
      }
    } else if (where === 'beforebegin') {
      if (this.parentNode) this.parentNode.insertBefore(el, this);
    } else if (where === 'afterbegin') {
      if (this.firstChild) this.insertBefore(el, this.firstChild);
      else this.appendChild(el);
    } else if (where === 'beforeend') {
      this.appendChild(el);
    }
    return el;
  };
}

// xmldom's <template>.innerHTML doesn't auto-parse into .content; the
// dom.js html`` helper relies on that. Provide a lazy parser.
const NodeProto = Object.getPrototypeOf(doc);
if (!Object.getOwnPropertyDescriptor(NodeProto, 'createTreeWalker')) {
  NodeProto.createTreeWalker = function (root, what) {
    const queue = [];
    function walk(n) {
      if (what === globalThis.NodeFilter.SHOW_COMMENT && n.nodeType === 8) queue.push(n);
      const kids = n.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    }
    for (const k of root.childNodes || []) walk(k);
    let i = -1;
    return { nextNode() { i++; return queue[i] || null; } };
  };
}

// Replace document.createElement('template') so .innerHTML triggers parse.
const _origCreate = doc.createElement.bind(doc);
doc.createElement = function (tag) {
  if (String(tag).toLowerCase() === 'template') {
    const frag = doc.createDocumentFragment();
    const tpl = _origCreate('template');
    Object.defineProperty(tpl, 'content', {
      get() { return frag; },
      configurable: true,
    });
    Object.defineProperty(tpl, 'innerHTML', {
      set(html) {
        // Naive HTML-to-fragment via xmldom's parser by wrapping in a
        // root element. This is enough for the small templates used by
        // station.js's renderSkeleton.
        const { DOMParser } = require('@xmldom/xmldom');
        const parser = new DOMParser({ onError() {} });
        const wrapped = parser.parseFromString('<root>' + html + '</root>', 'text/html');
        const root = wrapped.documentElement;
        while (root.firstChild) frag.appendChild(root.firstChild);
      },
      configurable: true,
    });
    return tpl;
  }
  return _origCreate(tag);
};

// CommonJS require shim for the DOMParser import above.
if (typeof globalThis.require === 'undefined') {
  const { createRequire } = await import('node:module');
  globalThis.require = createRequire(import.meta.url);
}

// querySelector / querySelectorAll for the assertions. Selector grammar
// is limited (#id, .class, tag, [attr=val], descendant), which is all
// the view + tests use.
const QSAll = function (sel) {
  return collectMatching(this, parseSelectors(sel));
};
const QSOne = function (sel) {
  return collectMatching(this, parseSelectors(sel))[0] || null;
};
if (!ElementProto.querySelector) {
  ElementProto.querySelector = QSOne;
  ElementProto.querySelectorAll = QSAll;
}
// xmldom's DocumentFragment is a separate prototype; dom.js html`` walks
// tpl.content, so it needs querySelectorAll too.
const _frag = doc.createDocumentFragment();
const FragProto = Object.getPrototypeOf(_frag);
if (!FragProto.querySelector) {
  FragProto.querySelector = QSOne;
  FragProto.querySelectorAll = QSAll;
}
if (!doc.querySelector) {
  doc.querySelector = function (sel) {
    return doc.documentElement ? doc.documentElement.querySelector(sel) : null;
  };
}

function parseSelectors(sel) {
  return String(sel).split(',').map((s) => s.trim()).map((s) => s.split(/\s+/).map(parseStep));
}

function parseStep(step) {
  // [attr=val] / [attr]
  const out = { tag: '*', classes: [], attrs: [] };
  let s = step;
  // pull off attrs
  s = s.replace(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_, k, q, q2, raw) => {
    out.attrs.push({ k, v: q != null ? q : q2 != null ? q2 : raw != null ? raw : null });
    return '';
  });
  // classes
  s = s.replace(/\.([\w-]+)/g, (_, c) => { out.classes.push(c); return ''; });
  // tag
  if (s) out.tag = s.toLowerCase();
  return out;
}

function nodeMatches(n, step) {
  if (n.nodeType !== 1) return false;
  if (step.tag !== '*' && n.tagName.toLowerCase() !== step.tag) return false;
  const cls = (n.getAttribute && n.getAttribute('class') || '').split(/\s+/);
  for (const c of step.classes) if (!cls.includes(c)) return false;
  for (const { k, v } of step.attrs) {
    const got = n.getAttribute && n.getAttribute(k);
    if (v == null) { if (got == null) return false; }
    else if (String(got) !== String(v)) return false;
  }
  return true;
}

function collectMatching(root, selectorList) {
  const out = [];
  function visit(n) {
    if (n.nodeType === 1) {
      for (const steps of selectorList) {
        if (descendantMatch(n, steps)) { out.push(n); break; }
      }
    }
    // Descend through elements AND DocumentFragments (xmldom appendChild
    // keeps fragments as children rather than splicing — walk through.)
    if (n.nodeType === 1 || n.nodeType === 11 || n.nodeType === 9) {
      const kids = n.childNodes || [];
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
    }
  }
  const startKids = root.childNodes || [];
  for (let i = 0; i < startKids.length; i++) visit(startKids[i]);
  return out;
}

function descendantMatch(node, steps) {
  // last step must match the node itself; walk up checking earlier steps
  // appear in any ancestor in order.
  if (!nodeMatches(node, steps[steps.length - 1])) return false;
  let p = node.parentNode;
  for (let i = steps.length - 2; i >= 0; i--) {
    while (p && !(p.nodeType === 1 && nodeMatches(p, steps[i]))) p = p.parentNode;
    if (!p) return false;
    p = p.parentNode;
  }
  return true;
}

// replaceChildren — used by mount() in dom.js.
if (!ElementProto.replaceChildren) {
  ElementProto.replaceChildren = function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (const n of nodes) {
      if (n == null) continue;
      this.appendChild(n);
    }
  };
}

// dom.js calls .replaceWith / .remove on comment + text nodes. Walk
// every prototype above a sample comment node to find the closest
// owner that lacks these methods, then patch on Element & Node-level
// prototypes so all child types inherit.
const _patchTargets = new Set();
const _commentNode = doc.createComment('x');
for (let p = Object.getPrototypeOf(_commentNode); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
  _patchTargets.add(p);
}
for (let p = Object.getPrototypeOf(_sample); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
  _patchTargets.add(p);
}
for (const p of _patchTargets) {
  if (typeof p.replaceWith !== 'function') {
    p.replaceWith = function (node) {
      if (this.parentNode) this.parentNode.replaceChild(node, this);
    };
  }
  if (typeof p.remove !== 'function') {
    p.remove = function () {
      if (this.parentNode) this.parentNode.removeChild(this);
    };
  }
}

// The view reads .textContent — xmldom supports it; just ensure setter
// for elements without children works.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'firstChild')) {
  // present already
}

// Stub globalThis.fetch to a never-resolving promise; the probe + tunein
// network paths are otherwise driven via probe._setDeps below.
globalThis.fetch = function () { return new Promise(() => {}); };

// localStorage stub for state.js.
const _ls = new Map();
globalThis.localStorage = {
  getItem(k)   { return _ls.has(k) ? _ls.get(k) : null; },
  setItem(k, v) { _ls.set(k, String(v)); },
  removeItem(k) { _ls.delete(k); },
};

// Now the modules under test.
const { default: stationView } = await import('../app/views/station.js');
const { _setDeps } = await import('../app/probe.js');
const { store } = await import('../app/state.js');
const { readFile } = await import('node:fs/promises');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const TUNEIN_FIXTURE = JSON.parse(await readFile(join(FIXTURES, 's12345.tunein.json'), 'utf8'));

const PROBE_PLAYABLE = {
  sid: 's12345',
  verdict: {
    kind: 'playable',
    streams: [
      { streamUrl: 'http://streams.example.de/live/hqlivestream.aac', bitrate: 168, media_type: 'aac', reliability: 99 },
      { streamUrl: 'http://streams.example.de/live/livestream.mp3',   bitrate: 128, media_type: 'mp3', reliability: 99 },
    ],
  },
  // Real Tune.ashx fixture so reshape() returns a Bose payload, which
  // is what the Play CTA test asserts on.
  tuneinJson: TUNEIN_FIXTURE,
  expires: Date.now() + 600000,
};
const PROBE_GATED = {
  sid: 's55555',
  verdict: { kind: 'gated', reason: 'no-streams' },
  tuneinJson: {}, expires: Date.now() + 600000,
};
const PROBE_DARK = {
  sid: 's99999',
  verdict: { kind: 'dark', reason: 'http-404' },
  tuneinJson: {}, expires: Date.now() + 600000,
};

function makeStoreStub() {
  // station.js imports the real store; for these tests we just reuse it
  // (it's an in-process singleton) and reset the bits we care about.
  store.state.speaker.presets = null;
  store.state.caches.probe.clear();
  return store;
}

function makeRoot() { return doc.createElement('div'); }

beforeEach(() => {
  makeStoreStub();
  _setDeps({
    tuneinProbe: async () => { throw new Error('tuneinProbe not stubbed'); },
    presetsAssign: async () => { throw new Error('presetsAssign not stubbed'); },
    setPresets: () => {},
  });
});

// Drive the view past its async fetches by seeding the probe cache so
// probe(sid) returns synchronously (cache hit), and by using a plain
// rendered skeleton + applying the verdict directly via a stubbed init.
async function mountWith(root, sid, probeEntry, presets) {
  store.state.caches.probe.set(sid, probeEntry);
  if (presets) store.state.speaker.presets = presets;
  const destroy = stationView.init(root, store, { params: { id: sid } });
  // Let the microtask + probe chain settle.
  await new Promise((r) => setTimeout(r, 5));
  return destroy;
}

// --- preset grid ----------------------------------------------------

test('station: preset grid renders 6 cells (3 columns × 2 rows)', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const grid = root.querySelector('.station-presets-grid');
  assert.ok(grid, 'grid container present');
  const cells = root.querySelectorAll('.station-preset-cell');
  assert.equal(cells.length, 6, 'six preset cells');
  destroy();
});

test('station: each cell shows slot number 1..6', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const slots = root.querySelectorAll('.station-preset-cell__slot');
  const numbers = Array.from(slots, (n) => n.textContent);
  assert.deepEqual(numbers, ['1', '2', '3', '4', '5', '6']);
  destroy();
});

test('station: empty cells show "Empty" placeholder', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { empty: true }, { empty: true }, { empty: true },
    { empty: true }, { empty: true }, { empty: true },
  ]);
  const occupants = root.querySelectorAll('.station-preset-cell__occupant');
  for (const o of occupants) assert.equal(o.textContent, 'Empty');
  destroy();
});

test('station: occupied cells show the station name', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { itemName: 'Klassik FM',  source: 'INTERNET_RADIO', location: 's11111' },
    { itemName: 'Jazz Live',   source: 'INTERNET_RADIO', location: 's22222' },
    { empty: true },
    { itemName: 'Hits 24/7',   source: 'INTERNET_RADIO', location: 's33333' },
    { empty: true },
    { empty: true },
  ]);
  const occupants = root.querySelectorAll('.station-preset-cell__occupant');
  const names = Array.from(occupants, (n) => n.textContent);
  assert.deepEqual(names, ['Klassik FM', 'Jazz Live', 'Empty', 'Hits 24/7', 'Empty', 'Empty']);
  destroy();
});

test('station: cell holding the current station gets the .is-current accent', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { empty: true },
    { itemName: 'Bo Test Stream', source: 'INTERNET_RADIO', location: 's12345' },
    { empty: true }, { empty: true }, { empty: true }, { empty: true },
  ]);
  const cells = root.querySelectorAll('.station-preset-cell');
  assert.equal(cells[1].classList.contains('is-current'), true, 'matching cell highlighted');
  assert.equal(cells[0].classList.contains('is-current'), false);
  destroy();
});

// --- test-play CTA --------------------------------------------------

test('station: full-width Play CTA appears on playable verdict', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const cta = root.querySelector('.station-test-play');
  assert.ok(cta, 'test-play CTA mounted');
  assert.equal(cta.dataset.testPlay, '1', 'data-test-play marker present');
  const sub = root.querySelector('.station-test-play__sub');
  assert.ok(sub, 'subtitle present');
  assert.equal(sub.textContent, 'Stream a test sample without saving');
  // Inline gradient style — driven by stationGradient(name).
  const style = cta.getAttribute('style') || '';
  assert.ok(/linear-gradient/.test(style), 'background gradient applied inline');
  destroy();
});

test('station: Play CTA label reads exactly "Play" (issue #82 rename)', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const labelEl = root.querySelector('.station-test-play__label');
  assert.ok(labelEl, 'CTA label slot present');
  assert.equal(labelEl.textContent, 'Play',
    'station-detail audition button label is the verb "Play"');
  destroy();
});

test('station: clicking Play calls previewStream with the chosen ContentItem', async () => {
  // Replace the api.previewStream call by intercepting via fetch — the
  // test-play handler eventually awaits previewStream({...}) which calls
  // fetch('/api/v1/preview'). Capture the body to assert the callsite.
  const root = makeRoot();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: {} }),
    };
  };

  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);
  const cta = root.querySelector('.station-test-play');
  // Synthesise click; the view attaches with addEventListener('click').
  cta.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  await new Promise((r) => setTimeout(r, 5));

  globalThis.fetch = realFetch;

  const previewCall = calls.find((c) => /\/preview$/.test(c.url));
  assert.ok(previewCall, 'previewStream POST issued (preserved callsite)');
  assert.equal(previewCall.opts.method, 'POST');
  const body = JSON.parse(previewCall.opts.body);
  assert.equal(body.id, 's12345', 'payload carries the station sid');
  assert.ok(body.json && body.json.audio, 'payload carries the Bose ContentItem JSON');
  destroy();
});

// --- debug-string regression ----------------------------------------

test('station: no debug strings ("/mnt/nv/resolver" / "writes to") leak into the DOM', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { itemName: 'A', source: 'INTERNET_RADIO', location: 's11111' },
    { empty: true }, { empty: true }, { empty: true }, { empty: true }, { empty: true },
  ]);
  const text = serialize(root);
  assert.equal(/\/mnt\/nv\/resolver/.test(text), false, 'no /mnt/nv/resolver in output');
  assert.equal(/writes to/i.test(text), false, 'no "writes to" in output');
  destroy();
});

// --- gated + dark message variants ----------------------------------

test('station: gated verdict renders the friendly message + More like this', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's55555', PROBE_GATED);

  const verdict = root.querySelector('.station-verdict');
  assert.ok(verdict.classList.contains('is-gated'), 'is-gated tone applied');
  assert.ok(/available from this client/i.test(verdict.textContent), 'gated message rendered');
  // Assign grid replaced by the more-like-this link.
  const more = root.querySelector('.station-more-like-this');
  assert.ok(more, 'More like this link present');
  assert.equal(more.getAttribute('href'), '#/browse');
  // No test-play CTA on gated.
  assert.equal(root.querySelector('.station-test-play'), null);
  destroy();
});

test('station: dark verdict renders the off-air message + More like this', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's99999', PROBE_DARK);

  const verdict = root.querySelector('.station-verdict');
  assert.ok(verdict.classList.contains('is-dark'), 'is-dark tone applied');
  assert.ok(/currently off-air/i.test(verdict.textContent), 'dark message rendered');
  const more = root.querySelector('.station-more-like-this');
  assert.ok(more, 'More like this link present');
  assert.equal(root.querySelector('.station-test-play'), null);
  destroy();
});

// ---------------------------------------------------------------------
// Helpers

function serialize(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType === 8) return ''; // comments
  let out = '';
  if (node.tagName) out += '<' + node.tagName.toLowerCase() + '>';
  const kids = node.childNodes || [];
  for (let i = 0; i < kids.length; i++) out += serialize(kids[i]);
  if (node.tagName) out += '</' + node.tagName.toLowerCase() + '>';
  return out;
}

