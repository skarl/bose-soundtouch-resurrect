// Tests for admin/app/transport-state.js — pure helpers driving the
// now-playing transport row's buffering glyph + Prev/Next enablement.
//
// All four helpers are framework-free (no DOM, no fetch, no store) so
// we exercise them directly. The cache-key helpers are intentionally
// trivial; we keep one round-trip test each so a rename can't drift
// from the caller in components.js / browse.js / now-playing.js.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const {
  transportPhase,
  classifyPrevNext,
  extractGuideIdFromLocation,
  extractParentShowId,
  parentKey,
  topicsKey,
} = await import('../app/transport-state.js');

// --- transportPhase --------------------------------------------------

test('transportPhase: null nowPlaying → idle', () => {
  assert.equal(transportPhase(null), 'idle');
  assert.equal(transportPhase(undefined), 'idle');
});

test('transportPhase: STANDBY source wins over playStatus', () => {
  assert.equal(
    transportPhase({ source: 'STANDBY', playStatus: 'PLAY_STATE' }),
    'standby',
    'STANDBY overrides even an erroneous PLAY_STATE',
  );
  assert.equal(transportPhase({ source: 'STANDBY' }), 'standby');
});

test('transportPhase: PLAY_STATE → playing', () => {
  assert.equal(
    transportPhase({
      source: 'TUNEIN',
      item: { location: '/v1/playback/station/s12345', name: 'KEXP' },
      playStatus: 'PLAY_STATE',
    }),
    'playing',
  );
});

test('transportPhase: PAUSE_STATE → paused', () => {
  assert.equal(
    transportPhase({
      source: 'TUNEIN',
      item: { location: '/v1/playback/station/s12345', name: 'KEXP' },
      playStatus: 'PAUSE_STATE',
    }),
    'paused',
  );
});

test('transportPhase: BUFFERING_STATE with selected item → buffering', () => {
  assert.equal(
    transportPhase({
      source: 'TUNEIN',
      item: { location: '/v1/playback/station/p17', name: 'Fresh Air' },
      playStatus: 'BUFFERING_STATE',
    }),
    'buffering',
  );
});

test('transportPhase: STOP_STATE with no item → idle', () => {
  assert.equal(
    transportPhase({ source: 'TUNEIN', item: { location: '', name: '' }, playStatus: 'STOP_STATE' }),
    'idle',
  );
});

test('transportPhase: INVALID_PLAY_STATUS with no item → idle', () => {
  assert.equal(
    transportPhase({ source: 'TUNEIN', item: {}, playStatus: 'INVALID_PLAY_STATUS' }),
    'idle',
  );
});

test('transportPhase: STOP_STATE with item still selected → paused', () => {
  // For TUNEIN streams Bo emits STOP_STATE when the user pauses (the
  // stream ends rather than freezing). The Play button must stay
  // tappable so a resume is possible — treating STOP_STATE as paused
  // keeps the resume contract honest. Only the explicit BUFFERING_STATE
  // drives the loading glyph.
  assert.equal(
    transportPhase({
      source: 'TUNEIN',
      item: { location: '/v1/playback/station/s24896', name: 'SWR3' },
      playStatus: 'STOP_STATE',
    }),
    'paused',
  );
});

test('transportPhase: INVALID_PLAY_STATUS with item selected → idle (no resume possible)', () => {
  // INVALID_PLAY_STATUS means the firmware can't classify the state;
  // we don't pretend the button is resumable.
  assert.equal(
    transportPhase({
      source: 'TUNEIN',
      item: { location: '/v1/playback/station/s24896', name: 'SWR3' },
      playStatus: 'INVALID_PLAY_STATUS',
    }),
    'idle',
  );
});

test('transportPhase: empty playStatus + no item → idle', () => {
  assert.equal(transportPhase({ source: 'BLUETOOTH', item: {} }), 'idle');
});

// --- extractGuideIdFromLocation -------------------------------------

test('extractGuideIdFromLocation: station path', () => {
  assert.equal(
    extractGuideIdFromLocation('/v1/playback/station/s12345'),
    's12345',
  );
});

test('extractGuideIdFromLocation: show path (p prefix)', () => {
  assert.equal(
    extractGuideIdFromLocation('/v1/playback/station/p17'),
    'p17',
  );
});

test('extractGuideIdFromLocation: topic path (t prefix)', () => {
  assert.equal(
    extractGuideIdFromLocation('/v1/playback/station/t123456'),
    't123456',
  );
});

test('extractGuideIdFromLocation: unsupported prefix returns null', () => {
  assert.equal(extractGuideIdFromLocation('/v1/playback/station/g79'), null);
  assert.equal(extractGuideIdFromLocation(''), null);
  assert.equal(extractGuideIdFromLocation(null), null);
});

// --- extractParentShowId --------------------------------------------

test('extractParentShowId: topic outline with sid=p<N> returns p<N>', () => {
  const outline = {
    type: 'link',
    item: 'topic',
    guide_id: 't1234',
    URL: 'http://opml.radiotime.com/Tune.ashx?id=t1234&sid=p17&render=json',
  };
  assert.equal(extractParentShowId(outline), 'p17');
});

