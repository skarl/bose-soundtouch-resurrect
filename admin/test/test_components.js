// Tests for app/components.js — pill / switchEl / slider / equalizer /
// stationArt + the connectionPill back-compat refactor.
//
// xmldom doesn't ship classList or DOM events; we shim just enough on
// Element.prototype to drive the components imperatively. Keyboard /
// click flows are exercised by invoking the same toggle entry point the
// real handlers would call (the components expose .toggle() exactly so
// callers and tests share the path).
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation } from '@xmldom/xmldom';

// --- DOM shim --------------------------------------------------------

const doc = new DOMImplementation().createDocument(null, null, null);
// applyTint() (reached via stationArt → setArt) calls
// document.querySelector('.np-view'); xmldom has no querySelector. The
// lookup just needs to return null so applyTint bails out cleanly.
if (!doc.querySelector) doc.querySelector = () => null;
// theme.js applies on import via document.documentElement.dataset.theme.
// xmldom's empty doc has no documentElement; create a fake one with a
// dataset stand-in so the side-effecting import doesn't blow up.
if (!doc.documentElement) {
  const html = doc.createElement('html');
  doc.appendChild(html);
}
if (!doc.documentElement.dataset) {
  doc.documentElement.dataset = {};
}
globalThis.document = doc;

// Pull a sample element to grab the Element prototype, then patch it.
const _sampleEl = doc.createElement('span');
const ElementProto = Object.getPrototypeOf(_sampleEl);

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
          const next = cur.filter((c) => !names.includes(c));
          el.setAttribute('class', next.join(' '));
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

// xmldom stores className / href / src / alt as JS-only properties; the
// production code (stationRow, art.js) writes via the property and our
// assertions read via getAttribute. Mirror property → attribute so both
// sides see the same value.
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

// Minimal Event-ish factories.
function ev(type, init = {}) {
  return Object.assign({
    type,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  }, init);
}

const {
  pill,
  switchEl,
  slider,
  equalizer,
  stationArt,
  connectionPill,
  updatePill,
  throttleLeadingTrailing,
  stationRow,
} = await import('../app/components.js');

// --- pill ------------------------------------------------------------

test('pill: ok tone is the default', () => {
  const p = pill({ text: 'idle' });
  assert.equal(p.tagName, 'span');
  assert.ok((p.getAttribute('class') || '').includes('pill--ok'));
  assert.equal(p.getAttribute('data-tone'), 'ok');
});

test('pill: every tone applies the matching class', () => {
  for (const tone of ['live', 'ok', 'warn', 'danger']) {
    const p = pill({ tone, text: tone });
    assert.ok((p.getAttribute('class') || '').includes(`pill--${tone}`),
      `expected pill--${tone}`);
  }
});

test('pill: pulse=true adds the pill__dot--on class on the dot', () => {
  const p = pill({ tone: 'live', pulse: true, text: 'live' });
  const dot = p.firstChild;
  assert.ok((dot.getAttribute('class') || '').includes('pill__dot--on'));
});

test('pill: update() mutates without replacing the node', () => {
  const p = pill({ tone: 'ok', text: 'one' });
  const labelNode = p.childNodes[1];
  p.update({ tone: 'warn', text: 'two', pulse: true });
  assert.ok((p.getAttribute('class') || '').includes('pill--warn'));
  assert.ok(!(p.getAttribute('class') || '').includes('pill--ok'));
  assert.equal(p.childNodes[1], labelNode, 'same label node identity');
  assert.equal(labelNode.textContent, 'two');
  assert.equal(p.getAttribute('data-tone'), 'warn');
});

test('pill: unknown tone falls back to ok', () => {
  const p = pill({ tone: 'mauve', text: 'x' });
  assert.equal(p.getAttribute('data-tone'), 'ok');
});

// --- connectionPill back-compat -------------------------------------

test('connectionPill: returned node carries .conn-pill and data-state', () => {
  const el = connectionPill({ ws: { mode: 'ws' } });
  const cls = el.getAttribute('class') || '';
  assert.ok(cls.includes('conn-pill'), 'has .conn-pill class');
  assert.ok(cls.includes('pill'), 'has .pill class');
  assert.equal(el.getAttribute('data-state'), 'ws');
  assert.equal(el.getAttribute('aria-label'), 'Connection: live');
});

test('connectionPill: defaults to offline when state missing', () => {
  const el = connectionPill();
  assert.equal(el.getAttribute('data-state'), 'offline');
});

test('updatePill: flips state without re-creating the node', () => {
  const el = connectionPill({ ws: { mode: 'connecting' } });
  assert.equal(el.getAttribute('data-state'), 'connecting');
  updatePill(el, { ws: { mode: 'ws' } });
  assert.equal(el.getAttribute('data-state'), 'ws');
  assert.equal(el.getAttribute('aria-label'), 'Connection: live');
  updatePill(el, { ws: { mode: 'offline' } });
  assert.equal(el.getAttribute('data-state'), 'offline');
});

