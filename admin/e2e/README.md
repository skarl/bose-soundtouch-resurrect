# admin/e2e — Playwright smoke suite

End-to-end coverage for the admin SPA, running against a deployed admin
on a Bose SoundTouch speaker. The suite was scaffolded as the
verification gate for the 0.4.2 TuneIn rewrite and has grown alongside
the admin since; new specs land here whenever a slice ships behaviour
that the unit suite can't pin without a real browser + speaker.

## Prerequisites

- **Node.js** ≥ 18 (project standardises on 20 LTS).
- **Playwright browsers** (Chromium is enough for this suite).
- A speaker on your network running the resolver and the admin SPA
  deployed via `admin/deploy.sh`. The default `BOSE_HOST` in
  `playwright.config.js` points at the project's test speaker; override
  via the `BOSE_HOST` env var to target your own.

## First-time setup

```bash
cd admin/e2e
npm install
npx playwright install chromium
```

`npm install` resolves `@playwright/test` into a local `node_modules/`
inside `admin/e2e/` — it does **not** affect any other part of the
repo, and the directory is git-ignored.

## Running

```bash
# Run the full suite against the default host (the project test speaker).
npm test

# Target a different speaker.
BOSE_HOST=<speaker-ip> npm test

# Watch it run with a real browser window.
npm run test:headed

# Open the latest HTML report after a run.
npm run test:report
```

**Important — do not pass `--reporter=…` to the canonical run.** Playwright's
CLI `--reporter` flag *replaces* the config's reporter list, so passing
`--reporter=list` (handy during dev iteration on a single spec) skips
both the HTML reporter and the JSON reporter the smoke report depends
on. Use `npm test` for the full run and reserve `--reporter=line` for
single-spec dev runs (e.g. `npx playwright test tests/play.spec.js
--reporter=line`).

## What each spec covers

| Spec | Slice | Coverage |
|------|-------|----------|
| `languages.spec.js`    | #73 | By-Language drill renders ≥1 station row for broken-form lcodes (l117 Welsh, l109 Bashkir). |
| `breadcrumb.spec.js`   | #74 | 3-level drill records `from=<list>` in the URL hash; page header reads API `head.title`; refresh + Back preserve / pop the stack. |
| `sections.spec.js`     | #75 | Folk Music drill (g25) renders 4 distinct section containers with labels + counts. |
| `pagination.spec.js`   | #76 | Top 40 & Pop (g3) Load-more strictly increases row count without duplicate guide_ids. |
| `filter.spec.js`       | #77 | Filter mounts a progress strap, grows the row list as the auto-crawl progresses, unmounts on clear. |
| `play.spec.js`         | #78 | Inline Play spins, updates `/now_playing` within ~5s, surfaces a toast. MITM placeholder-URL response surfaces the error toast. |
| `row-polish.spec.js`   | #79 | Reliability badges with colour classes, 2-line subtitles, clickable genre chips. |
| `search.spec.js`       | #80 | "Folk Alley" yields a p-prefix row with inline Play; toggling "Include podcasts" off removes p-prefix rows. |
| `show-drill.spec.js`   | #81 | Show drill renders topic rows; tapping a topic's Play icon fires the /play CGI. |
| `local-polish.spec.js` | #82 / #85 | "Browse all of <country>" card, retired-annotation guard on a live tiny-country drill (#85), every `<img loading="lazy">`, `related` chips, station-detail CTA reads "Play". |
| `station-redirect.spec.js` | #86 | `#/station/p<N>` and `#/station/t<N>` redirect to the browse view (no dead-end on the not-found placeholder); unknown prefixes still 404; `s`-sids unaffected. |
| `transport-controls.spec.js` | #88 | Buffering indicator on the now-playing play button (MITM `BUFFERING_STATE`); Prev/Next enable on a topic-list drill and fire `/play` with the neighbour topic id. |
| `mobile-overflow.spec.js` | #119 | Phone-viewport horizontal-overflow guard for every primary view + the station-detail / preset-modal carriers. |
| `full-smoke.spec.js`   | —   | Orchestrator entry — writes `test-results/0.4.2-smoke-report.md` summarising the run. |

## Patterns

- **Shared fixture (`tests/_setup.js`)** — every spec imports `test`
  and `expect` from here. The shared `page` fixture wires the project's
  standard listener block: console errors, uncaught page errors, and
  `/cgi-bin/` request failures fail the test. Two helpers — `gotoBrowse`
  and `gotoSearch` — drive the SPA's hash-router into a known state.
- **MITM via `page.route`** — `play.spec.js` uses Playwright's
  `page.route` to intercept `/cgi-bin/play` and return the fixture in
  `fixtures/play-placeholder-url.json`, exercising the error toast
  without needing TuneIn to actually serve a placeholder.
- **Console-error tolerance** — by default any `console.error` fails the
  test. Specs that intentionally trigger an error log (e.g. the toast
  helper) opt in via `test.use({ allowConsoleErrors: true })` scoped to
  a `test.describe` block.

## Refreshing the smoke report

`full-smoke.spec.js` writes a stub Markdown report to
`test-results/0.4.2-smoke-report.md` during the run. The custom
reporter at `smoke-report-reporter.js` watches every test's status
and fills the Result column in the Markdown report from the
in-process Playwright test data — no extra shell incantation needed.
Running `npm test` produces a fully-populated report.

The reporter is wired into `playwright.config.js`; `--reporter=line`
overrides the config and skips it (handy for single-spec dev iteration
where the report is not needed).

## Where this fits

The unit-test suite (`admin/test/*.js`) covers reshape, validators,
WebSocket dispatch, render helpers, and favourites logic in pure JS —
no browser, no speaker. This suite covers the rendered DOM + the live
speaker. They are complementary; both should pass before a release tag
is cut.
