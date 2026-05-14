// Tests for the favourites-tab drag reorder (issue #128):
//
//   - splice math: a pure function lifts the "remove from i, insert at
//     gap g" math out of the DOM so we can hammer the edge cases
//     (no-op drops, end-of-list, cross-source) without instrumenting
//     pointer events.
//   - POST-on-drop: a synthetic pointer drag from one row to another's
//     gap fires exactly one POST with the reordered list.
//   - abort-no-POST: pointercancel and Escape both tear the drag down
//     without writing.
//
// The DOM shim doesn't ship a real document.addEventListener, so the
// drag controller's document-scoped listeners (pointermove / pointerup
// / pointercancel / keydown) wouldn't fire under the default no-op. We
// install a tiny dispatching shim per-test so the synthetic pointer
// events route through to the controller. Rows get a stubbed
// getBoundingClientRect so the "gap from pointer Y" math has something
// to chew on — the production code uses the real rect from layout.
//
// Run: node --test admin/test

import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installFetchNeverResolving } from './fixtures/dom-shim.js';

installFetchNeverResolving();

const { spliceReorder } = await import('../app/favorites.js');
const { default: favoritesView } = await import('../app/views/favorites.js');
const { store } = await import('../app/state.js');

function makeRoot() { return doc.createElement('div'); }

function installFetchStub(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function mountFavorites(root) {
  return favoritesView.init(root, store, { params: {} });
}

// Install a dispatching doc.addEventListener for the duration of one
// test. The default shim is a no-op; the drag controller needs the
// document-scoped pointermove / pointerup / pointercancel / keydown
// listeners to actually fire. Returns { fireDoc, restore }.
function installDocEventDispatch() {
  const listeners = new Map();
  const originalAdd    = doc.addEventListener;
  const originalRemove = doc.removeEventListener;
  doc.addEventListener = function (type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  doc.removeEventListener = function (type, fn) {
    if (listeners.has(type)) listeners.get(type).delete(fn);
  };
  function fireDoc(type, init) {
    const evt = Object.assign({
      type,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
    }, init);
    const set = listeners.get(type);
    if (!set) return evt;
    for (const fn of set) {
      try { fn.call(doc, evt); } catch (_e) { /* swallow */ }
    }
    return evt;
  }
  function restore() {
    doc.addEventListener    = originalAdd;
    doc.removeEventListener = originalRemove;
  }
  return { fireDoc, restore };
}

// Stub rect: each row claims a 40 px tall band starting at its index.
// Row 0 → y 0..40, row 1 → y 40..80, etc. The midline of row i is
// i * 40 + 20, which lets us pick "before row N" with `pointerY <
// N * 40 + 20` and "after the last row" with any y past length * 40.
function stubRowRects(rows) {
  for (let i = 0; i < rows.length; i++) {
    const top = i * 40;
    const height = 40;
    rows[i].getBoundingClientRect = () => ({
      top, left: 0, right: 100, bottom: top + height, width: 100, height,
      x: 0, y: top,
    });
  }
}

function findRows(root) { return root.querySelectorAll('.favorites-row'); }
function findDragHandle(row) { return row.querySelector('.favorites-row__drag'); }

function dispatch(el, type, init) {
  const evt = Object.assign({
    type,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  }, init);
  el.dispatchEvent(evt);
  return evt;
}

beforeEach(() => {
  store.state.speaker.favorites = null;
});

// --- splice math ----------------------------------------------------

test('spliceReorder: move down past one neighbour', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  // from 0, drop after index 2 (gap 3) → b, c, a, d.
  const next = spliceReorder(list, 0, 3);
  assert.deepEqual(next.map((e) => e.id), ['b', 'c', 'a', 'd']);
  // Returns a new array (no in-place mutation).
  assert.notEqual(next, list);
  assert.deepEqual(list.map((e) => e.id), ['a', 'b', 'c', 'd']);
});

test('spliceReorder: move up past one neighbour', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  // from 2 → gap 0: c, a, b, d.
  const next = spliceReorder(list, 2, 0);
  assert.deepEqual(next.map((e) => e.id), ['c', 'a', 'b', 'd']);
});

test('spliceReorder: move from start to end', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  // from 0 → gap 3 (past the last row): b, c, a.
  const next = spliceReorder(list, 0, 3);
  assert.deepEqual(next.map((e) => e.id), ['b', 'c', 'a']);
});

