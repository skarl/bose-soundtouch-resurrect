// Slice #74 — Breadcrumb + crumb stack.
//
// Drilling N levels deep records each parent in the URL hash via a
// `from=<list>` parameter. The page title row reads the API's
// `head.title` (not the URL id), and the drill stack survives a
// reload. The pill-bar's circular Back chevron (`a.browse-bar__back`)
// pops one level. Selectors target the post-#103 pill-bar DOM:
//
//   .browse-bar          — wrapping pill row
//   .browse-bar__back    — circular Back chevron
//   .browse-title        — h1 page title row
//   .browse-title__sid   — small muted sid suffix in the title row

import { test, expect } from './_setup.js';

test('drilling 3 levels records from=<list>; refresh + Back preserve / pop the stack', async ({ page }) => {
  // Level 1 — Music root (c=music). gotoBrowse() only builds `id=`-
  // anchored hashes; route past it directly.
  await page.goto('/#/browse?c=music', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="drill"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Level-1 page title reads head.title from the API ("Music").
  const level1Title = (await page.locator('.browse-title').first().innerText()).trim();
  expect(level1Title.length).toBeGreaterThan(0);

  // Level 2 — Folk Music (c100000948) is a stable, reliably-populated
  // genre. Pick by guide_id rather than .first() so the test is
  // deterministic across upstream re-rankings of the Music hub.
  const folkRow = page.locator('a.browse-row[href*="id=c100000948"]').first();
  await expect(folkRow).toBeVisible({ timeout: 10_000 });
  await folkRow.click();
  await page.waitForFunction(
    () => /id=c100000948\b/.test(decodeURIComponent(location.hash))
       && /from=music\b/.test(decodeURIComponent(location.hash)),
    null,
    { timeout: 10_000 },
  );
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Level-2 page title reads head.title — "Folk".
  const level2Title = (await page.locator('.browse-title').first().innerText()).trim();
  expect(level2Title.length).toBeGreaterThan(0);
  expect(level2Title).not.toBe(level1Title);

  // Level 3 — drill into the first station in the `local` section. A
  // station row links to #/station/sNNN which is a different view
  // (station detail), so to keep this test scoped to the browse-drill
  // crumb stack we drill into a Pop/Adult Hits-style related chip if
  // available; otherwise drill into the `By Location` pivot. Folk's
  // related section has `popular` + `pivotLocation` chips — both have
  // hrefs encoding `from=music,c100000948`, so either suffices.
  const level3Link = page.locator('.browse-related a.browse-pivot').first();
  await expect(level3Link).toBeVisible({ timeout: 10_000 });
  await level3Link.click();
  // The level-3 hash must carry from=<two-element-list>. Comma is
  // URL-encoded as `%2C` in `location.hash`; check either form.
  await page.waitForFunction(
    () => /from=[^&]*(?:,|%2C)[^&]*/i.test(location.hash),
    null,
    { timeout: 10_000 },
  );
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 20_000 });

  // URL hash carries from=<comma-separated list>.
  const level3Hash = await page.evaluate(() => location.hash);
  expect(level3Hash).toMatch(/from=[^&]+(?:,|%2C)[^&]+/i);

  // Page title reads head.title — non-empty, distinct from the
  // verbatim sid suffix in the title row.
  const level3Title = (await page.locator('.browse-title').first().innerText()).trim();
  expect(level3Title.length).toBeGreaterThan(0);
  // The title is the API head.title (human name); the
  // .browse-title__sid sibling carries the verbatim id/parts.
  const level3IdBadge = (await page.locator('.browse-title__sid').first().innerText()).trim();
  expect(level3IdBadge.length).toBeGreaterThan(0);
  expect(level3Title).not.toBe(level3IdBadge);

  // Refresh — breadcrumb (the from= chain) survives.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="drill"]', { timeout: 15_000 });
  const afterReloadHash = await page.evaluate(() => location.hash);
  expect(afterReloadHash).toMatch(/from=[^&]+(?:,|%2C)[^&]+/i);

  // Click Back (the circular chevron in the pill bar). The pill-bar
  // back anchor pops one level off the from= chain.
  const back = page.locator('a.browse-bar__back').first();
  await expect(back).toBeVisible();
  await back.click();

  // Hash + title have shifted one level up.
  await page.waitForFunction((h) => location.hash !== h, afterReloadHash, { timeout: 10_000 });
  const newHash = await page.evaluate(() => location.hash);
  expect(newHash).not.toBe(afterReloadHash);
  // The `from=` chain on the parent has one element fewer (or no
  // from= at all when we land at level 1).
  if (newHash.includes('from=')) {
    const fromAfter = decodeURIComponent((newHash.match(/from=([^&]+)/) || [])[1] || '');
    const fromBefore = decodeURIComponent((afterReloadHash.match(/from=([^&]+)/) || [])[1] || '');
    expect(fromAfter.split(',').length).toBeLessThan(fromBefore.split(',').length);
  }
});
