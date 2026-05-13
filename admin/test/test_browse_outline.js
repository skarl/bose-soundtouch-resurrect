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
  renderPivotChips,
  renderRelatedChips,
  drillHashFor,
  drillPartsFor,
  drillPartsForUrl,
  primeTuneinSkipCaches,
  primeLabelForEntry,
  primeLabelForChip,
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

// --- issue #105: primeLabelForEntry / primeLabelForChip + render-time
// label-cache priming ---------------------------------------------------

test('primeLabelForEntry stashes tunein.label.<guide_id> from a station outline', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.s105_a');
  primeLabelForEntry({ type: 'audio', guide_id: 's105_a', text: 'KEXP' });
  assert.equal(tc.cache.get('tunein.label.s105_a'), 'KEXP');
  tc.cache.invalidate('tunein.label.s105_a');
});

test('primeLabelForEntry uses the canonicalised URL anchor when guide_id is absent', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.g79');
  primeLabelForEntry({
    text: 'Folk',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=g79&render=json',
  });
  assert.equal(tc.cache.get('tunein.label.g79'), 'Folk');
  tc.cache.invalidate('tunein.label.g79');
});

test('primeLabelForEntry emits a `<anchor>:<filter>` combined token for filter-bearing drills', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.r101821:g26');
  primeLabelForEntry({
    text: 'Bayreuth · Country',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=r101821&filter=g26',
  });
  assert.equal(tc.cache.get('tunein.label.r101821:g26'), 'Bayreuth · Country');
  tc.cache.invalidate('tunein.label.r101821:g26');
});

test('primeLabelForEntry skips entries with no usable label or drill target', async () => {
  const tc = await import('../app/tunein-cache.js');
  // No text → no write
  tc.cache.invalidate('tunein.label.s105_b');
  primeLabelForEntry({ type: 'audio', guide_id: 's105_b' });
  assert.equal(tc.cache.get('tunein.label.s105_b'), undefined);
  // Whitespace-only text → no write
  primeLabelForEntry({ type: 'audio', guide_id: 's105_b', text: '   ' });
  assert.equal(tc.cache.get('tunein.label.s105_b'), undefined);
  // No drill parts → no write
  primeLabelForEntry({ type: 'text', text: 'No drill here' });
  // No throw for nullish input
  primeLabelForEntry(null);
  primeLabelForEntry(undefined);
});

test('primeLabelForChip writes the bare anchor key for a plain drill chip', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.r101821');
  primeLabelForChip({ id: 'r101821' }, 'Bayreuth');
  assert.equal(tc.cache.get('tunein.label.r101821'), 'Bayreuth');
  tc.cache.invalidate('tunein.label.r101821');
});

test('primeLabelForChip writes the bare filter key for a filter-bearing chip', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.g26');
  tc.cache.invalidate('tunein.label.r101821:g26');
  // Filter-bearing chips' text labels the filter axis (e.g. "Country"),
  // not the combined node — so the write must go under the bare filter
  // key and NOT under the combined token.
  primeLabelForChip({ id: 'r101821', filter: 'g26' }, 'Country');
  assert.equal(tc.cache.get('tunein.label.g26'), 'Country');
  assert.equal(tc.cache.get('tunein.label.r101821:g26'), undefined);
  tc.cache.invalidate('tunein.label.g26');
});

test('primeLabelForChip tolerates empty inputs without throwing', () => {
  primeLabelForChip(null, 'X');
  primeLabelForChip({ id: 'r1' }, '');
  primeLabelForChip({ id: 'r1' }, '   ');
  primeLabelForChip({}, 'no anchor');
});

test('renderEntry primes tunein.label from the row text at render time (#105)', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.r101821');
  renderEntry({
    text: 'Bayreuth',
    URL: 'http://opml.radiotime.com/Browse.ashx?id=r101821&render=json',
  });
  assert.equal(tc.cache.get('tunein.label.r101821'), 'Bayreuth');
  tc.cache.invalidate('tunein.label.r101821');
});

test('renderEntry primes tunein.label for a station row too (defence-in-depth) (#105)', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.s12345');
  renderEntry({ type: 'audio', guide_id: 's12345', text: 'KEXP' });
  assert.equal(tc.cache.get('tunein.label.s12345'), 'KEXP');
  tc.cache.invalidate('tunein.label.s12345');
});

test('renderPivotChips primes tunein.label.<filter> from pivot chip text (#105)', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.g26');
  renderPivotChips([{
    url:   'http://opml.radiotime.com/Browse.ashx?id=r101821&filter=g26',
    label: 'Country',
    axis:  'genre',
  }]);
  assert.equal(tc.cache.get('tunein.label.g26'), 'Country');
  tc.cache.invalidate('tunein.label.g26');
});

test('renderRelatedChips primes tunein.label from each chip (#105)', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.g79');
  tc.cache.invalidate('tunein.label.l109');
  renderRelatedChips([
    { text: 'Folk', URL: 'http://opml.radiotime.com/Browse.ashx?id=g79', key: 'pivotGenre' },
    {
      text: 'German',
      URL:  'http://opml.radiotime.com/Browse.ashx?id=g79&filter=l109',
      key:  'pivotLanguage',
    },
  ]);
  // Plain drill chip → bare anchor key.
  assert.equal(tc.cache.get('tunein.label.g79'), 'Folk');
  // Filter-bearing chip → bare filter key.
  assert.equal(tc.cache.get('tunein.label.l109'), 'German');
  tc.cache.invalidate('tunein.label.g79');
  tc.cache.invalidate('tunein.label.l109');
});

test('renderEntry does not fire a fetch when priming the cache (#105)', async () => {
  // Wrap fetch and count calls — the primer must be pure cache I/O.
  const realFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    renderEntry({
      text: 'Bayreuth',
      URL: 'http://opml.radiotime.com/Browse.ashx?id=r105_nofetch&render=json',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.r105_nofetch');
  assert.equal(fetchCount, 0, 'primer must not fire a fetch');
});
