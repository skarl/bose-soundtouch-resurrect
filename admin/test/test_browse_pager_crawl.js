// Tests for app/views/browse/pager-crawl.js — the per-section "Load
// more" pager mounts + the eager-serial filter-crawl coordinator.
// test_browse.js covers the integrated coordinator path via the
// re-exports on views/browse.js; these per-submodule tests pin the
// seam contracts directly on the pager-crawl module so it remains
// independently testable.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, ev } from './fixtures/dom-shim.js';
void ev;

const {
  mountLoadMoreButtons,
  appendNewRows,
  disposeActivePagers,
  setFilterInput,
  applyDomFilter,
  currentFilterQuery,
  ensureCoordinator,
  filterRowEntries,
  _setActivePagersForTest,
  _setFilterInputForTest,
  _resetBrowseStateForTest,
  _ensureCoordinatorForTest,
  _applyDomFilterForTest,
  _getCoordinatorForTest,
} = await import('../app/views/browse/pager-crawl.js');

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

// Build a minimal drill-view DOM tree. The structure mirrors what
// renderDrill mounts: section[data-view="browse"] wrapping an
// optional input + a browse-body that hosts one .browse-section
// per requested section key.
function buildDrillTree({ sections } = { sections: [] }) {
  const root = doc.createElement('section');
  root.setAttribute('data-view', 'browse');
  root.setAttribute('data-mode', 'drill');

  const input = doc.createElement('input');
  input.setAttribute('type', 'search');
  root.appendChild(input);

  const body = doc.createElement('div');
  body.className = 'browse-body';
  for (const key of sections) {
    const sec = doc.createElement('section');
    sec.className = 'browse-section';
    sec.setAttribute('data-section', key);
    const footer = doc.createElement('div');
    footer.className = 'browse-section__footer';
    sec.appendChild(footer);
    body.appendChild(sec);
  }
  root.appendChild(body);
  return { root, input, body };
}

// Stub a pager with the minimal surface the coordinator reads.
function makeStubPager(section, step) {
  const state = {
    rows: [],
    exhausted: false,
    pagesFetched: 0,
    section,
    sectionCap: 50,
  };
  return {
    get rows() { return state.rows; },
    get exhausted() { return state.exhausted; },
    get pagesFetched() { return state.pagesFetched; },
    get status() {
      return {
        section: state.section,
        scanned: state.pagesFetched,
        sectionCap: state.sectionCap,
        exhausted: state.exhausted,
      };
    },
    async loadMore() {
      if (state.exhausted) return { added: 0, exhausted: true };
      const r = await step();
      state.pagesFetched++;
      if (r && r.exhausted) state.exhausted = true;
      return r;
    },
    dispose() { state.exhausted = true; },
  };
}

// --- filterRowEntries: 3-line filter rule ---------------------------

test('filterRowEntries: empty query passes every row through', () => {
  const rows = [{ text: 'A' }, { text: 'B' }];
  assert.deepEqual(filterRowEntries(rows, ''), rows);
});

test('filterRowEntries: matches across text / subtext / playing / current_track', () => {
  const rows = [
    { text: 'BBC One',  subtext: 'UK' },
    { text: 'NPR',      playing: 'BBC news segment' },
    { text: 'KEXP',     current_track: 'BBC News' },
    { text: 'Other',    subtext: 'no match here' },
  ];
  const matched = filterRowEntries(rows, 'bbc').map((r) => r.text);
  assert.deepEqual(matched.sort(), ['BBC One', 'KEXP', 'NPR']);
});

test('filterRowEntries: query is trimmed and lowercased', () => {
  const rows = [{ text: 'BBC One' }, { text: 'Other' }];
  assert.deepEqual(filterRowEntries(rows, '  BBC  ').map((r) => r.text), ['BBC One']);
});

// --- setFilterInput + currentFilterQuery ----------------------------

test('currentFilterQuery returns "" when no input is registered', () => {
  _resetBrowseStateForTest();
  assert.equal(currentFilterQuery(), '');
});

