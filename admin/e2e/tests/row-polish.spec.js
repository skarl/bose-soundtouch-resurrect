// Slice #79 — Reliability + field polish.
//
// Station rows carry a reliability badge (green/yellow/red/grey class),
// genre chips that are clickable links, and at least one row has a
// two-line subtitle.

import { test, expect, gotoBrowse } from './_setup.js';

test('reliability badges, 2-line subtitles, and clickable genre chips on a populated drill', async ({ page }) => {
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Reliability badges present with correct colour classes.
  const badges = page.locator('.station-row .reliability, .station-row__reliability, .reliability-badge');
  await expect(badges.first()).toBeVisible({ timeout: 15_000 });
  const colourClasses = await badges.evaluateAll((els) =>
    els.map((el) => Array.from(el.classList).find((c) => /reliability/.test(c) || /is-(green|yellow|red|grey|gray|unknown)/.test(c))).filter(Boolean));
  expect(colourClasses.length).toBeGreaterThan(0);
  // At least one badge carries a known colour modifier.
  const knownColour = colourClasses.some((c) => /(green|yellow|red|grey|gray|unknown|good|fair|poor)/i.test(c));
  expect(knownColour).toBe(true);

  // ≥1 station has a 2-line subtitle. We allow either an explicit
  // .station-row__subtitle--two-line modifier OR a subtitle element
  // whose computed height crosses two text lines.
  const subtitles = page.locator('.station-row .station-row__subtitle, .station-row__sub, .station-row [data-role="subtitle"]');
  const twoLineCount = await subtitles.evaluateAll((els) =>
    els.filter((el) => {
      if (el.classList.contains('is-two-line') || el.classList.contains('station-row__subtitle--two-line')) return true;
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
      return el.getBoundingClientRect().height > lh * 1.5;
    }).length);
  expect(twoLineCount).toBeGreaterThanOrEqual(1);

  // Genre chips are clickable and drill correctly.
  const chip = page.locator('.station-row .chip, .station-row__chip, a.genre-chip').first();
  if (await chip.count() > 0) {
    const href = await chip.getAttribute('href');
    expect(href).toMatch(/#\/browse\?id=|#\/search/);
    await chip.click();
    await page.waitForFunction(
      () => location.hash.startsWith('#/browse') || location.hash.startsWith('#/search'),
      null,
      { timeout: 10_000 },
    );
  }
});