test('spliceReorder: move from end to start', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  // from 2 → gap 0: c, a, b.
  const next = spliceReorder(list, 2, 0);
  assert.deepEqual(next.map((e) => e.id), ['c', 'a', 'b']);
});

test('spliceReorder: drop at source gap is a no-op (same reference)', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(spliceReorder(list, 1, 1), list, 'drop at own gap = no-op');
  assert.equal(spliceReorder(list, 1, 2), list, 'drop just past self = no-op');
});

test('spliceReorder: invalid args return the original list', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.equal(spliceReorder(list, -1, 0), list);
  assert.equal(spliceReorder(list,  0, -1), list);
  assert.equal(spliceReorder(list,  5,  0), list);
  assert.equal(spliceReorder(list,  0,  9), list);
  assert.equal(spliceReorder(null, 0, 0).length, 0, 'null list → []');
});

test('spliceReorder: empty / single-element lists never reorder', () => {
  assert.deepEqual(spliceReorder([], 0, 0), []);
  const single = [{ id: 'a' }];
  assert.equal(spliceReorder(single, 0, 0), single);
  assert.equal(spliceReorder(single, 0, 1), single);
});

// --- pointer-driven drag → POST -------------------------------------

test('drag drop: pointer drag fires one POST with the reordered list', async () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
    { id: 's2', name: 'Two', art: '', note: '' },
    { id: 's3', name: 'Three', art: '', note: '' },
  ];
  const posts = [];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posts.push(body);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: body }) };
    }
    return new Promise(() => {});
  });
  const { fireDoc, restore: restoreDoc } = installDocEventDispatch();
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const rows = findRows(root);
    assert.equal(rows.length, 3, 'three rows rendered');
    stubRowRects(rows);

    // Pick up row 0 from its drag handle.
    const handle0 = findDragHandle(rows[0]);
    dispatch(handle0, 'pointerdown', {
      button: 0, pointerId: 1, clientX: 0, clientY: 20,
    });

    // Drag down past row 2's midline (row 2 mid = 100). pointerY = 110
    // sits past every row's midline → gap 3 (after the last row).
    fireDoc('pointermove', { pointerId: 1, clientX: 0, clientY: 110 });

    // Release → splice 0 into gap 3 → ['s2','s3','s1'].
    fireDoc('pointerup', { pointerId: 1, clientX: 0, clientY: 110 });

    // Optimistic state lands synchronously.
    const optimistic = store.state.speaker.favorites.map((e) => e.id);
    assert.deepEqual(optimistic, ['s2', 's3', 's1']);

    // POST fires asynchronously through replaceFavorites.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 1, 'exactly one POST per successful drop');
    assert.deepEqual(posts[0].map((e) => e.id), ['s2', 's3', 's1']);
  } finally {
    destroy();
    restore();
    restoreDoc();
  }
});

test('drag drop: drop into the middle splices correctly', async () => {
  store.state.speaker.favorites = [
    { id: 'a', name: 'A', art: '', note: '' },
    { id: 'b', name: 'B', art: '', note: '' },
    { id: 'c', name: 'C', art: '', note: '' },
    { id: 'd', name: 'D', art: '', note: '' },
  ];
  const posts = [];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return new Promise(() => {});
  });
  const { fireDoc, restore: restoreDoc } = installDocEventDispatch();
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const rows = findRows(root);
    stubRowRects(rows);

    // Pick up row 3 (d), drop between row 0 (a) and row 1 (b).
    // Row 1's midline is at y=60, so pointerY=50 sits "before row 1"
    // → gap 1. Splice 3→1 yields ['a','d','b','c'].
    const handle3 = findDragHandle(rows[3]);
    dispatch(handle3, 'pointerdown', {
      button: 0, pointerId: 2, clientX: 0, clientY: 140,
    });
    fireDoc('pointermove', { pointerId: 2, clientX: 0, clientY: 50 });
    fireDoc('pointerup',   { pointerId: 2, clientX: 0, clientY: 50 });

    assert.deepEqual(
      store.state.speaker.favorites.map((e) => e.id),
      ['a', 'd', 'b', 'c'],
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].map((e) => e.id), ['a', 'd', 'b', 'c']);
  } finally {
    destroy();
    restore();
    restoreDoc();
  }
});

// --- abort: no POST --------------------------------------------------

