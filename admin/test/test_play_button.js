// Tests for admin/app/play-button.js — the consolidated inline Play
// widget mounted by both stationRow and showHero.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installSessionStorage } from './fixtures/dom-shim.js';

installSessionStorage();

const { createPlayButton } = await import('../app/play-button.js');
const { cache } = await import('../app/tunein-cache.js');
const { playGuideId } = await import('../app/api.js');

function dispatchClick(el) {
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
}

test('createPlayButton: throws when sid is missing', () => {
  assert.throws(() => createPlayButton({ label: 'X' }), /sid is required/);
});

test('createPlayButton: throws when label is missing or empty', () => {
  assert.throws(() => createPlayButton({ sid: 's1' }), /label is required/);
  assert.throws(() => createPlayButton({ sid: 's1', label: '' }), /label is required/);
});

test('createPlayButton: renders the widget shape stationRow + showHero rely on', () => {
  const btn = createPlayButton({ sid: 's24862', label: 'Radio Test' });
  assert.equal(btn.getAttribute('role'), 'button');
  assert.equal(btn.getAttribute('tabindex'), '0');
  assert.equal(btn.getAttribute('data-tap'), '44');
  assert.equal(btn.getAttribute('aria-label'), 'Play Radio Test on Bo');
  assert.ok((btn.getAttribute('class') || '').includes('station-row__play'));
});

test('createPlayButton: click fires /play with the resolved label', async () => {
  cache.invalidate('tunein.stream.s24862');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    return { ok: true, status: 200, json: async () => ({ ok: true, url: 'http://stream.example/x.aac' }) };
  };

  const btn = createPlayButton({ sid: 's24862', label: 'Radio Test' });
  dispatchClick(btn);
  await new Promise((r) => setTimeout(r, 10));

  globalThis.fetch = realFetch;

  const playCall = calls.find((c) => /\/play\b/.test(c.url));
  assert.ok(playCall, 'one /play POST issued');
  const payload = JSON.parse(String(playCall.body || '{}'));
  assert.equal(payload.id, 's24862');
  assert.equal(payload.name, 'Radio Test',
    '#99 contract: label rides on every /play call');

  cache.invalidate('tunein.stream.s24862');
});

test('playGuideId: throws synchronously when name is missing', async () => {
  await assert.rejects(() => playGuideId('s12345'), /label is required/);
  await assert.rejects(() => playGuideId('s12345', ''), /label is required/);
});
