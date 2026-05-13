// Tests for app/views/browse/outline-render.js — the entry → DOM
// primitives that the broader browse pipeline composes on top of.
// test_browse.js covers the integrated path (renderEntry composed
// through renderOutline + section rendering with fixture payloads);
// these per-submodule tests pin the seam contracts so the module
// remains independently testable.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, ev } from './fixtures/dom-shim.js';
void ev;

const {
  renderEntry,
  renderOutline,
  renderCard,
  renderSection,
  renderFlatSection,
  drillHashFor,
  drillPartsFor,
  drillPartsForUrl,
  primeTuneinSkipCaches,
  emptyNode,
  skeleton,
  errorNode,
  pluralize,
  setChildCrumbs,
  _setChildCrumbsForTest,
} = await import('../app/views/browse/outline-render.js');

function classOf(el) { return el.getAttribute('class') || ''; }
function hasClass(el, cls) {
  return classOf(el).split(/\s+/).includes(cls);
}
function findFirstByClass(root, cls) {
  if (!root) return null;
  if (root.nodeType === 1 && hasClass(root, cls)) return root;
  for (const c of root.childNodes || []) {
    if (c && c.nodeType === 1) {
      const found = findFirstByClass(c, cls);
      if (found) return found;
    }
  }
  return null;
}
function findAllBy(root, predicate) {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1 && predicate(node)) out.push(node);
    for (const c of node.childNodes || []) walk(c);
  }
  walk(root);
  return out;
}

// --- drillHashFor contract ------------------------------------------

