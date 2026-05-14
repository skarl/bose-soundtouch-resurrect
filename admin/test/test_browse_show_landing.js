// Tests for app/views/browse/show-landing.js — the c=pbrowse
// Describe + Browse(bare-id) composite. test_browse.js already
// exercises the high-level _renderShowLandingForTest path; these
// per-submodule tests pin the seam contracts so the module remains
// independently testable.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, ev } from './fixtures/dom-shim.js';
void ev;

const {
  _renderShowLandingForTest,
  loadShowLanding,
  renderLiveShowCard,
  renderTopicsCard,
  renderTopicRow,
} = await import('../app/views/browse/show-landing.js');

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

// --- renderLiveShowCard ---------------------------------------------

test('renderLiveShowCard mounts one row per entry, marks the last is-last', () => {
  const card = renderLiveShowCard([
    { type: 'link', item: 'show', guide_id: 'p17', text: 'Fresh Air' },
  ]);
  assert.ok(hasClass(card, 'browse-card'));
  const rows = findAllBy(card, (el) => hasClass(el, 'station-row'));
  assert.equal(rows.length, 1);
  assert.ok(hasClass(rows[0], 'is-last'));
  // p-prefix lights up the inline Play icon (showHero auto-attach).
  const play = findFirstByClass(rows[0], 'station-row__play');
  assert.ok(play, 'liveShow row has the Play icon');
});

test('renderLiveShowCard hero row is a non-anchor body (showHero, not stationRow)', () => {
  // The live-show card is the airing-show subject, not a drill target —
  // the row body never carries an <a> href. #87 regression guard.
  const card = renderLiveShowCard([
    { type: 'link', item: 'show', guide_id: 'p17', text: 'Fresh Air' },
  ]);
  const rows = findAllBy(card, (el) => hasClass(el, 'station-row'));
  assert.notEqual(rows[0].tagName, 'a',
    'live show hero is not an <a> — the page subject has no drill target');
});

// --- renderTopicRow / renderTopicsCard ------------------------------

test('renderTopicRow renders the t-prefix row with formatted duration on the meta line', () => {
  const row = renderTopicRow({
    type: 'link', item: 'topic', guide_id: 't1001', text: 'Episode 1',
    URL: 'http://opml.radiotime.com/Tune.ashx?id=t1001&sid=p17',
    topic_duration: '3600',
  });
  assert.ok(hasClass(row, 'station-row'));
  assert.equal(row.getAttribute('data-sid'), 't1001');
  const loc = findFirstByClass(row, 'station-row__loc');
  assert.ok(loc, 'meta location chunk holds the formatted duration');
  assert.equal(loc.textContent, '1:00:00');
});

test('renderTopicRow falls back to subtext when topic_duration is absent', () => {
  const row = renderTopicRow({
    type: 'link', item: 'topic', guide_id: 't1002', text: 'Episode 2',
    subtext: 'A short summary',
  });
  const loc = findFirstByClass(row, 'station-row__loc');
  assert.equal(loc.textContent, 'A short summary');
});

test('renderTopicRow formats sub-hour durations as M:SS', () => {
  const row = renderTopicRow({
    type: 'link', item: 'topic', guide_id: 't1003', text: 'Short Episode',
    topic_duration: 1830,  // 30:30
  });
  const loc = findFirstByClass(row, 'station-row__loc');
  assert.equal(loc.textContent, '30:30');
});

test('renderTopicRow tolerates malformed topic_duration without crashing', () => {
  const row = renderTopicRow({
    type: 'link', item: 'topic', guide_id: 't1004', text: 'Malformed',
    subtext: 'fallback',
    topic_duration: 'not-a-number',
  });
  const loc = findFirstByClass(row, 'station-row__loc');
  // Unparseable duration falls through to the subtext.
  assert.equal(loc.textContent, 'fallback');
});

test('renderTopicsCard primes the parent + topics-list cache (#88) on render', async () => {
  const tc = await import('../app/tunein-cache.js');
  // Clear any state from earlier tests so the assertion is on this call.
  tc.cache.invalidate('tunein.parent.t8001');
  tc.cache.invalidate('tunein.parent.t8002');
  tc.cache.invalidate('tunein.topics.p99');

  renderTopicsCard([
    {
      type: 'link', item: 'topic', guide_id: 't8001', text: 'A',
      URL: 'http://opml.radiotime.com/Tune.ashx?id=t8001&sid=p99&render=json',
    },
    {
      type: 'link', item: 'topic', guide_id: 't8002', text: 'B',
      URL: 'http://opml.radiotime.com/Tune.ashx?id=t8002&sid=p99&render=json',
    },
  ]);

  assert.equal(tc.cache.get('tunein.parent.t8001'), 'p99');
  assert.equal(tc.cache.get('tunein.parent.t8002'), 'p99');
  assert.deepEqual(tc.cache.get('tunein.topics.p99'), ['t8001', 't8002']);

  tc.cache.invalidate('tunein.parent.t8001');
  tc.cache.invalidate('tunein.parent.t8002');
  tc.cache.invalidate('tunein.topics.p99');
});

