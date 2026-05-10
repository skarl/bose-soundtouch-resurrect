// Tests for app/a11y.js — pure-function helpers backing the
// aria-valuetext announcements and the preset-row roving-tabindex move.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  formatVolumeValueText,
  formatBassValueText,
  formatBalanceValueText,
  rovingFocus,
} from '../app/a11y.js';

// --- formatVolumeValueText ------------------------------------------

test('formatVolumeValueText: typical level, not muted', () => {
  assert.equal(formatVolumeValueText(32, 100, false), 'Volume 32 of 100');
});

test('formatVolumeValueText: muted appends ", muted"', () => {
  assert.equal(formatVolumeValueText(32, 100, true), 'Volume 32 of 100, muted');
});

test('formatVolumeValueText: zero level reads cleanly', () => {
  assert.equal(formatVolumeValueText(0, 100, false), 'Volume 0 of 100');
});

test('formatVolumeValueText: max level reads cleanly', () => {
  assert.equal(formatVolumeValueText(100, 100, false), 'Volume 100 of 100');
});

test('formatVolumeValueText: muted at zero', () => {
  assert.equal(formatVolumeValueText(0, 100, true), 'Volume 0 of 100, muted');
});

// --- formatBassValueText --------------------------------------------

test('formatBassValueText: zero (default) reads cleanly', () => {
  assert.equal(formatBassValueText(0, -9, 0), 'Bass 0 (range -9 to 0)');
});

test('formatBassValueText: negative level', () => {
  assert.equal(formatBassValueText(-5, -9, 0), 'Bass -5 (range -9 to 0)');
});

// --- formatBalanceValueText -----------------------------------------

test('formatBalanceValueText: centre', () => {
  assert.equal(formatBalanceValueText(0, -7, 7), 'Balance centred');
});

test('formatBalanceValueText: left', () => {
  assert.equal(formatBalanceValueText(-3, -7, 7), 'Balance left 3 of 7');
});

test('formatBalanceValueText: right', () => {
  assert.equal(formatBalanceValueText(4, -7, 7), 'Balance right 4 of 7');
});

test('formatBalanceValueText: full left', () => {
  assert.equal(formatBalanceValueText(-7, -7, 7), 'Balance left 7 of 7');
});

// --- rovingFocus ----------------------------------------------------

test('rovingFocus: ArrowRight advances', () => {
  assert.equal(rovingFocus(6, 0, 'ArrowRight'), 1);
});

test('rovingFocus: ArrowRight at end wraps to 0', () => {
  assert.equal(rovingFocus(6, 5, 'ArrowRight'), 0);
});

test('rovingFocus: ArrowLeft retreats', () => {
  assert.equal(rovingFocus(6, 3, 'ArrowLeft'), 2);
});

test('rovingFocus: ArrowLeft at 0 wraps to last', () => {
  assert.equal(rovingFocus(6, 0, 'ArrowLeft'), 5);
});

test('rovingFocus: Home jumps to 0', () => {
  assert.equal(rovingFocus(6, 4, 'Home'), 0);
});

test('rovingFocus: End jumps to last', () => {
  assert.equal(rovingFocus(6, 1, 'End'), 5);
});

test('rovingFocus: ArrowDown / ArrowUp behave like Right / Left', () => {
  assert.equal(rovingFocus(6, 2, 'ArrowDown'), 3);
  assert.equal(rovingFocus(6, 2, 'ArrowUp'), 1);
});

test('rovingFocus: unknown key returns clamped current index', () => {
  assert.equal(rovingFocus(6, 2, 'Tab'), 2);
  assert.equal(rovingFocus(6, 2, 'Enter'), 2);
});

test('rovingFocus: empty list returns -1', () => {
  assert.equal(rovingFocus(0, 0, 'ArrowRight'), -1);
});

test('rovingFocus: clamps out-of-range current index', () => {
  // 99 → clamp to 5, ArrowRight wraps to 0.
  assert.equal(rovingFocus(6, 99, 'ArrowRight'), 0);
  // -3 → clamp to 0, ArrowLeft wraps to 5.
  assert.equal(rovingFocus(6, -3, 'ArrowLeft'), 5);
});
