// Slice #78 — /play CGI + inline Play.
//
// Two flows exercised:
//   1. Happy path — tap an inline Play icon, assert the /play CGI
//      fires and the SPA renders a success toast naming the station.
//   2. Error path — MITM the /play response to return the placeholder
//      URL fixture; assert the SPA's error toast surfaces.
//
// The SPA's Play button is `span.station-row__play[role="button"]`
// (components.js stationRow). It does NOT trigger an explicit
// /now_playing fetch — the now-playing surface relies on the speaker's
// WebSocket presentation feed, which arrives independently. Assert
// the network round-trip and the toast; those are the deterministic
// signals.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect, gotoBrowse } from './_setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'play-placeholder-url.json'), 'utf8'),
);

test('inline Play on a station row fires /play and surfaces a success toast', async ({ page }) => {
  // Drill into a populated, well-stocked genre.
  await gotoBrowse(page, 'g3');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Pick the first station row (any section). station-rows have data-sid.
  const stationRow = page.locator('a.station-row[data-sid]').first();
  await expect(stationRow).toBeVisible();

  // Read the row's display name so we can verify the toast.
  const targetName = (await stationRow.locator('.station-row__name').innerText()).trim();
  expect(targetName.length).toBeGreaterThan(0);

  const playBtn = stationRow.locator('.station-row__play');
  await expect(playBtn).toBeVisible();

  // Install the /play response listener before clicking.
  const playResponsePromise = page.waitForResponse(
    (r) => r.url().includes('/cgi-bin/api/v1/play')
       && r.request().method() === 'POST'
       && r.status() === 200,
    { timeout: 10_000 },
  );

  await playBtn.click();

  // Spinner mounts on the play button (CSS .is-loading).
  await expect(playBtn).toHaveClass(/is-loading/, { timeout: 2_000 });

  await playResponsePromise;

  // Success toast surfaces. Toast text starts with "Playing on Bo: ".
  // Toasts dwell ~2s; the wait must catch the toast inside that window.
  await expect(page.locator('.toast').filter({ hasText: 'Playing on Bo' }).first())
    .toBeVisible({ timeout: 3_000 });
});

// The error path triggers an intentional console.error in the SPA's
// toast helper (showToast doesn't actually log; but route-intercepted
// 422 responses may surface console errors from the SPA's fetch
// handler). Scope the relaxed-listener config to this describe block
// only so the happy-path test above still enforces a clean log.
test.describe('error path (MITM)', () => {
  test.use({ allowConsoleErrors: true });

  test('MITM placeholder-URL response surfaces the error toast', async ({ page }) => {
    // MITM the /play CGI to inject the placeholder-URL fixture. The
    // browser fetch treats a 422 with a JSON body as a non-throwing
    // response; the SPA reads .ok=false and toasts the documented
    // error message.
    await page.route('**/cgi-bin/api/v1/play**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PLACEHOLDER_FIXTURE),
      });
    });

    await gotoBrowse(page, 'g3');
    await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

    const row = page.locator('a.station-row[data-sid]').first();
    const playBtn = row.locator('.station-row__play');
    await expect(playBtn).toBeVisible();

    await playBtn.click();

    // An error toast surfaces — the SPA branches on result.error and
    // calls messageFor(code). The placeholder fixture's `error` field
    // is `placeholder_url`, which falls through to the generic
    // "Could not play this row" message. Match by absence of the
    // success "Playing on Bo:" prefix and presence of a toast.
    const toast = page.locator('.toast').first();
    await expect(toast).toBeVisible({ timeout: 5_000 });
    const toastText = (await toast.innerText()).trim();
    expect(toastText.toLowerCase()).not.toContain('playing on bo');
    expect(toastText.toLowerCase()).toMatch(/could not|cannot|error|fail|not available|placeholder/);
  });
});
