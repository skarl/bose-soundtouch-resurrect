// Tests for app/views/now-playing-data.js — the topic-cache
// coordination helpers extracted out of views/now-playing.js.
//
// Unlike test_now_playing.js these don't mount the view. The data
// module is a set of pure(-ish) functions over (json | topicId | np)
// plus the shared tunein-cache, so the tests exercise it directly.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { installSessionStorage } from './fixtures/dom-shim.js';

installSessionStorage();

// fetch stub for the lazyFetchTopicsList tests — overridden per-test.
globalThis.fetch = () => new Promise(() => {});

const {
  extractTopicIds,
  cacheTopicNames,
  labelForTopic,
  lazyFetchTopicsList,
} = await import('../app/views/now-playing-data.js');

const tc = await import('../app/tunein-cache.js');
const ts = await import('../app/transport-state.js');

// --- extractTopicIds -----------------------------------------------

test('extractTopicIds: pulls t-prefix guide_ids out of a flat body', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic', guide_id: 't100', URL: 'Tune.ashx?id=t100&sid=p17' },
      { type: 'link', item: 'topic', guide_id: 't200', URL: 'Tune.ashx?id=t200&sid=p17' },
      { type: 'link', item: 'topic', guide_id: 't300', URL: 'Tune.ashx?id=t300&sid=p17' },
    ],
  };
  assert.deepEqual(extractTopicIds(json), ['t100', 't200', 't300']);
});

test('extractTopicIds: descends into section.children containers', () => {
  const json = {
    body: [{
      element: 'outline',
      text: 'Episodes',
      children: [
        { type: 'link', item: 'topic', guide_id: 't100', URL: 'Tune.ashx?id=t100&sid=p17' },
        { type: 'link', item: 'topic', guide_id: 't200', URL: 'Tune.ashx?id=t200&sid=p17' },
      ],
    }],
  };
  assert.deepEqual(extractTopicIds(json), ['t100', 't200']);
});

test('extractTopicIds: drops station siblings (s-prefix) in the same body', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic',   guide_id: 't100', URL: 'Tune.ashx?id=t100&sid=p17' },
      { type: 'audio', item: 'station', guide_id: 's12345', URL: 'Tune.ashx?id=s12345' },
      { type: 'link', item: 'topic',   guide_id: 't200', URL: 'Tune.ashx?id=t200&sid=p17' },
    ],
  };
  assert.deepEqual(extractTopicIds(json), ['t100', 't200']);
});

test('extractTopicIds: drops cursors / pivots / non-outline entries', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic',  guide_id: 't100', URL: 'Tune.ashx?id=t100&sid=p17' },
      // Cursor row — classifyOutline rejects this.
      { type: 'link', text: 'More',   URL: 'http://example/next', key: 'nextStations' },
      // Pivot row — also rejected.
      { element: 'pivot', text: 'Country', URL: 'http://example/p' },
      { type: 'link', item: 'topic',  guide_id: 't200', URL: 'Tune.ashx?id=t200&sid=p17' },
    ],
  };
  assert.deepEqual(extractTopicIds(json), ['t100', 't200']);
});

test('extractTopicIds: missing body / wrong shape returns []', () => {
  assert.deepEqual(extractTopicIds(null), []);
  assert.deepEqual(extractTopicIds({}), []);
  assert.deepEqual(extractTopicIds({ body: null }), []);
  assert.deepEqual(extractTopicIds({ body: 'string' }), []);
});

test('extractTopicIds: ignores entries with non-t-prefix guide_ids', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic', guide_id: 'r123', URL: 'Tune.ashx?id=r123' },
      { type: 'link', item: 'topic', guide_id: 't200', URL: 'Tune.ashx?id=t200&sid=p17' },
    ],
  };
  assert.deepEqual(extractTopicIds(json), ['t200']);
});

// --- cacheTopicNames -----------------------------------------------

test('cacheTopicNames: writes tunein.topicname.<t<N>> for each t-row', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic', guide_id: 't9100',
        text: 'Episode A', URL: 'Tune.ashx?id=t9100&sid=p17' },
      { type: 'link', item: 'topic', guide_id: 't9200',
        text: 'Episode B', URL: 'Tune.ashx?id=t9200&sid=p17' },
    ],
  };
  cacheTopicNames(json);
  assert.equal(tc.cache.get(ts.topicNameKey('t9100')), 'Episode A');
  assert.equal(tc.cache.get(ts.topicNameKey('t9200')), 'Episode B');
  tc.cache.invalidate(ts.topicNameKey('t9100'));
  tc.cache.invalidate(ts.topicNameKey('t9200'));
});

