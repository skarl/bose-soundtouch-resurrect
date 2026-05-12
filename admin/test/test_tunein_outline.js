// Tests for admin/app/tunein-outline.js — the four pure functions
// that fold TuneIn outline elements into a renderer-friendly shape.
// See admin/app/tunein-outline.js and § 2-§ 6 of docs/tunein-api.md.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyOutline,
  normaliseRow,
  extractCursor,
  extractPivots,
} from '../app/tunein-outline.js';

// --- helpers ---------------------------------------------------------

function loadFixture(name) {
  const p = path.resolve('admin/test/fixtures/api', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Pull the first child matching a predicate, walking the multi-section
// Folk fixture. Used to grab a station / show / drill / cursor / pivot
// without hand-typing fixture coordinates.
function findChild(json, predicate) {
  for (const section of (json && json.body) || []) {
    for (const child of section.children || []) {
      if (predicate(child)) return child;
    }
  }
  return null;
}

// --- classifyOutline: the five outline `type` values ----------------

test('classifyOutline: type:"audio" classifies as station', () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const audio = findChild(folk, (c) => c.type === 'audio');
  assert.ok(audio, 'fixture must contain at least one audio row');
  assert.equal(classifyOutline(audio), 'station');
});

test('classifyOutline: type:"link" with item:"show" classifies as show', () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const showRow = findChild(folk, (c) => c.type === 'link' && c.item === 'show');
  assert.ok(showRow, 'fixture must contain at least one show row');
  assert.equal(classifyOutline(showRow), 'show');
});

test('classifyOutline: type:"link" with item:"topic" classifies as topic', () => {
  // The Folk fixture doesn't always carry a topic row. Construct a
  // minimal synthetic outline mirroring the wire shape.
  assert.equal(classifyOutline({
    element: 'outline',
    type:    'link',
    text:    'Episode: A Folk Tale',
    item:    'topic',
    guide_id: 't456789',
    URL:     'http://opml.radiotime.com/Tune.ashx?id=t456789',
  }), 'topic');
});

test('classifyOutline: type:"link" without an item or pivot/next key classifies as drill', () => {
  // Genre-tree drill node — e.g. a `g`-prefix subgenre under the
  // music hub. Not a pivot, not a cursor, no item label.
  assert.equal(classifyOutline({
    element: 'outline',
    type:    'link',
    text:    'Folk',
    URL:     'http://opml.radiotime.com/Browse.ashx?id=g79',
    guide_id: 'g79',
  }), 'drill');
});

test('classifyOutline: type:"text" with the tombstone message classifies as tombstone', () => {
  const tomb = loadFixture('c424724-l117-tombstone.tunein.json');
  const row = tomb.body[0];
  assert.equal(classifyOutline(row), 'tombstone');
  assert.equal(row.text, 'No stations or shows available');
});

test('classifyOutline: type:"text" with a different message still classifies as tombstone', () => {
  // The spec only enumerates one tombstone message in § 6.2, but the
  // safe default for any text-only outline is tombstone — text rows
  // never carry a drill URL we could render.
  assert.equal(classifyOutline({
    element: 'outline',
    type:    'text',
    text:    'Service unavailable',
  }), 'tombstone');
});

// --- classifyOutline: cursor and pivot detection by key prefix ------

test('classifyOutline: any key starting "next" classifies as cursor', () => {
  for (const key of ['nextStations', 'nextShows', 'nextEpisodes']) {
    assert.equal(classifyOutline({
      element: 'outline',
      type:    'link',
      text:    'More...',
      key,
      URL:     'http://opml.radiotime.com/Browse.ashx?offset=26&id=c100000948&filter=s',
    }), 'cursor', `expected cursor for key=${key}`);
  }
});

test('classifyOutline: any key starting "pivot" classifies as pivot', () => {
  for (const key of ['pivotName', 'pivotGenre', 'pivotLocation']) {
    assert.equal(classifyOutline({
      element: 'outline',
      type:    'link',
      text:    'By something',
      key,
      URL:     'http://opml.radiotime.com/Browse.ashx?pivot=name&id=c100000948',
    }), 'pivot', `expected pivot for key=${key}`);
  }
});

test('classifyOutline: pivot detection beats link/drill — a pivotLocation row is pivot, not drill', () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const pivotRow = findChild(folk, (c) => c.key === 'pivotLocation');
  assert.ok(pivotRow, 'Folk fixture must contain a pivotLocation row');
  assert.equal(classifyOutline(pivotRow), 'pivot');
});

test('classifyOutline: key:"popular" classifies as nav (chip in related section)', () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const navRow = findChild(folk, (c) => c.key === 'popular');
  assert.ok(navRow, 'Folk fixture must contain a "popular" nav row');
  assert.equal(classifyOutline(navRow), 'nav');
});

