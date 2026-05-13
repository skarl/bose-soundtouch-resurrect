// Issue #88 — transport controls on the now-playing surface.
//
// Two flows exercised against the real speaker:
//
//   1. Buffering indicator. Tap the inline Play icon on a TUNEIN show
//      row (Fresh Air, p17 — verified reachable from this region), open
//      the now-playing view, and assert the main play button surfaces a
//      distinct `data-phase="buffering"` state before the speaker
//      finishes buffering. The buffer glyph (3-dot icon) replaces both
//      Play (triangle) and Pause (two bars).
//
//   2. Prev/Next enablement for a topic-list. Drill into Fresh Air's
//      topics list, tap an episode, jump to now-playing, assert Next
//      becomes enabled, tap Next, and assert /now_playing shifts to a
//      different topic id within ~5s.
//
// The spec uses BOSE_HOST via the shared baseURL in playwright.config.js
// — no hardcoded IPs. The standard listener block from _setup.js
// catches console errors and CGI failures.

import { test, expect } from './_setup.js';

test('buffering glyph: tap a TUNEIN show row → main play button shows data-phase="buffering"', async ({ page }) => {
  // Drill into the show-landing card for Fresh Air. p17 is reachable
  // from this region (verified live in issue #88).
  await page.goto('/#/browse?c=pbrowse&id=p17', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"][data-mode="show-landing"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // The inline Play on the show hero kicks off a p-prefix /play call.
  // The Tune.ashx round-trip + audio-socket open takes ~3-6 s; the
  // SPA must surface a distinct buffering state during that window.
  const hero = page.locator('[data-section="showLanding"] [data-show-landing="1"][data-sid="p17"]');
  const playIcon = hero.locator('.station-row__play');
  await expect(playIcon).toBeVisible();

  // Capture the /play network round-trip alongside the click so we
  // assert the buffering state appears while audio is genuinely in
  // flight (and not just for the ~500 ms station-row inline spinner).
  const playRespPromise = page.waitForResponse(
    (r) => r.url().includes('/cgi-bin/api/v1/play') && r.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await playIcon.click();
  await playRespPromise;

  // Jump to the now-playing view. The mini-player's main play button
  // and the now-playing main play button share data-phase semantics —
  // we assert on the now-playing surface because that's the new
  // affordance in #88 (the mini-player already worked via inline play).
  await page.goto('/#/', { waitUntil: 'load' });
  await page.waitForSelector('.np-btn--play', { timeout: 5_000 });
  const npPlay = page.locator('.np-btn--play');

  // Wait for buffering to surface. The speaker's playStatus drives
  // this — Bo flips through STOP/INVALID → BUFFERING → PLAY during
  // the first 3-6 seconds. The buffer glyph must appear at least once
  // in that window.
  await expect(npPlay).toHaveAttribute('data-phase', 'buffering', { timeout: 6_000 });
  await expect(npPlay).toHaveAttribute('aria-busy', 'true');

  // The button surface is a no-op in this state — pointer events are
  // off and the JS guard refuses to send a PLAY/PAUSE key. The assert
  // is "no PLAY/PAUSE network request fires when we tap it"; the
  // simplest reliable wire-shape check is "no /speaker/key with
  // press body of PLAY or PAUSE during the next ~500ms".
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

test('topic-list Prev/Next: drill into Fresh Air, play an episode, Next becomes enabled and skips to the next topic', async ({ page }) => {
  // Walk into the topics list directly via the c=topics route. That
  // endpoint is regional but verified reachable for p17 from this
  // region (issue #88). The drill primes the parent + topics-list
  // caches as a side effect of rendering — see browse.js
  // primeTuneinSkipCaches.
  await page.goto('/#/browse?c=topics&id=p17', { waitUntil: 'load' });
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
  await expect(page.locator('.browse-loading')).toHaveCount(0, { timeout: 15_000 });

  // Locate the topic rows (t-prefix). Pick the second so Prev + Next
  // both have a neighbour.
  const topicRow = page.locator('a.station-row[data-sid^="t"]').nth(1);
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

  // Hop to the now-playing surface. The speaker's /now_playing will
  // shift to the t-prefix once it accepts the new content item.
  await page.goto('/#/', { waitUntil: 'load' });
  await page.waitForSelector('.np-btn--play', { timeout: 5_000 });

  // Wait for the transport row to reflect the topic-list mode (the
  // classifier marks the buttons with data-transport-mode).
  const btnNext = page.locator('.np-btn--next');
  await expect(btnNext).toHaveAttribute('data-transport-mode', 'topic-list', { timeout: 10_000 });
  // And to actually be enabled.
  await expect(btnNext).toBeEnabled({ timeout: 10_000 });

  // Tap Next — should fire a /play POST (NOT a /speaker/key) targeting
  // a different t-prefix id. We snapshot the request body to assert
  // the neighbour id is non-empty and != current.
  const skipReqPromise = page.waitForRequest(
    (r) => r.url().includes('/cgi-bin/api/v1/play') && r.method() === 'POST',
    { timeout: 10_000 },
  );
  await btnNext.click();
  const skipReq = await skipReqPromise;
  const skipBody = JSON.parse(skipReq.postData() || '{}');
  expect(skipBody.id).toMatch(/^t\d+$/);
  expect(skipBody.id).not.toBe(targetSid);

  // The /now_playing should reflect the skip within ~5s. Poll the
  // speaker XML through the SPA's WS-driven now-playing surface — the
  // simplest signal is the np-name text changing away from what we
  // just played. We don't know the exact next name (regional, varies
  // by show) so just assert the location updates to a different t-id
  // by querying the speaker endpoint directly via the CGI proxy.
  await page.waitForFunction(async (prevSid) => {
    try {
      const r = await fetch('/cgi-bin/api/v1/speaker/now_playing', { cache: 'no-store' });
      const text = await r.text();
      // Parse the location attribute out of the ContentItem element.
      const m = text.match(/<ContentItem[^>]*location="\/v1\/playback\/station\/(t\d+)/);
      return m && m[1] !== prevSid;
    } catch (_e) {
      return false;
    }
  }, targetSid, { timeout: 8_000 });
});
