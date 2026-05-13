// Tests for app/tunein-url.js — the pure functions that own all
// TuneIn OPML URL operations. See admin/app/tunein-url.js and § 7 of
// docs/tunein-api.md for the rules being asserted.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

// --- sessionStorage shim ---------------------------------------------
//
// The module reads sessionStorage in isValidLcode and writes in
// cacheLcodes. Node has no global sessionStorage, so install a
// minimal in-memory shim before importing the module under test.

const ssStore = new Map();
globalThis.sessionStorage = {
  getItem(key)        { return ssStore.has(key) ? ssStore.get(key) : null; },
  setItem(key, value) { ssStore.set(key, String(value)); },
  removeItem(key)     { ssStore.delete(key); },
  clear()             { ssStore.clear(); },
};

const {
  canonicaliseBrowseUrl,
  extractDrillKey,
  composeDrillUrl,
  isValidLcode,
  lcodeLabel,
  cacheLcodes,
  cacheLcodesFromDescribe,
  LCODE_CACHE_KEY,
} = await import('../app/tunein-url.js');

beforeEach(() => {
  ssStore.clear();
});

// --- language-tree rewrite ------------------------------------------
//
// The 11 languages whose `c=lang` entries point at the broken-form
// id=c424724/5/6 URL. The lcodes below are the values observed on
// the live API at time of writing. The test asserts that every
// broken-form URL is rewritten to the c=music short form (the
// language-tree URLs from c=lang always hit the music container).

const BROKEN_FORM_LANGUAGES = [
  { name: 'Bashkir',   lcode: 216 },
  { name: 'Dari',      lcode: 200 },
  { name: 'Dhivehi',   lcode: 190 },
  { name: 'Fijian',    lcode: 206 },
  { name: 'Kannada',   lcode: 217 },
  { name: 'Kashmiri',  lcode: 218 },
  { name: 'Romansch',  lcode: 145 },
  { name: 'Sami',      lcode: 162 },
  { name: 'Shona',     lcode: 186 },
  { name: 'Uyghur',    lcode: 221 },
  { name: 'Welsh',     lcode: 117 },
];

for (const { name, lcode } of BROKEN_FORM_LANGUAGES) {
  test(`canonicaliseBrowseUrl rewrites the Music language-tree URL for ${name}`, () => {
    const raw = `http://opml.radiotime.com/Browse.ashx?id=c424724&filter=l${lcode}`;
    const out = canonicaliseBrowseUrl(raw);
    // id=c424724 must be gone, replaced by c=music; filter survives.
    assert.match(out, /\bc=music\b/, `expected c=music in ${out}`);
    assert.doesNotMatch(out, /\bid=c424724\b/, `id=c424724 must be stripped in ${out}`);
    assert.match(out, new RegExp(`\\bfilter=l${lcode}\\b`), `lcode preserved`);
    // render=json always reappended.
    assert.match(out, /\brender=json\b/, `render=json appended`);
  });

  test(`canonicaliseBrowseUrl rewrites the Talk language-tree URL for ${name}`, () => {
    const raw = `http://opml.radiotime.com/Browse.ashx?id=c424725&filter=l${lcode}`;
    const out = canonicaliseBrowseUrl(raw);
    assert.match(out, /\bc=talk\b/);
    assert.doesNotMatch(out, /\bid=c424725\b/);
    assert.match(out, new RegExp(`\\bfilter=l${lcode}\\b`));
  });

  test(`canonicaliseBrowseUrl rewrites the Sports language-tree URL for ${name}`, () => {
    const raw = `http://opml.radiotime.com/Browse.ashx?id=c424726&filter=l${lcode}`;
    const out = canonicaliseBrowseUrl(raw);
    assert.match(out, /\bc=sports\b/);
    assert.doesNotMatch(out, /\bid=c424726\b/);
    assert.match(out, new RegExp(`\\bfilter=l${lcode}\\b`));
  });

  test(`extractDrillKey on the rewritten URL exposes c=music + filter=l${lcode} for ${name}`, () => {
    const raw = `http://opml.radiotime.com/Browse.ashx?id=c424724&filter=l${lcode}`;
    const parts = extractDrillKey(canonicaliseBrowseUrl(raw));
    assert.equal(parts.c, 'music');
    assert.equal(parts.filter, `l${lcode}`);
    assert.equal(parts.id, undefined, 'id must not survive the rewrite');
  });
}

