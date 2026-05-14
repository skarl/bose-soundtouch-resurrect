// Issue #119 — mobile-viewport horizontal-overflow guard.
//
// All primary views (Now / Search / Browse / Settings) and the
// station detail view must render without forcing a horizontal
// scrollbar at a phone-sized viewport. The default viewport in
// playwright.config.js is already 390x844 (iPhone 13); this spec
// pins that contract so a stray fixed-width descendant or an
// unbroken long label can't regress the layout again.
//
// The selector list in the container-query block at style.css
// §1642 (`.np-view`, `[data-view="browse"]`, `[data-view="search"]`,
// `.station-detail`, `.preset-modal`) is the load-bearing carrier
// set — those wrapper classes / data-view attributes must stay on
// the root of each view so the @container rules can fire. This
// spec is the regression net for both that carrier set and the
// defensive `overflow-x: hidden` on `.shell-body`.

import { test, expect } from './_setup.js';

// Tolerate sub-pixel rounding: a `scrollWidth` one CSS pixel beyond
// `innerWidth` is the noisy boundary cross-browser rendering
// produces and is not a real overflow.
async function assertNoHorizontalOverflow(page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth:  window.innerWidth,
  }));
  expect(
    scrollWidth,
    `documentElement.scrollWidth (${scrollWidth}) exceeded window.innerWidth (${innerWidth}) — horizontal scroll on a phone viewport`,
  ).toBeLessThanOrEqual(innerWidth + 1);
}

test('now-playing view fits the 390px viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="now-playing"]', { timeout: 15_000 });
  await assertNoHorizontalOverflow(page);
});

test('search view fits the 390px viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/#/search', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="search"]', { timeout: 15_000 });
  await assertNoHorizontalOverflow(page);
});

test('browse view (root tabs) fits the 390px viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/#/browse', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
  // Give the first tab's API body a moment to mount — the row
  // entries are where most width risk lives (long station names).
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });
  await assertNoHorizontalOverflow(page);
});

test('settings view fits the 390px viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/#/settings', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="settings"]', { timeout: 15_000 });
  await assertNoHorizontalOverflow(page);
});

test('station detail view fits the 390px viewport without horizontal overflow', async ({ page }) => {
  // s12345 (KEXP) — the same known-real sid used by
  // station-redirect.spec.js to assert the strict matcher.
  await page.goto('/#/station/s12345', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="station"]', { timeout: 15_000 });
  await assertNoHorizontalOverflow(page);
});