test('currentFilterQuery reads the trimmed lowercased value from the registered input', () => {
  _resetBrowseStateForTest();
  const input = doc.createElement('input');
  input.setAttribute('value', '  BBC  ');
  setFilterInput(input);
  assert.equal(currentFilterQuery(), 'bbc');
  _resetBrowseStateForTest();
});

// --- mountLoadMoreButtons -------------------------------------------

test('mountLoadMoreButtons mounts one button per section with a data-cursor-url', () => {
  _resetBrowseStateForTest();
  const { body } = buildDrillTree({ sections: ['stations', 'shows'] });
  // Park a cursor on the first section; leave the second uncursored.
  const stations = findAllBy(body, (el) => el.getAttribute('data-section') === 'stations')[0];
  stations.setAttribute('data-cursor-url', 'http://opml.radiotime.com/Browse.ashx?id=g79&offset=1');

  mountLoadMoreButtons(body, { fetcher: async () => ({ head: {}, body: [] }) });

  const btns = findAllBy(body, (el) => hasClass(el, 'browse-load-more'));
  assert.equal(btns.length, 1, 'one button mounted for the section with a cursor');
  assert.equal(btns[0].getAttribute('data-load-more'), 'stations');
  assert.equal(btns[0].getAttribute('data-state'), 'idle');

  _resetBrowseStateForTest();
});

test('mountLoadMoreButtons mounts nothing when no section carries data-cursor-url', () => {
  _resetBrowseStateForTest();
  const { body } = buildDrillTree({ sections: ['stations'] });
  mountLoadMoreButtons(body);
  const btns = findAllBy(body, (el) => hasClass(el, 'browse-load-more'));
  assert.equal(btns.length, 0);
});

// --- appendNewRows lazily creates a .browse-card --------------------

test('appendNewRows mounts a .browse-card when the section has none yet', () => {
  _resetBrowseStateForTest();
  const { body } = buildDrillTree({ sections: ['stations'] });
  const section = findAllBy(body, (el) => el.getAttribute('data-section') === 'stations')[0];
  // No card pre-mounted.
  assert.equal(findFirstByClass(section, 'browse-card'), null);

  const pager = makeStubPager('stations', async () => ({ added: 1, exhausted: true }));
  // Hand the pager one row so appendNewRows has something to render.
  pager.rows.push({ type: 'audio', guide_id: 's999', text: 'Late Row' });
  appendNewRows(section, pager);

  const card = findFirstByClass(section, 'browse-card');
  assert.ok(card, 'browse-card was created lazily');
  assert.equal(section.getAttribute('data-pager-mounted'), '1');
});

test('appendNewRows only appends rows beyond data-pager-mounted on subsequent calls', () => {
  _resetBrowseStateForTest();
  const { body } = buildDrillTree({ sections: ['stations'] });
  const section = findAllBy(body, (el) => el.getAttribute('data-section') === 'stations')[0];
  const pager = makeStubPager('stations', async () => ({ added: 0, exhausted: false }));

  pager.rows.push({ type: 'audio', guide_id: 's1', text: 'One' });
  pager.rows.push({ type: 'audio', guide_id: 's2', text: 'Two' });
  appendNewRows(section, pager);
  let stationRows = findAllBy(section, (el) => hasClass(el, 'station-row'));
  assert.equal(stationRows.length, 2);

  // Push one more row; appendNewRows should only mount the delta.
  pager.rows.push({ type: 'audio', guide_id: 's3', text: 'Three' });
  appendNewRows(section, pager);
  stationRows = findAllBy(section, (el) => hasClass(el, 'station-row'));
  assert.equal(stationRows.length, 3, 'third row appended, earlier two not duplicated');
});

// --- coordinator section ordering -----------------------------------

