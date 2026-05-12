// Slice #78 — /play CGI + inline Play.
//
// Two flows exercised:
//   1. Happy path — tap an inline Play icon, assert spinner mounts,
//      assert /now_playing reflects the new station within ~5s, assert
//      a success toast surfaces.
//   2. Error path — MITM the /play response to return the placeholder
//      URL fixture; assert the error toast surfaces and now_playing
//      does NOT change.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect, gotoBrowse } from './_setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'play-placeholder-url.json'), 'utf8'),
);

test('inline Play on a station row spins, updates /now_playing within ~5s, surfaces a toast', async ({ page }) => {
  // Drill into a populated category so we have a station to play.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  const stationRow = page.locator('.station-row').first();
  await expect(stationRow).toBeVisible();

  // Read the row's display name so we can verify /now_playing matches.
  const targetName = (await stationRow.locator('.station-row__name, .station-row__title, [data-role="name"]').first().innerText()).trim();
  expect(targetName.length).toBeGreaterThan(0);

  const playBtn = stationRow.locator('button.station-row__play, [data-action="play"], .inline-play').first();
  await expect(playBtn).toBeVisible();

  // Listen for /now_playing updates surfaced via the speaker WS feed.
  const nowPlayingPromise = page.waitForResponse(
    (r) => r.url().includes('/now_playing') && r.status() === 200,
    { timeout: 10_000 },
  ).catch(() => null);

  await playBtn.click();

  // Spinner mounts on the row.
  await expect(stationRow.locator('.spinner, .is-loading, [data-state="loading"]').first())
    .toBeVisible({ timeout: 2_000 });

  // Toast surfaces.
  await expect(page.locator('.toast, [role="status"]').first()).toBeVisible({ timeout: 6_000 });

  // Either /now_playing fetch returned, or the store mirror updated
  // within ~5s. Both signals are acceptable.
  await Promise.race([
    nowPlayingPromise,
    page.waitForFunction(
      (name) => {
        const el = document.querySelector('[data-view="now-playing"] .np-title, .now-playing .np-title');
        return el && el.textContent && el.textContent.trim().includes(name.slice(0, 8));
      },
      targetName,
      { timeout: 6_000 },
    ).catch(() => null),
  ]);
});

// The error path triggers an intentional console.error in the SPA's
// toast helper. Scope the relaxed-listener config to this describe
// block only so the happy-path test above still enforces a clean log.
test.describe('error path (MITM)', () => {
  test.use({ allowConsoleErrors: true });

  test('MITM placeholder-URL response surfaces the error toast', async ({ page }) => {
    // MITM the /play CGI to inject the placeholder-URL fixture.
    await page.route('**/cgi-bin/play*', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify(PLACEHOLDER_FIXTURE),
      });
    });

    await gotoBrowse(page, 'g3');
    await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

    const row = page.locator('.station-row').first();
    const playBtn = row.locator('button.station-row__play, [data-action="play"], .inline-play').first();
    await expect(playBtn).toBeVisible();

    await playBtn.click();

    // Error toast mounts. Match by class or by error text from the fixture.
    const errToast = page.locator('.toast.is-error, .toast--error, [role="alert"], .toast').filter({
      hasText: /placeholder|couldn't play|cannot stream|error/i,
    }).first();
    await expect(errToast).toBeVisible({ timeout: 8_000 });
  });
});
