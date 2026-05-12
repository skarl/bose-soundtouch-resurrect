// Slice #77 — Filter + auto-crawl progress strap.
//
// On a large drill page, the filter input triggers an auto-crawl
// across paginated results so the user sees every matching row, not
// just rows on the current page. A progress strap mounts at the top
// of the list while the crawl is in flight and unmounts when the
// filter is cleared.

import { test, expect, gotoBrowse } from './_setup.js';

test('filter on a large category mounts the progress strap, grows the row list, and unmounts on clear', async ({ page }) => {
  // Top 40 & Pop is paginated and >100 stations — a fine large drill.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const filter = page.locator('input.browse-filter, input[data-role="filter"], input[placeholder*="Filter" i]').first();
  await expect(filter).toBeVisible({ timeout: 10_000 });

  const before = await page.locator('.station-row').count();
  expect(before).toBeGreaterThan(0);

  // Type a substring that's broad enough to match across multiple pages
  // (a single letter forces the crawl to fetch ahead).
  await filter.fill('a');

  // Progress strap mounts while the crawl runs.
  const strap = page.locator('.filter-progress, [data-role="filter-progress"], .browse-filter-progress').first();
  await expect(strap).toBeVisible({ timeout: 10_000 });

  // Row list grows as new pages stream in — wait for the count to
  // strictly exceed the pre-filter baseline.
  await page.waitForFunction(
    (n) => document.querySelectorAll('.station-row').length > n,
    before,
    { timeout: 30_000 },
  );

  // Every visible row matches the filter (case-insensitive).
  const labels = await page.$$eval('.station-row', (rows) =>
    rows.map((r) => (r.textContent || '').toLowerCase()));
  for (const text of labels) {
    expect(text).toContain('a');
  }

  // Clear the filter → strap unmounts.
  await filter.fill('');
  await expect(strap).toHaveCount(0, { timeout: 10_000 });
});
