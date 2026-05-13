// Slice #81 — Show drill (c=pbrowse).
//
// The SPA enters the show drill via `#/browse?c=pbrowse&id=p<NN>`,
// which composes Browse.ashx?c=pbrowse&id=p<NN>. Upstream the response
// carries a `liveShow` section (currently-airing show as a p-prefix
// row) and a `topics` section (recent episodes as t-prefix rows). Both
// row kinds render via stationRow, which auto-attaches an inline Play
// icon for p/s/t guide_ids (components.js isPlayableSid).
//
// **NOTE:** Direct c=pbrowse requests to opml.radiotime.com from
// Bo's IP currently return HTTP 200 with
// `{head: {status: "400", fault: "Invalid root category"}, body: []}`
// — a genuine upstream regional gating, NOT an SPA bug. The slice's
// rendering logic is exercised here against the canonical p17 fixture
// (the same data shape used by the unit-suite slice-#81 test), so the
// e2e suite still proves the DOM contract end-to-end on every run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect } from './_setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('show drill renders liveShow + topics with inline Play; topic Play fires /play CGI', async ({ page }) => {
  const fixturePath = join(__dirname, '..', '..', 'test', 'fixtures', 'api',
    'p17-pbrowse.tunein.json');
  const fixture = readFileSync(fixturePath, 'utf8');

  // MITM the c=pbrowse fetch with the canonical liveShow+topics
  // fixture. We don't intercept other tunein/browse calls so the page
  // shell's startup describes/init still hit the real Bo.
  await page.route('**/cgi-bin/api/v1/tunein/browse?**c=pbrowse**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: fixture }));

  await page.goto('/#/browse?c=pbrowse&id=p17', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="drill"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // liveShow section renders as a section card.
  const liveShow = page.locator('.browse-section[data-section="liveShow"]');
  await expect(liveShow).toBeVisible({ timeout: 10_000 });
  // Single p-prefix row inside, with inline Play.
  const liveRow = liveShow.locator('a.station-row[data-sid^="p"]');
  await expect(liveRow).toBeVisible();
  await expect(liveRow.locator('.station-row__play')).toBeVisible();

  // topics section — at least one t-prefix row.
  const topics = page.locator('.browse-section[data-section="topics"]');
  await expect(topics).toBeVisible({ timeout: 10_000 });
  const topicRows = topics.locator('a.station-row[data-sid^="t"]');
  expect(await topicRows.count()).toBeGreaterThanOrEqual(1);

  // Each topic row carries an inline Play icon.
  const firstTopic = topicRows.first();
  const topicPlay = firstTopic.locator('.station-row__play');
  await expect(topicPlay).toBeVisible();

  // Tap the topic Play → /play CGI fires. We assert the network
  // round-trip; the actual /play envelope from Bo is OK — the topic
  // guide_ids (t<digits>) are valid Tune.ashx targets.
  const playReqPromise = page.waitForRequest(
    (r) => r.url().includes('/cgi-bin/api/v1/play') && r.method() === 'POST',
    { timeout: 10_000 },
  );
  await topicPlay.click();
  await playReqPromise;
});
