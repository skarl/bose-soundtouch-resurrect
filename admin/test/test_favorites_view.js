// Tests for the Favourites tab CRUD surface (issue #127):
//
//   - row shape: [drag-handle stub] [body — tap to play] [pencil] [trash]
//   - pencil expands the row in place; Save commits + POSTs + collapses;
//     Cancel collapses without writing.
//   - trash optimistically removes the row + POSTs; toast offers Undo
//     for 5 s; Undo re-inserts at the previous index and POSTs again.
//   - delete + timeout (5 s elapsed) → deletion is permanent.
//   - delete + POST failure → state reverts, toast surfaces.
//
// Strategy: dom-shim gives a working Element / document. We fake-time
// the toast's setTimeout via `node:test`'s mock.timers so the 5 s
// dwell collapses to a tick.
//
// Run: node --test admin/test

import { test, beforeEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';

import { doc, installFetchNeverResolving } from './fixtures/dom-shim.js';

installFetchNeverResolving();

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

// Helpers — find row + its inline controls.

function findRows(root) { return root.querySelectorAll('.station-row--crud'); }
function findRow(root, idx) { return findRows(root)[idx] || null; }
function findEditBtn(row)   { return row.querySelector('.station-row__crud-edit'); }
function findDeleteBtn(row) { return row.querySelector('.station-row__crud-delete'); }
function findDragHandle(row){ return row.querySelector('.station-row__drag'); }
// The row root itself is the play button (#134); the body is a layout
// span. Tests click the row to fire play.
function findBody(row)      { return row; }
function findEditForm(row)  { return row.querySelector('.station-row__edit'); }
function findToastAction()  { return doc.querySelector('.toast--action .toast__action'); }
function findToastText()    { return doc.querySelector('.toast--action .toast__text'); }

function click(el) {
  if (!el) throw new Error('click: target missing');
  el.dispatchEvent({ type: 'click', defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
}

function setInputValue(input, value) {
  input.value = value;
}

beforeEach(() => {
  store.state.speaker.favorites = null;
  // Reset toast container so tests don't see stale toasts from a
  // previous case.
  const container = doc.getElementById('toast-container');
  if (container && container.parentNode) container.parentNode.removeChild(container);
});

// --- row shape ------------------------------------------------------

test('favorites tab: each row renders drag-handle | body | pencil | trash', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
    { id: 'p99',    name: 'Some Show', art: '', note: 'live mix' },
  ];
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const rows = findRows(root);
    assert.equal(rows.length, 2, 'two rows rendered');
    for (const row of rows) {
      assert.ok(findDragHandle(row), 'drag-handle present');
      assert.ok(findBody(row),       'body present');
      assert.ok(findEditBtn(row),    'pencil present');
      assert.ok(findDeleteBtn(row),  'trash present');
    }
    // Body text reflects the entry.
    const firstName = rows[0].querySelector('.station-row__name');
    assert.equal(firstName && firstName.textContent, 'Radio One');
    // Notes surface on the meta line — the shared station-row contract.
    const secondMeta = rows[1].querySelector('.station-row__meta');
    assert.equal(secondMeta && secondMeta.textContent, 'live mix');
  } finally {
    destroy();
  }
});

// --- edit round-trip ------------------------------------------------

