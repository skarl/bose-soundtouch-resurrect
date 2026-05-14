// Tests for the pure half of the Crumb stack module —
// admin/app/views/browse/crumb-parts.js. Covers the value type
// (parseCrumbs / stringifyCrumbs, crumbTokenFor / partsFromCrumb),
// the URL composer (backHrefFor), and the cache-driven label
// readers (crumbLabelFor + the lcode catalogue join).
//
// crumb-parts.js is pure: no DOM imports, no api.js, no fetch. This
// test file therefore avoids the @xmldom/xmldom-backed dom-shim and
// brings in only the sessionStorage stub that tunein-cache.js needs.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

// sessionStorage stub — tunein-cache.js reads sessionStorage at import
// time to back its label cache. Mirrors the in-memory Map shim the
// dom-shim installs (kept in scope so beforeEach can clear it
// between tests).
const ssStore = new Map();
globalThis.sessionStorage = {
  getItem(k)         { return ssStore.has(k) ? ssStore.get(k) : null; },
  setItem(k, v)      { ssStore.set(k, String(v)); },
  removeItem(k)      { ssStore.delete(k); },
  clear()            { ssStore.clear(); },
};

const {
  parseCrumbs,
  stringifyCrumbs,
  crumbTokenFor,
  partsFromCrumb,
  backHrefFor,
  crumbLabelFor,
} = await import('../app/views/browse/crumb-parts.js');

beforeEach(() => {
  ssStore.clear();
});

// --- parseCrumbs / stringifyCrumbs ----------------------------------

test('parseCrumbs splits a comma-separated string into trimmed tokens', () => {
  assert.deepEqual(parseCrumbs('c100000948,g79,music'), ['c100000948', 'g79', 'music']);
});

test('parseCrumbs returns [] for empty / non-string input', () => {
  assert.deepEqual(parseCrumbs(''), []);
  assert.deepEqual(parseCrumbs(null), []);
  assert.deepEqual(parseCrumbs(undefined), []);
});

test('parseCrumbs drops empty segments', () => {
  assert.deepEqual(parseCrumbs('a,,b,'), ['a', 'b']);
});

test('parseCrumbs caps the stack at 8 entries, keeping the tail', () => {
  const raw = 'a,b,c,d,e,f,g,h,i,j';
  const parsed = parseCrumbs(raw);
  assert.equal(parsed.length, 8, 'cap to MAX_CRUMBS');
  // The last crumb is the most recent — preserved.
  assert.equal(parsed[parsed.length - 1], 'j');
  // The first two are dropped (the oldest).
  assert.equal(parsed[0], 'c');
});

test('stringifyCrumbs joins with comma and returns empty for empty', () => {
  assert.equal(stringifyCrumbs(['a', 'b', 'c']), 'a,b,c');
  assert.equal(stringifyCrumbs([]), '');
  assert.equal(stringifyCrumbs(null), '');
  assert.equal(stringifyCrumbs(undefined), '');
});

test('stringifyCrumbs then parseCrumbs round-trip preserves token order', () => {
  const original = ['c100000948', 'g79', 'music'];
  assert.deepEqual(parseCrumbs(stringifyCrumbs(original)), original);
});

// --- crumbTokenFor / partsFromCrumb ---------------------------------

test('crumbTokenFor prefers id over c', () => {
  assert.equal(crumbTokenFor({ id: 'g79' }), 'g79');
  assert.equal(crumbTokenFor({ c: 'music' }), 'music');
  assert.equal(crumbTokenFor({ id: 'g79', c: 'music' }), 'g79');
});

test('crumbTokenFor returns null when neither anchor is set', () => {
  assert.equal(crumbTokenFor({}), null);
  assert.equal(crumbTokenFor({ filter: 'l109' }), null);
  assert.equal(crumbTokenFor(null), null);
});

test('partsFromCrumb maps lowercase-letter-then-digit tokens to id', () => {
  assert.deepEqual(partsFromCrumb('g79'),       { id: 'g79' });
  assert.deepEqual(partsFromCrumb('c100000948'), { id: 'c100000948' });
  assert.deepEqual(partsFromCrumb('p38913'),     { id: 'p38913' });
  assert.deepEqual(partsFromCrumb('s12345'),     { id: 's12345' });
});