// --- normaliseRow: the basic shape ----------------------------------

test('normaliseRow: station row picks `playing` over `subtext` when both present', () => {
  const both = {
    element:  'outline',
    type:     'audio',
    text:     'Celtic Music Radio',
    guide_id: 's92207',
    image:    'http://cdn-profiles.tunein.com/s92207/images/logo.jpg',
    subtext:  'Glasgow, UK',
    playing:  'The Dubliners - Whiskey in the Jar',
  };
  const row = normaliseRow(both);
  assert.equal(row.type, 'station');
  assert.equal(row.primary, 'Celtic Music Radio');
  assert.equal(row.secondary, 'The Dubliners - Whiskey in the Jar');
  assert.equal(row.id, 's92207');
});

test('normaliseRow: subtext used when playing is absent', () => {
  const onlySub = {
    type:     'audio',
    text:     'Alpin FM (Germany)',
    guide_id: 's323114',
    subtext:  'echt.bairisch.',
  };
  assert.equal(normaliseRow(onlySub).secondary, 'echt.bairisch.');
});

test('normaliseRow: empty playing falls back to subtext, not the empty string', () => {
  const emptyPlaying = {
    type:     'audio',
    text:     'Quiet Station',
    guide_id: 's999',
    subtext:  'A description',
    playing:  '',
  };
  assert.equal(normaliseRow(emptyPlaying).secondary, 'A description');
});

test('normaliseRow: image gets the q.jpg 145px-logo suffix', () => {
  const row = normaliseRow({
    type:  'audio',
    text:  'X',
    image: 'http://cdn-profiles.tunein.com/s12345/images/logo.jpg',
  });
  assert.equal(row.image, 'http://cdn-profiles.tunein.com/s12345/images/logoq.jpg');
});

test('normaliseRow: image with no recognisable extension is left unchanged', () => {
  const row = normaliseRow({ type: 'audio', text: 'X', image: 'http://example/noext' });
  assert.equal(row.image, 'http://example/noext');
});

test('normaliseRow: missing image returns empty string', () => {
  const row = normaliseRow({ type: 'audio', text: 'X' });
  assert.equal(row.image, '');
});

test('normaliseRow: badges starts empty (Slice #79 will populate)', () => {
  const row = normaliseRow({ type: 'audio', text: 'X' });
  assert.deepEqual(row.badges, []);
});

// --- extractCursor / extractPivots ----------------------------------

test('extractCursor: pulls the nextStations cursor out of the stations section', () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const stations = folk.body.find((s) => s.key === 'stations');
  assert.ok(stations, 'stations section must exist');
  const cur = extractCursor(stations);
  assert.ok(cur, 'cursor must be found');
  assert.equal(cur.key, 'nextStations');
  assert.match(cur.url, /offset=26/);
  assert.match(cur.url, /id=c100000948/);
});

test('extractCursor: pulls the nextShows cursor out of the shows section', () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const shows = folk.body.find((s) => s.key === 'shows');
  const cur = extractCursor(shows);
  assert.ok(cur);
  assert.equal(cur.key, 'nextShows');
});

test('extractCursor: returns null when the section has no next* child', () => {
  assert.equal(extractCursor({ children: [{ type: 'audio', text: 'x' }] }), null);
  assert.equal(extractCursor(null), null);
  assert.equal(extractCursor({}), null);
});

test('extractPivots: collects every pivot* child of the related section', () => {
  const folk = loadFixture('c100000948-page0.tunein.json');
  const related = folk.body.find((s) => s.key === 'related');
  const pivots = extractPivots(related);
  assert.ok(pivots.length >= 1, `expected at least one pivot, got ${pivots.length}`);
  // pivotLocation → axis "location"
  const loc = pivots.find((p) => p.axis === 'location');
  assert.ok(loc, 'pivotLocation row must be parsed');
  assert.match(loc.url, /pivot=country/);
});

test('extractPivots: parses every pivot* prefix into an axis suffix', () => {
  const section = {
    children: [
      { type: 'link', text: 'By Name',     key: 'pivotName',     URL: 'u1' },
      { type: 'link', text: 'By Genre',    key: 'pivotGenre',    URL: 'u2' },
      { type: 'link', text: 'By Location', key: 'pivotLocation', URL: 'u3' },
      // Non-pivot children are ignored.
      { type: 'link', text: 'Drill',       key: 'popular',       URL: 'u4' },
    ],
  };
  const pivots = extractPivots(section);
  assert.deepEqual(pivots.map((p) => p.axis), ['name', 'genre', 'location']);
});

test('extractPivots: returns [] when no pivot* children exist', () => {
  assert.deepEqual(extractPivots({ children: [{ type: 'audio' }] }), []);
  assert.deepEqual(extractPivots(null), []);
});
