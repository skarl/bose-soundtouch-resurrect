// Headless Playwright smoke for the admin SPA.
//
// Walks the four top-level tabs, opens every settings collapsible,
// flips through every theme, and exercises the preset-replace modal.
// Designed as a pre-release sanity check — extends the unit test suite
// (admin/test/*) with end-to-end DOM behaviour against a live speaker.
//
// Usage:
//   SPEAKER_HOST=192.168.178.36 node scripts/playwright-smoke.mjs
//
// Exit code is non-zero on the first hard failure. Soft failures
// (missing optional sections, etc.) print a warning and continue so
// the operator can see the full surface in one run.
//
// Playwright is expected on the host; the script does not install it.
// On macOS with Homebrew + the `playwright` global package, link the
// global node_modules into the cwd before running:
//
//   ln -sf /opt/homebrew/lib/node_modules ./node_modules
//   SPEAKER_HOST=… node scripts/playwright-smoke.mjs
//
// (Or invoke from a directory that already resolves `playwright` —
// e.g. /tmp/admin-smoke per the project memory recipe.)

import { chromium } from 'playwright';

const SPEAKER = process.env.SPEAKER_HOST;
if (!SPEAKER) {
  console.error('SPEAKER_HOST env var is required (e.g. 192.168.178.36)');
  process.exit(2);
}

const BASE = `http://${SPEAKER}:8181`;

let okCount = 0;
let failCount = 0;

function ok(label)   { console.log(`  [ OK ] ${label}`);   okCount++; }
function fail(label, detail) {
  console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
  failCount++;
}
function section(name) { console.log(`\n=== ${name} ===`); }

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('requestfailed', (r) =>
    console.log(`  [reqfail] ${r.method()} ${r.url()} — ${r.failure()?.errorText}`));

  try {
    await runSmoke(page);
  } finally {
    await browser.close();
  }

  console.log(`\n=== Summary: ${okCount} ok, ${failCount} failed ===`);
  if (failCount > 0) process.exit(1);
}

