// Slice #82 — Polish grab-bag.
//
// Final-mile polish that didn't fit cleanly into earlier slices:
//   - "Browse all of <country>" anchor on c=local responses, surfacing
//     the localCountry link as a prominent card above the local audio list.
//   - Every `<img>` rendered in the SPA has loading="lazy".
//   - `related` arrays render as chip rows on the browse drill page.
//   - Station-detail call-to-action reads "Play" (not "Audition" /
//     "Testplay" — see project memory).
//
// The tiny-country annotation originally shipped in slice #82 has been
// retired (issue #85): the live Browse.ashx r-list response does not
// emit `count` / `station_count` / `item_count` on country rows, so
// the threshold render path could never fire against a real Bo. The
// spec below asserts the retirement against a real Bo drill into a
// tiny country (Vatican City, r101312).

import { test, expect, gotoBrowse } from './_setup.js';

test('Local Radio (c=local) surfaces a "Browse all of <country>" card', async ({ page }) => {
  // c=local is the canonical entry to Local Radio. Its response
  // carries a `key="localCountry"` child the SPA lifts into the
  // .browse-local-country card. gotoBrowse() only builds id=-anchored
  // hashes; route past it directly.
  await page.goto('/#/browse?c=local', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="drill"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const card = page.locator('a.browse-local-country[data-local-country="1"]');
  await expect(card).toBeVisible({ timeout: 10_000 });
  const label = (await card.locator('.browse-local-country__label').innerText()).trim();
  expect(label).toMatch(/^Browse all of\s+/);
});

test('tiny-country annotation is retired — Vatican drill renders without any .browse-row__annot', async ({ page }) => {
  // Issue #85: the threshold render path was retired because the live
  // Browse.ashx r-list response carries only element/type/text/URL/
  // guide_id on country rows. No count / station_count / item_count
  // is emitted, so the annotation could never fire on a real Bo
  // egress. This spec drills into Vatican City (r101312, currently
  // one station on the wire) on Bo and asserts no annotation node
  // leaks into the rendered drill — proving the dead code path is
  // gone end-to-end, not just in unit tests.
  await gotoBrowse(page, 'r101312');
  await page.waitForSelector('[data-view="browse"][data-mode="drill"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // The drill must actually render — at least one audio row from the
  // Vatican station list. If Bo returns an empty body the rest of the
  // assertion is meaningless.
  await expect(page.locator('.station-row').first()).toBeVisible({ timeout: 10_000 });

  // No annotation node anywhere on the page — neither the class nor
  // the data-attribute survives.
  await expect(page.locator('.browse-row__annot')).toHaveCount(0);
  await expect(page.locator('[data-tiny-country]')).toHaveCount(0);
});

test('every <img> on the browse view has loading="lazy"', async ({ page }) => {
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const offenders = await page.$$eval('img', (imgs) =>
    imgs
      .filter((img) => img.getAttribute('loading') !== 'lazy')
      .map((img) => img.getAttribute('src') || img.outerHTML.slice(0, 80)));
  expect(offenders, `images missing loading="lazy": ${offenders.join(', ')}`).toEqual([]);
});

test('`related` entries render as chips on a browse drill', async ({ page }) => {
  // Folk Music (c100000948) has a related section with two pivots
  // (Most Popular, By Location). Each chip is .browse-pivot, mounted
  // inside .browse-related.
  await gotoBrowse(page, 'c100000948');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const relatedSection = page.locator('.browse-section[data-section="related"]');
  await expect(relatedSection).toBeVisible({ timeout: 10_000 });
  const chips = relatedSection.locator('.browse-pivot');
  expect(await chips.count()).toBeGreaterThanOrEqual(1);
});

test('station-detail call-to-action reads "Play"', async ({ page }) => {
  // Drill into a populated category, follow the first station row to
  // the station detail view, wait for the probe to settle, assert the
  // play CTA label.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const firstStation = page.locator('a.station-row[href*="#/station/"]').first();
  await expect(firstStation).toBeVisible({ timeout: 10_000 });

  // Click the row body (not the inline Play icon) — the row anchor is
  // a link to #/station/<sid>. We force-click on the row's name span
  // to avoid hitting the Play icon's stopPropagation.
  await firstStation.locator('.station-row__name').click();
  await page.waitForFunction(() => location.hash.startsWith('#/station/'), null, { timeout: 10_000 });
  await page.waitForSelector('[data-view="station"]', { timeout: 15_000 });

  // The Play CTA is button.station-test-play (station.js
  // buildTestPlayButton). It only mounts on playable verdicts so wait
  // for the probe to settle. Skeleton time can be up to ~15s on Bo
  // since the probe walks Tune.ashx + parses streams.
  const cta = page.locator('[data-view="station"] button.station-test-play');
  await expect(cta).toBeVisible({ timeout: 30_000 });

  // The visible label inside the CTA is the .station-test-play__label
  // span. The button has a secondary description span below; assert
  // the primary label text exactly reads "Play".
  const label = (await cta.locator('.station-test-play__label').innerText()).trim();
  expect(label).toMatch(/^Play$/);
  // Project memory: the verb is "Play". "Audition" / "Testplay" are forbidden.
  expect(label).not.toMatch(/Audition|Testplay/i);
});
