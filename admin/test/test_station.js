// Tests for app/views/station.js — the v2 station-detail re-skin (#60).
//
// Covers the new layout:
//   - 3×2 preset grid (6 cells) replaces the inline 6-button row
//   - cells show slot number, occupant name, optional genre tag
//   - full-width gradient Play CTA replaces the per-stream audition
//     buttons; preserves the existing previewStream callsite
//   - probe-state branching (playable / gated / dark) untouched
//   - no debug strings ("/mnt/nv/resolver/", "writes to") leak into the DOM
//
// Strategy: stub the network surface (globalThis.fetch + probe deps) so
// the view runs end-to-end without touching anything real. The view is
// driven via its public defineView shell so subscriptions and cleanup
// also exercise the production wiring.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installFetchNeverResolving } from './fixtures/dom-shim.js';

installFetchNeverResolving();


// Now the modules under test.
const { default: stationView } = await import('../app/views/station.js');
const { _setDeps } = await import('../app/probe.js');
const { store } = await import('../app/state.js');
const { readFile } = await import('node:fs/promises');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const TUNEIN_FIXTURE = JSON.parse(await readFile(join(FIXTURES, 's12345.tunein.json'), 'utf8'));

const PROBE_PLAYABLE = {
  sid: 's12345',
  verdict: {
    kind: 'playable',
    streams: [
      { streamUrl: 'http://streams.example.de/live/hqlivestream.aac', bitrate: 168, media_type: 'aac', reliability: 99 },
      { streamUrl: 'http://streams.example.de/live/livestream.mp3',   bitrate: 128, media_type: 'mp3', reliability: 99 },
    ],
  },
  // Real Tune.ashx fixture so reshape() returns a Bose payload, which
  // is what the Play CTA test asserts on.
  tuneinJson: TUNEIN_FIXTURE,
  expires: Date.now() + 600000,
};
const PROBE_GATED = {
  sid: 's55555',
  verdict: { kind: 'gated', reason: 'no-streams' },
  tuneinJson: {}, expires: Date.now() + 600000,
};
const PROBE_DARK = {
  sid: 's99999',
  verdict: { kind: 'dark', reason: 'http-404' },
  tuneinJson: {}, expires: Date.now() + 600000,
};

function makeStoreStub() {
  // station.js imports the real store; for these tests we just reuse it
  // (it's an in-process singleton) and reset the bits we care about.
  store.state.speaker.presets = null;
  store.state.caches.probe.clear();
  return store;
}

function makeRoot() { return doc.createElement('div'); }

beforeEach(() => {
  makeStoreStub();
  _setDeps({
    tuneinProbe: async () => { throw new Error('tuneinProbe not stubbed'); },
    presetsAssign: async () => { throw new Error('presetsAssign not stubbed'); },
    setPresets: () => {},
  });
});

// Drive the view past its async fetches by seeding the probe cache so
// probe(sid) returns synchronously (cache hit), and by using a plain
// rendered skeleton + applying the verdict directly via a stubbed init.
async function mountWith(root, sid, probeEntry, presets) {
  store.state.caches.probe.set(sid, probeEntry);
  if (presets) store.state.speaker.presets = presets;
  const destroy = stationView.init(root, store, { params: { id: sid } });
  // Let the microtask + probe chain settle.
  await new Promise((r) => setTimeout(r, 5));
  return destroy;
}

// --- preset grid ----------------------------------------------------

test('station: preset grid renders 6 cells (3 columns × 2 rows)', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const grid = root.querySelector('.station-presets-grid');
  assert.ok(grid, 'grid container present');
  const cells = root.querySelectorAll('.station-preset-cell');
  assert.equal(cells.length, 6, 'six preset cells');
  destroy();
});

test('station: each cell shows slot number 1..6', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const slots = root.querySelectorAll('.station-preset-cell__slot');
  const numbers = Array.from(slots, (n) => n.textContent);
  assert.deepEqual(numbers, ['1', '2', '3', '4', '5', '6']);
  destroy();
});

test('station: empty cells show "Empty" placeholder', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { empty: true }, { empty: true }, { empty: true },
    { empty: true }, { empty: true }, { empty: true },
  ]);
  const occupants = root.querySelectorAll('.station-preset-cell__occupant');
  for (const o of occupants) assert.equal(o.textContent, 'Empty');
  destroy();
});

test('station: occupied cells show the station name', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { itemName: 'Klassik FM',  source: 'INTERNET_RADIO', location: 's11111' },
    { itemName: 'Jazz Live',   source: 'INTERNET_RADIO', location: 's22222' },
    { empty: true },
    { itemName: 'Hits 24/7',   source: 'INTERNET_RADIO', location: 's33333' },
    { empty: true },
    { empty: true },
  ]);
  const occupants = root.querySelectorAll('.station-preset-cell__occupant');
  const names = Array.from(occupants, (n) => n.textContent);
  assert.deepEqual(names, ['Klassik FM', 'Jazz Live', 'Empty', 'Hits 24/7', 'Empty', 'Empty']);
  destroy();
});

