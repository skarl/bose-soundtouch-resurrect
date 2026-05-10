// Hash router. Reads location.hash, matches against registered routes,
// invokes the matched view's `init(root, store, ctx)` and stashes the
// destroy function it returns so the next dispatch can unmount cleanly.
// See admin/PLAN.md § Routing.

function parseHash(hash) {
  // strip leading "#" then split off query string
  const raw = (hash || '').replace(/^#/, '') || '/';
  const [pathRaw, queryRaw = ''] = raw.split('?');
  const path = pathRaw || '/';
  const query = {};
  for (const pair of queryRaw.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { path, query };
}

function matchRoute(routes, path) {
  for (const route of routes) {
    const m = path.match(route.pattern);
    if (m) return { route, params: m.groups || {} };
  }
  return null;
}

export function createRouter({ root, routes, fallback, store }) {
  let active = null;
  let destroy = null;

  function dispatch() {
    const { path, query } = parseHash(location.hash);
    const matched = matchRoute(routes, path) || { route: fallback, params: {} };
    const view = matched.route.view;

    if (destroy) { try { destroy(); } catch (_err) { /* keep dispatching */ } destroy = null; }
    root.replaceChildren();
    root.removeAttribute('aria-busy');

    active = view;
    destroy = view.init(root, store, { params: matched.params, query, path }) || null;
  }

  return {
    start() {
      window.addEventListener('hashchange', dispatch);
      if (!location.hash) location.hash = '#/';
      dispatch();
    },
    current() { return active; },
  };
}