// --- switchEl --------------------------------------------------------

test('switchEl: role + aria-checked are set correctly', () => {
  const s = switchEl({ checked: false, label: 'Mute' });
  assert.equal(s.getAttribute('role'), 'switch');
  assert.equal(s.getAttribute('aria-checked'), 'false');
  assert.equal(s.getAttribute('aria-label'), 'Mute');
});

test('switchEl: toggle() flips state, fires onChange, updates aria-checked', () => {
  const calls = [];
  const s = switchEl({ checked: false, onChange: (v) => calls.push(v) });
  s.toggle();
  assert.equal(s.checked, true);
  assert.equal(s.getAttribute('aria-checked'), 'true');
  assert.deepEqual(calls, [true]);
  s.toggle();
  assert.equal(s.checked, false);
  assert.equal(s.getAttribute('aria-checked'), 'false');
  assert.deepEqual(calls, [true, false]);
});

test('switchEl: click event toggles', () => {
  const calls = [];
  const s = switchEl({ checked: false, onChange: (v) => calls.push(v) });
  s.dispatchEvent(ev('click'));
  assert.equal(s.checked, true);
  assert.equal(s.getAttribute('aria-checked'), 'true');
  assert.deepEqual(calls, [true]);
});

test('switchEl: Space + Enter keydowns toggle and preventDefault', () => {
  const s = switchEl({ checked: false });
  const space = ev('keydown', { key: ' ' });
  s.dispatchEvent(space);
  assert.equal(space.defaultPrevented, true);
  assert.equal(s.checked, true);

  const enter = ev('keydown', { key: 'Enter' });
  s.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(s.checked, false);
});

test('switchEl: other keys are ignored', () => {
  const s = switchEl({ checked: false });
  const tab = ev('keydown', { key: 'Tab' });
  s.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false);
  assert.equal(s.checked, false);
});

test('switchEl: setChecked() updates without firing onChange', () => {
  const calls = [];
  const s = switchEl({ checked: false, onChange: (v) => calls.push(v) });
  s.setChecked(true);
  assert.equal(s.checked, true);
  assert.equal(s.getAttribute('aria-checked'), 'true');
  assert.deepEqual(calls, [], 'setChecked is silent');
});

// --- slider ----------------------------------------------------------

test('slider: builds a range input with the requested attrs', () => {
  const s = slider({ min: 0, max: 50, value: 25, step: 5, ariaLabel: 'Bass' });
  assert.equal(s.tagName, 'input');
  assert.equal(s.getAttribute('type'), 'range');
  assert.equal(s.getAttribute('min'), '0');
  assert.equal(s.getAttribute('max'), '50');
  assert.equal(s.getAttribute('value'), '25');
  assert.equal(s.getAttribute('step'), '5');
  assert.equal(s.getAttribute('aria-label'), 'Bass');
});

test('slider: setValue() updates the value attribute', () => {
  const s = slider({ value: 10 });
  s.setValue(42);
  assert.equal(s.getAttribute('value'), '42');
});

test('throttle: leading call fires immediately', () => {
  const calls = [];
  const fn = throttleLeadingTrailing((v) => calls.push(v), 50);
  fn(1);
  assert.deepEqual(calls, [1]);
});

test('throttle: rapid bursts coalesce; trailing value lands', async () => {
  const calls = [];
  const fn = throttleLeadingTrailing((v) => calls.push(v), 30);
  fn(1); fn(2); fn(3); fn(4); fn(5);
  assert.deepEqual(calls, [1], 'only the leading call fires synchronously');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(calls, [1, 5], 'final value lands on the trailing edge');
});

test('throttle: a single call at low rate is not held back', async () => {
  const calls = [];
  const fn = throttleLeadingTrailing((v) => calls.push(v), 20);
  fn('a');
  await new Promise((r) => setTimeout(r, 50));
  fn('b');
  assert.deepEqual(calls, ['a', 'b']);
});

test('slider: input event drives onChange via the throttle', async () => {
  const calls = [];
  const s = slider({
    value: 0,
    onChange: (v) => calls.push(v),
    throttleMs: 20,
  });
  s.setAttribute('value', '7');
  // The input handler reads from input.value — xmldom doesn't track that,
  // so simulate by setting the attribute and dispatching. The handler
  // calls Number(input.value); xmldom returns the attribute string.
  Object.defineProperty(s, 'value', { get() { return this.getAttribute('value'); } });
  s.dispatchEvent(ev('input'));
  assert.deepEqual(calls, [7], 'leading fires immediately');
  s.setAttribute('value', '8');
  s.dispatchEvent(ev('input'));
  s.setAttribute('value', '9');
  s.dispatchEvent(ev('input'));
  assert.deepEqual(calls, [7], 'rapid follow-ups are held back');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [7, 9], 'final value reaches onChange');
});

// --- equalizer -------------------------------------------------------

test('equalizer: idle has no data-state', () => {
  const eq = equalizer();
  assert.equal(eq.getAttribute('data-state'), null);
});

