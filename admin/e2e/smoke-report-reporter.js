// smoke-report-reporter — custom Playwright reporter.
//
// The stub Markdown report at test-results/0.4.2-smoke-report.md is
// written by tests/full-smoke.spec.js during the run. After every spec
// finishes, this reporter reads the in-memory test results and fills
// the Result column. Solves the chicken-and-egg of trying to read
// results.json (which the JSON reporter only finalises AFTER
// globalTeardown).
//
// Pattern follows Playwright's Reporter interface — onEnd is the only
// hook we need; we tally per-file status across every test we saw.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_MD = join(__dirname, 'test-results', '0.4.2-smoke-report.md');

export default class SmokeReportReporter {
  constructor() {
    this._fileStatuses = {};
  }

  // The JSON reporter's status vocabulary is:
  //   passed | failed | timedOut | skipped | interrupted
  // FAIL is sticky: once any test in a file fails, the file is FAIL.
  onTestEnd(test, result) {
    const file = (test.location && test.location.file)
      ? test.location.file.split(/[\\/]/).pop()
      : '';
    if (!file) return;
    const passed = result.status === 'passed' || result.status === 'skipped';
    if (this._fileStatuses[file] === 'FAIL') return;
    this._fileStatuses[file] = passed ? 'PASS' : 'FAIL';
  }

  async onEnd() {
    if (!existsSync(REPORT_MD)) return;
    let md = readFileSync(REPORT_MD, 'utf8');
    for (const [file, verdict] of Object.entries(this._fileStatuses)) {
      // Match the table row's `_filled by post-run reporter step_`
      // placeholder for this spec file.
      const re = new RegExp(
        '(\\`' + escapeReg(file) + '\\`[^|]*\\|[^|]*\\|) _filled by post-run reporter step_',
        'g',
      );
      md = md.replace(re, `$1 ${verdict}`);
    }
    writeFileSync(REPORT_MD, md);
  }
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
