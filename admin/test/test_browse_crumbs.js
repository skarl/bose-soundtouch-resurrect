// Tests for the URL crumb stack helpers and the pill-bar / trail
// renderer in admin/app/views/browse.js. The mounted-view paths
// (renderDrill / renderRoot) need a real DOM; tests focus on the
// pure helpers that own URL composition and on the cache-driven
// trail render.
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
  renderPillBar,
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

// --- renderCrumbTrail (legacy ancestor-only shape) ------------------
//
// renderCrumbTrail is the inline trail inside the pill bar. With no
// `currentParts` it produces the ancestor-only shape (Browse + the
// stack anchors); with `currentParts` it adds the bolded non-link
// current segment.

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

function trailCrumbs(root) {
  // Every crumb segment carries the `.browse-bar__crumb` class
  // (Browse, anchors, and the bolded current).
  return findChildrenByClass(root, 'browse-bar__crumb');
}

test('renderCrumbTrail always leads with the literal Browse entry-point anchor', () => {
  const trail = renderCrumbTrail([]);
  assert.equal(trail.tagName, 'nav');
  assert.ok((trail.getAttribute('class') || '').includes('browse-bar__trail'));
  const crumbs = trailCrumbs(trail);
  assert.equal(crumbs.length, 1, 'just the Browse anchor');
  assert.equal(crumbs[0].textContent, 'Browse');
  assert.equal(crumbs[0].getAttribute('href'), '#/browse');
  assert.equal(crumbs[0].dataset.crumbRole, 'root');
});

test('renderCrumbTrail emits one anchor per stack crumb after the Browse entry', () => {
  const trail = renderCrumbTrail(['c100000948', 'g79', 'music']);
  const crumbs = trailCrumbs(trail);
  // Browse + 3 stack crumbs.
  assert.equal(crumbs.length, 4);
  assert.equal(crumbs[0].textContent, 'Browse');
  assert.equal(crumbs[1].dataset.crumbToken, 'c100000948');
  assert.equal(crumbs[2].dataset.crumbToken, 'g79');
  assert.equal(crumbs[3].dataset.crumbToken, 'music');
});

test('renderCrumbTrail uses cached labels when present', () => {
  cache.set('tunein.label.c100000948', 'Folk', TTL_LABEL);
  cache.set('tunein.label.g79',        'Acoustic', TTL_LABEL);
  // music intentionally not cached — the bare anchor `music` is a
  // tab token at stack[0], so it falls back to the tab label override.
  const trail = renderCrumbTrail(['c100000948', 'g79', 'music']);
  const crumbs = trailCrumbs(trail);
  // crumbs[0] is the literal "Browse" entry; the stack starts at [1].
  assert.equal(crumbs[1].textContent, 'Folk');
  assert.equal(crumbs[2].textContent, 'Acoustic');
  assert.equal(crumbs[3].textContent, 'music', 'mid-stack tab token reads as raw token (no first-crumb override)');
});

test('renderCrumbTrail overrides the first stack crumb with its tab label when the bare anchor is a tab token', () => {
  // music as stack[0] reads as "Genre" (the tab label).
  const trail = renderCrumbTrail(['music', 'g79']);
  const crumbs = trailCrumbs(trail);
  assert.equal(crumbs[0].textContent, 'Browse');
  assert.equal(crumbs[1].textContent, 'Genre', 'music at stack[0] reads as Genre');
});

test('renderCrumbTrail tab override applies to all three tab tokens at stack[0]', () => {
  assert.equal(trailCrumbs(renderCrumbTrail(['music']))[1].textContent, 'Genre');
  assert.equal(trailCrumbs(renderCrumbTrail(['r0']))[1].textContent,    'Location');
  assert.equal(trailCrumbs(renderCrumbTrail(['lang']))[1].textContent,  'Language');
});

