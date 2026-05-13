// Issue #88 — transport controls on the now-playing surface.
//
// Two flows exercised:
//
//   1. Buffering indicator. MITM `/speaker/now_playing` to inject a
//      BUFFERING_STATE response and assert the SPA's main play button
//      surfaces a distinct `data-phase="buffering"` state plus the
//      re-entrancy guard. We don't try to catch Bo's own transient
//      buffer window — it's typically shorter than the SPA's 2s poll
//      interval, so a live integration assert is unavoidably flaky.
//      The MITM keeps the spec deterministic; the production transition
//      paths are covered by the unit tests on transport-state.
//
//   2. Prev/Next enablement for a topic-list. Drill into Fresh Air's
//      topics list (p17 — verified reachable from this region), tap
//      an episode, wait for /now_playing to confirm the speaker has
//      taken the new content item, then assert Next becomes enabled
//      and tapping it fires a /play POST with the neighbour topic id.

import { test, expect } from './_setup.js';

const BUFFERING_NP_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<nowPlaying deviceID="test" source="TUNEIN" sourceAccount="">
  <ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/s17488" sourceAccount="" isPresetable="true">
    <itemName>Test station</itemName>
  </ContentItem>
  <track></track>
  <artist></artist>
  <album></album>
  <stationName>Test station</stationName>
  <art artImageStatus="IMAGE_PRESENT">http://example.invalid/art.png</art>
  <favoriteEnabled />
  <playStatus>BUFFERING_STATE</playStatus>
  <streamType>RADIO_STREAMING</streamType>
</nowPlaying>`;

test('buffering glyph: MITM /now_playing with BUFFERING_STATE → main play button shows data-phase="buffering" and refuses PLAY/PAUSE taps', async ({ page }) => {
  // MITM the speaker now_playing CGI to lock the SPA's polling onto a
  // BUFFERING_STATE response. The WS feed only emits on real state
  // changes upstream, so within the assertion window the polled state
  // is what the now-playing view sees.
  await page.route('**/cgi-bin/api/v1/speaker/now_playing**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/xml; charset=utf-8',
      body: BUFFERING_NP_XML,
    });
  });

  await page.goto('/#/', { waitUntil: 'load' });
  await page.waitForSelector('.np-btn--play', { timeout: 5_000 });
  const npPlay = page.locator('.np-btn--play');

  // The SPA polls every 2s, so the first poll cycle lands within ~2s.
  await expect(npPlay).toHaveAttribute('data-phase', 'buffering', { timeout: 6_000 });
  await expect(npPlay).toHaveAttribute('aria-busy', 'true');

  // Tapping the buffering control must be a no-op. CSS marks the button
  // pointer-events:none AND the JS handler refuses to dispatch a
  // PLAY/PAUSE key — assert by absence of any /speaker/key POST during
  // a ~500ms window after a forced click.
  let keyRequestsDuringBuffer = 0;
  const keyListener = (req) => {
    if (!req.url().includes('/cgi-bin/api/v1/speaker/key')) return;
    if (req.method() !== 'POST') return;
    const body = req.postData() || '';
    if (/PLAY|PAUSE/.test(body)) keyRequestsDuringBuffer += 1;
  };
  page.on('request', keyListener);
  try {
    await npPlay.click({ force: true });
    await page.waitForTimeout(400);
    expect(keyRequestsDuringBuffer).toBe(0);
  } finally {
    page.off('request', keyListener);
  }
});

test('topic-list Prev/Next: drill Fresh Air topics → play episode → Next becomes enabled and skips to a neighbour', async ({ page }) => {
  // The flat-body drill renders t-prefix outlines as a single section
  // and primes both tunein.parent.<t<N>> and tunein.topics.<p<N>>
  // caches as a side effect (renderFlatSection → primeTuneinSkipCaches).
  await page.goto('/#/browse?c=topics&id=p17', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Pick a mid-list topic so Prev + Next both have neighbours. Use the
  // 3rd row so a single regional emission gap at the head / tail of
  // the list doesn't strand the spec at an end.
  const topicRow = page.locator('a.station-row[data-sid^="t"]').nth(2);
  await expect(topicRow).toBeVisible({ timeout: 10_000 });
  const targetSid = await topicRow.getAttribute('data-sid');
  expect(targetSid).toMatch(/^t\d+$/);

  const playIcon = topicRow.locator('.station-row__play');
  await expect(playIcon).toBeVisible();

  const playRespPromise = page.waitForResponse(
    (r) => r.url().includes('/cgi-bin/api/v1/play') && r.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await playIcon.click();
  await playRespPromise;

  // Wait for the speaker to confirm the topic took. The SPA's classifier
  // reads /now_playing's location; we need Bo to actually have shifted
  // before the data-transport-mode flip can land. Poll the CGI directly
  // (cheap; the SPA polls every 2s on its own).
  await page.waitForFunction(async (expected) => {
    try {
      const r = await fetch('/cgi-bin/api/v1/speaker/now_playing', { cache: 'no-store' });
      const text = await r.text();
      return text.includes(`location="/v1/playback/station/${expected}`);
    } catch (_e) {
      return false;
    }
  }, targetSid, { timeout: 20_000 });

  await page.goto('/#/', { waitUntil: 'load' });
  await page.waitForSelector('.np-btn--play', { timeout: 5_000 });

  const btnNext = page.locator('.np-btn--next');
  // data-transport-mode is set on the button by the classifier. Once
  // /now_playing has shifted to the t-prefix and the cache primer
  // wrote the parent/siblings, mode flips to "topic-list".
  await expect(btnNext).toHaveAttribute('data-transport-mode', 'topic-list', { timeout: 10_000 });
  await expect(btnNext).toBeEnabled({ timeout: 10_000 });

  // Tap Next — should fire a /play POST (NOT a /speaker/key) targeting
  // a different t-prefix id.
  const skipReqPromise = page.waitForRequest(
    (r) => r.url().includes('/cgi-bin/api/v1/play') && r.method() === 'POST',
    { timeout: 10_000 },
  );
  await btnNext.click();
  const skipReq = await skipReqPromise;
  const skipBody = JSON.parse(skipReq.postData() || '{}');
  expect(skipBody.id).toMatch(/^t\d+$/);
  expect(skipBody.id).not.toBe(targetSid);
});