// --- magic-param scoping --------------------------------------------
//
// canonicaliseBrowseUrl strips formats=mp3,aac and lang=de-de from
// the URL it returns — these are Tune-side parameters and must not
// leak into Browse / Search drills (§ 7.4). The CGI is the other half
// of this contract; see test below.

test('canonicaliseBrowseUrl strips formats= and lang= from a Browse URL', () => {
  const raw = 'http://opml.radiotime.com/Browse.ashx?id=g22&formats=mp3,aac&lang=de-de';
  const out = canonicaliseBrowseUrl(raw);
  assert.doesNotMatch(out, /\bformats=/);
  assert.doesNotMatch(out, /\blang=/);
  assert.match(out, /\bid=g22\b/);
  assert.match(out, /\brender=json\b/);
});

// Helper: pick out the assignment line `URL="$BASE/<ENDPOINT>.ashx?...".
// The CGI is busybox-shell — each route composes URL in a single line
// inside its case-arm. Returns the substring from URL= to the line end.
function urlAssignmentLineFor(cgi, endpoint) {
  // Anchor on URL= so we don't pick up the comment header (which uses
  // raw `Browse.ashx?id=g22` etc.).
  const re = new RegExp(`URL=[^\\n]*${endpoint}\\.ashx[^\\n]*`);
  const m = cgi.match(re);
  return m ? m[0] : null;
}

test('CGI tunein forwarder: Browse route does NOT append formats= / lang=', async () => {
  // The CGI shell script is the canonical source of truth — read it
  // and assert on the resolved URL strings. This catches regressions
  // where someone re-introduces the magic params on Browse.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cgi = fs.readFileSync(path.resolve('admin/cgi-bin/api/v1/tunein'), 'utf8');
  const line = urlAssignmentLineFor(cgi, 'Browse');
  assert.ok(line, 'found Browse.ashx URL assignment');
  assert.doesNotMatch(line, /\$MAGIC_TUNE\b/, 'Browse must not interpolate $MAGIC_TUNE');
  assert.doesNotMatch(line, /\bformats=/, 'Browse must not carry literal formats=');
  assert.doesNotMatch(line, /\blang=de-de\b/, 'Browse must not carry literal lang=de-de');
  assert.match(line, /\$RENDER\b/, 'Browse must interpolate $RENDER (render=json)');
});

test('CGI tunein forwarder: Search route does NOT append formats= / lang=', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cgi = fs.readFileSync(path.resolve('admin/cgi-bin/api/v1/tunein'), 'utf8');
  const line = urlAssignmentLineFor(cgi, 'Search');
  assert.ok(line, 'found Search.ashx URL assignment');
  assert.doesNotMatch(line, /\$MAGIC_TUNE\b/, 'Search must not interpolate $MAGIC_TUNE');
  assert.doesNotMatch(line, /\bformats=/, 'Search must not carry literal formats=');
  assert.doesNotMatch(line, /\blang=de-de\b/, 'Search must not carry literal lang=de-de');
  assert.match(line, /\$RENDER\b/, 'Search must interpolate $RENDER (render=json)');
});

test('CGI tunein forwarder: Tune route DOES append formats=mp3,aac and lang=de-de', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cgi = fs.readFileSync(path.resolve('admin/cgi-bin/api/v1/tunein'), 'utf8');
  const line = urlAssignmentLineFor(cgi, 'Tune');
  assert.ok(line, 'found Tune.ashx URL assignment');
  assert.match(line, /\$MAGIC_TUNE\b/, 'Tune must interpolate $MAGIC_TUNE');
  assert.match(line, /\$RENDER\b/, 'Tune must interpolate $RENDER');
  // And the MAGIC_TUNE value itself contains both fields.
  const magic = cgi.match(/MAGIC_TUNE='([^']*)'/);
  assert.ok(magic, 'found MAGIC_TUNE assignment');
  assert.match(magic[1], /formats=mp3,aac/);
  assert.match(magic[1], /lang=de-de/);
});

// --- render=json re-append ------------------------------------------

test('canonicaliseBrowseUrl appends render=json when missing', () => {
  const raw = 'http://opml.radiotime.com/Browse.ashx?id=g22';
  const out = canonicaliseBrowseUrl(raw);
  assert.match(out, /\brender=json\b/);
});

