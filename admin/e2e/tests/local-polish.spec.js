// Slice #82 — Polish grab-bag.
//
// Final-mile polish that didn't fit cleanly into earlier slices:
//   - "Browse all of <country>" anchor on c=local responses, surfacing
//     the localCountry link as a prominent card above the local audio list.
//   - Tiny-country annotation when a country surfaces ≤5 stations
//     (Vatican / Liechtenstein / Andorra). The live r-list API doesn't
//     emit `station_count` metadata on country rows, so we MITM the
//     Browse response to inject one (the SPA fixture under
//     admin/test/fixtures/api/r-europe-countries.tunein.json is the
//     canonical shape).
//   - Every `<img>` rendered in the SPA has loading="lazy".
//   - `related` arrays render as chip rows on the browse drill page.
//   - Station-detail call-to-action reads "Play" (not "Audition" /
//     "Testplay" — see project memory).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect, gotoBrowse } from './_setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

test('tiny-country drills carry the tiny-country annotation (MITMed station_count)', async ({ page }) => {
  // The live r-list API doesn't emit station_count on country rows,
  // so this assertion would never fire against a real Bo response.
  // MITM the Browse fetch for the European-countries node with the
  // already-canonical fixture from the unit suite — same data shape
  // the slice was authored against.
  const fixturePath = join(__dirname, '..', '..', 'test', 'fixtures', 'api',
    'r-europe-countries.tunein.json');
  const fixture = readFileSync(fixturePath, 'utf8');

  await page.route('**/cgi-bin/api/v1/tunein/browse?id=r-europe-countries**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: fixture }));
  // The fixture uses guide_ids r101193 / r101160 / r101110 / r101172 /
  // r100346; we navigate via a synthetic id and serve the fixture.
  await page.route('**/cgi-bin/api/v1/tunein/browse?id=r-tiny-countries-mitm', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: fixture }));

  await page.goto('/#/browse?id=r-tiny-countries-mitm', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="drill"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // The annotation lives on rows whose count is <= 5 (browse.js
  // TINY_COUNTRY_THRESHOLD). The fixture has Vatican (1), Liechtenstein
  // (3), Andorra (5) under that threshold; the annotation must mount
  // on each.
  const annotations = page.locator('.browse-row__annot[data-tiny-country="1"]');
  await expect(annotations.first()).toBeVisible({ timeout: 5_000 });
  expect(await annotations.count()).toBeGreaterThanOrEqual(3);

  // Each annotation's text is " · N station(s)".
  const texts = await annotations.allInnerTexts();
  for (const t of texts) {
    expect(t).toMatch(/·\s+\d+\s+stations?$/);
  }
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
