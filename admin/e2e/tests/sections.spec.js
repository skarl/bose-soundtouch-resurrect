// Slice #75 — Section rendering.
//
// Folk Music's Browse.ashx response carries four named sections in its
// outline (`local`, `stations`, `shows`, `related`). The drill renderer
// must place each in its own `.browse-section[data-section]` card with
// a labelled section heading and (where the API hasn't inlined a count
// into the title text) a `.section-h__meta` counter.
//
// Folk Music's canonical TuneIn id is **c100000948** — verified live
// against opml.radiotime.com. (The previous `g25` was Consumer, not
// Folk; see docs/tunein-api.md § 7.6 — "Don't hardcode category IDs".)

import { test, expect, gotoBrowse } from './_setup.js';

test('Folk Music drill renders 4 distinct section containers with labels', async ({ page }) => {
  await gotoBrowse(page, 'c100000948');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const sections = page.locator('.browse-section[data-section]');
  await expect(sections.first()).toBeVisible({ timeout: 15_000 });
  await expect(sections).toHaveCount(4);

  // Section data-section attributes are the wire-format keys.
  const keys = await sections.evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
  expect(new Set(keys).size).toBe(4);
  // The four sections Folk Music currently emits. Any drift here is a
  // genuine TuneIn-side change worth investigating, not a flake.
  for (const expected of ['local', 'stations', 'shows', 'related']) {
    expect(keys).toContain(expected);
  }

  // Every section card carries a heading.
  const headings = await sections.locator('h2.section-h .section-h__title').allInnerTexts();
  expect(headings.length).toBe(4);
  const distinct = new Set(headings.map((s) => s.trim()));
  expect(distinct.size).toBe(4);

  // Each section that holds visible rows must hold ≥1 row card. The
  // `related` section renders as a chip strip rather than a stacked
  // card, so it has no `.browse-row` / `.station-row` inside — assert
  // its chip strip instead.
  for (let i = 0; i < 4; i++) {
    const key = keys[i];
    if (key === 'related') {
      // Related surfaces as a chip strip alongside or in place of rows.
      const chips = sections.nth(i).locator('.browse-pivot');
      expect(await chips.count()).toBeGreaterThanOrEqual(1);
    } else {
      const rows = sections.nth(i).locator('a.browse-row, a.station-row');
      expect(await rows.count()).toBeGreaterThanOrEqual(1);
    }
  }
});