test('partsFromCrumb maps letters-only tokens to c=', () => {
  assert.deepEqual(partsFromCrumb('music'),  { c: 'music' });
  assert.deepEqual(partsFromCrumb('talk'),   { c: 'talk' });
  assert.deepEqual(partsFromCrumb('sports'), { c: 'sports' });
  assert.deepEqual(partsFromCrumb('lang'),   { c: 'lang' });
});

test('partsFromCrumb returns null for empty / non-string', () => {
  assert.equal(partsFromCrumb(''), null);
  assert.equal(partsFromCrumb(null), null);
  assert.equal(partsFromCrumb(123), null);
});

// --- filter-aware crumb encoding (#89) ------------------------------

test('crumbTokenFor encodes a filter as <anchor>:<filter> so language-tree drills produce distinct tokens', () => {
  assert.equal(crumbTokenFor({ c: 'lang',  filter: 'l109' }), 'lang:l109');
  assert.equal(crumbTokenFor({ c: 'music', filter: 'l109' }), 'music:l109');
  assert.equal(crumbTokenFor({ id: 'c100000948', filter: 'l109' }), 'c100000948:l109');
});

test('crumbTokenFor omits the filter suffix when no filter is set', () => {
  assert.equal(crumbTokenFor({ c: 'lang' }), 'lang');
  assert.equal(crumbTokenFor({ id: 'g79' }), 'g79');
});

test('partsFromCrumb round-trips the <anchor>:<filter> form back to drill parts', () => {
  // #106: parts carry `filters: string[]` plus a back-compat `filter`
  // alias (the comma-joined wire value). Single-filter tokens land as
  // single-element arrays.
  assert.deepEqual(partsFromCrumb('lang:l109'),       { c: 'lang',  filters: ['l109'],       filter: 'l109' });
  assert.deepEqual(partsFromCrumb('music:l109'),      { c: 'music', filters: ['l109'],       filter: 'l109' });
  assert.deepEqual(partsFromCrumb('c100000948:l109'), { id: 'c100000948', filters: ['l109'], filter: 'l109' });
});

test('crumbTokenFor → partsFromCrumb round-trip for the language-tree path emits distinct tokens', () => {
  // The bug from issue #89: drilling root → Language → German → Music
  // in German used to collapse every step's token to "lang", giving a
  // breadcrumb of "By Language › By Language › By Language". After the
  // filter-aware fix each step produces its own token.
  const lang   = crumbTokenFor({ c: 'lang' });
  const german = crumbTokenFor({ c: 'lang', filter: 'l109' });
  const music  = crumbTokenFor({ c: 'music', filter: 'l109' });
  assert.equal(lang,   'lang');
  assert.equal(german, 'lang:l109');
  assert.equal(music,  'music:l109');
  assert.notEqual(lang, german);
  assert.notEqual(german, music);
  // Round-trip back to drill parts (now carrying the `filters` array
  // plus the back-compat `filter` alias — #106).
  assert.deepEqual(partsFromCrumb(german), { c: 'lang',  filters: ['l109'], filter: 'l109' });
  assert.deepEqual(partsFromCrumb(music),  { c: 'music', filters: ['l109'], filter: 'l109' });
});

// --- backHrefFor: pop the rightmost crumb --------------------------

test('backHrefFor with empty stack lands at the root tabs view', () => {
  assert.equal(backHrefFor([]), '#/browse');
  assert.equal(backHrefFor(null), '#/browse');
  assert.equal(backHrefFor(undefined), '#/browse');
});

test('backHrefFor with one crumb lands at that crumb with no further from=', () => {
  // Stack [music] → pop → land on c=music with empty from=.
  assert.equal(backHrefFor(['music']), '#/browse?c=music');
});

test('backHrefFor with multiple crumbs pops the rightmost and carries the rest as from=', () => {
  // Stack [music, g79] → pop → land on id=g79 with from=music.
  assert.equal(backHrefFor(['music', 'g79']), '#/browse?id=g79&from=music');
  // Stack [c100000948, g79, music] → pop → land on c=music with from=c100000948,g79.
  // URLSearchParams encodes commas as %2C.
  assert.equal(
    backHrefFor(['c100000948', 'g79', 'music']),
    '#/browse?c=music&from=c100000948%2Cg79',
  );
});

// --- crumbLabelFor surfaces the resolved language name (#90) --------

