// Shared DOM shim for the admin view-tests.
//
// xmldom ships only the bits of the DOM the production code touches at
// build time — not classList, dataset, addEventListener, template
// parsing, style, NodeFilter, Node, getElementById, etc. Each view-test
// previously redeclared 60–110 lines of nearly-identical patches before
// its first assert. This module consolidates all of that:
//
//   import { doc, ElementProto, ev, installFetchNeverResolving,
//            installWindowAndLocation, installSessionStorage,
//            } from './fixtures/dom-shim.js';
//
// The import is side-effecting — touching it installs the shim on
// xmldom's shared Element / CharacterData prototypes and wires the
// returned `doc` onto globalThis.document. Subsequent in-file tweaks
// (per-test sessionStorage state, fetch stubs scoped to a single test,
// shell DOM teardown) compose on top.
//
// Every patch is guarded with an `if (!...)` so re-import in the same
// process is idempotent. node's test runner spawns a fresh subprocess
// per file, so cross-file pollution is moot — but the guards keep the
// shim safe to import twice within one file too.

import { DOMImplementation, DOMParser } from '@xmldom/xmldom';

// --- core document --------------------------------------------------

export const doc = new DOMImplementation().createDocument(null, null, null);

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
    if (!n) return null;
    if (n.nodeType === 1 && n.getAttribute && n.getAttribute('id') === id) return n;
    const kids = n.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const r = walk(kids[i]);
      if (r) return r;
    }
    return null;
  }
  return walk(doc.documentElement);
};

globalThis.document = doc;

// --- selector engine (.class / #id / tag / [attr=val] / descendant)
// Used by view code and assertions. Selector grammar is limited to the
// shapes the views actually emit and the tests actually query.

function camelToKebab(s) {
  return String(s).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

function parseStep(step) {
  const out = { tag: '*', classes: [], attrs: [] };
  let s = step;
  s = s.replace(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_, k, q, q2, raw) => {
    out.attrs.push({ k, v: q != null ? q : q2 != null ? q2 : raw != null ? raw : null });
    return '';
  });
  s = s.replace(/#([\w-]+)/g, (_, id) => { out.attrs.push({ k: 'id', v: id }); return ''; });
  s = s.replace(/\.([\w-]+)/g, (_, c) => { out.classes.push(c); return ''; });
  if (s) out.tag = s.toLowerCase();
  return out;
}

function parseSelectors(sel) {
  return String(sel).split(',').map((s) => s.trim()).map((s) => s.split(/\s+/).map(parseStep));
}

function nodeMatches(n, step) {
  if (n.nodeType !== 1) return false;
  if (step.tag !== '*' && n.tagName.toLowerCase() !== step.tag) return false;
  const cls = ((n.getAttribute && n.getAttribute('class')) || '').split(/\s+/);
  for (const c of step.classes) if (!cls.includes(c)) return false;
  for (const { k, v } of step.attrs) {
    const got = n.getAttribute && n.getAttribute(k);
    if (v == null) { if (got == null) return false; }
    else if (String(got) !== String(v)) return false;
  }
  return true;
}

function descendantMatch(node, steps) {
  if (!nodeMatches(node, steps[steps.length - 1])) return false;
  let p = node.parentNode;
  for (let i = steps.length - 2; i >= 0; i--) {
    while (p && !(p.nodeType === 1 && nodeMatches(p, steps[i]))) p = p.parentNode;
    if (!p) return false;
    p = p.parentNode;
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
    // Descend through elements AND DocumentFragments / Documents
    // (xmldom keeps fragments as children rather than splicing them in).
    if (n.nodeType === 1 || n.nodeType === 11 || n.nodeType === 9) {
      const kids = n.childNodes || [];
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
    }
  }
  const startKids = root.childNodes || [];
  for (let i = 0; i < startKids.length; i++) visit(startKids[i]);
  return out;
}

function querySelectorAll(root, sel) {
  return collectMatching(root, parseSelectors(sel));
}
function querySelector(root, sel) {
  return collectMatching(root, parseSelectors(sel))[0] || null;
}

// --- Element prototype ----------------------------------------------

const _sample = doc.createElement('span');
export const ElementProto = Object.getPrototypeOf(_sample);

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

// xmldom keeps className / href / src / alt / id as plain attributes;
// production code writes via the property and assertions read via
// getAttribute. Mirror property → attribute on the shared prototype.
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
          const a = 'data-' + camelToKebab(key);
          const v = el.getAttribute(a);
          return v == null ? undefined : v;
        },
        set(_t, key, value) {
          if (typeof key !== 'string') return true;
          const a = 'data-' + camelToKebab(key);
          el.setAttribute(a, String(value));
          return true;
        },
        has(_t, key) {
          if (typeof key !== 'string') return false;
          const a = 'data-' + camelToKebab(key);
          return el.getAttribute(a) != null;
        },
        deleteProperty(_t, key) {
          if (typeof key !== 'string') return true;
          const a = 'data-' + camelToKebab(key);
          el.removeAttribute(a);
          return true;
        },
      });
    },
  });
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

