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

import { doc, ev } from './fixtures/dom-shim.js';

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
  stationCard,
  pillInput,
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

// --- stationRow href derivation (#86) -------------------------------
//
// Hard-coding `#/station/<sid>` produced dead links for `p` (show) and
// `t` (topic) sids — the router only mounts the station view for `s`
// sids. These tests pin the prefix-aware href on the primitive itself
// so a regression at any call site (browse-drill, search, show-landing
// row, etc.) shows up here instead of as a silent 404 in the SPA.

test('stationRow href: s-prefix sid routes to the station detail view', () => {
  const c = stationRow({ sid: 's12345', name: 'KEXP' });
  assert.equal(c.getAttribute('href'), '#/station/s12345');
});

test('stationRow href: p-prefix sid routes to c=pbrowse show landing', () => {
  // c=pbrowse triggers the show-landing dispatch in browse.js (#84),
  // which renders the Describe-driven show card. Without it the bare
  // id falls into the generic drill and the show metadata never shows.
  const c = stationRow({ sid: 'p73', name: 'Jazz at Lincoln Center' });
  assert.equal(c.getAttribute('href'), '#/browse?c=pbrowse&id=p73');
});

test('stationRow href: t-prefix sid routes to the bare-id browse drill', () => {
  const c = stationRow({ sid: 't9999', name: 'Some Topic' });
  assert.equal(c.getAttribute('href'), '#/browse?id=t9999');
});

test('stationRow href: unknown prefix collapses to "#"', () => {
  const c = stationRow({ sid: 'g42', name: 'Genre row' });
  assert.equal(c.getAttribute('href'), '#');
});

test('stationRow href: empty / missing sid collapses to "#"', () => {
  const empty = stationRow({ name: 'no id' });
  assert.equal(empty.getAttribute('href'), '#');
  const blank = stationRow({ sid: '', name: 'blank' });
  assert.equal(blank.getAttribute('href'), '#');
  const tooShort = stationRow({ sid: 's', name: 'just prefix' });
  assert.equal(tooShort.getAttribute('href'), '#');
});

// stationCard mirrors stationRow's href derivation so a future caller
// passing a `p`/`t` sid through the card variant doesn't dead-end.
test('stationCard href: s-prefix sid routes to the station detail view', () => {
  const c = stationCard({ sid: 's12345', name: 'KEXP' });
  assert.equal(c.getAttribute('href'), '#/station/s12345');
});

test('stationCard href: p-prefix sid routes to c=pbrowse show landing', () => {
  const c = stationCard({ sid: 'p73', name: 'Show' });
  assert.equal(c.getAttribute('href'), '#/browse?c=pbrowse&id=p73');
});

test('stationCard href: unknown prefix collapses to "#"', () => {
  const c = stationCard({ sid: 'g42', name: 'Genre card' });
  assert.equal(c.getAttribute('href'), '#');
});

// --- pillInput -------------------------------------------------------

test('pillInput: builds the .pill-input-wrap shell with leading icon + input', () => {
  const { wrap, input } = pillInput({
    placeholder: 'Type…',
    ariaLabel:   'Search things',
  });
  assert.ok(classOf(wrap).includes('pill-input-wrap'));
  assert.ok(findFirstByClass(wrap, 'pill-input-icon'), 'leading icon slot present');
  assert.equal(input.tagName, 'input');
  assert.equal(input.getAttribute('class'), 'pill-input');
  assert.equal(input.getAttribute('aria-label'), 'Search things');
  assert.equal(input.getAttribute('placeholder'), 'Type…');
});

test('pillInput: initialValue pre-fills the input and shows the clear button', () => {
  const { wrap, input } = pillInput({ initialValue: 'jazz' });
  assert.equal(input.getAttribute('value'), 'jazz');
  const clearBtn = findFirstByClass(wrap, 'pill-input-clear');
  assert.ok(clearBtn, 'clear-X present by default');
  assert.equal(clearBtn.hidden, false, 'clear-X visible when initial value is non-empty');
});

test('pillInput: clear-X is hidden when initialValue is empty', () => {
  const { wrap } = pillInput({ initialValue: '' });
  const clearBtn = findFirstByClass(wrap, 'pill-input-clear');
  assert.equal(clearBtn.hidden, true);
});

test('pillInput: showClear=false omits the clear button entirely', () => {
  const { wrap } = pillInput({ showClear: false });
  assert.equal(findFirstByClass(wrap, 'pill-input-clear'), null);
});

test('pillInput: input event fires onInput with the live value (no debounce)', () => {
  const calls = [];
  const { input } = pillInput({
    onInput: (v) => calls.push(v),
  });
  input.setAttribute('value', 'kexp');
  input.dispatchEvent(ev('input', { target: input }));
  assert.deepEqual(calls, ['kexp']);
});

test('pillInput: debounceMs > 0 trailing-debounces onInput', async () => {
  const calls = [];
  const { input } = pillInput({
    debounceMs: 30,
    onInput: (v) => calls.push(v),
  });
  input.setAttribute('value', 'a');
  input.dispatchEvent(ev('input', { target: input }));
  input.setAttribute('value', 'ab');
  input.dispatchEvent(ev('input', { target: input }));
  input.setAttribute('value', 'abc');
  input.dispatchEvent(ev('input', { target: input }));
  assert.deepEqual(calls, [], 'no synchronous fire while debouncing');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, ['abc'], 'only the trailing value fires');
});

test('pillInput: clear-X click empties input, fires onInput(""), refocuses', () => {
  const calls = [];
  const { wrap, input } = pillInput({
    initialValue: 'folk',
    onInput: (v) => calls.push(v),
  });
  input.setAttribute('value', 'folk');
  const clearBtn = findFirstByClass(wrap, 'pill-input-clear');
  globalThis.__focus_target__ = null;
  clearBtn.dispatchEvent(ev('click'));
  assert.equal(input.getAttribute('value'), '');
  assert.equal(clearBtn.hidden, true, 'clear-X hides itself after clearing');
  assert.deepEqual(calls, ['']);
  assert.equal(globalThis.__focus_target__, input, 'focus returns to the input');
});

test('pillInput: setValue() updates the input and fires onInput when changed', () => {
  const calls = [];
  const { input, setValue } = pillInput({
    initialValue: 'one',
    onInput: (v) => calls.push(v),
  });
  setValue('two');
  assert.equal(input.getAttribute('value'), 'two');
  assert.deepEqual(calls, ['two']);
});

test('pillInput: setValue() with the same value is a no-op', () => {
  const calls = [];
  const { setValue } = pillInput({
    initialValue: 'same',
    onInput: (v) => calls.push(v),
  });
  setValue('same');
  assert.deepEqual(calls, [], 'same value does not re-fire onInput');
});

test('pillInput: setValue() shows / hides clear-X to match the new value', () => {
  const { wrap, setValue } = pillInput({ initialValue: '' });
  const clearBtn = findFirstByClass(wrap, 'pill-input-clear');
  assert.equal(clearBtn.hidden, true);
  setValue('something');
  assert.equal(clearBtn.hidden, false);
  setValue('');
  assert.equal(clearBtn.hidden, true);
});
