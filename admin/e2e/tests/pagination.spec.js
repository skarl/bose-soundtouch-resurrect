// Slice #76 — Pagination via Load-more.
//
// Multi-section browse drills (e.g. `g3` Adult Hits) emit several
// section cards, each with its own cursor. Clicking the `Stations`
// section's Load-more button must strictly grow the rows inside THAT
// section without re-emitting guide_ids the same section already
// rendered.
//
// We pin the test to the `stations` section because it's the section
// most likely to support 3+ pages without exhausting. The `local`
// section is small (Bo's location only emits a handful) and
// cross-section duplicates between `local` and `stations` are
// expected — the local list is a curated cross-cut, not a separate
// universe — so a whole-view dedup assertion would mis-fire.

import { test, expect, gotoBrowse } from './_setup.js';

test('Stations section Load-more grows row count without duplicate guide_ids within the section', async ({ page }) => {
  // g3 (Adult Hits) is one of the larger, reliably-paginated genres.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const stationsSection = page.locator('.browse-section[data-section="stations"]');
  await expect(stationsSection).toBeVisible({ timeout: 15_000 });

  async function collectSectionSids() {
    return stationsSection.locator('a.station-row[data-sid]').evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('data-sid') || '').filter(Boolean));
  }

  const baseline = await collectSectionSids();
  expect(baseline.length).toBeGreaterThan(0);
  // Page-0 should never have internal duplicates.
  expect(new Set(baseline).size).toBe(baseline.length);

  const loadMore = stationsSection.locator('button.browse-load-more[data-load-more="stations"]');
  await expect(loadMore).toBeVisible({ timeout: 10_000 });

  let previousCount = baseline.length;
  const seen = new Set(baseline);

  for (let i = 0; i < 3; i++) {
    // The button may have unmounted on the previous iteration when the
    // pager exhausted; bail before clicking a stale handle.
    if (await loadMore.count() === 0) break;

    await loadMore.click();
    // Wait for the section's row count to strictly grow.
    await page.waitForFunction(
      ({ baseSel, n }) => document.querySelectorAll(baseSel).length > n,
      { baseSel: '.browse-section[data-section="stations"] a.station-row[data-sid]', n: previousCount },
      { timeout: 20_000 },
    );

    const after = await collectSectionSids();
    expect(after.length).toBeGreaterThan(previousCount);

    // Check for duplicates within the section across pages.
    const fresh = after.slice(previousCount);
    for (const id of fresh) {
      expect(seen.has(id), `duplicate guide_id surfaced after page ${i + 1}: ${id}`).toBe(false);
      seen.add(id);
    }
    previousCount = after.length;
  }
});
