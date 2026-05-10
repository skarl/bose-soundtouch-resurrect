// Tests for app/tint.js — pure dominantColor() over fixed pixel arrays.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { dominantColor } from '../app/tint.js';

function makeImageData(pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    const [r, g, b, a = 255] = pixels[i];
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { data, width: pixels.length, height: 1 };
}

function repeat(pixel, n) {
  return Array.from({ length: n }, () => pixel);
}

test('dominantColor: solid colour returns that colour', () => {
  const img = makeImageData(repeat([200, 50, 80], 100));
  const { r, g, b } = dominantColor(img);
  assert.equal(r, 200);
  assert.equal(g, 50);
  assert.equal(b, 80);
});

test('dominantColor: two-colour mix — modal bin wins', () => {
  // 70 red-ish pixels, 30 blue-ish; red bin should win.
  const red = [220, 30, 40];
  const blue = [30, 50, 220];
  const img = makeImageData([...repeat(red, 70), ...repeat(blue, 30)]);
  const { r, g, b } = dominantColor(img);
  assert.equal(r, 220);
  assert.equal(g, 30);
  assert.equal(b, 40);
});

test('dominantColor: grayscale — channels track each other', () => {
  // 60 mid-gray, 40 light-gray. 128 and 200 land in different bins
  // (bin size 32: bins 4 and 6); the modal bin's mean is returned.
  const mid = [128, 128, 128];
  const light = [200, 200, 200];
  const img = makeImageData([...repeat(mid, 60), ...repeat(light, 40)]);
  const { r, g, b } = dominantColor(img);
  assert.equal(r, 128);
  assert.equal(g, 128);
  assert.equal(b, 128);
});

test('dominantColor: single-pixel image returns that pixel', () => {
  const img = makeImageData([[10, 20, 30]]);
  const { r, g, b } = dominantColor(img);
  assert.equal(r, 10);
  assert.equal(g, 20);
  assert.equal(b, 30);
});

test('dominantColor: fully transparent pixels are skipped', () => {
  // 50 transparent red, 20 opaque green. Green wins because the
  // transparent pixels are excluded.
  const transRed = [220, 30, 40, 0];
  const green = [40, 200, 60, 255];
  const img = makeImageData([...repeat(transRed, 50), ...repeat(green, 20)]);
  const { r, g, b } = dominantColor(img);
  assert.equal(r, 40);
  assert.equal(g, 200);
  assert.equal(b, 60);
});
