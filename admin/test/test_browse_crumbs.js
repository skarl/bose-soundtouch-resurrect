// Tests for the URL crumb stack helpers and the trail renderer in
// admin/app/views/browse.js. The mounted-view paths (renderDrill /
// renderRoot) need a real DOM; tests focus on the pure helpers that
// own URL composition and on the cache-driven trail render.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installSessionStorage } from './fixtures/dom-shim.js';

const ssStore = installSessionStorage();

const {
  parseCrumbs,
  stringifyCrumbs,
  crumbTokenFor,
  partsFromCrumb,
  renderCrumbTrail,
  renderEntry,
  backHrefFor,
  crumbLabelFor,
  _setChildCrumbsForTest,
} = await import('../app/views/browse.js');

const { cache, TTL_LABEL } = await import('../app/tunein-cache.js');

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
  assert.deepEqual(partsFromCrumb('lang:l109'),       { c: 'lang',  filter: 'l109' });
  assert.deepEqual(partsFromCrumb('music:l109'),      { c: 'music', filter: 'l109' });
  assert.deepEqual(partsFromCrumb('c100000948:l109'), { id: 'c100000948', filter: 'l109' });
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
  // Round-trip back to drill parts.
  assert.deepEqual(partsFromCrumb(german), { c: 'lang',  filter: 'l109' });
  assert.deepEqual(partsFromCrumb(music),  { c: 'music', filter: 'l109' });
});

// --- renderCrumbTrail ------------------------------------------------

function findChildrenByClass(root, cls) {
  const out = [];
  for (let i = 0; i < (root.childNodes || []).length; i++) {
    const n = root.childNodes[i];
    if (n && n.nodeType === 1) {
      if ((n.getAttribute('class') || '').split(/\s+/).includes(cls)) out.push(n);
    }
  }
  return out;
}

test('renderCrumbTrail emits one anchor per crumb in stack order', () => {
  const trail = renderCrumbTrail(['c100000948', 'g79', 'music']);
  assert.equal(trail.tagName, 'nav');
  assert.ok((trail.getAttribute('class') || '').includes('browse-trail'));
  const crumbs = findChildrenByClass(trail, 'browse-trail__crumb');
  assert.equal(crumbs.length, 3);
  assert.equal(crumbs[0].dataset.crumbToken, 'c100000948');
  assert.equal(crumbs[1].dataset.crumbToken, 'g79');
  assert.equal(crumbs[2].dataset.crumbToken, 'music');
});

test('renderCrumbTrail uses cached labels when present', () => {
  cache.set('tunein.label.c100000948', 'Folk', TTL_LABEL);
  cache.set('tunein.label.g79',        'Acoustic', TTL_LABEL);
  // music intentionally not cached — should fall back to the raw token.
  const trail = renderCrumbTrail(['c100000948', 'g79', 'music']);
  const crumbs = findChildrenByClass(trail, 'browse-trail__crumb');
  assert.equal(crumbs[0].textContent, 'Folk');
  assert.equal(crumbs[1].textContent, 'Acoustic');
  assert.equal(crumbs[2].textContent, 'music', 'falls back to raw token when cache misses');
});

test('renderCrumbTrail href on a crumb embeds the prefix up to (not including) itself', () => {
  const trail = renderCrumbTrail(['c100000948', 'g79', 'music']);
  const crumbs = findChildrenByClass(trail, 'browse-trail__crumb');
  // First crumb: no ancestors, so no `from=`.
  const h0 = crumbs[0].getAttribute('href');
  assert.match(h0, /^#\/browse\?id=c100000948$/, `first crumb href: ${h0}`);
  // Second crumb: ancestors = [c100000948].
  const h1 = crumbs[1].getAttribute('href');
  assert.match(h1, /^#\/browse\?id=g79&from=c100000948$/, `second crumb href: ${h1}`);
  // Third crumb: ancestors = [c100000948, g79].
  const h2 = crumbs[2].getAttribute('href');
  assert.match(h2, /^#\/browse\?c=music&from=c100000948%2Cg79$/, `third crumb href: ${h2}`);
});

test('renderCrumbTrail returns an empty nav for an empty stack', () => {
  const trail = renderCrumbTrail([]);
  assert.equal(trail.tagName, 'nav');
  const crumbs = findChildrenByClass(trail, 'browse-trail__crumb');
  assert.equal(crumbs.length, 0);
});

test('renderCrumbTrail dedupes consecutive identical tokens (defence against legacy URLs) — #89', () => {
  // A from=lang,lang,lang that pre-dates the filter-aware emitter must
  // not render three "By Language" anchors.
  cache.set('tunein.label.lang', 'By Language', TTL_LABEL);
  const trail = renderCrumbTrail(['lang', 'lang', 'lang']);
  const crumbs = findChildrenByClass(trail, 'browse-trail__crumb');
  assert.equal(crumbs.length, 1, 'collapses to one anchor');
  assert.equal(crumbs[0].textContent, 'By Language');
});

test('renderCrumbTrail resolves <anchor>:l<NNN> tokens to the cached language name — #89', async () => {
  // Prime the lcode catalogue and assert the breadcrumb picks up the
  // language name without any network work.
  const { cacheLcodes } = await import('../app/tunein-url.js');
  cacheLcodes([
    { id: 'l109', name: 'German' },
    { id: 'l216', name: 'English' },
  ]);
  cache.set('tunein.label.lang', 'By Language', TTL_LABEL);
  const trail = renderCrumbTrail(['lang', 'lang:l109']);
  const crumbs = findChildrenByClass(trail, 'browse-trail__crumb');
  assert.equal(crumbs.length, 2);
  assert.equal(crumbs[0].textContent, 'By Language');
  assert.equal(crumbs[1].textContent, 'German');
  // The lang:l109 anchor navigates back to the German language root.
  const h1 = crumbs[1].getAttribute('href');
  assert.match(h1, /c=lang/);
  assert.match(h1, /filter=l109/);
  assert.match(h1, /from=lang/);
});

test('renderCrumbTrail falls back to the raw token when neither cache nor lcode catalogue resolves the label', () => {
  // No catalogue, no tunein.label cache — lang:l9999 has no human name
  // to show, so the anchor renders the raw token.
  const trail = renderCrumbTrail(['lang:l9999']);
  const crumbs = findChildrenByClass(trail, 'browse-trail__crumb');
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0].textContent, 'lang:l9999');
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

// --- renderEntry picks up the module-level child crumb stack --------

test('renderEntry: child row href embeds the parent crumb stack as from=', () => {
  // Simulate the user being on `?c=music&from=lang` — the next click
  // should produce `from=lang,music` (parent stack + current node).
  _setChildCrumbsForTest(['lang', 'music']);
  try {
    const row = renderEntry({
      text: 'Folk',
      URL:  'http://opml.radiotime.com/Browse.ashx?id=g79',
    });
    const href = row.getAttribute('href');
    assert.match(href, /^#\/browse\?/);
    assert.match(href, /id=g79/);
    assert.match(href, /from=lang%2Cmusic/, `expected from=lang,music in ${href}`);
  } finally {
    _setChildCrumbsForTest([]);
  }
});

test('renderEntry: with empty child crumb stack, href has no from= param', () => {
  _setChildCrumbsForTest([]);
  const row = renderEntry({
    text: 'Genre',
    URL:  'http://opml.radiotime.com/Browse.ashx?id=g22',
  });
  const href = row.getAttribute('href');
  assert.equal(href, '#/browse?id=g22', `no from= for root-level child: ${href}`);
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