test('ensureCoordinator walks sections serially in CRAWL_SECTION_ORDER', async () => {
  _resetBrowseStateForTest();
  const { root, input, body } = buildDrillTree({ sections: ['local', 'stations'] });
  doc.documentElement.appendChild(root);

  const callLog = [];

  let localPages = 0;
  const localPager = makeStubPager('local', async () => {
    callLog.push(`local-${localPages + 1}`);
    localPages++;
    return localPages === 1
      ? { added: 1, exhausted: false }
      : { added: 1, exhausted: true };
  });

  let stationsPages = 0;
  const stationsPager = makeStubPager('stations', async () => {
    callLog.push(`stations-${stationsPages + 1}`);
    assert.equal(localPager.exhausted, true,
      'stations.loadMore must not start until local has exhausted');
    stationsPages++;
    return { added: 1, exhausted: true };
  });

  _setActivePagersForTest([localPager, stationsPager]);
  _setFilterInputForTest(input);
  input.setAttribute('value', 'bbc');

  await _ensureCoordinatorForTest();

  assert.deepEqual(callLog, ['local-1', 'local-2', 'stations-1'],
    `serial ordering: ${callLog.join(', ')}`);

  _resetBrowseStateForTest();
  if (root.parentNode) root.parentNode.removeChild(root);
  void body;
});

// --- coordinator no-op when no pagers are present -------------------

test('ensureCoordinator resolves immediately with no active pagers', async () => {
  _resetBrowseStateForTest();
  // No pagers, no filter input — coordinator should be a no-op promise.
  const result = await ensureCoordinator();
  assert.equal(result, undefined);
  assert.equal(_getCoordinatorForTest(), null,
    'coordinator stays null when there is nothing to crawl');
});

// --- DOM filter applies + clears -----------------------------------

test('applyDomFilter toggles is-filtered-out on non-matching rows', () => {
  _resetBrowseStateForTest();
  const { root, input } = buildDrillTree({ sections: ['stations'] });
  const section = findAllBy(root, (el) => el.getAttribute('data-section') === 'stations')[0];

  // Manually pin _outline on three rows so applyDomFilter can match.
  const card = doc.createElement('div');
  card.className = 'browse-card';
  const r1 = doc.createElement('a'); r1.className = 'station-row'; r1._outline = { text: 'BBC' };
  const r2 = doc.createElement('a'); r2.className = 'station-row'; r2._outline = { text: 'NPR' };
  const r3 = doc.createElement('a'); r3.className = 'station-row'; r3._outline = { text: 'BBC Two' };
  card.appendChild(r1); card.appendChild(r2); card.appendChild(r3);
  section.insertBefore(card, findFirstByClass(section, 'browse-section__footer'));

  setFilterInput(input);
  input.setAttribute('value', 'bbc');
  _applyDomFilterForTest(root);

  assert.equal(hasClass(r1, 'is-filtered-out'), false);
  assert.equal(hasClass(r2, 'is-filtered-out'), true, 'NPR hidden under bbc filter');
  assert.equal(hasClass(r3, 'is-filtered-out'), false);

  // Clearing the filter restores visibility.
  input.setAttribute('value', '');
  _applyDomFilterForTest(root);
  assert.equal(hasClass(r2, 'is-filtered-out'), false);

  _resetBrowseStateForTest();
});

// --- disposeActivePagers tidies up ----------------------------------

test('disposeActivePagers tears down both pagers and the filter input handle', () => {
  _resetBrowseStateForTest();
  const pagers = [
    makeStubPager('stations', async () => ({ added: 0, exhausted: true })),
    makeStubPager('shows',    async () => ({ added: 0, exhausted: true })),
  ];
  _setActivePagersForTest(pagers);
  const input = doc.createElement('input');
  input.setAttribute('value', 'bbc');
  setFilterInput(input);

  disposeActivePagers();

  // After disposal the filter input is no longer reachable, and
  // current query reads as empty.
  assert.equal(currentFilterQuery(), '');
  // Pagers are marked disposed (exhausted is the visible signal).
  for (const p of pagers) assert.equal(p.exhausted, true);
});
