// Slice #75 — Section rendering.
//
// Folk Music's Browse.ashx response carries four named sections in its
// outline. The drill renderer must place each in its own .browse-section
// card with a labelled section heading and a children count.
//
// Folk Music's canonical TuneIn id is g25 (verified in docs/tunein-api.md).

import { test, expect, gotoBrowse } from './_setup.js';

test('Folk Music drill renders 4 distinct section containers with labels and counts', async ({ page }) => {
  await gotoBrowse(page, 'g25');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const sections = page.locator('.browse-section');
  await expect(sections.first()).toBeVisible({ timeout: 15_000 });
  await expect(sections).toHaveCount(4);

  // Every section card carries a heading + meta count.
  const headings = await sections.locator('h2.section-h, .section-h--inline').allInnerTexts();
  expect(headings.length).toBe(4);
  // Headings must be distinct (not 4 copies of the same label).
  const distinct = new Set(headings.map((s) => s.trim()));
  expect(distinct.size).toBe(4);

  // Each section's heading carries a non-empty count.
  for (let i = 0; i < 4; i++) {
    const meta = await sections.nth(i).locator('.section-h__meta').first().innerText();
    expect(meta.trim()).toMatch(/\d/);
    // And the card holds at least one row.
    const rows = sections.nth(i).locator('.browse-row, .station-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
  }
});
