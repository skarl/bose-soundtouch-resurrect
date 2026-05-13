// Slice #80 — Search reframe.
//
// The unified search returns stations (s-prefix), shows (p-prefix),
// topics (t-prefix), and artists (m-prefix). The "Include podcasts"
// toggle filters out p-prefix rows via the `filter=s:popular`
// upstream parameter. Inline Play icons surface on every playable
// row (s / p / t), including p-prefix rows when podcasts are included.
//
// Search results render as `a.station-row[data-prefix=…]` inside the
// `.search-results` container (search.js searchRowCard). Show
// (p-prefix) rows override the href to point at a browse-drill,
// not a station detail.

import { test, expect, gotoSearch } from './_setup.js';

test('searching "Folk Alley" yields a p-prefix row with inline Play; toggle off excludes p-prefix rows', async ({ page }) => {
  await gotoSearch(page, 'Folk Alley');

  // Wait for the search to settle: at least one row inside the
  // results pane.
  const resultRows = page.locator('.search-results a.station-row');
  await expect(resultRows.first()).toBeVisible({ timeout: 20_000 });

  // ≥1 p-prefix row appears. The row carries data-prefix="p".
  const pRows = page.locator('.search-results a.station-row[data-prefix="p"]');
  expect(await pRows.count()).toBeGreaterThanOrEqual(1);

  // Inline Play icon present on the first p-prefix row. Play is a
  // span[role="button"].station-row__play, not an actual <button>.
  const firstPRow = pRows.first();
  await expect(firstPRow.locator('.station-row__play')).toBeVisible({ timeout: 5_000 });

  // Capture station-rows from the initial (podcasts-included) response
  // for the post-toggle comparison.
  const baselineCount = await resultRows.count();
  expect(baselineCount).toBeGreaterThan(0);

  // Toggle "Include podcasts" off. Set up the response listener BEFORE
  // the toggle click so the eager-fire search doesn't race past us.
  const toggle = page.locator('input.search-include-podcasts__input');
  await expect(toggle).toBeVisible({ timeout: 5_000 });
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes('/cgi-bin/api/v1/tunein/search')
       && /filter=s(?:%3A|:)popular/.test(r.url())
       && r.status() === 200,
    { timeout: 10_000 },
  );
  if (await toggle.isChecked()) {
    await toggle.uncheck();
  }
  await responsePromise;

  // After the toggle re-render, p-prefix rows are gone.
  await expect(page.locator('.search-results a.station-row[data-prefix="p"]'))
    .toHaveCount(0, { timeout: 5_000 });

  // ≥1 s-prefix row still surfaces — Folk Alley has multiple s-rows
  // from affiliate stations.
  await expect(page.locator('.search-results a.station-row[data-prefix="s"]').first())
    .toBeVisible({ timeout: 10_000 });
});