test('cacheTopicNames: descends into section.children containers', () => {
  const json = {
    body: [{
      element: 'outline',
      children: [
        { type: 'link', item: 'topic', guide_id: 't9301',
          text: 'Nested Episode', URL: 'Tune.ashx?id=t9301&sid=p17' },
      ],
    }],
  };
  cacheTopicNames(json);
  assert.equal(tc.cache.get(ts.topicNameKey('t9301')), 'Nested Episode');
  tc.cache.invalidate(ts.topicNameKey('t9301'));
});

test('cacheTopicNames: skips rows with empty / whitespace text', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic', guide_id: 't9400', text: '',
        URL: 'Tune.ashx?id=t9400&sid=p17' },
      { type: 'link', item: 'topic', guide_id: 't9401', text: '   ',
        URL: 'Tune.ashx?id=t9401&sid=p17' },
    ],
  };
  cacheTopicNames(json);
  assert.equal(tc.cache.get(ts.topicNameKey('t9400')), undefined);
  assert.equal(tc.cache.get(ts.topicNameKey('t9401')), undefined);
});

test('cacheTopicNames: ignores non-t-prefix guide_ids', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic',   guide_id: 's12345',
        text: 'Station', URL: 'Tune.ashx?id=s12345' },
      { type: 'link', item: 'topic',   guide_id: 'p17',
        text: 'Show', URL: 'Tune.ashx?id=p17' },
    ],
  };
  cacheTopicNames(json);
  assert.equal(tc.cache.get(ts.topicNameKey('s12345')), undefined);
  assert.equal(tc.cache.get(ts.topicNameKey('p17')), undefined);
});

test('cacheTopicNames: trims surrounding whitespace from the title', () => {
  const json = {
    body: [
      { type: 'link', item: 'topic', guide_id: 't9500',
        text: '   Padded Title   ', URL: 'Tune.ashx?id=t9500&sid=p17' },
    ],
  };
  cacheTopicNames(json);
  assert.equal(tc.cache.get(ts.topicNameKey('t9500')), 'Padded Title');
  tc.cache.invalidate(ts.topicNameKey('t9500'));
});

// --- labelForTopic --------------------------------------------------

test('labelForTopic: cached topicname wins over everything else', () => {
  tc.cache.set(ts.topicNameKey('t9600'), 'Canonical Title', tc.TTL_LABEL);
  const np = {
    item: { name: 'Stale itemName', location: '/v1/playback/station/t9600' },
  };
  assert.equal(labelForTopic('t9600', np), 'Canonical Title');
  tc.cache.invalidate(ts.topicNameKey('t9600'));
});

test('labelForTopic: falls back to nowPlaying.item.name when cache empty + same topic', () => {
  tc.cache.invalidate(ts.topicNameKey('t9601'));
  const np = {
    item: { name: 'Episode From Firmware', location: '/v1/playback/station/t9601' },
  };
  assert.equal(labelForTopic('t9601', np), 'Episode From Firmware');
});

test('labelForTopic: ignores itemName when it equals the raw guide_id (stale sid degrade)', () => {
  tc.cache.invalidate(ts.topicNameKey('t9602'));
  const np = {
    item: { name: 't9602', location: '/v1/playback/station/t9602' },
  };
  // Should fall through to the topic id as the last-resort label.
  assert.equal(labelForTopic('t9602', np), 't9602');
});

test('labelForTopic: ignores itemName when nowPlaying is on a different topic', () => {
  tc.cache.invalidate(ts.topicNameKey('t9603'));
  const np = {
    item: { name: 'Different Episode', location: '/v1/playback/station/t9700' },
  };
  // Asked about t9603 but nowPlaying is on t9700 — fall back to the id.
  assert.equal(labelForTopic('t9603', np), 't9603');
});

