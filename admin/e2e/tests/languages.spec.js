// Slice #73 — URL discipline + language drill.
//
// Welsh (l117) and Bashkir (l109) are "broken-form" lcodes in the
// TuneIn API: Browse.ashx accepts them in slightly different envelopes
// than the canonical Genre/Location lists. v0.4.2 normalises the
// fetch so the drill page renders ≥1 station row instead of the
// tombstone empty state.

import { test, expect, gotoBrowse } from './_setup.js';

const BROKEN_LCODES = ['l117', 'l109']; // Welsh, Bashkir

for (const lcode of BROKEN_LCODES) {
  test(`By Language → ${lcode} drills to ≥1 station row (not the tombstone)`, async ({ page }) => {
    await gotoBrowse(page, lcode);

    // Wait until the loading skeleton clears.
    await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

    // Tombstone copy from views/browse.js — must not surface for a
    // valid language drill.
    await expect(page.locator('.browse-empty')).toHaveCount(0);
    await expect(page.locator('.browse-error')).toHaveCount(0);

    // ≥1 audio leaf row. The post-#73 normaliser turns broken envelopes
    // into the same outline shape as the canonical genre list.
    const stationRows = page.locator('.station-row');
    await expect(stationRows.first()).toBeVisible({ timeout: 15_000 });
    const count = await stationRows.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
}
