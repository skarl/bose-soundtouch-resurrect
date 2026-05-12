// Slice #82 — Polish grab-bag.
//
// Final-mile polish that didn't fit cleanly into earlier slices:
//   - "Browse all of <country>" anchor on Local Radio drills.
//   - Tiny-country annotation when a country surfaces only a handful of
//     stations.
//   - Every <img> in the SPA has loading="lazy".
//   - `related` arrays render as chip rows.
//   - Station-detail call-to-action reads "Play" (not "Audition" /
//     "Testplay" — see project memory).

import { test, expect, gotoBrowse } from './_setup.js';

test('Local Radio surfaces a "Browse all of <country>" card', async ({ page }) => {
  // Local Radio root: r0 → region → country drill. r100000079 is the
  // canonical Germany id in the TuneIn taxonomy.
  await gotoBrowse(page, 'r100000079');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const browseAll = page.locator('a, button').filter({ hasText: /Browse all of\s+/i }).first();
  await expect(browseAll).toBeVisible({ timeout: 10_000 });
});

test('tiny-country drills carry the tiny-country annotation', async ({ page }) => {
  // A small country drill — Vatican City / San Marino / Andorra all
  // qualify. We probe via a couple of candidates and assert the
  // annotation surfaces on at least one.
  const candidates = ['r101188', 'r101384', 'r101107']; // Vatican, San Marino, Andorra
  let found = false;
  for (const id of candidates) {
    await gotoBrowse(page, id);
    await page.locator('.browse-loading').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    const annotation = page.locator('.tiny-country, [data-annotation="tiny-country"], .browse-tiny-note').first();
    if (await annotation.count() > 0 && await annotation.isVisible().catch(() => false)) {
      found = true;
      break;
    }
  }
  expect(found, 'expected at least one tiny-country annotation across Vatican/San Marino/Andorra').toBe(true);
});

test('every <img> on the browse view has loading="lazy"', async ({ page }) => {
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const offenders = await page.$$eval('img', (imgs) =>
    imgs
      .filter((img) => img.getAttribute('loading') !== 'lazy')
      // Inline SVG fallback markers sometimes use <img> with data: URIs
      // and an explicit loading="eager" — surface those if present.
      .map((img) => img.getAttribute('src') || img.outerHTML.slice(0, 80)));
  expect(offenders, `images missing loading="lazy": ${offenders.join(', ')}`).toEqual([]);
});

test('`related` entries render as chips on a station detail', async ({ page }) => {
  // Drill from a populated category, follow the first station.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });
  const firstStation = page.locator('.station-row a[href*="#/station/"], a.station-row[href*="#/station/"]').first();
  await expect(firstStation).toBeVisible({ timeout: 10_000 });
  await firstStation.click();
  await page.waitForFunction(() => location.hash.startsWith('#/station/'), null, { timeout: 10_000 });
  await page.waitForSelector('[data-view="station"]', { timeout: 15_000 });

  // If the station carries a `related` array, it renders as chips.
  // Some stations have no related set; we don't fail the spec when
  // there are zero related entries, but if any are present they MUST
  // render as chips.
  const related = page.locator('.related-chips, [data-role="related"], .station-related');
  if (await related.count() > 0) {
    const chips = related.first().locator('.chip, a.related-chip, [role="link"]');
    expect(await chips.count()).toBeGreaterThanOrEqual(1);
  }
});

test('station-detail call-to-action reads "Play"', async ({ page }) => {
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });
  const firstStation = page.locator('.station-row a[href*="#/station/"], a.station-row[href*="#/station/"]').first();
  await firstStation.click();
  await page.waitForFunction(() => location.hash.startsWith('#/station/'), null, { timeout: 10_000 });

  const cta = page.locator('[data-view="station"] button.station-play, [data-view="station"] [data-action="play"], [data-view="station"] button').filter({ hasText: /Play\b/ }).first();
  await expect(cta).toBeVisible({ timeout: 10_000 });
  const label = (await cta.innerText()).trim();
  expect(label).toMatch(/^Play$/);
  // Project memory: the verb is "Play". "Audition" / "Testplay" are forbidden.
  expect(label).not.toMatch(/Audition|Testplay/i);
});