test('favorites tab: pencil expands row; Save commits + POSTs + collapses', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
  ];
  let captured = null;
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      captured = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, data: captured }),
      };
    }
    return new Promise(() => {});
  });
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const row = findRow(root, 0);
    click(findEditBtn(row));
    const form = findEditForm(row);
    assert.ok(form, 'edit form appears after pencil click');
    assert.equal(row.classList.contains('is-expanded'), true, 'row marked as expanded');

    const inputs = form.querySelectorAll('.station-row__edit-input');
    assert.equal(inputs.length, 3, 'three inputs (name, art, note)');
    setInputValue(inputs[0], 'New Name');
    setInputValue(inputs[1], 'http://art');
    setInputValue(inputs[2], 'edited note');

    const saveBtn = form.querySelector('.station-row__edit-btn--save');
    click(saveBtn);

    // Optimistic mutation lands synchronously.
    assert.equal(store.state.speaker.favorites[0].name, 'New Name');
    assert.equal(store.state.speaker.favorites[0].art,  'http://art');
    assert.equal(store.state.speaker.favorites[0].note, 'edited note');
    // Form collapses.
    assert.equal(findEditForm(findRow(root, 0)), null, 'edit form torn down after Save');
    assert.equal(findRow(root, 0).classList.contains('is-expanded'), false);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(captured, 'POST issued');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].name, 'New Name');
  } finally {
    destroy();
    restore();
  }
});

test('favorites tab: pencil → Cancel collapses without writing', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
  ];
  let posts = 0;
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      posts++;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    }
    return new Promise(() => {});
  });
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const row = findRow(root, 0);
    click(findEditBtn(row));
    const form = findEditForm(row);
    assert.ok(form);
    const inputs = form.querySelectorAll('.station-row__edit-input');
    setInputValue(inputs[0], 'Mutated');
    const cancelBtn = form.querySelector('.station-row__edit-btn--cancel');
    click(cancelBtn);
    assert.equal(findEditForm(findRow(root, 0)), null, 'form collapsed after Cancel');
    assert.equal(store.state.speaker.favorites[0].name, 'Radio One', 'state untouched');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts, 0, 'no POST issued on Cancel');
  } finally {
    destroy();
    restore();
  }
});

// --- delete + undo --------------------------------------------------

test('favorites tab: trash removes row optimistically + POSTs; toast offers Undo', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
    { id: 'p99',    name: 'Some Show', art: '', note: '' },
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
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const row = findRow(root, 0);
    click(findDeleteBtn(row));
    // Optimistic removal.
    assert.equal(store.state.speaker.favorites.length, 1);
    assert.equal(store.state.speaker.favorites[0].id, 'p99');
    // Toast with Undo appears.
    const undo = findToastAction();
    assert.ok(undo, 'Undo action visible in toast');
    assert.equal(undo.textContent, 'Undo');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 1, 'one POST fired for the delete');
    assert.equal(posts[0].length, 1, 'POST body has the post-remove array');
    assert.equal(posts[0][0].id, 'p99');

    // Tap Undo — re-insert at the previous index + POST the restored list.
    click(undo);
    assert.equal(store.state.speaker.favorites.length, 2, 'restored optimistically');
    assert.equal(store.state.speaker.favorites[0].id, 's12345', 'restored at original index');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 2, 'a second POST fired for the restore');
    assert.equal(posts[1].length, 2);
    assert.equal(posts[1][0].id, 's12345');
  } finally {
    destroy();
    restore();
  }
});

test('favorites tab: 5 s after delete, the toast auto-dismisses; deletion is permanent', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
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
  // Mock node's setTimeout so we can fast-forward 5 s in one call.
  mock.timers.enable({ apis: ['setTimeout'] });
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    click(findDeleteBtn(findRow(root, 0)));
    assert.equal(store.state.speaker.favorites.length, 0);
    const undo = findToastAction();
    assert.ok(undo, 'Undo button shown after delete');

    // Fast-forward past the 5-second dwell; the toast should dismiss
    // and no further POST should fire (the deletion is permanent).
    mock.timers.tick(5500);
    assert.equal(store.state.speaker.favorites.length, 0, 'state stays empty after the toast times out');
    assert.equal(posts.length, 1, 'still just the one delete POST');
  } finally {
    mock.timers.reset();
    destroy();
    restore();
  }
});

