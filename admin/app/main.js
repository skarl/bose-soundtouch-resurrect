// Entry point. Wires the hash router to the view modules and the
// observable store.
// See admin/PLAN.md § Routing and § State management.

import { store } from './state.js';
import { createRouter } from './router.js';
import { html, mount } from './dom.js';

import nowPlaying from './views/now-playing.js';
import browse     from './views/browse.js';
import search     from './views/search.js';
import station    from './views/station.js';

import { installVersionDriftCheck } from './version.js';
import { getSpeakerInfo } from './api.js';
import { connectionPill, updatePill } from './components.js';
import * as ws from './ws.js';

// #/preset/N is reserved for the 0.3 "replace this preset" modal
// triggered from now-playing. Until then, render a tiny inline
// placeholder so the route doesn't 404.
const presetPlaceholder = {
  init(root, _store, ctx) {
    const slot = (ctx && ctx.params && ctx.params.slot) || '?';
    mount(root, html`
      <section class="placeholder" data-view="preset">
        <h1>Preset ${slot}</h1>
        <p>Coming in 0.3.</p>
      </section>
    `);
  },
  update() {},
};

const notFound = {
  init(root, _store, ctx) {
    const path = (ctx && ctx.path) || '(unknown)';
    mount(root, html`
      <section class="placeholder" data-view="not-found">
        <h1>Not found</h1>
        <p>No view for <code>${path}</code>. Try <a href="#/">home</a>.</p>
      </section>
    `);
  },
  update() {},
};

const routes = [
  { pattern: /^\/$/,                             view: nowPlaying, subscribe: 'speaker' },
  { pattern: /^\/browse$/,                       view: browse },
  { pattern: /^\/search$/,                       view: search },
  { pattern: /^\/station\/(?<id>s\d+)$/,         view: station },
  { pattern: /^\/preset\/(?<slot>[1-6])$/,       view: presetPlaceholder },
];

function renderShell(appRoot) {
  const pill = connectionPill(store.state);
  mount(appRoot, html`
    <header class="app-header">
      <span class="app-speaker-name"></span>
      ${pill}
    </header>
    <nav class="routes" aria-label="primary">
      <a href="#/">Now playing</a>
      <a href="#/browse">Browse</a>
      <a href="#/search">Search</a>
    </nav>
    <div id="view" role="main"></div>
  `);

  const nameEl = appRoot.querySelector('.app-speaker-name');

  store.subscribe('ws', (state) => {
    updatePill(pill, state);
  });

  store.subscribe('speaker', (state) => {
    nameEl.textContent = (state.speaker.info && state.speaker.info.name) || '';
  });

  return appRoot.querySelector('#view');
}

function boot() {
  const appRoot = document.getElementById('app');
  if (!appRoot) throw new Error('#app element missing from index.html');
  const viewRoot = renderShell(appRoot);
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
