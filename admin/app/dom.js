// All views init once; reactivity is via per-view mutators on
// state-path subscriptions, not via re-rendering. Re-rendering
// inputs/sliders/scroll-containers breaks them.

// html`...` — tagged template that returns a DocumentFragment.
//
// Each interpolation is marked with a numbered HTML comment, then
// parsed; we walk the resulting tree to substitute real values back in.
// Comments survive HTML5 parsing intact (unlike text-position sentinels,
// which are subject to whitespace and NULL-stripping rules), and the
// numeric index means we don't care about placeholder uniqueness.
//
// Element/text positions accept Node | string | number | null/undefined.
// Nodes are inserted directly; primitives render as text (HTML-escaped);
// null/undefined render nothing.
//
// Attribute positions accept primitives only — Nodes don't make sense
// in an attribute value, and pass through as the empty string.
const MARKER_PREFIX = '__HTML_PLACEHOLDER__';
const MARKER_RE = new RegExp(`<!--${MARKER_PREFIX}(\\d+)-->`, 'g');

export function html(strings, ...values) {
  let src = strings[0];
  for (let i = 0; i < values.length; i++) {
    src += `<!--${MARKER_PREFIX}${i}-->` + strings[i + 1];
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = src;

  // Attribute substitutions. Inside an attribute value, the parser
  // keeps our marker as literal text (comments don't apply in attribute
  // contexts), so we sweep every attribute on every element and rewrite
  // any that mentions the marker prefix.
  for (const el of tpl.content.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (!attr.value.includes(MARKER_PREFIX)) continue;
      attr.value = attr.value.replace(MARKER_RE, (_, idx) => {
        const v = values[parseInt(idx, 10)];
        if (v == null || v instanceof Node) return '';
        return String(v);
      });
    }
  }

  // Element / text-position substitutions.
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_COMMENT);
  const markers = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.startsWith(MARKER_PREFIX)) markers.push(node);
  }
  for (const c of markers) {
    const idx = parseInt(c.nodeValue.slice(MARKER_PREFIX.length), 10);
    const v = values[idx];
    if (v instanceof Node) {
      c.replaceWith(v);
    } else if (v == null) {
      c.remove();
    } else {
      c.replaceWith(document.createTextNode(String(v)));
    }
  }
  return tpl.content;
}

// mount(root, fragment): clear root, append fragment, return root.
export function mount(root, fragment) {
  root.replaceChildren(fragment);
  return root;
}

// View shell: defineView({ mount }) → { init(root, store, ctx) → destroy }.
//
// `mount(root, store, ctx, env)` builds DOM once and returns an updaters
// object whose keys are top-level store keys to subscribe to. `env`
// carries an AbortSignal for async work and an `onCleanup(fn)` register
// that fires LIFO on unmount.
const ALLOWED_UPDATER_KEYS = new Set(['speaker', 'ws', 'ui', 'caches']);

function makeEnv(controller, cleanups) {
  return {
    signal: controller.signal,
    onCleanup(fn) {
      if (typeof fn !== 'function') return;
      cleanups.push(fn);
    },
  };
}

function runCleanups(cleanups) {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { fn(); } catch (_err) { /* swallow — one bad cleanup shouldn't strand others */ }
  }
}

function wireUpdaters(store, updaters) {
  const unsubs = [];
  if (!updaters || typeof updaters !== 'object') return unsubs;
  for (const key of Object.keys(updaters)) {
    if (!ALLOWED_UPDATER_KEYS.has(key)) {
      throw new Error(`defineView: unknown updater key "${key}"`);
    }
    const fn = updaters[key];
    if (typeof fn !== 'function') continue;
    unsubs.push(store.subscribe(key, (state) => fn(state)));
  }
  return unsubs;
}

export function defineView({ mount: mountFn }) {
  if (typeof mountFn !== 'function') {
    throw new Error('defineView: mount must be a function');
  }
  return {
    init(root, store, ctx) {
      const controller = new AbortController();
      const cleanups = [];
      const env = makeEnv(controller, cleanups);
      const updaters = mountFn(root, store, ctx, env) || {};
      let unsubs;
      try {
        unsubs = wireUpdaters(store, updaters);
      } catch (err) {
        controller.abort();
        runCleanups(cleanups);
        throw err;
      }
      return function destroy() {
        controller.abort();
        for (const u of unsubs) { try { u(); } catch (_err) { /* keep going */ } }
        runCleanups(cleanups);
      };
    },
  };
}

// mountChild(node, subview, store, ctx, parentEnv) — same wiring on a
// sub-DOM, with the child's destroy registered against the parent env so
// unmount cascades from the outer view.
export function mountChild(node, subview, store, ctx, parentEnv) {
  const destroy = subview.init(node, store, ctx);
  if (parentEnv && typeof parentEnv.onCleanup === 'function') {
    parentEnv.onCleanup(destroy);
  }
  return destroy;
}
