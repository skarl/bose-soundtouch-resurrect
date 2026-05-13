// Slice #77 — Filter + auto-crawl progress strap.
//
// On a large drill page the filter input triggers an auto-crawl across
// paginated results. A progress strap (`.browse-strap`) mounts at the
// top of the drill body while the crawl is in flight and unmounts on
// clear / exhaustion. Visible rows that don't match the filter gain
// the `is-filtered-out` class (CSS collapses them to display:none).

import { test, expect, gotoBrowse } from './_setup.js';

test('filter on a large category mounts the progress strap, grows the row list, and unmounts on clear', async ({ page }) => {
  // g3 (Adult Hits) is paginated and has well over a hundred stations.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // The filter input sits in `.browse-filter` and carries
  // `.browse-filter__input` (see browse.js renderFilterInput).
  const filter = page.locator('input.browse-filter__input');
  await expect(filter).toBeVisible({ timeout: 10_000 });

  // Count rows that the DOM filter could actually hide (rows with an
  // `_outline` stash). The `is-filtered-out` class only applies to
  // `.station-row` and `.browse-row` elements.
  const visibleRowsSelector = '.station-row:not(.is-filtered-out)';
  const baselineVisible = await page.locator(visibleRowsSelector).count();
  expect(baselineVisible).toBeGreaterThan(0);

  // Type a short string that's likely to hit several stations but also
  // filter most out — broad enough to also trigger the auto-crawl.
  await filter.fill('radio');

  // Progress strap mounts while the crawl runs. The crawl is debounced
  // 300ms; allow generous slack for Bo's busybox CGI.
  const strap = page.locator('.browse-strap');
  await expect(strap).toBeVisible({ timeout: 15_000 });
  await expect(strap.locator('.browse-strap__label')).toContainText(/Scanning/, { timeout: 5_000 });

  // The crawl loads more pages serially; eventually the total row pool
  // (matched + hidden) grows beyond baseline. We measure the pool size
  // including hidden rows because the section keeps mounting fetched
  // rows and the DOM filter only hides them — they remain in the DOM.
  await page.waitForFunction(
    (n) => document.querySelectorAll('.station-row').length > n,
    baselineVisible,
    { timeout: 60_000 },
  );

  // Every visible (non-hidden) row matches the filter substring.
  const visibleRowTexts = await page.locator(visibleRowsSelector).evaluateAll((rows) =>
    rows.map((r) => (r.textContent || '').toLowerCase()));
  expect(visibleRowTexts.length).toBeGreaterThan(0);
  for (const text of visibleRowTexts) {
    expect(text).toContain('radio');
  }

  // Clear the filter → strap unmounts.
  await filter.fill('');
  await expect(strap).toHaveCount(0, { timeout: 15_000 });
});