test('extractParentShowId: missing sid returns null', () => {
  assert.equal(
    extractParentShowId({ URL: 'http://opml.radiotime.com/Tune.ashx?id=t1234' }),
    null,
  );
});

test('extractParentShowId: missing URL returns null', () => {
  assert.equal(extractParentShowId({ guide_id: 't1' }), null);
  assert.equal(extractParentShowId(null), null);
  assert.equal(extractParentShowId({}), null);
});

test('extractParentShowId: non-p sid (legacy) returns null', () => {
  assert.equal(
    extractParentShowId({ URL: 'Tune.ashx?id=t1&sid=s99' }),
    null,
    'sid must be p-prefixed for the parent-show contract',
  );
});

// --- classifyPrevNext: source matrix --------------------------------

test('classifyPrevNext: STANDBY → both disabled', () => {
  const r = classifyPrevNext({ source: 'STANDBY' });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: AUX → both disabled', () => {
  const r = classifyPrevNext({ source: 'AUX' });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: BLUETOOTH → both enabled, firmware mode', () => {
  const r = classifyPrevNext({
    source: 'BLUETOOTH',
    item: { location: '', name: '' },
    playStatus: 'PLAY_STATE',
  });
  assert.equal(r.prev, true);
  assert.equal(r.next, true);
  assert.equal(r.mode, 'firmware');
});

test('classifyPrevNext: UPNP → both enabled, firmware mode', () => {
  const r = classifyPrevNext({ source: 'UPNP', item: {} });
  assert.equal(r.prev, true);
  assert.equal(r.next, true);
  assert.equal(r.mode, 'firmware');
});

test('classifyPrevNext: SPOTIFY → both enabled, firmware mode', () => {
  const r = classifyPrevNext({ source: 'SPOTIFY', item: {} });
  assert.equal(r.prev, true);
  assert.equal(r.next, true);
  assert.equal(r.mode, 'firmware');
});

test('classifyPrevNext: TUNEIN station (s-prefix) → both disabled', () => {
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/s24896', name: 'SWR3' },
  });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: TUNEIN show (p-prefix) → both disabled', () => {
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/p17', name: 'Fresh Air' },
  });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: TUNEIN topic without cached parent → disabled', () => {
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/t456789', name: 'Episode' },
  });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: topic with parent but only 1 sibling → disabled', () => {
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/t456789', name: 'Episode' },
  }, {
    parentShowId: 'p17',
    siblings: ['t456789'],
  });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: topic mid-list → both enabled, topic-list mode', () => {
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/t2', name: 'B' },
  }, {
    parentShowId: 'p17',
    siblings: ['t1', 't2', 't3', 't4'],
  });
  assert.equal(r.prev, true);
  assert.equal(r.next, true);
  assert.equal(r.mode, 'topic-list');
  assert.equal(r.prevId, 't1');
  assert.equal(r.nextId, 't3');
  assert.equal(r.currentId, 't2');
});

test('classifyPrevNext: topic at first index → prev disabled, next enabled', () => {
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/t1', name: 'A' },
  }, {
    parentShowId: 'p17',
    siblings: ['t1', 't2', 't3'],
  });
  assert.equal(r.prev, false, 'first item has no Prev');
  assert.equal(r.next, true);
  assert.equal(r.prevId, null);
  assert.equal(r.nextId, 't2');
});

test('classifyPrevNext: topic at last index → next disabled, prev enabled', () => {
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/t3', name: 'C' },
  }, {
    parentShowId: 'p17',
    siblings: ['t1', 't2', 't3'],
  });
  assert.equal(r.prev, true);
  assert.equal(r.next, false, 'last item has no Next');
  assert.equal(r.prevId, 't2');
  assert.equal(r.nextId, null);
});

test('classifyPrevNext: topic outside cached list → disabled', () => {
  // Defence-in-depth — the user got to the topic via a paged list
  // that doesn't include the playing one. Don't enable speculatively.
  const r = classifyPrevNext({
    source: 'TUNEIN',
    item: { location: '/v1/playback/station/t999', name: 'Distant' },
  }, {
    parentShowId: 'p17',
    siblings: ['t1', 't2', 't3'],
  });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: TUNEIN with empty location → disabled', () => {
  const r = classifyPrevNext({ source: 'TUNEIN', item: { location: '', name: '' } });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

test('classifyPrevNext: unknown source → disabled', () => {
  const r = classifyPrevNext({ source: 'CUSTOM_PROVIDER', item: {} });
  assert.equal(r.prev, false);
  assert.equal(r.next, false);
  assert.equal(r.mode, 'disabled');
});

// --- cache-key helpers ----------------------------------------------

test('parentKey: stable shape `tunein.parent.<topic>`', () => {
  assert.equal(parentKey('t456789'), 'tunein.parent.t456789');
});

test('topicsKey: stable shape `tunein.topics.<show>`', () => {
  assert.equal(topicsKey('p17'), 'tunein.topics.p17');
});
