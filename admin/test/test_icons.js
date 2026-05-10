// Tests for app/icons.js — every named glyph builds a non-null DOM
// node, every static icon advertises currentColor (so the theme cycle
// reaches it), unknowns throw, and the equalizer special case returns
// the 3-bar .eq span.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { DOMImplementation } from '@xmldom/xmldom';

const doc = new DOMImplementation().createDocument(null, null, null);
globalThis.document = doc;

const { icon, ICON_NAMES } = await import('../app/icons.js');

const STATIC_NAMES = [
  'play', 'pause', 'next', 'prev',
  'vol', 'mute',
  'search', 'list', 'settings',
  'speaker', 'bt', 'wifi', 'cpu',
  'bell', 'music', 'refresh',
  'warning', 'trash', 'arrow',
];

test('ICON_NAMES exposes 19 static glyphs + equalizer', () => {
  assert.equal(STATIC_NAMES.length, 19);
  assert.equal(ICON_NAMES.length, 20);
  for (const n of STATIC_NAMES) assert.ok(ICON_NAMES.includes(n), `missing: ${n}`);
  assert.ok(ICON_NAMES.includes('equalizer'));
});

test('every static name returns a non-null SVG element', () => {
  for (const name of STATIC_NAMES) {
    const node = icon(name);
    assert.ok(node, `null for ${name}`);
    assert.equal(node.tagName, 'svg', `wrong tag for ${name}: ${node.tagName}`);
  }
});

test('every static icon advertises currentColor for theming', () => {
  for (const name of STATIC_NAMES) {
    const node = icon(name);
    const stroke = node.getAttribute('stroke');
    const fill = node.getAttribute('fill');
    assert.ok(
      stroke === 'currentColor' || fill === 'currentColor',
      `${name} has neither stroke=currentColor nor fill=currentColor (stroke=${stroke}, fill=${fill})`,
    );
  }
});

test('static icons use Lucide 24x24 viewBox', () => {
  for (const name of STATIC_NAMES) {
    assert.equal(icon(name).getAttribute('viewBox'), '0 0 24 24');
  }
});

test('default size is 16 px', () => {
  const node = icon('play');
  assert.equal(node.getAttribute('width'), '16');
  assert.equal(node.getAttribute('height'), '16');
});

test('explicit size is honoured', () => {
  const node = icon('play', 24);
  assert.equal(node.getAttribute('width'), '24');
  assert.equal(node.getAttribute('height'), '24');
});

test('unknown name throws a clear error', () => {
  assert.throws(
    () => icon('not-a-real-icon'),
    /unknown icon: not-a-real-icon/,
  );
});

test('equalizer returns a span.eq with 3 bars', () => {
  const node = icon('equalizer');
  assert.ok(node);
  assert.equal(node.tagName, 'span');
  assert.equal(node.getAttribute('class'), 'eq');
  assert.equal(node.childNodes.length, 3);
  for (const bar of Array.from(node.childNodes)) {
    assert.equal(bar.tagName, 'i');
  }
});

test('every static icon has at least one child path/shape', () => {
  for (const name of STATIC_NAMES) {
    const node = icon(name);
    assert.ok(node.childNodes.length >= 1, `${name} has no children`);
  }
});
