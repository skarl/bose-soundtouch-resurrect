// Playwright config for the admin SPA e2e suite.
//
// Target host comes from BOSE_HOST. Default is Bo's IP per project
// memory (the test speaker at 192.168.178.36, port 8181 served by
// busybox httpd on the device).
//
//   BOSE_HOST=192.168.x.x npm test          # different speaker
//   BOSE_HOST=192.168.178.36 npm test       # explicit Bo
//   npm test                                # falls back to Bo
//
// The standard listener block (console errors, network failures, and
// uncaught promise rejections fail the test) is wired in via the
// custom `page` fixture in tests/_setup.js — every spec that imports
// `test` from that file inherits the listeners automatically.

import { defineConfig, devices } from '@playwright/test';

const BOSE_HOST = process.env.BOSE_HOST || '192.168.178.36';
const BASE_URL  = process.env.BOSE_BASE_URL || `http://${BOSE_HOST}:8181`;

export default defineConfig({
  testDir: './tests',
  // Specs touch a real speaker — never parallelise, and always run them
  // in the order Playwright sees them so full-smoke.spec.js can rely on
  // the others having executed in a known sequence when invoked alone.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    // Custom: fills the Result column in 0.4.2-smoke-report.md from
    // the same in-memory test data the JSON reporter consumes, so the
    // Markdown report is complete the moment the run finishes.
    ['./smoke-report-reporter.js'],
  ],
  outputDir: 'test-results/artefacts',
  use: {
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
});
