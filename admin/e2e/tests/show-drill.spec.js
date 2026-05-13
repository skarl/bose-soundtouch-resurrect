// Issue #84 — show-drill landing (real Bo, no MITM).
//
// Upstream's `Browse.ashx?c=pbrowse&id=p<N>` is regionally gated from
// Bo's egress (returns `head.status:"400", fault:"Invalid root
// category"` with `body:[]`). The 0.4.2-tunein SPA's show-drill
// dispatch was rewired in issue #84 to compose `Describe.ashx?id=p<N>`
// (show metadata) + `Browse.ashx?id=p<N>` (related Genres / Networks
// sections) instead. Both alternate routes return 200 with usable
// payloads against Bo's CGI proxy.
//
// This spec drives the real SPA, makes the real CGI calls to Bo, and
// asserts the user-visible show-landing surface: title, host meta,
// genre chip, description block, and the inline Play icon on the
// p-prefix guide_id. No MITM — the test fails if Bo's CGI surface
// regresses on either Describe or Browse for a p-id.
//
// Issue #87 layered onto that: the show-landing card is the page
// subject, not a listing row. The hero is mounted as a non-anchor
// element (no body-level href, tap on the body is a no-op); the chip
// and Play icon remain their own clickable surfaces.

import { test, expect } from './_setup.js';

test('show drill landing renders Describe-driven show card with title, hosts, genre chip, Play', async ({ page }) => {
  // p17 = Fresh Air (NPR / WHYY). Stable, documented in Describe.ashx
  // by TuneIn; their canonical talk-show id.
  await page.goto('/#/browse?c=pbrowse&id=p17', { waitUntil: 'load' });

  // The view distinguishes show-landing from generic drill via the
  // data-mode attribute on the outer section.
  await page.waitForSelector('[data-view="browse"][data-mode="show-landing"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Show-landing section is the load-bearing card.
  const landing = page.locator('.browse-section[data-section="showLanding"]');
  await expect(landing).toBeVisible({ timeout: 10_000 });

  // The hero carries the p-prefix guide_id + the show-landing marker.
  // Note: the selector deliberately omits any tag prefix — #87 swapped
  // the underlying element from <a> to <div>; asserting the
  // non-anchor body lives in the dedicated test further down.
  const hero = landing.locator('[data-show-landing="1"][data-sid="p17"]');
  await expect(hero).toBeVisible();

  // The hero name reads "Fresh Air" — Describe-driven.
  await expect(hero.locator('.station-row__name')).toHaveText('Fresh Air');

  // p-prefix lights up the inline Play icon (auto-attached via
  // isPlayableSid).
  await expect(hero.locator('.station-row__play')).toBeVisible();

  // Hosts populate the secondary meta line ("Terry Gross").
  await expect(hero.locator('.station-row__loc')).toContainText('Terry Gross');

  // Genre chip drills to #/browse?id=g168 (Interviews).
  const chip = hero.locator('.station-row__chip--genre');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('data-genre-id', 'g168');

  // Description block follows the row, carrying paragraph chunks.
  const desc = landing.locator('.browse-show-description');
  await expect(desc).toBeVisible();
  const paragraphs = desc.locator('p');
  expect(await paragraphs.count()).toBeGreaterThanOrEqual(1);
});

test('show drill landing hero is a non-anchor body — tap leaves location.hash unchanged (#87)', async ({ page }) => {
  await page.goto('/#/browse?c=pbrowse&id=p17', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="show-landing"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const hero = page.locator('[data-section="showLanding"] [data-show-landing="1"]');
  await expect(hero).toBeVisible();

  // The hero's underlying element is not an anchor. The hero is the
  // page subject (a hero block), not a listing row; tapping the body
  // has no useful destination.
  const tagName = await hero.evaluate((el) => el.tagName.toLowerCase());
  expect(tagName).not.toBe('a');

  // No href attribute on the hero body (neither anchor nor data-href).
  await expect(hero).not.toHaveAttribute('href', /.*/);

  // Tap the hero body (avoiding the chip and the Play icon) and assert
  // the hash didn't navigate. The .station-row__name is the safest
  // body-surface to click — it's not interactive on its own.
  const hashBefore = await page.evaluate(() => location.hash);
  await hero.locator('.station-row__name').click();
  // Allow the router a beat to react — even though nothing should.
  await page.waitForTimeout(250);
  const hashAfter = await page.evaluate(() => location.hash);
  expect(hashAfter).toBe(hashBefore);
});

test('show drill landing surfaces Browse(bare-id) Genres + Networks sections below the card', async ({ page }) => {
  await page.goto('/#/browse?c=pbrowse&id=p17', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="show-landing"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Genres + Networks sections come from Browse.ashx?id=p17 (no
  // c=pbrowse). The keys are stable across the show — Genres always
  // surfaces under key="genres", Networks under key="affiliates".
  const genres = page.locator('.browse-section[data-section="genres"]');
  await expect(genres).toBeVisible({ timeout: 10_000 });
  expect(await genres.locator('a.browse-row').count()).toBeGreaterThanOrEqual(1);

  const networks = page.locator('.browse-section[data-section="affiliates"]');
  await expect(networks).toBeVisible();
  expect(await networks.locator('a.browse-row').count()).toBeGreaterThanOrEqual(1);
});

test('show drill landing Play icon fires /play CGI with the show guide_id', async ({ page }) => {
  await page.goto('/#/browse?c=pbrowse&id=p17', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="show-landing"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Hero element — non-anchor in #87 — exposes the Play icon as its
  // primary affordance.
  const hero = page.locator('[data-section="showLanding"] [data-show-landing="1"][data-sid="p17"]');
  const play = hero.locator('.station-row__play');
  await expect(play).toBeVisible();

  // Tap Play → /play CGI fires. The actual upstream Tune.ashx call
  // returns audio streams for p-prefix ids (confirmed by curl evidence
  // in /tmp/issue-84/bo-direct-tune-p17.json during issue #84
  // investigation); we only assert the round-trip here.
  const playReqPromise = page.waitForRequest(
    (r) => r.url().includes('/cgi-bin/api/v1/play') && r.method() === 'POST',
    { timeout: 10_000 },
  );
  await play.click();
  await playReqPromise;
});
