// Entry point. Wires the hash router to the view modules and the
// observable store; the four-zone app shell lives in shell.js.

import { store } from './state.js';
import { createRouter } from './router.js';
import { html, mount, defineView } from './dom.js';

import nowPlaying from './views/now-playing.js';
import browse     from './views/browse.js';
import search     from './views/search.js';
import station    from './views/station.js';
import preset     from './views/preset.js';
import favorites  from './views/favorites.js';
import settings   from './views/settings.js';

import { installVersionDriftCheck } from './version.js';
import { parseSid } from './tunein-sid.js';
import { getSpeakerInfo, tuneinDescribe } from './api.js';
import { mountShell } from './shell.js';
import * as ws from './ws.js';
import * as theme from './theme.js';
import { cacheLcodesFromDescribe, LCODE_CACHE_KEY } from './tunein-url.js';

theme.init();

const notFound = defineView({
  mount(root, _store, ctx) {
    const path = (ctx && ctx.path) || '(unknown)';
    mount(root, html`
      <section class="placeholder" data-view="not-found">
        <h1>Not found</h1>
        <p>No view for <code>${path}</code>. Try <a href="#/">home</a>.</p>
      </section>
    `);
    return {};
  },
});

// Safety net for #/station/<non-s-sid>. The strict matcher above only
// catches `s` sids (where the preset-assignment station view lives);
// legacy bookmarks, copy-pasted shares, and any caller that hasn't been
// updated may still hand us a `p` (show) or `t` (topic) sid via the
// `/station/` route. Rather than let them fall through to the
// not-found placeholder (per #86), inspect the prefix and redirect to
// the canonical browse drill. Unknown prefixes render the explicit
// not-found view so the user sees the same dead-end they would have
// hit otherwise — just routed through a deliberate decision, not a
// regex miss.
//
// `location.replace` is preferred over assignment so the redirect does
// not create a separate back-button entry — the bad URL never enters
// the history stack.
function redirectHashForStation(id) {
  // Only p (show) and t (topic) prefixes redirect; s falls through to
  // the strict station-detail matcher upstream of this view, and
  // unknown prefixes (or garbage) render the explicit not-found surface
  // below. The destination is the prefix's detailHref from tunein-sid
  // (the single source of truth for prefix routing).
  const parsed = parseSid(id);
  if (parsed.prefix !== 'p' && parsed.prefix !== 't') return null;
  return parsed.detailHref;
}

const stationRedirect = defineView({
  mount(root, _store, ctx) {
    const id = (ctx && ctx.params && ctx.params.id) || '';
    const target = redirectHashForStation(id);
    if (target) {
      location.replace(target);
      return {};
    }
    // Unknown prefix — render the same not-found surface the fallback
    // would have produced, but reached through a deliberate matcher
    // rather than the catch-all.
    const path = (ctx && ctx.path) || '(unknown)';
    mount(root, html`
      <section class="placeholder" data-view="not-found">
        <h1>Not found</h1>
        <p>No view for <code>${path}</code>. Try <a href="#/">home</a>.</p>
      </section>
    `);
    return {};
  },
});

const routes = [
  { pattern: /^\/$/,                             view: nowPlaying },
  { pattern: /^\/browse$/,                       view: browse },
  { pattern: /^\/search$/,                       view: search },
  { pattern: /^\/station\/(?<id>s\d+)$/,         view: station },
  // Wildcard catch-all for non-`s` sids — see stationRedirect above.
  // Ordering matters: the strict `s\d+` matcher must come first so
  // existing station-detail flows are untouched; this one only fires
  // when the strict matcher misses.
  { pattern: /^\/station\/(?<id>[^/]+)$/,        view: stationRedirect },
  { pattern: /^\/preset\/(?<slot>[1-6])$/,       view: preset },
  { pattern: /^\/favorites$/,                    view: favorites },
  { pattern: /^\/settings$/,                     view: settings },
];

function boot() {
  const viewRoot = mountShell(store);
  if (!viewRoot) throw new Error('shell mount failed');

  const router = createRouter({
    root: viewRoot,
    routes,
    fallback: { view: notFound },
    store,
  });
  router.start();
  installVersionDriftCheck();

  getSpeakerInfo().then((info) => {
    if (info) {
      store.state.speaker.info = info;
      store.touch('speaker');
    }
  }).catch(() => {
    // Non-fatal — header name stays blank; speaker still works.
  });

  // Populate the lcode allow-list once per session. § 7.5 of the
  // TuneIn working guide: the service fails open on bogus language
  // codes, so the client validates every emitted lcode against the
  // 102-entry catalogue from Describe.ashx?c=languages. The cache
  // lives in sessionStorage (see admin/app/tunein-url.js); skip the
  // fetch if a previous boot already populated it.
  try {
    const already = (typeof sessionStorage !== 'undefined')
      ? sessionStorage.getItem(LCODE_CACHE_KEY)
      : null;
    if (!already) {
      tuneinDescribe({ c: 'languages' })
        .then((json) => cacheLcodesFromDescribe(json))
        .catch(() => { /* non-fatal — isValidLcode fails closed */ });
    }
  } catch (_err) {
    // sessionStorage unavailable (private mode / quota); the SPA
    // still works — lcode validation just always returns false.
  }

  ws.connect(store);

  window.addEventListener('beforeunload', () => ws.disconnect(), { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
