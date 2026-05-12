// Slice #76 — Pagination via Load-more.
//
// Top 40 & Pop (g3 in TuneIn's taxonomy) returns paged stations.
// Each Load-more click strictly grows the row count without re-emitting
// existing guide_ids.

import { test, expect, gotoBrowse } from './_setup.js';

test('Top 40 & Pop pagination: Load-more increases row count without duplicate guide_ids', async ({ page }) => {
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  async function collectIds() {
    return page.$$eval('.station-row', (rows) =>
      rows.map((r) =>
        r.dataset.sid ||
        r.dataset.guideId ||
        r.getAttribute('data-sid') ||
        r.getAttribute('data-guide-id') ||
        r.querySelector('a[href*="#/station/"]')?.getAttribute('href') ||
        r.textContent?.slice(0, 32)
      ).filter(Boolean));
  }

  const baseline = await collectIds();
  expect(baseline.length).toBeGreaterThan(0);

  const loadMore = page.locator('button.browse-load-more, [data-action="load-more"], button:has-text("Load more")').first();
  await expect(loadMore).toBeVisible({ timeout: 10_000 });

  let previousCount = baseline.length;
  const seen = new Set(baseline);

  for (let i = 0; i < 3; i++) {
    await loadMore.click();
    // Wait for the row count to strictly grow.
    await page.waitForFunction(
      (n) => document.querySelectorAll('.station-row').length > n,
      previousCount,
      { timeout: 15_000 },
    );
    const after = await collectIds();
    expect(after.length).toBeGreaterThan(previousCount);

    // Check for duplicates in the appended slice.
    const fresh = after.slice(previousCount);
    for (const id of fresh) {
      expect(seen.has(id), `duplicate guide_id surfaced after page ${i + 1}: ${id}`).toBe(false);
      seen.add(id);
    }
    previousCount = after.length;

    // Re-resolve the button — it may unmount on the final page.
    if (await loadMore.count() === 0 || !(await loadMore.isVisible().catch(() => false))) break;
  }
});
