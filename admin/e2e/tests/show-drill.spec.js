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

  // Show row carries the p-prefix guide_id + the show landing marker.
  const showRow = landing.locator('a.station-row[data-show-landing="1"][data-sid="p17"]');
  await expect(showRow).toBeVisible();

  // The row name reads "Fresh Air" — Describe-driven.
  await expect(showRow.locator('.station-row__name')).toHaveText('Fresh Air');

  // p-prefix lights up the inline Play icon (auto-attached by
  // stationRow's isPlayableSid check).
  await expect(showRow.locator('.station-row__play')).toBeVisible();

  // Hosts populate the secondary meta line ("Terry Gross").
  await expect(showRow.locator('.station-row__loc')).toContainText('Terry Gross');

  // Genre chip drills to #/browse?id=g168 (Interviews).
  const chip = showRow.locator('.station-row__chip--genre');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('data-genre-id', 'g168');

  // Description block follows the row, carrying paragraph chunks.
  const desc = landing.locator('.browse-show-description');
  await expect(desc).toBeVisible();
  const paragraphs = desc.locator('p');
  expect(await paragraphs.count()).toBeGreaterThanOrEqual(1);
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

  const showRow = page.locator('a.station-row[data-show-landing="1"][data-sid="p17"]');
  const play = showRow.locator('.station-row__play');
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