test('drillHashFor composes id / c / filter / pivot / offset query keys', () => {
  _setChildCrumbsForTest([]);
  const h = drillHashFor({ id: 'g79', filter: 'l109', offset: '20' });
  assert.match(h, /^#\/browse\?/);
  assert.match(h, /id=g79/);
  assert.match(h, /filter=l109/);
  assert.match(h, /offset=20/);
});

test('drillHashFor reads module-level _childCrumbs as the default from= prefix', () => {
  _setChildCrumbsForTest(['music', 'g79']);
  const h = drillHashFor({ id: 'c424724' });
  assert.match(h, /from=music%2Cg79/);
  _setChildCrumbsForTest([]);
});

test('drillHashFor accepts an explicit crumbs override (used by the Back link)', () => {
  _setChildCrumbsForTest(['music', 'g79']);
  const h = drillHashFor({ id: 'g79' }, ['music']);
  assert.match(h, /from=music(?:&|$)/);
  // The module-level value is ignored when the caller passes one in.
  assert.equal(h.includes('music%2Cg79'), false);
  _setChildCrumbsForTest([]);
});

test('drillHashFor with empty crumbs array omits from= entirely', () => {
  _setChildCrumbsForTest([]);
  const h = drillHashFor({ c: 'music' });
  assert.equal(h.includes('from='), false);
});

// --- setChildCrumbs / _setChildCrumbsForTest are equivalent ---------

test('setChildCrumbs is the production setter for the crumb prefix', () => {
  setChildCrumbs(['g1', 'g2']);
  const h = drillHashFor({ id: 'g3' });
  assert.match(h, /from=g1%2Cg2/);
  setChildCrumbs([]);
});

// --- drillPartsFor / drillPartsForUrl --------------------------------

test('drillPartsFor prefers the canonicalised URL over the bare guide_id', () => {
  const parts = drillPartsFor({
    guide_id: 'g79',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=g79&offset=20&render=json',
  });
  // The URL carries the offset; the guide_id alone would not.
  assert.equal(parts.id, 'g79');
  assert.equal(parts.offset, '20');
});

test('drillPartsFor falls back to guide_id when URL is absent', () => {
  const parts = drillPartsFor({ guide_id: 'g79' });
  assert.deepEqual(parts, { id: 'g79' });
});

test('drillPartsFor returns null when neither URL nor guide_id is set', () => {
  assert.equal(drillPartsFor({ text: 'No drill target' }), null);
  assert.equal(drillPartsFor(null), null);
});

test('drillPartsForUrl returns null for empty / non-string input', () => {
  assert.equal(drillPartsForUrl(''), null);
  assert.equal(drillPartsForUrl(null), null);
  assert.equal(drillPartsForUrl(undefined), null);
});

test('drillPartsForUrl returns null for a URL that yields no drill keys', () => {
  // A Tune.ashx URL has neither id nor c at the top level — extractDrillKey
  // returns {}, so drillPartsForUrl falls through to null.
  assert.equal(drillPartsForUrl('http://opml.radiotime.com/Tune.ashx?render=json'), null);
});

// --- renderCard composes rows + marks the last one ------------------

test('renderCard renders one row per entry and marks the last as is-last', () => {
  const card = renderCard([
    { type: 'audio', guide_id: 's1', text: 'One' },
    { type: 'audio', guide_id: 's2', text: 'Two' },
    { type: 'audio', guide_id: 's3', text: 'Three' },
  ]);
  assert.ok(hasClass(card, 'browse-card'));
  const rows = findAllBy(card, (el) => hasClass(el, 'station-row'));
  assert.equal(rows.length, 3);
  assert.equal(hasClass(rows[0], 'is-last'), false);
  assert.equal(hasClass(rows[1], 'is-last'), false);
  assert.equal(hasClass(rows[2], 'is-last'), true);
});

// --- emptyNode / skeleton / errorNode / pluralize -------------------

test('emptyNode renders a .browse-empty paragraph with the supplied message', () => {
  const e = emptyNode('Nothing here.');
  assert.equal(e.tagName, 'p');
  assert.ok(hasClass(e, 'browse-empty'));
  assert.equal(e.textContent, 'Nothing here.');
});

test('skeleton renders the loading paragraph', () => {
  const s = skeleton();
  assert.ok(hasClass(s, 'browse-loading'));
  assert.equal(s.textContent, 'Loading...');
});

test('errorNode renders the failure paragraph including err.message', () => {
  const e = errorNode(new Error('boom'));
  assert.ok(hasClass(e, 'browse-error'));
  assert.match(e.textContent, /boom/);
});

test('pluralize: singular for 1, plural for everything else', () => {
  assert.equal(pluralize(1), 'entry');
  assert.equal(pluralize(0), 'entries');
  assert.equal(pluralize(2), 'entries');
  assert.equal(pluralize(100), 'entries');
});

// --- renderSection: data-section attribute + footer placeholder -----

test('renderSection emits a [data-section] wrapper + .browse-section__footer placeholder', () => {
  const rendered = renderSection({
    text: 'Stations',
    key: 'stations',
    children: [
      { type: 'audio', guide_id: 's1', text: 'One' },
      { type: 'audio', guide_id: 's2', text: 'Two' },
    ],
  });
  assert.ok(rendered);
  assert.equal(rendered.visibleCount, 2);
  const wrap = rendered.element;
  assert.equal(wrap.getAttribute('data-section'), 'stations');
  // Footer placeholder for the Load-more button mount.
  const footer = findFirstByClass(wrap, 'browse-section__footer');
  assert.ok(footer, 'footer placeholder mounted');
});

test('renderSection parks data-cursor-url on the section when the children include a cursor outline', () => {
  const rendered = renderSection({
    text: 'Stations',
    key: 'stations',
    children: [
      { type: 'audio', guide_id: 's1', text: 'One' },
      { type: 'link', key: 'nextStations', URL: 'http://opml.radiotime.com/Browse.ashx?id=g79&offset=1' },
    ],
  });
  assert.equal(rendered.element.getAttribute('data-cursor-url'),
    'http://opml.radiotime.com/Browse.ashx?id=g79&offset=1');
});

// --- renderFlatSection: no header, marks data-section="flat" --------

test('renderFlatSection wraps the rows in a flat section card', () => {
  const rendered = renderFlatSection([
    { type: 'audio', guide_id: 's1', text: 'One' },
    { type: 'audio', guide_id: 's2', text: 'Two' },
  ]);
  assert.equal(rendered.visibleCount, 2);
  assert.equal(rendered.element.getAttribute('data-section'), 'flat');
  const rows = findAllBy(rendered.element, (el) => hasClass(el, 'station-row'));
  assert.equal(rows.length, 2);
});

// --- renderOutline drives the multi-section dispatch ----------------

test('renderOutline returns the total visible row count, skipping cursors / pivots', () => {
  const json = {
    head: { title: 'X', status: '200' },
    body: [
      {
        text: 'Stations',
        key: 'stations',
        children: [
          { type: 'audio', guide_id: 's1', text: 'One' },
          { type: 'audio', guide_id: 's2', text: 'Two' },
          { type: 'link', key: 'nextStations', URL: 'http://opml.radiotime.com/Browse.ashx?id=g79&offset=1' },
        ],
      },
      {
        text: 'Shows',
        key: 'shows',
        children: [
          { type: 'link', item: 'show', guide_id: 'p1', text: 'Show A' },
        ],
      },
    ],
  };
  const body = doc.createElement('div');
  const total = renderOutline(body, json);
  // 2 stations + 1 show — cursors / pivots excluded.
  assert.equal(total, 3);
});

test('renderOutline emits an empty-state for an entirely empty body', () => {
  const body = doc.createElement('div');
  const total = renderOutline(body, { head: { status: '200' }, body: [] });
  assert.equal(total, 0);
  const empty = findFirstByClass(body, 'browse-empty');
  assert.ok(empty);
});

// --- primeTuneinSkipCaches preserves the #102 episode-name write ----

test('primeTuneinSkipCaches stashes the resolved topic name under tunein.topicname.<t<N>> (#102)', async () => {
  const entries = [
    {
      type: 'link', item: 'topic', guide_id: 't9001', text: 'Episode Title 9001',
      URL: 'http://opml.radiotime.com/Tune.ashx?id=t9001&sid=p17&render=json',
    },
    {
      type: 'link', item: 'topic', guide_id: 't9002', text: 'Episode Title 9002',
      URL: 'http://opml.radiotime.com/Tune.ashx?id=t9002&sid=p17&render=json',
    },
  ];
  primeTuneinSkipCaches(entries);

  const tc = await import('../app/tunein-cache.js');
  const { topicNameKey, parentKey, topicsKey } = await import('../app/transport-state.js');
  // #102 regression guard — the resolved episode title is cached so
  // the now-playing skip path can ship `name` to /play.
  assert.equal(tc.cache.get(topicNameKey('t9001')), 'Episode Title 9001');
  assert.equal(tc.cache.get(topicNameKey('t9002')), 'Episode Title 9002');
  // Parent + topics list also primed.
  assert.equal(tc.cache.get(parentKey('t9001')), 'p17');
  assert.deepEqual(tc.cache.get(topicsKey('p17')), ['t9001', 't9002']);

  tc.cache.invalidate(topicNameKey('t9001'));
  tc.cache.invalidate(topicNameKey('t9002'));
  tc.cache.invalidate(parentKey('t9001'));
  tc.cache.invalidate(parentKey('t9002'));
  tc.cache.invalidate(topicsKey('p17'));
});

test('primeTuneinSkipCaches tolerates empty input without throwing', () => {
  primeTuneinSkipCaches([]);
  primeTuneinSkipCaches(null);
  primeTuneinSkipCaches(undefined);
});

// --- renderEntry routes by classifyOutline kind ---------------------

test('renderEntry dispatches a station outline to .station-row', () => {
  const node = renderEntry({ type: 'audio', guide_id: 's1', text: 'Test' });
  assert.ok(hasClass(node, 'station-row'));
});

test('renderEntry dispatches a drillable category to .browse-row', () => {
  const node = renderEntry({ text: 'Folk', URL: 'http://opml.radiotime.com/Browse.ashx?id=g79' });
  assert.ok(hasClass(node, 'browse-row'));
});

test('renderEntry stashes the raw outline on the rendered node._outline', () => {
  const entry = { type: 'audio', guide_id: 's1', text: 'Stash' };
  const node = renderEntry(entry);
  assert.equal(node._outline, entry);
});