if (!Object.getOwnPropertyDescriptor(ElementProto, 'tabIndex')) {
  Object.defineProperty(ElementProto, 'tabIndex', {
    get() {
      const v = this.getAttribute('tabindex');
      return v == null ? -1 : Number(v);
    },
    set(v) { this.setAttribute('tabindex', String(v)); },
  });
}

for (const prop of ['type', 'title']) {
  if (!Object.getOwnPropertyDescriptor(ElementProto, prop)) {
    Object.defineProperty(ElementProto, prop, {
      get() { return this.getAttribute(prop) || ''; },
      set(v) { this.setAttribute(prop, String(v)); },
    });
  }
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

// HTMLImageElement-ish props: applyTint() reads .complete / .naturalWidth
// before sampling the canvas. Stub both as "not loaded" so the sample
// path bails out cleanly. Defining them on Element rather than just <img>
// is fine — non-images never read these.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'complete')) {
  Object.defineProperty(ElementProto, 'complete', { get() { return false; } });
}
if (!Object.getOwnPropertyDescriptor(ElementProto, 'naturalWidth')) {
  Object.defineProperty(ElementProto, 'naturalWidth', { get() { return 0; } });
}

// xmldom omits offsetWidth; the toast nudges layout with `void node.offsetWidth`.
// Returning 0 satisfies the access without faking a real measurement.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'offsetWidth')) {
  Object.defineProperty(ElementProto, 'offsetWidth', { get() { return 0; } });
}

// Inline style: cur[prop] = val collects camel-cased props into the
// `style` attribute, kebab-cased and joined with ;. Both reads and
// writes round-trip through the attribute so assertions see the result.
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

if (!Object.getOwnPropertyDescriptor(ElementProto, 'style')) {
  Object.defineProperty(ElementProto, 'style', {
    get() {
      const el = this;
      if (el.__style_obj__) return el.__style_obj__;
      const props = new Map();
      const sync = () => {
        // Keep both the attribute and the Map in sync so consumers can
        // read either way. parse-from-attribute on first access so style
        // set via setAttribute is visible to the property API too.
        const cur = parseStyle(el.getAttribute('style') || '');
        for (const [k, v] of Object.entries(cur)) {
          if (!props.has(k)) props.set(k, v);
        }
      };
      const apply = () => {
        const obj = Object.fromEntries(props);
        el.setAttribute('style', stringifyStyle(obj));
      };
      const api = {
        setProperty(name, value) { sync(); props.set(name, String(value)); apply(); },
        getPropertyValue(name)   { sync(); return props.get(name) || ''; },
        removeProperty(name)     { sync(); props.delete(name); apply(); },
      };
      // Also expose camel-cased properties (style.background = ...) via
      // a Proxy so both APIs work. Reads return the camel-keyed value
      // (matching how the view writes), writes round-trip into props.
      const proxy = new Proxy(api, {
        get(t, prop) {
          if (prop in t) return t[prop];
          sync();
          return props.get(String(prop)) || '';
        },
        set(t, prop, val) {
          if (prop in t) { t[prop] = val; return true; }
          sync();
          props.set(String(prop), String(val));
          apply();
          return true;
        },
      });
      Object.defineProperty(el, '__style_obj__', { value: proxy });
      return proxy;
    },
  });
}

