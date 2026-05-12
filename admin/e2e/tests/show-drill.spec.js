// Slice #81 — Show drill.
//
// Tapping a show row (p-prefix in the TuneIn guide_id space) navigates
// to a show-detail view listing topic rows. Each topic carries an
// inline Play icon that, when tapped, plays on the speaker.

import { test, expect, gotoSearch } from './_setup.js';

test('show drill: tapping a show opens topic rows, topic Play triggers speaker', async ({ page }) => {
  // Search for a known show; Folk Alley reliably surfaces a show row.
  await gotoSearch(page, 'Folk Alley');
  await page.waitForSelector('.station-row, .search-row, [data-role="result"]', { timeout: 20_000 });

  // Find a p-prefix row and click it.
  const showLink = page.locator('a[href*="#/show/p"], a[href*="#/station/p"]').first();
  await expect(showLink).toBeVisible({ timeout: 10_000 });
  await showLink.click();

  // Show drill view renders.
  await page.waitForSelector('[data-view="show"], [data-view="station"][data-kind="show"], .show-detail', { timeout: 15_000 });

  // Topic rows render — at least one.
  const topics = page.locator('.topic-row, [data-role="topic"], .show-topic');
  await expect(topics.first()).toBeVisible({ timeout: 15_000 });
  expect(await topics.count()).toBeGreaterThanOrEqual(1);

  // Each topic carries an inline Play icon.
  const playBtn = topics.first().locator('button, [data-action="play"], .inline-play').first();
  await expect(playBtn).toBeVisible();

  // Tap → assert /play CGI fires (a network round-trip is the device-
  // independent signal; a follow-up /now_playing update confirms the
  // speaker actually moved).
  const playReqPromise = page.waitForRequest(
    (r) => r.url().includes('/cgi-bin/play'),
    { timeout: 10_000 },
  );
  await playBtn.click();
  await playReqPromise;
});
