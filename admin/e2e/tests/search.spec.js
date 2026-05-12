// Slice #80 — Search reframe.
//
// The unified search returns stations (s-prefix), shows (p-prefix),
// and topics. A "Include podcasts" toggle filters out p-prefix rows.
// Inline Play icons surface on every audio leaf, including p-prefix
// rows when podcasts are included.

import { test, expect, gotoSearch } from './_setup.js';

test('searching "Folk Alley" yields a p-prefix row with inline Play; toggle off excludes p-prefix rows', async ({ page }) => {
  await gotoSearch(page, 'Folk Alley');

  // Wait for at least one result row to render.
  await page.waitForSelector('.station-row, .search-row, [data-role="result"]', { timeout: 20_000 });

  // p-prefix row appears. We look at row hrefs for #/station/p... or
  // #/show/p... since both shapes have surfaced across recent slices.
  const allHrefs = await page.$$eval('a[href*="#/station/"], a[href*="#/show/"]', (els) =>
    els.map((a) => a.getAttribute('href') || ''));
  const hasPRow = allHrefs.some((h) => /\b\/(?:station|show)\/p[0-9a-z]+/i.test(h));
  expect(hasPRow, `expected a p-prefix result for "Folk Alley", got hrefs: ${allHrefs.join(', ')}`).toBe(true);

  // Inline Play icon present on the p-prefix row.
  const pRow = page.locator('a[href*="#/station/p"], a[href*="#/show/p"]').first();
  const pRowContainer = pRow.locator('xpath=ancestor-or-self::*[contains(@class, "station-row") or contains(@class, "search-row") or @data-role="result"][1]');
  await expect(pRowContainer.locator('button.station-row__play, [data-action="play"], .inline-play').first())
    .toBeVisible({ timeout: 5_000 });

  // Toggle "Include podcasts" off.
  const toggle = page.locator('label:has-text("Include podcasts") input, [data-toggle="podcasts"] input, input[name="include-podcasts"]').first();
  await expect(toggle).toBeVisible({ timeout: 5_000 });
  if (await toggle.isChecked()) {
    await toggle.uncheck();
  }

  // Re-run the same query so the toggle takes effect.
  const searchInput = page.locator('input.search-input, input[type="search"], input[placeholder*="Search" i]').first();
  if (await searchInput.count() > 0) {
    await searchInput.fill('');
    await searchInput.fill('Folk Alley');
    await searchInput.press('Enter');
  }

  // Wait for results to settle, then assert no p-prefix rows.
  await page.waitForTimeout(500);
  const refreshed = await page.$$eval('a[href*="#/station/"], a[href*="#/show/"]', (els) =>
    els.map((a) => a.getAttribute('href') || ''));
  const stillHasP = refreshed.some((h) => /\b\/(?:station|show)\/p[0-9a-z]+/i.test(h));
  expect(stillHasP, 'p-prefix rows leaked through when "Include podcasts" was OFF').toBe(false);
});
