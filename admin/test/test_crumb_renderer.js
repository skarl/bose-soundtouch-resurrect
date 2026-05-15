// Tests for the DOM half of the Crumb stack module —
// admin/app/views/browse/crumb-renderer.js. Covers the pill-bar
// builder (renderPillBar, renderCrumbTrail), the filter-badge
// renderers (renderFilterBadge / renderFilterBadges) and the
// renderEntry → child-stack composition seam.
//
// The pure value type lives in crumb-parts.js (test_crumb_parts.js
// covers it without the xmldom shim); this file exercises the
// DOM-bound surface that hydrateCrumbLabels and the pill-bar mount.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installSessionStorage } from './fixtures/dom-shim.js';

const ssStore = installSessionStorage();

const {
  renderCrumbTrail,
  renderPillBar,
  renderFilterBadge,
  renderFilterBadges,
} = await import('../app/views/browse/crumb-renderer.js');

const {
  backHrefFor,
} = await import('../app/views/browse/crumb-parts.js');

const {
  renderEntry,
} = await import('../app/views/browse.js');

const { cache, TTL_LABEL } = await import('../app/tunein-cache.js');

beforeEach(() => {
  ssStore.clear();
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
  const row = renderEntry({
    text: 'Folk',
    URL:  'http://opml.radiotime.com/Browse.ashx?id=g79',
  }, { childCrumbs: ['lang', 'music'], currentParts: null });
  const href = row.getAttribute('href');
  assert.match(href, /^#\/browse\?/);
  assert.match(href, /id=g79/);
  assert.match(href, /from=lang%2Cmusic/, `expected from=lang,music in ${href}`);
});

test('renderEntry: with empty child crumb stack, href has no from= param', () => {
  const row = renderEntry({
    text: 'Genre',
    URL:  'http://opml.radiotime.com/Browse.ashx?id=g22',
  }, { childCrumbs: [], currentParts: null });
  const href = row.getAttribute('href');
  assert.equal(href, '#/browse?id=g22', `no from= for root-level child: ${href}`);
});

// --- #104 — dedupe trail tail when current parts match last stack ---
//
// When the user clicks an end-of-page filter chip, the link appends
// the current id to `from=` AND keeps the same primary id. Without
// the tail-dedupe, the breadcrumb renders
//   Browse › Location › … › Bayreuth › **Bayreuth**
// with the bolded current segment duplicating the last stack crumb.

test('renderCrumbTrail dedupes the trail tail when the current token equals the last stack token — #104', () => {
  // Real-world shape: `#/browse?id=r101821&from=r0,r101217,r100346,r101821`
  cache.set('tunein.label.r101217', 'Europe',  TTL_LABEL);
  cache.set('tunein.label.r100346', 'Germany', TTL_LABEL);
  cache.set('tunein.label.r101821', 'Bayreuth', TTL_LABEL);
  const trail = renderCrumbTrail(
    ['r0', 'r101217', 'r100346', 'r101821'],
    { id: 'r101821' },
  );
  const crumbs = trailCrumbs(trail);
  // Browse + r0 (Location) + r101217 + r100346 + (current=r101821).
  // The trailing r101821 in the stack is dropped — IS the current node.
  assert.equal(crumbs.length, 5);
  assert.deepEqual(
    crumbs.map((c) => c.textContent),
    ['Browse', 'Location', 'Europe', 'Germany', 'Bayreuth'],
  );
  // The Bayreuth segment is the bolded current span, not a stack anchor.
  assert.equal(crumbs[4].tagName, 'span');
  assert.equal(crumbs[4].getAttribute('aria-current'), 'page');
});

test('renderCrumbTrail dedupes the trail tail when the current parts add a filter to a stack anchor — #104', () => {
  // The filter chip click shape: stack tail is `r101821` (bare), and
  // the current parts are `{id:'r101821', filter:'g26'}` whose token
  // is `r101821:g26`. They refer to the same drill node — dedupe the
  // duplicate tail.
  cache.set('tunein.label.r101821', 'Bayreuth', TTL_LABEL);
  const trail = renderCrumbTrail(
    ['r0', 'r101217', 'r100346', 'r101821'],
    { id: 'r101821', filter: 'g26' },
  );
  const crumbs = trailCrumbs(trail);
  // Browse + r0 + r101217 + r100346 + (current=r101821:g26).
  assert.equal(crumbs.length, 5);
  assert.equal(crumbs[4].tagName, 'span');
  assert.equal(crumbs[4].textContent, 'Bayreuth');
});

test('renderCrumbTrail does NOT dedupe when the current parts token does not match the last stack token — #104', () => {
  // The language-tree case: stack tail is `lang:l170`, current parts
  // are `{c:'music', filter:'l170'}` → token `music:l170`. The anchors
  // differ (lang vs music) so no dedupe; the trail keeps both.
  cache.set('tunein.label.lang:l170', 'Hungarian', TTL_LABEL);
  cache.set('tunein.label.music:l170', 'Music', TTL_LABEL);
  const trail = renderCrumbTrail(
    ['lang', 'lang:l170'],
    { c: 'music', filter: 'l170' },
  );
  const crumbs = trailCrumbs(trail);
  // Browse + Language + Hungarian + (current=Music).
  assert.equal(crumbs.length, 4);
  assert.deepEqual(
    crumbs.map((c) => c.textContent),
    ['Browse', 'Language', 'Hungarian', 'Music'],
  );
});

test('renderCrumbTrail tail-dedupe is a no-op when stack is empty — #104', () => {
  // Defence: dedupe must not blow up when there are no stack crumbs.
  const trail = renderCrumbTrail([], { id: 'g999' });
  const crumbs = trailCrumbs(trail);
  // Browse + (current).
  assert.equal(crumbs.length, 2);
  assert.equal(crumbs[1].getAttribute('aria-current'), 'page');
});

// --- #104 — filter badge in the pill bar ----------------------------
//
// When `parts.filter` is non-empty, the bar mounts a `.browse-bar__filter`
// peer to the trail. It carries the resolved filter label and a × close
// affordance that navigates to the same drill minus the filter.

test('renderFilterBadge returns null when parts has no filter — #104', () => {
  assert.equal(renderFilterBadge({ id: 'r101821' }, []), null);
  assert.equal(renderFilterBadge({ id: 'r101821', filter: '' }, []), null);
  assert.equal(renderFilterBadge({}, []), null);
});

test('renderFilterBadge mounts label + × close anchor for an lcode filter — #104', async () => {
  // Prime the lcode catalogue so the badge resolves "l109" → "German"
  // synchronously, no fetch.
  const { cacheLcodes } = await import('../app/tunein-url.js');
  cacheLcodes([{ id: 'l109', name: 'German' }]);
  const badge = renderFilterBadge({ c: 'music', filter: 'l109' }, ['lang', 'lang:l109']);
  assert.ok(badge, 'badge returned for lcode filter');
  assert.ok((badge.getAttribute('class') || '').includes('browse-bar__filter'));
  assert.equal(badge.dataset.filterToken, 'l109');
  const label = badge.querySelector('.browse-bar__filter-label');
  assert.ok(label, 'label child present');
  assert.equal(label.textContent, 'German', 'label resolved from lcode catalogue');
  const close = badge.querySelector('.browse-bar__filter-close');
  assert.ok(close, 'close affordance present');
  assert.equal(close.tagName, 'a', 'close is an anchor (hash-router)');
  assert.equal(close.getAttribute('aria-label'), 'Remove filter');
});

test('renderFilterBadge × close navigates to the same drill without the filter — #104', () => {
  // The close anchor preserves the stack and the primary id; it just
  // drops the filter query param.
  cache.set('tunein.label.g26', 'Country', TTL_LABEL);
  const stack = ['r0', 'r101217', 'r100346', 'r101821'];
  const badge = renderFilterBadge({ id: 'r101821', filter: 'g26' }, stack);
  const close = badge.querySelector('.browse-bar__filter-close');
  const href = close.getAttribute('href');
  // Same drill, no filter, full stack preserved.
  assert.match(href, /^#\/browse\?id=r101821/, `id preserved: ${href}`);
  assert.doesNotMatch(href, /filter=/, `filter dropped: ${href}`);
  assert.match(href, /from=r0%2Cr101217%2Cr100346%2Cr101821/, `stack preserved: ${href}`);
});

test('renderFilterBadge × close preserves the c-style anchor and drops only the filter — #104', async () => {
  // c-style drill: `c=music&filter=l109&from=lang,lang:l109` — close
  // strips the filter, leaves c=music + the stack.
  const { cacheLcodes } = await import('../app/tunein-url.js');
  cacheLcodes([{ id: 'l109', name: 'German' }]);
  const badge = renderFilterBadge(
    { c: 'music', filter: 'l109' },
    ['lang', 'lang:l109'],
  );
  const close = badge.querySelector('.browse-bar__filter-close');
  const href = close.getAttribute('href');
  assert.match(href, /^#\/browse\?c=music/);
  assert.doesNotMatch(href, /filter=/);
  assert.match(href, /from=lang%2Clang%3Al109/);
});

test('renderFilterBadge uses the cached label when present (no network) — #104', () => {
  // Non-lcode filter; cache hit resolves the label without hitting fetch.
  cache.set('tunein.label.g26', 'Country', TTL_LABEL);
  const badge = renderFilterBadge({ id: 'r101821', filter: 'g26' }, []);
  const label = badge.querySelector('.browse-bar__filter-label');
  assert.equal(label.textContent, 'Country');
});

test('renderFilterBadge falls back to the raw token when no label is resolvable yet — #104', () => {
  // No cache, no catalogue — the badge initially shows the raw token
  // and (in production) kicks an async Describe / Browse to upgrade.
  // The async branch is fire-and-forget; we just assert the initial
  // render. Stub fetch so the async path doesn't hit the network.
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const badge = renderFilterBadge({ id: 'r101821', filter: 'g9999' }, []);
    const label = badge.querySelector('.browse-bar__filter-label');
    assert.equal(label.textContent, 'g9999');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('renderPillBar mounts the filter badge inside the bar when parts.filter is set — #104', () => {
  cache.set('tunein.label.g26', 'Country', TTL_LABEL);
  const bar = renderPillBar(
    { id: 'r101821', filter: 'g26' },
    ['r0', 'r101217', 'r100346', 'r101821'],
  );
  const badge = bar.querySelector('.browse-bar__filter');
  assert.ok(badge, 'filter badge mounted in the bar');
  assert.equal(badge.querySelector('.browse-bar__filter-label').textContent, 'Country');
  // The bar still carries the back affordance + trail.
  assert.ok(bar.querySelector('.browse-bar__back'), 'back affordance still present');
  assert.ok(bar.querySelector('.browse-bar__trail'), 'trail still present');
});

test('renderPillBar omits the filter badge when parts has no filter — #104', () => {
  const bar = renderPillBar({ id: 'g79' }, ['music']);
  assert.equal(bar.querySelector('.browse-bar__filter'), null);
});

test('renderPillBar + filter chip click shape produces a clean trail + badge — #104', () => {
  // The end-to-end shape from the issue: stack tail equals the current
  // anchor; current parts carries filter=g26. Expect the trail to
  // dedupe the duplicate tail AND the badge to mount with the resolved
  // filter label.
  cache.set('tunein.label.r101217', 'Europe',   TTL_LABEL);
  cache.set('tunein.label.r100346', 'Germany',  TTL_LABEL);
  cache.set('tunein.label.r101821', 'Bayreuth', TTL_LABEL);
  cache.set('tunein.label.g26',     'Country',  TTL_LABEL);
  const bar = renderPillBar(
    { id: 'r101821', filter: 'g26' },
    ['r0', 'r101217', 'r100346', 'r101821'],
  );
  const trail = bar.querySelector('.browse-bar__trail');
  const crumbs = trailCrumbs(trail);
  assert.deepEqual(
    crumbs.map((c) => c.textContent),
    ['Browse', 'Location', 'Europe', 'Germany', 'Bayreuth'],
    'trail tail dedupes the duplicated r101821',
  );
  const badge = bar.querySelector('.browse-bar__filter');
  assert.ok(badge);
  assert.equal(badge.querySelector('.browse-bar__filter-label').textContent, 'Country');
});

// --- #106 — trail-tail dedupe still fires with multi-filter ---------

test('renderCrumbTrail dedupes the trail tail when current parts have N filters refining the stack-tail anchor — #106', () => {
  // Stack tail is the bare anchor; the current parts add multiple
  // filters. Same drill node, just refined — trail must dedupe.
  cache.set('tunein.label.r101821', 'Bayreuth', TTL_LABEL);
  const trail = renderCrumbTrail(
    ['r0', 'r101217', 'r100346', 'r101821'],
    { id: 'r101821', filters: ['g26', 'l170'] },
  );
  const crumbs = trailCrumbs(trail);
  // Browse + r0 + r101217 + r100346 + (current=Bayreuth) — five total.
  assert.equal(crumbs.length, 5);
  assert.equal(crumbs[4].tagName, 'span');
  assert.equal(crumbs[4].getAttribute('aria-current'), 'page');
  assert.equal(crumbs[4].textContent, 'Bayreuth');
});

// --- #106 — renderFilterBadges: one badge per filter -----------------

test('renderFilterBadges returns one badge per filter in parts.filters — #106', async () => {
  cache.set('tunein.label.g26', 'Country', TTL_LABEL);
  const { cacheLcodes } = await import('../app/tunein-url.js');
  cacheLcodes([{ id: 'l170', name: 'Hungarian' }]);
  const badges = renderFilterBadges(
    { id: 'r101821', filters: ['g26', 'l170'] },
    ['r0', 'r101217', 'r100346', 'r101821'],
  );
  assert.equal(badges.length, 2, 'one badge per filter');
  assert.equal(badges[0].dataset.filterToken, 'g26');
  assert.equal(badges[1].dataset.filterToken, 'l170');
  assert.equal(badges[0].querySelector('.browse-bar__filter-label').textContent, 'Country');
  assert.equal(badges[1].querySelector('.browse-bar__filter-label').textContent, 'Hungarian');
});

test('renderFilterBadges returns [] when parts has no filters — #106', () => {
  assert.deepEqual(renderFilterBadges({ id: 'r101821' }, []), []);
  assert.deepEqual(renderFilterBadges({ id: 'r101821', filters: [] }, []), []);
});

test('renderFilterBadges per-filter × removes only that filter from the URL — #106', () => {
  // Three filters; clicking the middle × must drop just `l170` and
  // keep the other two in the URL.
  cache.set('tunein.label.g26',  'Country',    TTL_LABEL);
  cache.set('tunein.label.l170', 'Hungarian',  TTL_LABEL);
  cache.set('tunein.label.s:popular', 'Popular', TTL_LABEL);
  const stack = ['r0', 'r101217', 'r100346', 'r101821'];
  const badges = renderFilterBadges(
    { id: 'r101821', filters: ['g26', 'l170', 's:popular'] },
    stack,
  );
  assert.equal(badges.length, 3);
  // Middle filter's × — drops only l170.
  const middleClose = badges[1].querySelector('.browse-bar__filter-close');
  const href = middleClose.getAttribute('href');
  assert.match(href, /^#\/browse\?id=r101821/);
  // The remaining filters are joined with %2C (URLSearchParams comma).
  assert.match(href, /filter=g26%2Cs%3Apopular/, `expected g26 + s:popular preserved in ${href}`);
  assert.doesNotMatch(href, /l170/, `l170 dropped from ${href}`);
  // Stack still preserved.
  assert.match(href, /from=r0%2Cr101217%2Cr100346%2Cr101821/);
});

test('renderFilterBadges last-filter × reverts to the bare drill (no empty filter= param) — #106', () => {
  cache.set('tunein.label.g26', 'Country', TTL_LABEL);
  const badges = renderFilterBadges({ id: 'r101821', filters: ['g26'] }, ['r0', 'r101821']);
  assert.equal(badges.length, 1);
  const close = badges[0].querySelector('.browse-bar__filter-close');
  const href = close.getAttribute('href');
  // Bare drill, no lingering filter= or filter= with empty value.
  assert.match(href, /^#\/browse\?id=r101821/);
  assert.doesNotMatch(href, /filter=/, `no filter= param in ${href}`);
});

test('renderFilterBadges first-filter × drops the first and keeps the rest — #106', () => {
  cache.set('tunein.label.g26',  'Country',   TTL_LABEL);
  cache.set('tunein.label.l170', 'Hungarian', TTL_LABEL);
  const badges = renderFilterBadges(
    { id: 'r101821', filters: ['g26', 'l170'] },
    [],
  );
  const firstClose = badges[0].querySelector('.browse-bar__filter-close');
  const href = firstClose.getAttribute('href');
  assert.match(href, /filter=l170(?:&|$)/, `only l170 remains in ${href}`);
  assert.doesNotMatch(href, /g26/);
});

test('renderPillBar mounts N badges side-by-side when parts has N filters — #106', () => {
  cache.set('tunein.label.g26',  'Country',    TTL_LABEL);
  cache.set('tunein.label.l170', 'Hungarian',  TTL_LABEL);
  const bar = renderPillBar(
    { id: 'r101821', filters: ['g26', 'l170'] },
    ['r0', 'r101217', 'r100346', 'r101821'],
  );
  // querySelectorAll isn't available on xmldom — walk children instead.
  const badges = [];
  for (const child of bar.childNodes || []) {
    if (child && child.nodeType === 1
        && (child.getAttribute('class') || '').split(/\s+/).includes('browse-bar__filter')) {
      badges.push(child);
    }
  }
  assert.equal(badges.length, 2, 'two badges mount as peers in the bar');
  assert.equal(badges[0].dataset.filterToken, 'g26');
  assert.equal(badges[1].dataset.filterToken, 'l170');
});

test('renderPillBar back-compat: renderFilterBadge still returns a single badge for the single-filter case — #106', () => {
  // The shim keeps old test-fixture calls working: passing a single
  // filter still returns one badge node (or null when no filter).
  cache.set('tunein.label.g26', 'Country', TTL_LABEL);
  const badge = renderFilterBadge({ id: 'r101821', filter: 'g26' }, []);
  assert.ok(badge);
  assert.equal(badge.dataset.filterToken, 'g26');
});

test('renderPillBar in-the-wild single-filter URL still mounts one badge — #106 back-compat', () => {
  // The bookmark / paste scenario: a URL stashed before #106 lands
  // with a single `filter=l109` and partsFromCrumb on its from= stack
  // produces `parts.filter = 'l109'`. Treated as filters: ['l109'].
  cache.set('tunein.label.l109', 'German', TTL_LABEL);
  const bar = renderPillBar({ c: 'music', filter: 'l109' }, ['lang', 'lang:l109']);
  const badges = [];
  for (const child of bar.childNodes || []) {
    if (child && child.nodeType === 1
        && (child.getAttribute('class') || '').split(/\s+/).includes('browse-bar__filter')) {
      badges.push(child);
    }
  }
  assert.equal(badges.length, 1);
  assert.equal(badges[0].dataset.filterToken, 'l109');
});