test('crumbLabelFor appends the resolved language name when filter is a known lcode', async () => {
  const { cacheLcodes } = await import('../app/tunein-url.js');
  cacheLcodes([{ id: 'l109', name: 'German' }]);
  assert.equal(
    crumbLabelFor({ c: 'music', filter: 'l109' }),
    'c=music · filter=l109 (German)',
  );
});

test('crumbLabelFor leaves the badge unchanged when the lcode catalogue does not know the filter', () => {
  // No cacheLcodes — lcodeLabel returns undefined → no "(name)" suffix.
  assert.equal(
    crumbLabelFor({ c: 'music', filter: 'l9999' }),
    'c=music · filter=l9999',
  );
});

test('crumbLabelFor leaves non-lcode filters unchanged', async () => {
  const { cacheLcodes } = await import('../app/tunein-url.js');
  cacheLcodes([{ id: 'l109', name: 'German' }]);
  // A non-l filter shape — even if a cached catalogue exists.
  assert.equal(
    crumbLabelFor({ id: 'g79', filter: 'top' }),
    'g79 · filter=top',
  );
});

// --- #106 — multi-filter support: parts.filters: string[] -----------
//
// TuneIn upstream accepts comma-separated values inside a single
// `filter=` query param (e.g. `filter=l109,g22` for "rock stations in
// German-speaking countries"). The SPA's state shape is
// `parts.filters: string[]`; the crumb-token form is
// `<anchor>:<f1>+<f2>+…` (plus sign separates filters inside one
// crumb so the comma-separated `from=` stack is unambiguous).

test('crumbTokenFor encodes parts.filters: string[] as <anchor>:<f1>+<f2>+… — #106', () => {
  assert.equal(crumbTokenFor({ id: 'r101821', filters: ['g26', 'l170'] }),       'r101821:g26+l170');
  assert.equal(crumbTokenFor({ c: 'music',    filters: ['l109', 'g22'] }),       'music:l109+g22');
  assert.equal(crumbTokenFor({ id: 'r101821', filters: ['g26', 'l170', 'm:5'] }), 'r101821:g26+l170+m:5');
});

test('crumbTokenFor with a single filter emits the legacy <anchor>:<filter> shape — #106', () => {
  // Single-filter case must produce the same token as the old single-
  // string callers so bookmarks / pasted URLs from before #106 keep
  // resolving against the same cache keys.
  assert.equal(crumbTokenFor({ id: 'r101821', filters: ['g26'] }), 'r101821:g26');
  assert.equal(crumbTokenFor({ c: 'lang',     filters: ['l109'] }), 'lang:l109');
});

test('crumbTokenFor with an empty filters array drops to the bare anchor — #106', () => {
  assert.equal(crumbTokenFor({ id: 'r101821', filters: [] }), 'r101821');
  assert.equal(crumbTokenFor({ c: 'music',    filters: [] }), 'music');
});

test('partsFromCrumb splits a <anchor>:<f1>+<f2> token back to filters: [f1, f2] — #106', () => {
  assert.deepEqual(
    partsFromCrumb('r101821:g26+l170'),
    { id: 'r101821', filters: ['g26', 'l170'], filter: 'g26,l170' },
  );
  assert.deepEqual(
    partsFromCrumb('music:l109+g22'),
    { c: 'music', filters: ['l109', 'g22'], filter: 'l109,g22' },
  );
});

test('partsFromCrumb round-trips three stacked filters — #106', () => {
  const tok = 'r101821:g26+l170+m:5';
  const parts = partsFromCrumb(tok);
  assert.deepEqual(parts.filters, ['g26', 'l170', 'm:5']);
  assert.equal(crumbTokenFor(parts), tok, 'token round-trips');
});

test('crumbTokenFor → partsFromCrumb round-trips zero / one / two / three filters — #106', () => {
  for (const filters of [[], ['g26'], ['g26', 'l170'], ['g26', 'l170', 's:popular']]) {
    const parts = { id: 'r101821' };
    if (filters.length > 0) parts.filters = filters;
    const token = crumbTokenFor(parts);
    const round = partsFromCrumb(token);
    if (filters.length === 0) {
      assert.equal(token, 'r101821');
      assert.deepEqual(round, { id: 'r101821' });
    } else {
      assert.deepEqual(round.filters, filters, `${filters.length}-filter round-trip`);
      assert.equal(round.id, 'r101821');
    }
  }
});