test('station: cell holding the current station gets the .is-current accent', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { empty: true },
    { itemName: 'Bo Test Stream', source: 'INTERNET_RADIO', location: 's12345' },
    { empty: true }, { empty: true }, { empty: true }, { empty: true },
  ]);
  const cells = root.querySelectorAll('.station-preset-cell');
  assert.equal(cells[1].classList.contains('is-current'), true, 'matching cell highlighted');
  assert.equal(cells[0].classList.contains('is-current'), false);
  destroy();
});

// --- test-play CTA --------------------------------------------------

test('station: full-width Play CTA appears on playable verdict', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const cta = root.querySelector('.station-test-play');
  assert.ok(cta, 'test-play CTA mounted');
  assert.equal(cta.dataset.testPlay, '1', 'data-test-play marker present');
  const sub = root.querySelector('.station-test-play__sub');
  assert.ok(sub, 'subtitle present');
  assert.equal(sub.textContent, 'Stream a test sample without saving');
  // Inline gradient style — driven by stationGradient(name).
  const style = cta.getAttribute('style') || '';
  assert.ok(/linear-gradient/.test(style), 'background gradient applied inline');
  destroy();
});

test('station: Play CTA label reads exactly "Play" (issue #82 rename)', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);

  const labelEl = root.querySelector('.station-test-play__label');
  assert.ok(labelEl, 'CTA label slot present');
  assert.equal(labelEl.textContent, 'Play',
    'station-detail audition button label is the verb "Play"');
  destroy();
});

test('station: clicking Play calls previewStream with the chosen ContentItem', async () => {
  // Replace the api.previewStream call by intercepting via fetch — the
  // test-play handler eventually awaits previewStream({...}) which calls
  // fetch('/api/v1/preview'). Capture the body to assert the callsite.
  const root = makeRoot();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, data: {} }),
    };
  };

  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE);
  const cta = root.querySelector('.station-test-play');
  // Synthesise click; the view attaches with addEventListener('click').
  cta.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  await new Promise((r) => setTimeout(r, 5));

  globalThis.fetch = realFetch;

  const previewCall = calls.find((c) => /\/preview$/.test(c.url));
  assert.ok(previewCall, 'previewStream POST issued (preserved callsite)');
  assert.equal(previewCall.opts.method, 'POST');
  const body = JSON.parse(previewCall.opts.body);
  assert.equal(body.id, 's12345', 'payload carries the station sid');
  assert.ok(body.json && body.json.audio, 'payload carries the Bose ContentItem JSON');
  destroy();
});

// --- debug-string regression ----------------------------------------

test('station: no debug strings ("/mnt/nv/resolver" / "writes to") leak into the DOM', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's12345', PROBE_PLAYABLE, [
    { itemName: 'A', source: 'INTERNET_RADIO', location: 's11111' },
    { empty: true }, { empty: true }, { empty: true }, { empty: true }, { empty: true },
  ]);
  const text = serialize(root);
  assert.equal(/\/mnt\/nv\/resolver/.test(text), false, 'no /mnt/nv/resolver in output');
  assert.equal(/writes to/i.test(text), false, 'no "writes to" in output');
  destroy();
});

// --- gated + dark message variants ----------------------------------

test('station: gated verdict renders the friendly message + More like this', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's55555', PROBE_GATED);

  const verdict = root.querySelector('.station-verdict');
  assert.ok(verdict.classList.contains('is-gated'), 'is-gated tone applied');
  assert.ok(/available from this client/i.test(verdict.textContent), 'gated message rendered');
  // Assign grid replaced by the more-like-this link.
  const more = root.querySelector('.station-more-like-this');
  assert.ok(more, 'More like this link present');
  assert.equal(more.getAttribute('href'), '#/browse');
  // No test-play CTA on gated.
  assert.equal(root.querySelector('.station-test-play'), null);
  destroy();
});

test('station: dark verdict renders the off-air message + More like this', async () => {
  const root = makeRoot();
  const destroy = await mountWith(root, 's99999', PROBE_DARK);

  const verdict = root.querySelector('.station-verdict');
  assert.ok(verdict.classList.contains('is-dark'), 'is-dark tone applied');
  assert.ok(/currently off-air/i.test(verdict.textContent), 'dark message rendered');
  const more = root.querySelector('.station-more-like-this');
  assert.ok(more, 'More like this link present');
  assert.equal(root.querySelector('.station-test-play'), null);
  destroy();
});

// ---------------------------------------------------------------------
// Helpers

function serialize(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType === 8) return ''; // comments
  let out = '';
  if (node.tagName) out += '<' + node.tagName.toLowerCase() + '>';
  const kids = node.childNodes || [];
  for (let i = 0; i < kids.length; i++) out += serialize(kids[i]);
  if (node.tagName) out += '</' + node.tagName.toLowerCase() + '>';
  return out;
}

