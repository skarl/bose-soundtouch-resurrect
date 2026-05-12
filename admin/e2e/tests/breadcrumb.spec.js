// Slice #74 — Breadcrumb + crumb stack.
//
// Drilling N levels deep records each parent in the URL hash via a
// `from=<list>` parameter. The page header reads the API's `head.title`,
// not the URL id. A page refresh preserves the crumb stack; Back pops
// one level.

import { test, expect, gotoBrowse } from './_setup.js';

test('drilling 3 levels records from=<list>, header reads head.title, refresh + Back preserve the stack', async ({ page }) => {
  // Level 1 — Music root.
  await gotoBrowse(page, 'c=music');
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Pick the first drillable .browse-row and follow it.
  const firstDrill = page.locator('a.browse-row').first();
  await expect(firstDrill).toBeVisible();
  const level2Id = (await firstDrill.getAttribute('href')) || '';
  expect(level2Id).toMatch(/#\/browse\?id=/);
  await firstDrill.click();
  await page.waitForFunction((h) => location.hash.startsWith(h), '#/browse?id=');

  // Level 2 — wait for it to render, then capture its header text.
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });
  const level2Header = (await page.locator('.section-h__title').first().innerText()).trim();
  expect(level2Header.length).toBeGreaterThan(0);

  // Level 3 — drill again.
  const secondDrill = page.locator('a.browse-row').first();
  await expect(secondDrill).toBeVisible();
  await secondDrill.click();
  await page.waitForFunction(() => location.hash.includes('from='), null, { timeout: 10_000 });

  // URL hash carries from=<list> with the crumb stack.
  const level3Hash = await page.evaluate(() => location.hash);
  expect(level3Hash).toMatch(/from=/);

  // Page header reads the API's head.title — not the bare URL id.
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });
  const level3Header = (await page.locator('.section-h__title').first().innerText()).trim();
  expect(level3Header.length).toBeGreaterThan(0);
  // The id appears separately as a badge, not as the only header text.
  const headerHasMoreThanId = level3Header.replace(/[a-z]\d+/i, '').trim().length > 0;
  expect(headerHasMoreThanId).toBe(true);

  // Refresh — breadcrumb (the from= chain) survives.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
  const afterReloadHash = await page.evaluate(() => location.hash);
  expect(afterReloadHash).toMatch(/from=/);

  // Click Back (the inline back link, not browser back). The .browse-back
  // anchor pops one level off the from= chain.
  const back = page.locator('a.browse-back, button.browse-back, [data-action="back"]').first();
  await expect(back).toBeVisible();
  await back.click();

  // Hash + header have shifted one level up.
  await page.waitForFunction((h) => location.hash !== h, afterReloadHash, { timeout: 10_000 });
  const newHash = await page.evaluate(() => location.hash);
  expect(newHash).not.toBe(afterReloadHash);
  const newHeader = (await page.locator('.section-h__title').first().innerText()).trim();
  expect(newHeader).not.toBe(level3Header);
});