test('canonicaliseBrowseUrl replaces an alternate render value with render=json', () => {
  // The OPML service emits render=xml by default; cursor URLs strip
  // render entirely. Either way, the client always wants json.
  const raw = 'http://opml.radiotime.com/Browse.ashx?id=g22&render=xml';
  const out = canonicaliseBrowseUrl(raw);
  assert.match(out, /\brender=json\b/);
  assert.doesNotMatch(out, /\brender=xml\b/);
});

test('canonicaliseBrowseUrl preserves an offset cursor parameter', () => {
  // nextStations cursors carry &offset=N — the client must follow
  // them verbatim. § 6.1 requires render=json to be re-appended.
  const raw = 'http://opml.radiotime.com/Browse.ashx?id=g22&offset=50';
  const out = canonicaliseBrowseUrl(raw);
  assert.match(out, /\boffset=50\b/);
  assert.match(out, /\brender=json\b/);
});

// --- colon-form refusal ---------------------------------------------

test('canonicaliseBrowseUrl refuses filter=l:NNN colon form', () => {
  // The service silently ignores the colon form; emitting it produces
  // a dead-end UI affordance. Refusing it at the seam makes the bug
  // loud at construction time rather than at render time.
  assert.throws(
    () => canonicaliseBrowseUrl('http://opml.radiotime.com/Browse.ashx?c=music&filter=l:109'),
    /colon-form lcode filter/,
  );
});

test('composeDrillUrl refuses filter=l:NNN colon form', () => {
  assert.throws(
    () => composeDrillUrl({ c: 'music', filter: 'l:109' }),
    /colon-form lcode filter/,
  );
});

test('composeDrillUrl accepts the no-colon form filter=lNNN', () => {
  const out = composeDrillUrl({ c: 'music', filter: 'l109' });
  assert.match(out, /\bc=music\b/);
  assert.match(out, /\bfilter=l109\b/);
  assert.match(out, /\brender=json\b/);
});

// --- extractDrillKey / composeDrillUrl round-trip --------------------

test('extractDrillKey parses id, c, filter, pivot, offset from a URL', () => {
  const raw = 'http://opml.radiotime.com/Browse.ashx?id=rNN&filter=s:popular&pivot=name&offset=50';
  const parts = extractDrillKey(raw);
  assert.equal(parts.id, 'rNN');
  assert.equal(parts.filter, 's:popular');
  assert.equal(parts.pivot, 'name');
  assert.equal(parts.offset, '50');
  assert.equal(parts.c, undefined);
});

test('extractDrillKey omits keys that are absent (does not set to undefined)', () => {
  const parts = extractDrillKey('http://opml.radiotime.com/Browse.ashx?c=music');
  assert.equal(parts.c, 'music');
  assert.ok(!('id' in parts));
  assert.ok(!('filter' in parts));
});

test('composeDrillUrl emits the expected key order id|c, filter, pivot, offset', () => {
  const url = composeDrillUrl({ c: 'music', filter: 'l109' });
  // c before filter before render=json.
  assert.match(url, /^Browse\.ashx\?c=music&filter=l109&render=json$/);
});

test('compose then extract round-trips the drill keys', () => {
  const original = { c: 'music', filter: 'l109' };
  const url = composeDrillUrl(original);
  const parsed = extractDrillKey(url);
  assert.equal(parsed.c, original.c);
  assert.equal(parsed.filter, original.filter);
});

// --- multi-filter (#106) --------------------------------------------
//
// TuneIn's Browse / Search wire shape accepts comma-separated values
// inside a single `filter=` query param (e.g. `filter=l109,g22`). The
// client surfaces this as `filters: string[]` on the parts object;
// `filter` is kept as a back-compat alias holding the joined value.

test('extractDrillKey surfaces a single-filter URL as filters: [oneEntry] (back-compat for in-the-wild URLs)', () => {
  const parts = extractDrillKey('http://opml.radiotime.com/Browse.ashx?id=r101821&filter=g26');
  assert.equal(parts.id, 'r101821');
  assert.deepEqual(parts.filters, ['g26']);
  // The legacy `filter` alias stays populated for callers not yet on
  // the array shape.
  assert.equal(parts.filter, 'g26');
});

