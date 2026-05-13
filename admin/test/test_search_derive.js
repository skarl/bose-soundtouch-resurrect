// Tests for app/search-derive.js — pure derivations for the search
// view (#108 extraction). Every exported helper gets at least one
// positive case + one defensive/empty case.
//
// Note: test_search.js already covers the same helpers via the view's
// re-exports — these tests pin the contract at the new module boundary
// so future view rewrites can't accidentally drop the derivations.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  searchResultStations,
  popularStations,
  DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
} from '../app/search-derive.js';

// --- searchResultStations -------------------------------------------

test('searchResultStations: keeps only audio entries with valid sNNN guide_id', () => {
  const out = searchResultStations({
    body: [
      { type: 'audio', guide_id: 's12345', text: 'KEXP' },
      { type: 'audio', guide_id: 'g22',    text: 'Genre — not a station' },
      { type: 'link',  guide_id: 's55555', text: 'Wrong type' },
      { type: 'audio',                       text: 'Missing id' },
      { type: 'audio', guide_id: 's77',    text: 'Radio Paradise' },
    ],
  });
  assert.deepEqual(out.map((e) => e.guide_id), ['s12345', 's77']);
});

test('searchResultStations: empty / malformed body returns []', () => {
  assert.deepEqual(searchResultStations(null), []);
  assert.deepEqual(searchResultStations(undefined), []);
  assert.deepEqual(searchResultStations({}), []);
  assert.deepEqual(searchResultStations({ body: 'oops' }), []);
});

test('searchResultStations: tolerates null entries inside body', () => {
  const out = searchResultStations({
    body: [null, undefined, { type: 'audio', guide_id: 's1', text: 'A' }],
  });
  assert.deepEqual(out.map((e) => e.guide_id), ['s1']);
});

// --- popularStations ------------------------------------------------

test('popularStations: walks one level into nested sections', () => {
  const out = popularStations({
    body: [
      {
        text: 'Local section',
        children: [
          { type: 'audio', guide_id: 's1', text: 'A' },
          { type: 'audio', guide_id: 's2', text: 'B' },
          { type: 'link',  guide_id: 's3', text: 'wrong type' },
        ],
      },
      { type: 'audio', guide_id: 's4', text: 'top-level station' },
    ],
  });
  assert.deepEqual(out.map((e) => e.guide_id), ['s1', 's2', 's4']);
});

test('popularStations: empty body returns []', () => {
  assert.deepEqual(popularStations({ body: [] }), []);
  assert.deepEqual(popularStations(null), []);
  assert.deepEqual(popularStations({}), []);
});

test('popularStations: skips audio entries with non-sNNN guide_id', () => {
  const out = popularStations({
    body: [{ type: 'audio', guide_id: 'g99' }],
  });
  assert.deepEqual(out, []);
});

test('popularStations: tolerates null entries in children + body', () => {
  const out = popularStations({
    body: [
      null,
      { children: [null, { type: 'audio', guide_id: 's1' }] },
    ],
  });
  assert.deepEqual(out.map((e) => e.guide_id), ['s1']);
});

// --- constants ------------------------------------------------------

test('DEBOUNCE_MS: stable 300ms search debounce window', () => {
  assert.equal(DEBOUNCE_MS, 300);
});

test('SEARCH_PLACEHOLDER: hints at TuneIn + concrete example queries', () => {
  assert.match(SEARCH_PLACEHOLDER, /TuneIn/);
  assert.match(SEARCH_PLACEHOLDER, /jazz/);
  assert.match(SEARCH_PLACEHOLDER, /bbc/);
  assert.match(SEARCH_PLACEHOLDER, /ffh/);
});