// --- _renderShowLandingForTest (Describe + Browse composite) --------

test('_renderShowLandingForTest writes the resolved show title into head.titleEl', () => {
  const describe = {
    head: { status: '200' },
    body: [{
      element: 'show',
      guide_id: 'p17',
      title: 'Fresh Air',
      hosts: 'Terry Gross',
      description: 'A Peabody Award winner.',
      genre_id: 'g168',
    }],
  };
  const body = doc.createElement('div');
  const titleEl = doc.createElement('span');
  _renderShowLandingForTest(body, describe, null, null, { titleEl, crumbToken: 'p17' });
  assert.equal(titleEl.textContent, 'Fresh Air',
    'titleEl is upgraded to the Describe title once the body lands');
});

test('_renderShowLandingForTest renders the show-landing section with data-section="showLanding"', () => {
  const describe = {
    head: { status: '200' },
    body: [{
      element: 'show', guide_id: 'p17', title: 'Fresh Air',
    }],
  };
  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, null);
  const landing = findAllBy(body, (el) => el.getAttribute('data-section') === 'showLanding');
  assert.equal(landing.length, 1);
});

test('_renderShowLandingForTest skips description block when description is empty', () => {
  const describe = {
    head: { status: '200' },
    body: [{
      element: 'show', guide_id: 'p17', title: 'Empty Description Show',
      description: '',
    }],
  };
  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, null);
  const desc = findFirstByClass(body, 'browse-show-description');
  assert.equal(desc, null, 'no description block when description is empty');
});

test('_renderShowLandingForTest splits multi-paragraph description into multiple <p>', () => {
  const describe = {
    head: { status: '200' },
    body: [{
      element: 'show', guide_id: 'p17', title: 'Multi Paragraph',
      description: 'First paragraph.\r\n\r\nSecond paragraph.\r\n\r\nThird paragraph.',
    }],
  };
  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, null);
  const desc = findFirstByClass(body, 'browse-show-description');
  const paras = findAllBy(desc, (el) => el.tagName === 'p');
  assert.equal(paras.length, 3);
  assert.equal(paras[0].textContent, 'First paragraph.');
  assert.equal(paras[2].textContent, 'Third paragraph.');
});

test('_renderShowLandingForTest renders the headerCount based on related entries (Browse body)', () => {
  const describe = {
    head: { status: '200' },
    body: [{ element: 'show', guide_id: 'p17', title: 'Fresh Air' }],
  };
  const browse = {
    head: { title: 'Fresh Air', status: '200' },
    body: [
      {
        text: 'Genres', key: 'genres',
        children: [
          { text: 'Talk', URL: 'http://opml.radiotime.com/Browse.ashx?c=talk' },
          { text: 'Interviews', URL: 'http://opml.radiotime.com/Browse.ashx?id=g168' },
        ],
      },
    ],
  };
  const body = doc.createElement('div');
  const headerCount = doc.createElement('span');
  _renderShowLandingForTest(body, describe, browse, headerCount, null);
  // 2 genre children — header count reflects related-only count.
  assert.match(headerCount.textContent, /^2 entries$/);
});

test('_renderShowLandingForTest renders the empty-state when Describe has no show element', () => {
  const body = doc.createElement('div');
  _renderShowLandingForTest(body, { head: { status: '200' }, body: [] }, null, null, null);
  const empty = findFirstByClass(body, 'browse-empty');
  assert.ok(empty);
  assert.match(empty.textContent, /aren.t available/);
});

// --- issue #105: show landing primes tunein.label.<p-sid> on resolve

test('_renderShowLandingForTest primes tunein.label.<show.guide_id> from the resolved Describe title (#105)', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.p17');
  const describe = {
    head: { status: '200' },
    body: [{
      element: 'show', guide_id: 'p17', title: 'Fresh Air',
    }],
  };
  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, null);
  assert.equal(tc.cache.get('tunein.label.p17'), 'Fresh Air',
    'show landing primes the bare-sid label so back-and-return paints instantly');
  tc.cache.invalidate('tunein.label.p17');
});

