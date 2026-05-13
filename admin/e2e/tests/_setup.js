// Shared test setup — extends Playwright's `test` with the project's
// standard listener block (per the Playwright recipe memory):
//
//   - console errors           → fail the test
//   - uncaught page errors     → fail the test
//   - failed network requests  → fail the test (CGI under /cgi-bin/)
//
// Every spec imports `test` and `expect` from this module so the
// listeners are wired automatically.

import { test as base, expect } from '@playwright/test';

export { expect };

// Tests opt into noise-tolerance with `test.use({ allowConsoleErrors: true })`
// when they exercise an intentional error path (e.g. the /play error toast).
export const test = base.extend({
  allowConsoleErrors: [false, { option: true }],
  allowNetworkFailures: [false, { option: true }],
  page: async ({ page, allowConsoleErrors, allowNetworkFailures }, use, testInfo) => {
    const consoleErrors = [];
    const pageErrors    = [];
    const requestFails  = [];

    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      // Log every console message so it appears in the trace viewer.
      console.log(`  [c]   ${type} ${text}`);
      if (type === 'error') consoleErrors.push(text);
    });

    page.on('pageerror', (err) => {
      console.log(`  [err] ${err.message}`);
      pageErrors.push(err.message);
    });

    page.on('request', (r) => {
      if (r.url().includes('/cgi-bin/')) {
        console.log(`  [req] ${r.method()} ${r.url()}`);
      }
    });

    page.on('response', (r) => {
      if (r.url().includes('/cgi-bin/')) {
        console.log(`  [res] ${r.status()} ${r.url()}`);
      }
    });

    page.on('requestfailed', (r) => {
      const url = r.url();
      const detail = `${r.method()} ${url} — ${r.failure()?.errorText}`;
      console.log(`  [fail] ${detail}`);
      // The standard listener block scopes "network failure" to the
      // CGI surface; navigation-aborted image loads from
      // cdn-*.tunein.com are not the SPA's responsibility and
      // misfire the assertion on any drill-into-drill test. Match the
      // README's "/cgi-bin/" scope.
      if (url.includes('/cgi-bin/')) requestFails.push(detail);
    });

    await use(page);

    // After the test body runs, assert no leaked errors slipped past.
    if (!allowConsoleErrors && consoleErrors.length > 0) {
      throw new Error(`Console errors observed:\n  ${consoleErrors.join('\n  ')}`);
    }
    if (pageErrors.length > 0) {
      throw new Error(`Uncaught page errors observed:\n  ${pageErrors.join('\n  ')}`);
    }
    if (!allowNetworkFailures && requestFails.length > 0) {
      throw new Error(`Network failures observed:\n  ${requestFails.join('\n  ')}`);
    }
  },
});

// Convenience: drill helper used across multiple specs. Navigates
// directly via the URL hash since the SPA is hash-routed.
export async function gotoBrowse(page, id) {
  const hash = id ? `#/browse?id=${encodeURIComponent(id)}` : '#/browse';
  await page.goto(`/${hash}`, { waitUntil: 'load' });
  await page.waitForFunction((h) => location.hash === h, hash);
  await page.waitForSelector('[data-view="browse"]', { timeout: 15_000 });
}

export async function gotoSearch(page, query) {
  const hash = query ? `#/search?q=${encodeURIComponent(query)}` : '#/search';
  await page.goto(`/${hash}`, { waitUntil: 'load' });
  await page.waitForFunction((h) => location.hash === h, hash);
}
