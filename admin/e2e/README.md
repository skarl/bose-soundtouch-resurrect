# admin/e2e — Playwright smoke suite

End-to-end coverage for the admin SPA, running against a deployed admin
on a Bose SoundTouch speaker. This is the verification gate before
human-in-the-loop review for the 0.4.2 TuneIn rewrite.

## Prerequisites

- **Node.js** ≥ 18 (project standardises on 20 LTS).
- **Playwright browsers** (Chromium is enough for this suite).
- A speaker on your network running the resolver from `resolver/install.sh`
  with the admin SPA deployed via `admin/deploy.sh`. The project's test
  speaker is **Bo** at `192.168.178.36:8181`.

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
# Run the full suite against the default host (Bo at 192.168.178.36).
npm test

# Target a different speaker.
BOSE_HOST=192.168.178.42 npm test

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
| `local-polish.spec.js` | #82 | "Browse all of <country>" card, tiny-country annotation, every `<img loading="lazy">`, `related` chips, station-detail CTA reads "Play". |
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

## Deferred — orchestrator run

**The orchestrator run + closing comment on issue #83 is deferred.**

During the scaffolding pass (Wave 7 of the 0.4.2 milestone) the user's
internet was down, and Bo's TuneIn-dependent routes would have produced
spurious failures against the upstream. The suite is structurally
complete: every spec ships with assertions matching its slice's
acceptance criteria, the standard listener block is wired in, and the
MITM error path is hooked up.

Once connectivity returns:

1. `cd admin/e2e && npm install && npx playwright install chromium`
2. `BOSE_HOST=192.168.178.36 npm test`
3. Read `test-results/0.4.2-smoke-report.md` + the HTML report at
   `playwright-report/`.
4. Post the report as a closing comment on
   [issue #83](https://github.com/skarl/bose-soundtouch-resurrect/issues/83)
   if every spec passes, or as a follow-up comment naming the
   originating slice issue(s) if any fail.

## Where this fits

The unit-test suite (`admin/test/*.js`) covers reshape, validators, and
WS message handling in pure JS — no browser, no speaker. This suite
covers the rendered DOM + the live speaker. They are complementary;
both should pass before a 0.4.x tag is cut.