test('_renderShowLandingForTest primes the bare-sid label even when the crumb token carries a filter (#105)', async () => {
  // A filter-bearing crumb token (`p17:l109`) used to be the only key
  // primed; a subsequent drill into the bare `p17` would still flash
  // the raw token. The bare-sid primer covers that case.
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.p17');
  tc.cache.invalidate('tunein.label.p17:l109');
  const describe = {
    head: { status: '200' },
    body: [{ element: 'show', guide_id: 'p17', title: 'Fresh Air' }],
  };
  const body = doc.createElement('div');
  _renderShowLandingForTest(body, describe, null, null, {
    titleEl: doc.createElement('span'),
    crumbToken: 'p17:l109',
  });
  // Both the filter-bearing combined token AND the bare sid are primed.
  assert.equal(tc.cache.get('tunein.label.p17:l109'), 'Fresh Air');
  assert.equal(tc.cache.get('tunein.label.p17'), 'Fresh Air');
  tc.cache.invalidate('tunein.label.p17');
  tc.cache.invalidate('tunein.label.p17:l109');
});

test('renderTopicsCard primes tunein.label.<t-sid> from each topic row text (#105)', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.t105_a');
  tc.cache.invalidate('tunein.label.t105_b');
  renderTopicsCard([
    {
      type: 'link', item: 'topic', guide_id: 't105_a', text: 'Episode A',
      URL: 'http://opml.radiotime.com/Tune.ashx?id=t105_a&sid=p17&render=json',
    },
    {
      type: 'link', item: 'topic', guide_id: 't105_b', text: 'Episode B',
      URL: 'http://opml.radiotime.com/Tune.ashx?id=t105_b&sid=p17&render=json',
    },
  ]);
  assert.equal(tc.cache.get('tunein.label.t105_a'), 'Episode A');
  assert.equal(tc.cache.get('tunein.label.t105_b'), 'Episode B');
  tc.cache.invalidate('tunein.label.t105_a');
  tc.cache.invalidate('tunein.label.t105_b');
});

test('renderLiveShowCard primes tunein.label.<p-sid> from the airing show entry (#105)', async () => {
  const tc = await import('../app/tunein-cache.js');
  tc.cache.invalidate('tunein.label.p105');
  renderLiveShowCard([
    { type: 'link', item: 'show', guide_id: 'p105', text: 'Fresh Air' },
  ]);
  assert.equal(tc.cache.get('tunein.label.p105'), 'Fresh Air');
  tc.cache.invalidate('tunein.label.p105');
});

// --- loadShowLanding: Browse-half routed through resolveBrowseDrill (#123) ---
//
// The migration moves `tuneinBrowse(showId).catch(() => null)` onto the
// structured drill seam. Behavioural parity for valid drills and for
// rejected ones is unchanged; the gain is that empty / error / tombstone
// classification is explicit. This unit drives loadShowLanding end-to-end
// with a stubbed globalThis.fetch: Describe resolves with a show body so
// the card mounts, and Browse rejects (network down) so resolveBrowseDrill
// classifies it as kind:'error'. The expected outcome is parity with the
// pre-migration swallowed-rejection behaviour: show card present, no
// related-sections cards.

test('#123 loadShowLanding: kind:error from resolveBrowseDrill still mounts the show card with no related-sections card', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = typeof url === 'string' ? url : String(url);
    if (u.includes('/tunein/describe')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          head: { status: '200' },
          body: [{
            element: 'show',
            guide_id: 'p17',
            title: 'Fresh Air',
            hosts: 'Terry Gross',
            description: 'A Peabody Award winner.',
            genre_id: 'g168',
          }],
        }),
      };
    }
    if (u.includes('/tunein/browse')) {
      // Network-down-style throw — the resolver classifies this as
      // kind:'error' with code 'ERROR'.
      throw new Error('failed to fetch');
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  try {
    const body = doc.createElement('div');
    const headerCount = doc.createElement('span');
    loadShowLanding(body, 'p17', headerCount, null);

    // Let the Describe + drill-seam promises settle. The chain is:
    //   fetch → res.json() → tuneinDescribe/Browse → resolveBrowseDrill
    //     → Promise.all → renderShowLandingBody
    // each `await` advances one microtask turn; a macrotask boundary
    // (setTimeout 0) flushes the whole chain reliably.
    await new Promise((r) => setTimeout(r, 0));

    // Show card mounted from the Describe response.
    const landings = findAllBy(body, (el) => el.getAttribute('data-section') === 'showLanding');
    assert.equal(landings.length, 1, 'show-landing card renders despite Browse-half error');

    // No other sections — kind:'error' collapses to "no related sections",
    // matching the pre-migration swallowed-rejection behaviour.
    const sections = findAllBy(body, (el) => el.getAttribute('data-section') != null);
    assert.equal(sections.length, 1, 'no related-sections card mounts when Browse errored');

    // Header count is blank — relatedCount stays 0 when no related sections render.
    assert.equal(headerCount.textContent, '');
  } finally {
    globalThis.fetch = realFetch;
  }
});
