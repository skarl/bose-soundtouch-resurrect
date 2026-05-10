// Tests for app/views/browse.js — renderEntry() produces the polish-pass
// station-row layout for audio leaves and a browse-row for drillable
// section nodes. Mirrors the xmldom shim from test_components.js so the
// view can mount against a fake document.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation } from '@xmldom/xmldom';

// --- DOM shim (lifted from test_components.js) ----------------------

const doc = new DOMImplementation().createDocument(null, null, null);
if (!doc.querySelector) doc.querySelector = () => null;
if (!doc.documentElement) {
  const html = doc.createElement('html');
  doc.appendChild(html);
}
if (!doc.documentElement.dataset) doc.documentElement.dataset = {};
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
  ElementProto.addEventListener = function () {};
}

// xmldom keeps className / href / src as JS-only properties; the
// production code (browse.js, art.js) writes via the property and our
// assertions read via getAttribute. Mirror property → attribute so
// both sides see the same value.
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

const { renderEntry } = await import('../app/views/browse.js');

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
  assert.equal(node.getAttribute('href'), '#/browse?id=g22');

  const idBadge = findFirstByClass(node, 'browse-row__id');
  assert.equal(idBadge.textContent, 'g22');

  const label = findFirstByClass(node, 'browse-row__label');
  assert.equal(label.textContent, 'Genre');

  const chev = findFirstByClass(node, 'browse-row__chev');
  assert.ok(chev, 'chevron slot present');
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