test('extractDrillKey splits a comma-separated filter= into filters: string[]', () => {
  const parts = extractDrillKey('http://opml.radiotime.com/Browse.ashx?id=r101821&filter=g26,l170');
  assert.equal(parts.id, 'r101821');
  assert.deepEqual(parts.filters, ['g26', 'l170']);
  assert.equal(parts.filter, 'g26,l170');
});

test('extractDrillKey handles three filters stacked on one drill', () => {
  const parts = extractDrillKey('http://opml.radiotime.com/Browse.ashx?id=r101821&filter=g26,l170,s:popular');
  assert.deepEqual(parts.filters, ['g26', 'l170', 's:popular']);
  assert.equal(parts.filter, 'g26,l170,s:popular');
});

test('extractDrillKey omits filters when the URL has no filter= param', () => {
  const parts = extractDrillKey('http://opml.radiotime.com/Browse.ashx?id=r101821');
  assert.equal(parts.id, 'r101821');
  assert.ok(!('filters' in parts), 'no filters key when absent');
  assert.ok(!('filter' in parts),  'no filter alias when absent');
});

test('composeDrillUrl emits a comma-joined filter= from parts.filters: string[]', () => {
  const url = composeDrillUrl({ id: 'r101821', filters: ['g26', 'l170'] });
  // Service-natural order: id, filter, render=json. URLSearchParams
  // emits the comma as %2C (the OPML service decodes either way; the
  // browser hash router decodes %2C back to ',').
  assert.match(url, /\bid=r101821\b/);
  assert.match(url, /\bfilter=g26%2Cl170\b/);
  assert.match(url, /\brender=json\b/);
});

test('composeDrillUrl prefers parts.filters over the deprecated parts.filter when both are set', () => {
  const url = composeDrillUrl({ id: 'r101821', filters: ['g26', 'l170'], filter: 'stale' });
  assert.match(url, /\bfilter=g26%2Cl170\b/);
  assert.doesNotMatch(url, /\bfilter=stale\b/);
});

test('composeDrillUrl emits no filter= when parts.filters is empty', () => {
  const url = composeDrillUrl({ id: 'r101821', filters: [] });
  assert.match(url, /\bid=r101821\b/);
  assert.doesNotMatch(url, /\bfilter=/);
});

test('extractDrillKey → composeDrillUrl round-trips zero / one / two / three filters', () => {
  for (const filters of [[], ['g26'], ['g26', 'l170'], ['g26', 'l170', 's:popular']]) {
    const original = { id: 'r101821' };
    if (filters.length > 0) original.filters = filters;
    const url = composeDrillUrl(original);
    const parsed = extractDrillKey(url);
    assert.equal(parsed.id, 'r101821', `id round-trips for ${filters.length} filters`);
    if (filters.length === 0) {
      assert.ok(!('filters' in parsed), `no filters key for 0 filters`);
    } else {
      assert.deepEqual(parsed.filters, filters, `filters round-trip for ${filters.length} filters`);
    }
  }
});

test('composeDrillUrl refuses colon-form lcode hidden inside a multi-filter list', () => {
  assert.throws(
    () => composeDrillUrl({ id: 'r101821', filters: ['g26', 'l:170'] }),
    /colon-form lcode filter/,
  );
});

// --- isValidLcode against a fixture catalogue ------------------------

test('isValidLcode returns true for codes present in the cached catalogue', () => {
  cacheLcodes(['l1', 'l109', 'l216']);
  assert.equal(isValidLcode('l1'), true);
  assert.equal(isValidLcode('l109'), true);
  assert.equal(isValidLcode('l216'), true);
});

test('isValidLcode returns false for codes absent from the cached catalogue', () => {
  cacheLcodes(['l1', 'l109']);
  assert.equal(isValidLcode('l999'), false);
  assert.equal(isValidLcode('l216'), false);
});

test('isValidLcode returns false for malformed codes (no l prefix, non-numeric, empty)', () => {
  cacheLcodes(['l1']);
  assert.equal(isValidLcode(''), false);
  assert.equal(isValidLcode('1'), false);
  assert.equal(isValidLcode('labc'), false);
  assert.equal(isValidLcode('l:1'), false);
  assert.equal(isValidLcode(null), false);
  assert.equal(isValidLcode(undefined), false);
});

