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
import { getSpeakerInfo } from './api.js';
import { mountShell } from './shell.js';
import * as ws from './ws.js';
import * as theme from './theme.js';

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

  ws.connect(store);

  window.addEventListener('beforeunload', () => ws.disconnect(), { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