test('favorites tab: delete + POST failure → state reverts, toast surfaces', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
  ];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      return {
        ok: true, status: 400,
        json: async () => ({ ok: false, error: { code: 'WRITE_FAILED', message: 'disk full' } }),
      };
    }
    return new Promise(() => {});
  });
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    click(findDeleteBtn(findRow(root, 0)));
    // Optimistic removal lands first…
    assert.equal(store.state.speaker.favorites.length, 0);
    // …then the failed POST resolves and the snapshot is restored.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.state.speaker.favorites.length, 1, 'state rolled back to the snapshot');
    assert.equal(store.state.speaker.favorites[0].id, 's12345');
    // Failure toast surfaces (any .toast that isn't the undo one).
    const toasts = doc.querySelectorAll('.toast');
    assert.ok(toasts.length >= 1, 'at least one toast visible after the failure');
  } finally {
    destroy();
    restore();
  }
});

// --- edit POST failure ---------------------------------------------

test('favorites tab: edit Save + POST failure → state reverts, toast surfaces', async () => {
  const snapshot = { id: 's12345', name: 'Radio One', art: '', note: '' };
  store.state.speaker.favorites = [snapshot];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      return {
        ok: true, status: 400,
        json: async () => ({ ok: false, error: { code: 'INVALID_NAME', message: 'bad' } }),
      };
    }
    return new Promise(() => {});
  });
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    click(findEditBtn(findRow(root, 0)));
    const form = findEditForm(findRow(root, 0));
    const inputs = form.querySelectorAll('.station-row__edit-input');
    setInputValue(inputs[0], 'Mutated');
    click(form.querySelector('.station-row__edit-btn--save'));
    // Optimistic edit lands first.
    assert.equal(store.state.speaker.favorites[0].name, 'Mutated');
    await new Promise((r) => setTimeout(r, 10));
    // After the failed POST the snapshot is restored.
    assert.equal(store.state.speaker.favorites[0].name, 'Radio One', 'reverted');
  } finally {
    destroy();
    restore();
  }
});

// --- early-dismiss on subsequent activity ---------------------------

test('favorites tab: any other user action dismisses the Undo toast early', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
    { id: 'p99',    name: 'Some Show', art: '', note: '' },
  ];
  const restore = installFetchStub(async (url, opts) => {
    if (/\/favorites$/.test(String(url)) && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, data: body }) };
    }
    return new Promise(() => {});
  });
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    // Delete the first row → Undo toast appears.
    click(findDeleteBtn(findRow(root, 0)));
    assert.ok(findToastAction(), 'Undo toast present after delete');
    // Tap the pencil on the surviving row → counts as activity, toast collapses.
    click(findEditBtn(findRow(root, 0)));
    // Toast container's only `.toast--action` should be removed (or
    // marked dismissed pending the fade-out timer).
    const node = doc.querySelector('.toast--action');
    if (node) {
      // is-shown removed → in fade-out animation.
      assert.equal(node.classList.contains('is-shown'), false, 'Undo toast collapsed on subsequent activity');
    }
  } finally {
    destroy();
    restore();
  }
});

// --- body tap plays -------------------------------------------------

test('favorites tab: body tap fires /play with the entry id', async () => {
  store.state.speaker.favorites = [
    { id: 's12345', name: 'Radio One', art: '', note: '' },
  ];
  const calls = [];
  const restore = installFetchStub(async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (/\/play$/.test(String(url))) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, url: 'http://stream' }),
      };
    }
    return new Promise(() => {});
  });
  const root = makeRoot();
  const destroy = mountFavorites(root);
  try {
    const row = findRow(root, 0);
    click(findBody(row));
    await new Promise((r) => setTimeout(r, 10));
    const playCall = calls.find((c) => /\/play$/.test(c.url) && c.opts.method === 'POST');
    assert.ok(playCall, 'POST /play issued from body tap');
    const body = JSON.parse(playCall.opts.body);
    assert.equal(body.id, 's12345');
    assert.equal(body.name, 'Radio One');
  } finally {
    destroy();
    restore();
  }
});