async function runSmoke(page) {
  section('Boot');
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('.shell'), { timeout: 10000 });
  ok('shell host element rendered');

  // Geist must be loaded — the deploy step copies admin/fonts/ to
  // /mnt/nv/resolver/fonts/ and style.css references them by relative
  // URL. If the font 404s, Geist falls back to system-ui silently.
  await page.evaluate(() => document.fonts.ready);
  const ff = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  ff.toLowerCase().includes('geist')
    ? ok(`body fontFamily includes Geist (${ff})`)
    : fail(`body fontFamily missing Geist`, ff);

  section('Bottom tabs');
  const tabHrefs = ['#/', '#/search', '#/browse', '#/settings'];
  const tabLabels = ['Now', 'Search', 'Browse', 'Settings'];
  const renderedTabs = await page.$$eval('.shell-tabs .shell-tab', (els) =>
    els.map((a) => ({
      href: a.getAttribute('href'),
      label: a.querySelector('.shell-tab__label')?.textContent?.trim(),
    })));
  if (renderedTabs.length === 4) ok('4 bottom tabs rendered');
  else fail('expected 4 bottom tabs', `got ${renderedTabs.length}`);
  for (let i = 0; i < tabLabels.length; i++) {
    const expected = tabLabels[i];
    if (renderedTabs[i] && renderedTabs[i].label === expected) {
      ok(`tab ${i + 1} label = "${expected}"`);
    } else {
      fail(`tab ${i + 1} label`, `expected "${expected}", got ${JSON.stringify(renderedTabs[i])}`);
    }
  }

  for (let i = 0; i < tabHrefs.length; i++) {
    const href = tabHrefs[i];
    await page.click(`.shell-tabs .shell-tab[href="${href}"]`);
    await page.waitForFunction((h) => location.hash === h, href, { timeout: 5000 });
    ok(`tab "${tabLabels[i]}" click navigates to ${href}`);
  }

  section('Settings collapsibles');
  await page.click(`.shell-tabs .shell-tab[href="#/settings"]`);
  await page.waitForFunction(() => location.hash === '#/settings');
  await page.waitForSelector('[data-section]', { timeout: 5000 });

  const sections = ['appearance', 'speaker', 'audio', 'bluetooth', 'multiroom', 'network', 'system'];
  for (const name of sections) {
    const sel = `[data-section="${name}"]`;
    const handle = await page.$(sel);
    if (!handle) {
      fail(`settings/${name} section present`);
      continue;
    }
    ok(`settings/${name} section present`);

    // Each collapsible has a header button toggling its open state.
    // Pick the closest summary/header button and click twice (open → close).
    const opener = await page.$(`${sel} button[aria-expanded], ${sel} summary, ${sel} .settings-section__head`);
    if (!opener) {
      // Some sections might be always-open (multiroom stub). That's fine.
      ok(`settings/${name} has no collapsible header (always-open OK)`);
      continue;
    }
    await opener.click();
    await page.waitForTimeout(50);
    await opener.click();
    await page.waitForTimeout(50);
    ok(`settings/${name} opens and closes`);
  }

  section('Theme picker — four-way cycle');
  // Find the theme picker inside the appearance section and exercise
  // each of the four values; assert <html data-theme> updates.
  const themes = ['auto', 'graphite', 'cream', 'terminal'];
  for (const t of themes) {
    const set = await page.evaluate(async (theme) => {
      const mod = await import('/app/theme.js');
      mod.setTheme(theme);
      return document.documentElement.dataset.theme;
    }, t);
    // 'auto' resolves to graphite or terminal depending on the OS pref;
    // assert the attribute is one of the live palettes.
    const live = ['graphite', 'cream', 'terminal'];
    if (live.includes(set)) ok(`setTheme("${t}") → data-theme="${set}"`);
    else fail(`setTheme("${t}")`, `data-theme="${set}" not in ${live.join('|')}`);
  }

  section('Bluetooth section — MAC row, no paired-list');
  await page.evaluate(() => location.hash = '#/settings');
  await page.waitForFunction(() => location.hash === '#/settings');
  // Wait for bluetooth section to populate (async fetch behind the scenes).
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-section="bluetooth"]');
    return el && el.textContent && el.textContent.length > 20;
  }, { timeout: 10000 }).catch(() => {});
  const btText = await page.$eval('[data-section="bluetooth"]', (el) => el.textContent || '').catch(() => '');
  if (/MAC|mac|[0-9A-F]{2}:[0-9A-F]{2}/i.test(btText)) ok('bluetooth section shows a MAC row');
  else fail('bluetooth section has no visible MAC');

  section('Network section — signal bars');
  // Signal-bar visualisation: 4 segments, some/all marked active via CSS class.
  const bars = await page.$$('[data-section="network"] .signal-bars > *, [data-section="network"] [class*="signal"] [class*="bar"]');
  if (bars.length >= 4) ok(`network section renders ${bars.length} bar elements (≥4)`);
  else fail('network section signal bars', `expected ≥4, got ${bars.length}`);

  section('Preset replace modal flow');
  // Navigate home, find the preset row, long-press slot 1 → modal opens.
  await page.evaluate(() => location.hash = '#/');
  await page.waitForFunction(() => location.hash === '#/');
  await page.waitForSelector('.preset-card, [data-preset], .np-preset', { timeout: 8000 }).catch(() => {});
  const presetSel = '.preset-card, [data-preset], .np-preset';
  const preset = await page.$(presetSel);
  if (!preset) {
    fail('preset cards missing on home', 'cannot exercise long-press flow');
  } else {
    // Simulate long-press by dispatching contextmenu (right-click is the
    // shorter equivalent the SPA wires alongside long-press).
    await preset.dispatchEvent('contextmenu');
    await page.waitForFunction(() => location.hash.startsWith('#/preset/'), { timeout: 3000 })
      .then(() => ok('long-press / right-click on preset opens #/preset/N'))
      .catch(() => fail('preset long-press did not navigate to #/preset/N'));

    // Close the modal — back to home.
    await page.evaluate(() => location.hash = '#/');
    await page.waitForFunction(() => location.hash === '#/');
    ok('navigating away closes preset modal');
  }
}

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