test('labelForTopic: last-resort fallback is the topic id itself', () => {
  tc.cache.invalidate(ts.topicNameKey('t9604'));
  assert.equal(labelForTopic('t9604', null), 't9604');
  assert.equal(labelForTopic('t9604', { item: {} }), 't9604');
  assert.equal(labelForTopic('t9604', undefined), 't9604');
});

// --- lazyFetchTopicsList -------------------------------------------

test('lazyFetchTopicsList: returns cached list without fetching', async () => {
  const parent = 'p9700';
  tc.cache.set(ts.topicsKey(parent), ['t100', 't200', 't300'], tc.TTL_DRILL_HEAD);

  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; return Promise.reject(new Error('no fetch')); };

  try {
    const ids = await lazyFetchTopicsList(parent);
    assert.deepEqual(ids, ['t100', 't200', 't300']);
    assert.equal(fetchCalled, false, 'cached list short-circuits the fetch');
  } finally {
    globalThis.fetch = realFetch;
    tc.cache.invalidate(ts.topicsKey(parent));
  }
});

test('lazyFetchTopicsList: fetches, extracts ids, caches them, primes topic names', async () => {
  const parent = 'p9701';
  tc.cache.invalidate(ts.topicsKey(parent));

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        head: { status: '200' },
        body: [
          { type: 'link', item: 'topic', guide_id: 't9701',
            text: 'Episode One',  URL: 'Tune.ashx?id=t9701&sid=p9701' },
          { type: 'link', item: 'topic', guide_id: 't9702',
            text: 'Episode Two',  URL: 'Tune.ashx?id=t9702&sid=p9701' },
          { type: 'link', item: 'topic', guide_id: 't9703',
            text: 'Episode Three', URL: 'Tune.ashx?id=t9703&sid=p9701' },
        ],
      }),
    };
  };

  try {
    const ids = await lazyFetchTopicsList(parent);
    assert.deepEqual(ids, ['t9701', 't9702', 't9703']);
    assert.equal(calls.length, 1, 'one fetch issued');
    assert.ok(calls[0].includes('c=topics'), 'request asked for c=topics');
    assert.ok(calls[0].includes(`id=${parent}`), 'request carried the parent id');
    // Topic names should be cached alongside the list.
    assert.equal(tc.cache.get(ts.topicNameKey('t9701')), 'Episode One');
    assert.equal(tc.cache.get(ts.topicNameKey('t9702')), 'Episode Two');
    assert.equal(tc.cache.get(ts.topicNameKey('t9703')), 'Episode Three');
    // Topics list itself should be cached too.
    assert.deepEqual(tc.cache.get(ts.topicsKey(parent)), ['t9701', 't9702', 't9703']);
  } finally {
    globalThis.fetch = realFetch;
    tc.cache.invalidate(ts.topicsKey(parent));
    tc.cache.invalidate(ts.topicNameKey('t9701'));
    tc.cache.invalidate(ts.topicNameKey('t9702'));
    tc.cache.invalidate(ts.topicNameKey('t9703'));
  }
});

test('lazyFetchTopicsList: returns [] and swallows network errors', async () => {
  const parent = 'p9702';
  tc.cache.invalidate(ts.topicsKey(parent));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };

  try {
    const ids = await lazyFetchTopicsList(parent);
    assert.deepEqual(ids, []);
  } finally {
    globalThis.fetch = realFetch;
    tc.cache.invalidate(ts.topicsKey(parent));
  }
});

test('lazyFetchTopicsList: caches 1-entry results (so we don\'t refetch on every tap)', async () => {
  const parent = 'p9703';
  tc.cache.invalidate(ts.topicsKey(parent));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      head: { status: '200' },
      body: [
        { type: 'link', item: 'topic', guide_id: 't9704',
          text: 'Only Episode', URL: 'Tune.ashx?id=t9704&sid=p9703' },
      ],
    }),
  });

  try {
    const ids = await lazyFetchTopicsList(parent);
    assert.deepEqual(ids, ['t9704']);
    // Even a 1-entry result is cached — the classifier rejects length < 2
    // anyway, but the cache write prevents a refetch storm.
    assert.deepEqual(tc.cache.get(ts.topicsKey(parent)), ['t9704']);
  } finally {
    globalThis.fetch = realFetch;
    tc.cache.invalidate(ts.topicsKey(parent));
    tc.cache.invalidate(ts.topicNameKey('t9704'));
  }
});