test('drag abort: pointercancel mid-drag fires no POST', async () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
    { id: 's2', name: 'Two', art: '', note: '' },
    { id: 's3', name: 'Three', art: '', note: '' },
  ];
  const posts = [];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return new Promise(() => {});
  });
  const { fireDoc, restore: restoreDoc } = installDocEventDispatch();
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const rows = findRows(root);
    stubRowRects(rows);

    const handle0 = findDragHandle(rows[0]);
    dispatch(handle0, 'pointerdown', {
      button: 0, pointerId: 3, clientX: 0, clientY: 20,
    });
    fireDoc('pointermove',   { pointerId: 3, clientX: 0, clientY: 110 });
    fireDoc('pointercancel', { pointerId: 3, clientX: 0, clientY: 110 });

    // State preserved — pointercancel must not rewrite.
    assert.deepEqual(
      store.state.speaker.favorites.map((e) => e.id),
      ['s1', 's2', 's3'],
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 0, 'no POST fires on pointercancel');
  } finally {
    destroy();
    restore();
    restoreDoc();
  }
});

test('drag abort: Escape mid-drag fires no POST', async () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
    { id: 's2', name: 'Two', art: '', note: '' },
    { id: 's3', name: 'Three', art: '', note: '' },
  ];
  const posts = [];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return new Promise(() => {});
  });
  const { fireDoc, restore: restoreDoc } = installDocEventDispatch();
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const rows = findRows(root);
    stubRowRects(rows);

    const handle0 = findDragHandle(rows[0]);
    dispatch(handle0, 'pointerdown', {
      button: 0, pointerId: 4, clientX: 0, clientY: 20,
    });
    fireDoc('pointermove', { pointerId: 4, clientX: 0, clientY: 110 });
    fireDoc('keydown',     { key: 'Escape' });

    assert.deepEqual(
      store.state.speaker.favorites.map((e) => e.id),
      ['s1', 's2', 's3'],
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 0, 'no POST fires on Escape');
  } finally {
    destroy();
    restore();
    restoreDoc();
  }
});

// --- mid-drag has no POST -------------------------------------------

test('drag in flight: pointermove without pointerup fires no POST', async () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
    { id: 's2', name: 'Two', art: '', note: '' },
  ];
  const posts = [];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return new Promise(() => {});
  });
  const { fireDoc, restore: restoreDoc } = installDocEventDispatch();
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const rows = findRows(root);
    stubRowRects(rows);

    const handle0 = findDragHandle(rows[0]);
    dispatch(handle0, 'pointerdown', {
      button: 0, pointerId: 5, clientX: 0, clientY: 20,
    });
    for (let y = 30; y < 80; y += 10) {
      fireDoc('pointermove', { pointerId: 5, clientX: 0, clientY: y });
    }
    // No pointerup. The state is still the original list.
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(
      store.state.speaker.favorites.map((e) => e.id),
      ['s1', 's2'],
    );
    assert.equal(posts.length, 0, 'no POST until release');
  } finally {
    destroy();
    restore();
    restoreDoc();
  }
});

// --- no-op drop ------------------------------------------------------

test('drag drop at source: no POST fires', async () => {
  store.state.speaker.favorites = [
    { id: 's1', name: 'One', art: '', note: '' },
    { id: 's2', name: 'Two', art: '', note: '' },
    { id: 's3', name: 'Three', art: '', note: '' },
  ];
  const posts = [];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return new Promise(() => {});
  });
  const { fireDoc, restore: restoreDoc } = installDocEventDispatch();
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const rows = findRows(root);
    stubRowRects(rows);

    // Pick up row 1, release at its own midline → gap 1 = source's own
    // gap. spliceReorder returns the original list reference; no POST.
    const handle1 = findDragHandle(rows[1]);
    dispatch(handle1, 'pointerdown', {
      button: 0, pointerId: 6, clientX: 0, clientY: 60,
    });
    fireDoc('pointermove', { pointerId: 6, clientX: 0, clientY: 50 });
    fireDoc('pointerup',   { pointerId: 6, clientX: 0, clientY: 50 });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 0, 'drop at source gap is a no-op');
    assert.deepEqual(
      store.state.speaker.favorites.map((e) => e.id),
      ['s1', 's2', 's3'],
    );
  } finally {
    destroy();
    restore();
    restoreDoc();
  }
});