// textContent: xmldom usually provides it on the Node prototype, but
// the station view occasionally relies on a setter that wipes existing
// children. Patch only when missing.
if (!Object.getOwnPropertyDescriptor(ElementProto, 'textContent')) {
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

if (!ElementProto.querySelector) {
  ElementProto.querySelector = function (sel) { return querySelector(this, sel); };
  ElementProto.querySelectorAll = function (sel) { return querySelectorAll(this, sel); };
}
if (!doc.querySelector) {
  doc.querySelector = function (sel) {
    return doc.documentElement ? doc.documentElement.querySelector(sel) : null;
  };
}
if (!doc.querySelectorAll) {
  doc.querySelectorAll = function (sel) {
    return doc.documentElement ? doc.documentElement.querySelectorAll(sel) : [];
  };
}

// DocumentFragment also needs querySelector{All} — dom.js' html`` walks
// tpl.content.querySelectorAll('*') to do attribute substitution.
const _frag = doc.createDocumentFragment();
const FragProto = Object.getPrototypeOf(_frag);
if (!FragProto.querySelector) {
  FragProto.querySelector = function (sel) { return querySelector(this, sel); };
  FragProto.querySelectorAll = function (sel) { return querySelectorAll(this, sel); };
}

// insertAdjacentElement — station.js uses 'afterend' to inject the test
// player below the CTA. Implement the four positions the view touches.
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

// .replaceWith / .remove on every node type the html`` engine touches.
// dom.js calls these on comment markers and text nodes during template
// substitution. Walk both Comment and Element prototype chains; patch
// at each unique prototype level.
const _patchTargets = new Set();
const _commentNode = doc.createComment('x');
for (let p = Object.getPrototypeOf(_commentNode); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
  _patchTargets.add(p);
}
const _textNode = doc.createTextNode('x');
for (let p = Object.getPrototypeOf(_textNode); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
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

// NamedNodeMap iteration — dom.js does `for (const attr of el.attributes)`.
// xmldom exposes length + item(i) but isn't iterable by default.
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

// Node constructor — html`` uses `value instanceof Node` to branch
// between Node insertion vs text. Anchor it to whichever prototype owns
// nodeType.
let _NodeProto = Object.getPrototypeOf(_sample);
while (_NodeProto && _NodeProto !== Object.prototype) {
  if (Object.getOwnPropertyDescriptor(_NodeProto, 'nodeType')) break;
  _NodeProto = Object.getPrototypeOf(_NodeProto);
}
if (typeof globalThis.Node === 'undefined') {
  globalThis.Node = function Node() {};
  globalThis.Node.prototype = _NodeProto || Object.prototype;
}

// NodeFilter + createTreeWalker (comment-only) — html`` walks template
// content for comment markers and replaces them with values.
if (typeof globalThis.NodeFilter === 'undefined') {
  globalThis.NodeFilter = { SHOW_COMMENT: 0x80 };
}

const NodeProtoForDoc = Object.getPrototypeOf(doc);
if (!Object.getOwnPropertyDescriptor(NodeProtoForDoc, 'createTreeWalker')) {
  NodeProtoForDoc.createTreeWalker = function (root, _whatToShow) {
    const comments = [];
    function walk(n) {
      if (!n) return;
      if (n.nodeType === 8) comments.push(n);
      const kids = n.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    }
    walk(root);
    let i = 0;
    return {
      nextNode() { return i < comments.length ? comments[i++] : null; },
    };
  };
}

// Template parsing: <template>.innerHTML normally builds a parsed
// DocumentFragment via the HTML parser. xmldom doesn't, so intercept
// createElement('template') and hand back an object whose innerHTML
// setter routes through xmldom's text/html parser.
const _origCreateElement = doc.createElement.bind(doc);
doc.createElement = function (name) {
  if (String(name).toLowerCase() === 'template') return makeTemplateLike();
  return _origCreateElement(name);
};

function makeTemplateLike() {
  const tpl = _origCreateElement('template');
  let _content = null;
  Object.defineProperty(tpl, 'innerHTML', {
    get() { return ''; },
    set(html) {
      // Wrap so xmldom's parser has a single root to anchor on; we strip
      // the wrapper afterwards into a fragment-like container.
      const wrapped = `<div>${html}</div>`;
      const parsed = new DOMParser({ onError() {} }).parseFromString(wrapped, 'text/html');
      const root = parsed.documentElement;
      const frag = _origCreateElement('div');
      while (root.firstChild) frag.appendChild(root.firstChild);
      _content = frag;
    },
    configurable: true,
  });
  Object.defineProperty(tpl, 'content', {
    get() { return _content || _origCreateElement('div'); },
    configurable: true,
  });
  return tpl;
}

// CommonJS require shim — a couple of the older in-test helpers used
// it. Harmless to install unconditionally.
if (typeof globalThis.require === 'undefined') {
  const { createRequire } = await import('node:module');
  globalThis.require = createRequire(import.meta.url);
}

// document.hidden + visibilitychange — the now-playing view installs a
// visibility hook on init; expose just enough surface so the install
// doesn't throw. Individual files can override doc.addEventListener if
// they need to assert on hook installation.
if (!Object.getOwnPropertyDescriptor(doc, 'hidden')) {
  Object.defineProperty(doc, 'hidden', { get() { return true; }, configurable: true });
}
if (typeof doc.addEventListener !== 'function') {
  doc.addEventListener = function () {};
  doc.removeEventListener = function () {};
}

// requestAnimationFrame — view code uses it to defer paint-bound work.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}

// localStorage — state.js persistence + a few caches read/write here.
// Node 25 ships a built-in localStorage that emits a startup warning
// unless `--localstorage-file` is passed; override unconditionally so
// the warning is muted and tests get a clean in-memory store.
{
  const _ls = new Map();
  globalThis.localStorage = {
    getItem(k)   { return _ls.has(k) ? _ls.get(k) : null; },
    setItem(k, v) { _ls.set(k, String(v)); },
    removeItem(k) { _ls.delete(k); },
  };
}

// --- exported helpers -----------------------------------------------

// Minimal Event-ish factory. Tests pass keyboard / mouse init bags
// through; the engine just spreads them onto the event.
export function ev(type, init = {}) {
  return Object.assign({
    type,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  }, init);
}

// sessionStorage stub — install once. Files that want to inspect or
// reset between tests can grab the underlying store via the export.
//
// The shim is installed at module-evaluation time below so that any
// production module imported transitively through this file (e.g.
// tunein-cache.js, which captures `sessionStorage` once at load) sees
// a working backing store. Node < 22 has no built-in sessionStorage,
// so without this top-level install the cache silently no-ops on the
// CI runner (Node 20) while passing locally on Node ≥ 22.
let _sessionStore = null;
export function installSessionStorage() {
  if (_sessionStore) return _sessionStore;
  _sessionStore = new Map();
  globalThis.sessionStorage = {
    getItem(k)         { return _sessionStore.has(k) ? _sessionStore.get(k) : null; },
    setItem(k, v)      { _sessionStore.set(k, String(v)); },
    removeItem(k)      { _sessionStore.delete(k); },
    clear()            { _sessionStore.clear(); },
  };
  return _sessionStore;
}
installSessionStorage();

// fetch stub — never-resolving promise. Override per-test by reassigning
// globalThis.fetch after the dom-shim import.
export function installFetchNeverResolving() {
  if (typeof globalThis.fetch === 'undefined' || globalThis.fetch.__dom_shim_stub__) {
    const stub = () => new Promise(() => {});
    stub.__dom_shim_stub__ = true;
    globalThis.fetch = stub;
  }
}

// window + location stub. Returns { winListeners, fireHashChange } so
// callers can drive hashchange manually.
export function installWindowAndLocation(initialHash = '#/') {
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
  globalThis.location = { hash: initialHash };
  return {
    winListeners,
    fireHashChange(nextHash) {
      globalThis.location.hash = nextHash;
      const set = winListeners.get('hashchange');
      if (set) for (const fn of set) fn();
    },
  };
}
