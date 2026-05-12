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
import settings   from './views/settings.js';

import { installVersionDriftCheck } from './version.js';
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

const routes = [
  { pattern: /^\/$/,                             view: nowPlaying },
  { pattern: /^\/browse$/,                       view: browse },
  { pattern: /^\/search$/,                       view: search },
  { pattern: /^\/station\/(?<id>s\d+)$/,         view: station },
  { pattern: /^\/preset\/(?<slot>[1-6])$/,       view: preset },
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