test('isValidLcode returns false when no catalogue has been cached yet', () => {
  // cacheLcodes never called → readLcodeCache returns null → false.
  assert.equal(isValidLcode('l109'), false);
});

// --- lcodeLabel ----------------------------------------------------

test('lcodeLabel resolves a known code to its cached human label', () => {
  cacheLcodes([
    { id: 'l109', name: 'German' },
    { id: 'l216', name: 'English' },
  ]);
  assert.equal(lcodeLabel('l109'), 'German');
  assert.equal(lcodeLabel('l216'), 'English');
});

test('lcodeLabel returns undefined for unknown codes', () => {
  cacheLcodes([{ id: 'l109', name: 'German' }]);
  assert.equal(lcodeLabel('l999'), undefined);
});

test('lcodeLabel returns undefined when the cache holds the code but no label', () => {
  // Legacy / bare-string input path: code present, label empty.
  cacheLcodes(['l109']);
  assert.equal(isValidLcode('l109'), true, 'code is still in the allow-list');
  assert.equal(lcodeLabel('l109'), undefined, 'no label resolved');
});

test('lcodeLabel returns undefined when the cache is empty / never primed', () => {
  assert.equal(lcodeLabel('l109'), undefined);
});

test('lcodeLabel returns undefined for malformed input (no l prefix, etc.)', () => {
  cacheLcodes([{ id: 'l109', name: 'German' }]);
  assert.equal(lcodeLabel(''), undefined);
  assert.equal(lcodeLabel('109'), undefined);
  assert.equal(lcodeLabel(null), undefined);
});

test('cacheLcodesFromDescribe handles the Describe.ashx?c=languages body shape', () => {
  // The OPML response is {head, body: [outline, outline, ...]} where
  // each outline carries guide_id="lNNN".
  const json = {
    head: { status: '200' },
    body: [
      { element: 'outline', type: 'link', text: 'English', guide_id: 'l1' },
      { element: 'outline', type: 'link', text: 'German',  guide_id: 'l109' },
      { element: 'outline', type: 'link', text: 'NotAnLcode', guide_id: 'g22' },
    ],
  };
  cacheLcodesFromDescribe(json);
  assert.equal(isValidLcode('l1'), true);
  assert.equal(isValidLcode('l109'), true);
  // Non-l prefix entries are filtered out (defensive).
  assert.equal(isValidLcode('g22'), false);
});

test('cacheLcodesFromDescribe writes a {code: label} map to sessionStorage under LCODE_CACHE_KEY', () => {
  cacheLcodesFromDescribe({
    body: [
      { guide_id: 'l1',   text: 'English' },
      { guide_id: 'l109', text: 'German' },
    ],
  });
  const raw = sessionStorage.getItem(LCODE_CACHE_KEY);
  assert.ok(raw, 'sessionStorage entry exists under LCODE_CACHE_KEY');
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, { l1: 'English', l109: 'German' });
});

// --- empty / malformed input ----------------------------------------

test('canonicaliseBrowseUrl returns input unchanged for empty / non-string', () => {
  assert.equal(canonicaliseBrowseUrl(''), '');
  assert.equal(canonicaliseBrowseUrl(null), null);
  assert.equal(canonicaliseBrowseUrl(undefined), undefined);
});

test('canonicaliseBrowseUrl leaves non-language-tree URLs alone (just strips magic + reappends render)', () => {
  // A normal genre drill: no id=c424724/5/6, no language filter.
  const raw = 'http://opml.radiotime.com/Browse.ashx?id=g22';
  const out = canonicaliseBrowseUrl(raw);
  assert.match(out, /\bid=g22\b/);
  assert.match(out, /\brender=json\b/);
  // No spurious c=music sneaks in.
  assert.doesNotMatch(out, /\bc=music\b/);
});

test('canonicaliseBrowseUrl leaves id=c424724 alone when no language filter accompanies it', () => {
  // Bare id=c424724 (without filter=lNNN) is undocumented but not the
  // shape we're rewriting; preserve it verbatim.
  const raw = 'http://opml.radiotime.com/Browse.ashx?id=c424724';
  const out = canonicaliseBrowseUrl(raw);
  assert.match(out, /\bid=c424724\b/);
  assert.doesNotMatch(out, /\bc=music\b/);
});
