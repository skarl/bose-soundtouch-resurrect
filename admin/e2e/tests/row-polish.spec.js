// Slice #79 — Reliability + field polish.
//
// Station rows carry:
//   - a reliability badge (`.station-row__reliability[data-tier=…]`)
//     with three tiers: green / amber / red (see tunein-outline.js
//     reliabilityTier). The row itself mirrors the tier via
//     `data-reliability-tier`.
//   - a tertiary line (`.station-row__tertiary`) when current_track is
//     present and differs from the secondary line — gives the row a
//     three-line subtitle stack.
//   - a clickable genre chip (`.station-row__chip--genre`) that drills
//     into the genre.

import { test, expect, gotoBrowse } from './_setup.js';

test('reliability badges, tertiary subtitles, and clickable genre chips on a populated drill', async ({ page }) => {
  // g3 (Adult Hits) reliably surfaces a mix of reliability tiers and
  // a handful of rows with `current_track` distinct from `subtext`.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // --- Reliability badges -------------------------------------------
  const badges = page.locator('.station-row__reliability[data-tier]');
  await expect(badges.first()).toBeVisible({ timeout: 15_000 });
  const tiers = await badges.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-tier')).filter(Boolean));
  expect(tiers.length).toBeGreaterThan(0);
  for (const t of tiers) {
    expect(['green', 'amber', 'red']).toContain(t);
  }
  // At least one of the known tiers must actually surface.
  const distinct = new Set(tiers);
  expect(distinct.size).toBeGreaterThanOrEqual(1);

  // The row also mirrors the tier as a data attribute on the anchor.
  const rowTiers = await page.locator('a.station-row[data-reliability-tier]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-reliability-tier')));
  expect(rowTiers.length).toBeGreaterThan(0);

  // --- Three-line subtitle stack ------------------------------------
  // The tertiary line is the third subtitle — current_track lifted out
  // of `playing`/`subtext`. ≥1 row must surface it on a busy genre.
  const tertiaries = page.locator('.station-row .station-row__tertiary');
  expect(await tertiaries.count()).toBeGreaterThanOrEqual(1);

  // --- Genre chips clickable ----------------------------------------
  const chip = page.locator('a.station-row__chip.station-row__chip--genre[data-genre-id]').first();
  await expect(chip).toBeVisible({ timeout: 10_000 });
  const chipHref = await chip.getAttribute('href');
  expect(chipHref).toMatch(/#\/browse\?id=g\d+/);
  const chipGenreId = await chip.getAttribute('data-genre-id');
  expect(chipGenreId).toMatch(/^g\d+$/);

  await chip.click();
  await page.waitForFunction(
    () => location.hash.startsWith('#/browse?id=g'),
    null,
    { timeout: 10_000 },
  );
});
