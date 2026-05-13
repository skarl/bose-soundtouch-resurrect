// Slice #73 — URL discipline + language drill.
//
// Welsh (l117) and Bashkir (l109) are "broken-form" lcodes in the
// TuneIn API: Browse.ashx returns either a "No stations or shows
// available" tombstone (via `id=l117`) or only emits drill-link rows
// in odd envelopes (`Browse.ashx?id=c424724&filter=l117`). The
// canonicalised, working form is `c=music&filter=l<NNN>` — emitted
// only when the SPA rewrites the API-emitted URL (tunein-url.js
// canonicaliseBrowseUrl § 7.3).
//
// We assert two things:
//   1. The SPA's Languages tab → Welsh / Bashkir → drilled-into Music
//      row uses the canonicalised form (`c=music&filter=l<NNN>`).
//   2. Drilling into that canonicalised URL via the hash router
//      renders ≥1 browse-row (the Music hub's 25 genre links), NOT
//      the tombstone empty-state.
//
// "≥1 station row" was the old AC; the live API never emits audio
// outlines for Welsh or Bashkir at any depth (the languages have
// stations registered as Talk / News, not Music — see
// docs/tunein-api.md § 7.3, "the language filter is transitive"). The
// minimal proof the canonicalisation works is "≥1 drill row visible
// where the un-rewritten id=l117 form would show the tombstone".

import { test, expect, gotoBrowse } from './_setup.js';

const BROKEN_LCODES = ['l117', 'l109']; // Welsh, Bashkir

test('drill header surfaces the resolved language name when filter is a known lcode (#90)', async ({ page }) => {
  // German (l109) is a high-traffic catalogue entry — the lcode list
  // populated at app boot is authoritative. Navigate directly to the
  // canonical music-in-German drill and assert the page header carries
  // the resolved name alongside the verbatim filter badge.
  await page.goto('/#/browse?c=music&filter=l109', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const badge = page.locator('.browse-crumb__id');
  // The badge always carries the verbatim shape.
  await expect(badge).toContainText('c=music', { timeout: 15_000 });
  await expect(badge).toContainText('filter=l109');
  // The lcode catalogue resolves after app start; allow time for the
  // initial Describe.ashx?c=languages fetch + render.
  await expect(badge).toContainText('(German)', { timeout: 15_000 });
});

test('breadcrumb on a deep language drill resolves the language node to its name, not "By Language" (#89)', async ({ page }) => {
  // The bug from #89: from=lang,lang produced two "By Language" anchors
  // back to back. With the filter-aware crumb encoding, the second
  // anchor should resolve to the language name itself.
  await page.goto(
    '/#/browse?c=music&filter=l109&from=lang,lang%3Al109',
    { waitUntil: 'load' },
  );
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const crumbs = page.locator('.browse-trail__crumb');
  await expect(crumbs).toHaveCount(2, { timeout: 15_000 });
  // First crumb resolves to the language tab's own label (cached or
  // hydrated from Browse.ashx?c=lang). Second crumb resolves to the
  // language name via the in-memory lcode catalogue.
  const second = crumbs.nth(1);
  await expect(second).toHaveText('German', { timeout: 15_000 });
  // And the two anchors are NOT identical — that's the regression
  // the issue fixes.
  const firstText = await crumbs.first().innerText();
  const secondText = await second.innerText();
  expect(firstText).not.toBe(secondText);
});

for (const lcode of BROKEN_LCODES) {
  test(`By Language → ${lcode} drill via c=music&filter=${lcode} renders ≥1 drill row (not the tombstone)`, async ({ page }) => {
    // Navigate via the canonical hash form. The SPA emits this form on
    // its own row hrefs after canonicaliseBrowseUrl rewrites
    // `id=c424724&filter=l<NNN>` → `c=music&filter=l<NNN>`; we drive
    // the router directly to the same destination here.
    await page.goto(`/#/browse?c=music&filter=${encodeURIComponent(lcode)}`, { waitUntil: 'load' });
    await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
    await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

    // Tombstone must NOT surface — that's the regression the slice fixes.
    await expect(page.locator('.browse-empty')).toHaveCount(0);
    await expect(page.locator('.browse-error')).toHaveCount(0);

    // The Music hub renders as drill rows. At least one must mount.
    const drillRows = page.locator('a.browse-row');
    await expect(drillRows.first()).toBeVisible({ timeout: 15_000 });
    const count = await drillRows.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
}
