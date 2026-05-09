// Entry point. Wires the hash router to the view modules and the
// observable store. Slice 1 only — slice 6+ adds REST polling /
// WebSocket bootstrapping here.
// See admin/PLAN.md § Routing and § State management.

import { store } from './state.js';
import { createRouter } from './router.js';
import { html, mount } from './dom.js';

import nowPlaying from './views/now-playing.js';
import browse     from './views/browse.js';
import search     from './views/search.js';
import station    from './views/station.js';

import { installVersionDriftCheck } from './version.js';

// #/preset/N is a 0.3 modal triggered from now-playing. For 0.2 slice 1
// we render a tiny inline placeholder so the route doesn't 404.
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
  // Static nav scaffold — view content mounts into <div id="view">.
  mount(appRoot, html`
    <nav class="routes" aria-label="primary">
      <a href="#/">Now playing</a>
      <a href="#/browse">Browse</a>
      <a href="#/search">Search</a>
    </nav>
    <div id="view" role="main"></div>
  `);
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