test('renderCrumbTrail href on a stack crumb embeds the prefix up to (not including) itself', () => {
  const trail = renderCrumbTrail(['c100000948', 'g79', 'music']);
  const crumbs = trailCrumbs(trail);
  // crumbs[0] is the Browse entry — `#/browse`.
  assert.equal(crumbs[0].getAttribute('href'), '#/browse');
  // crumbs[1]: no ancestors, so no `from=`.
  const h1 = crumbs[1].getAttribute('href');
  assert.match(h1, /^#\/browse\?id=c100000948$/, `first stack crumb href: ${h1}`);
  // crumbs[2]: ancestors = [c100000948].
  const h2 = crumbs[2].getAttribute('href');
  assert.match(h2, /^#\/browse\?id=g79&from=c100000948$/, `second stack crumb href: ${h2}`);
  // crumbs[3]: ancestors = [c100000948, g79].
  const h3 = crumbs[3].getAttribute('href');
  assert.match(h3, /^#\/browse\?c=music&from=c100000948%2Cg79$/, `third stack crumb href: ${h3}`);
});

test('renderCrumbTrail dedupes consecutive identical tokens (defence against legacy URLs) — #89', () => {
  // A from=lang,lang,lang that pre-dates the filter-aware emitter must
  // not render three "By Language" anchors.
  cache.set('tunein.label.lang', 'By Language', TTL_LABEL);
  const trail = renderCrumbTrail(['lang', 'lang', 'lang']);
  const crumbs = trailCrumbs(trail);
  // Browse + 1 deduped lang anchor = 2 segments total.
  assert.equal(crumbs.length, 2, 'collapses three lang tokens to one anchor');
  // lang at stack[0] reads as the tab label override "Language".
  assert.equal(crumbs[1].textContent, 'Language');
});

test('renderCrumbTrail resolves <anchor>:l<NNN> tokens to the cached language name — #89', async () => {
  // Prime the lcode catalogue and assert the breadcrumb picks up the
  // language name without any network work. The filter-bearing token
  // is intentionally not treated as a tab-token override.
  const { cacheLcodes } = await import('../app/tunein-url.js');
  cacheLcodes([
    { id: 'l109', name: 'German' },
    { id: 'l216', name: 'English' },
  ]);
  cache.set('tunein.label.lang', 'By Language', TTL_LABEL);
  const trail = renderCrumbTrail(['lang', 'lang:l109']);
  const crumbs = trailCrumbs(trail);
  // Browse + lang + lang:l109 = 3 segments.
  assert.equal(crumbs.length, 3);
  // lang at stack[0] reads as the tab label override.
  assert.equal(crumbs[1].textContent, 'Language');
  // Filter-bearing token resolves to the language name via the lcode
  // catalogue (the tab override doesn't apply to filter-bearing tokens).
  assert.equal(crumbs[2].textContent, 'German');
  // The lang:l109 anchor navigates back to the German language root.
  const h2 = crumbs[2].getAttribute('href');
  assert.match(h2, /c=lang/);
  assert.match(h2, /filter=l109/);
  assert.match(h2, /from=lang/);
});

test('renderCrumbTrail falls back to the raw token when neither cache nor lcode catalogue resolves the label', () => {
  // No catalogue, no tunein.label cache — lang:l9999 has no human name
  // to show, so the anchor renders the raw token.
  const trail = renderCrumbTrail(['lang:l9999']);
  const crumbs = trailCrumbs(trail);
  assert.equal(crumbs.length, 2);
  assert.equal(crumbs[1].textContent, 'lang:l9999');
});

// --- renderCrumbTrail with currentParts appends the bolded tail -----

test('renderCrumbTrail with currentParts appends a non-anchor bolded current segment', () => {
  cache.set('tunein.label.c100000948', 'Folk', TTL_LABEL);
  cache.set('tunein.label.g79',        'Smooth Jazz', TTL_LABEL);
  const trail = renderCrumbTrail(['music', 'c100000948'], { id: 'g79' });
  const crumbs = trailCrumbs(trail);
  // Browse + music + c100000948 + (current = g79).
  assert.equal(crumbs.length, 4);
  const current = crumbs[3];
  assert.equal(current.tagName, 'span', 'current segment is a span, not an anchor');
  assert.equal(current.getAttribute('aria-current'), 'page');
  assert.ok((current.getAttribute('class') || '').includes('is-current'));
  // Reads as the resolved title (cached) for the current parts.
  assert.equal(current.textContent, 'Smooth Jazz');
});

test('renderCrumbTrail current segment is non-anchor even when parts have no cached label', () => {
  // No cache — the current segment still renders, falling back to the
  // compact crumbLabelFor form.
  const trail = renderCrumbTrail([], { id: 'g999' });
  const crumbs = trailCrumbs(trail);
  // Browse + (current = g999).
  assert.equal(crumbs.length, 2);
  assert.equal(crumbs[1].tagName, 'span');
  assert.equal(crumbs[1].getAttribute('aria-current'), 'page');
});

// --- renderPillBar composes back chevron + trail --------------------

test('renderPillBar mounts a circular Back affordance with chevron glyph + aria-label', () => {
  const bar = renderPillBar({ id: 'g79' }, ['music']);
  assert.ok((bar.getAttribute('class') || '').includes('browse-bar'));
  const back = bar.querySelector('.browse-bar__back');
  assert.ok(back, 'back affordance mounted');
  assert.equal(back.tagName, 'a', 'back is an anchor (hash-router target)');
  // aria-label carries the popped destination — "music" at stack[0]
  // surfaces as "Genre" via the tab-token override.
  assert.equal(back.getAttribute('aria-label'), 'Back to Genre');
  // The glyph itself is an inline SVG with no text.
  const svg = back.querySelector('svg');
  assert.ok(svg, 'back contains an svg glyph');
  // No text content beyond the glyph.
  assert.equal((back.textContent || '').trim(), '');
});

test('renderPillBar back href matches backHrefFor on the same stack', () => {
  const stack = ['music', 'g79'];
  const bar = renderPillBar({ id: 'c100000948' }, stack);
  const back = bar.querySelector('.browse-bar__back');
  assert.equal(back.getAttribute('href'), backHrefFor(stack));
});

test('renderPillBar back aria-label reads "Back to Browse" when stack is empty', () => {
  const bar = renderPillBar({ c: 'music' }, []);
  const back = bar.querySelector('.browse-bar__back');
  assert.equal(back.getAttribute('aria-label'), 'Back to Browse');
});

test('renderPillBar trail composes Browse › <Tab> › <Ancestor> › <Current>', () => {
  cache.set('tunein.label.c100000948', 'Folk', TTL_LABEL);
  const bar = renderPillBar({ id: 'g79' }, ['music', 'c100000948']);
  const trail = bar.querySelector('.browse-bar__trail');
  assert.ok(trail, 'trail mounted inside the bar');
  const crumbs = trailCrumbs(trail);
  assert.equal(crumbs.length, 4);
  const labels = crumbs.map((c) => c.textContent);
  assert.deepEqual(labels, ['Browse', 'Genre', 'Folk', 'g79']);
  // The first three are anchors; the last is the bolded current span.
  assert.equal(crumbs[0].tagName, 'a');
  assert.equal(crumbs[1].tagName, 'a');
  assert.equal(crumbs[2].tagName, 'a');
  assert.equal(crumbs[3].tagName, 'span');
  assert.equal(crumbs[3].getAttribute('aria-current'), 'page');
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
