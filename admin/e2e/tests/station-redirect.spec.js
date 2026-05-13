// Issue #86 — /station/<sid> safety net for non-`s` sids.
//
// Before #86 the router's only `/station/` matcher was strict on
// `s\d+`, so #/station/p<N> and #/station/t<N> fell through to the
// not-found view. Combined with stationRow's hard-coded
// `#/station/<sid>` default, the show-self card on the show landing
// (#84) emitted silent dead links — clicking the body for p73 (Jazz
// at Lincoln Center) landed on the not-found placeholder rather than
// the show landing itself.
//
// This spec drives the real SPA against Bo and asserts:
//   - #/station/p73 redirects to #/browse?id=p73 and renders the
//     show landing card (the route #84 dispatches on).
//   - #/station/t<N> redirects to #/browse?id=t<N>. The browse view
//     may render a fallback (TuneIn doesn't have a public detail page
//     for topic ids reached this way), but the URL transition is
//     what we're pinning — the row body must never dead-end.
//   - #/station/<unknown-prefix> still renders the not-found view.
//   - #/station/s<N> (real preset s-sid on Bo) is unaffected — the
//     existing station detail view still mounts.

import { test, expect } from './_setup.js';

test('#/station/p73 redirects to the show landing and renders the show-landing card', async ({ page }) => {
  // Navigate to the dead-link URL the show-self card used to emit.
  await page.goto('/#/station/p73', { waitUntil: 'load' });

  // The hash should be replaced — not pushed — to the canonical show
  // landing route. The `c=pbrowse` qualifier triggers the show-landing
  // dispatch in browse.js (#84); without it the bare-id path drops
  // into the generic drill and the show metadata never surfaces.
  await page.waitForFunction(
    () => location.hash === '#/browse?c=pbrowse&id=p73',
    null,
    { timeout: 5_000 },
  );

  // The browse view mounts, and the show-landing renderer (per #84)
  // takes over for a p-prefix bare id.
  await page.waitForSelector(
    '[data-view="browse"][data-mode="show-landing"]',
    { timeout: 15_000 },
  );
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Jazz at Lincoln Center — per Bo's live Describe.ashx?id=p73.
  // Issue #87 replaced the stationRow misuse on the hero with a non-
  // anchor showHero element. The hero carries data-show-landing="1"
  // and renders the show name in .station-row__name (CSS parity).
  const landing = page.locator('.browse-section[data-section="showLanding"]');
  await expect(landing).toBeVisible({ timeout: 10_000 });
  const hero = landing.locator('[data-show-landing="1"]');
  await expect(hero).toBeVisible();
  // Hero is a non-anchor — body tap is naturally inert.
  await expect(hero).not.toHaveJSProperty('tagName', 'A');
  await expect(hero.locator('.station-row__name')).toHaveText('Jazz at Lincoln Center');
});

test('#/station/t12345 redirects to a browse drill (URL transition only)', async ({ page }) => {
  // t-prefix ids are episode ids; TuneIn's Browse.ashx returns
  // "Invalid root category" for most synthetic topic ids reached
  // outside their parent show's c=pbrowse list. The redirect itself
  // is what we're pinning — the body must never dead-end on the
  // /station/ route.
  //
  // The browse view may render an empty body or an error pill for an
  // unresolvable id; either is acceptable here. We assert the hash
  // transition and that the browse view mounts (no not-found surface).
  await page.goto('/#/station/t12345', { waitUntil: 'load' });

  await page.waitForFunction(
    () => location.hash === '#/browse?id=t12345',
    null,
    { timeout: 5_000 },
  );

  // The browse view mounts (not the not-found view).
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
  await expect(page.locator('[data-view="not-found"]')).toHaveCount(0);
});

test('#/station/garbage renders the not-found view (no redirect, no dead-end)', async ({ page }) => {
  // The wildcard catch-all matches, but the prefix dispatch falls
  // through to the not-found render. The hash is preserved (no
  // location.replace) so the user can edit the URL and try again.
  await page.goto('/#/station/garbage', { waitUntil: 'load' });

  // Not-found view mounts.
  await page.waitForSelector('[data-view="not-found"]', { timeout: 10_000 });
  await expect(page.locator('[data-view="not-found"]')).toBeVisible();

  // No silent redirect away — the hash stays put.
  expect(await page.evaluate(() => location.hash)).toBe('#/station/garbage');

  // And the browse view is NOT mounted (we did not redirect).
  await expect(page.locator('[data-view="browse"]')).toHaveCount(0);
});

test('#/station/s12345 still mounts the station detail view (strict matcher unchanged)', async ({ page }) => {
  // s12345 (KEXP) — a known real station guide_id with a stable
  // station detail page. The strict matcher takes precedence over
  // the wildcard; the station view (preset assignment + probe) still
  // mounts. No redirect, no not-found.
  await page.goto('/#/station/s12345', { waitUntil: 'load' });

  // Hash unchanged.
  await page.waitForFunction(
    () => location.hash === '#/station/s12345',
    null,
    { timeout: 5_000 },
  );

  // Station view mounts. Use the canonical data-view marker used
  // across the SPA so we don't couple to internal layout.
  await page.waitForSelector('[data-view="station"]', { timeout: 15_000 });

  // Not-found and browse views are NOT mounted.
  await expect(page.locator('[data-view="not-found"]')).toHaveCount(0);
  await expect(page.locator('[data-view="browse"]')).toHaveCount(0);
});