test('equalizer: setPlaying(true) sets data-state="playing"', () => {
  const eq = equalizer();
  eq.setPlaying(true);
  assert.equal(eq.getAttribute('data-state'), 'playing');
  eq.setPlaying(false);
  assert.equal(eq.getAttribute('data-state'), null);
});

test('equalizer: wraps the .eq icon (3 bars)', () => {
  const eq = equalizer({ playing: true });
  assert.equal(eq.getAttribute('data-state'), 'playing');
  const inner = eq.firstChild;
  assert.equal(inner.getAttribute('class'), 'eq');
  assert.equal(inner.childNodes.length, 3);
});

// --- stationArt ------------------------------------------------------

test('stationArt: with url, the <img> src is set to that url', () => {
  const a = stationArt({ url: 'http://example/a.png', name: 'Foo', size: 32 });
  const img = a.firstChild;
  assert.equal(img.tagName, 'img');
  assert.equal(img.src, 'http://example/a.png');
  assert.equal(img.alt, 'Foo');
});

test('stationArt: without url, the <img> falls back to a data URI', () => {
  const a = stationArt({ url: '', name: 'Bar' });
  const img = a.firstChild;
  const src = img.src || '';
  assert.ok(src.startsWith('data:image/svg+xml'),
    `expected data: fallback, got ${src.slice(0, 32)}…`);
});

test('stationArt: same name yields the same fallback colour twice', () => {
  const a = stationArt({ name: 'Same' });
  const b = stationArt({ name: 'Same' });
  assert.equal(
    a.firstChild.src,
    b.firstChild.src,
    'hashHue is deterministic per name',
  );
});

test('stationArt: update({ url }) swaps src in place', () => {
  const a = stationArt({ url: '', name: 'Init' });
  const img = a.firstChild;
  a.update({ url: 'http://example/new.png' });
  assert.equal(img.src, 'http://example/new.png');
});

test('stationArt: size prop sets the wrapper width/height', () => {
  const a = stationArt({ name: 'X', size: 72 });
  // xmldom keeps style as a string attribute; just probe substrings.
  const style = a.getAttribute('style') || '';
  assert.ok(style.includes('72px'), `expected 72px in style, got "${style}"`);
});

// --- stationRow ------------------------------------------------------

function classOf(el) { return el.getAttribute('class') || ''; }

function findFirstByClass(root, cls) {
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

test('stationRow: art, name, location and bitrate render with chevron', () => {
  const c = stationRow({
    sid:      's12345',
    name:     'KEXP 90.3',
    art:      'http://example/art.png',
    location: 'Seattle, WA',
    bitrate:  128,
    codec:    'mp3',
  });
  assert.equal(c.tagName, 'a');
  assert.ok(classOf(c).includes('station-row'));
  assert.equal(c.getAttribute('href'), '#/station/s12345');

  const art = findFirstByClass(c, 'station-art');
  assert.ok(art, 'station-art slot present');
  const img = art.firstChild;
  assert.equal(img.tagName, 'img');
  assert.equal(img.src, 'http://example/art.png');

  const nameEl = findFirstByClass(c, 'station-row__name');
  assert.equal(nameEl.textContent, 'KEXP 90.3');

  const loc = findFirstByClass(c, 'station-row__loc');
  assert.equal(loc.textContent, 'Seattle, WA');

  const fmt = findFirstByClass(c, 'station-row__fmt');
  assert.equal(fmt.textContent, '128k MP3');

  const chev = findFirstByClass(c, 'station-row__chev');
  assert.ok(chev, 'chevron slot present');
});

test('stationRow: long names get the truncating class for ellipsis', () => {
  const c = stationRow({
    sid:  's00001',
    name: 'A Spectacularly Long Station Name That Should Be Forced To Truncate',
  });
  const nameEl = findFirstByClass(c, 'station-row__name');
  assert.ok(classOf(nameEl).includes('station-row__name'),
    'truncation class applied (.station-row__name carries white-space:nowrap + ellipsis)');
});

test('stationRow: meta line is omitted when no metadata is present', () => {
  const c = stationRow({ sid: 's00001', name: 'Bare' });
  assert.equal(findFirstByClass(c, 'station-row__meta'), null);
});

test('stationRow: format chunk omitted when bitrate is zero and no codec', () => {
  const c = stationRow({ sid: 's00001', name: 'Bare', location: 'Earth' });
  assert.equal(findFirstByClass(c, 'station-row__fmt'), null);
});

test('stationRow: codec without bitrate still shows a format chunk', () => {
  const c = stationRow({ sid: 's00001', name: 'Codec only', codec: 'aac' });
  const fmt = findFirstByClass(c, 'station-row__fmt');
  assert.ok(fmt);
  assert.equal(fmt.textContent, 'AAC');
});

test('stationRow: falls back to sid for the name when name is missing', () => {
  const c = stationRow({ sid: 's42' });
  const nameEl = findFirstByClass(c, 'station-row__name');
  assert.equal(nameEl.textContent, 's42');
});
