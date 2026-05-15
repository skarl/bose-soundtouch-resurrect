// favorites — #/favorites top-level tab.
//
// CRUD management surface. Each row carries always-on affordances:
//
//   [drag-handle]  [body — tap to play]  [pencil]  [trash]
//
// The row reuses the shared .station-row pill skin (#134) — same art
// size, name typography, and meta-line treatment as search/browse. The
// .station-row--crud modifier flips the layout to a 4-slot grid and
// adds the CRUD-specific affordances (drag-handle leading, pencil +
// trash trailing, inline edit form expansion below).
//
// Pencil expands the row vertically in place, exposing inputs for
// name / art / note plus Save & Cancel. Trash optimistically removes
// the row, fires POST immediately, and shows a 5-second toast with
// Undo; tapping Undo re-inserts the entry at its previous index and
// POSTs the restored list.
//
// Validation failures from the CGI surface as toasts; local state
// reverts to match the last-known-good response (via replaceFavorites
// snapshot rollback).
//
// Visibility refetch: the favourites array is fetched on app boot via
// reconcile() and again on every `visibilitychange → 'visible'` so a
// second tab that mutated the list flows back into this one.

import { html, mount, defineView } from '../dom.js';
import { stationArt } from '../components.js';
import { reconcileField } from '../speaker-state.js';
import { isPlayableSid } from '../tunein-sid.js';
import { icon } from '../icons.js';
import { playSid } from '../play-button.js';
import { showToast, showActionToast } from '../toast.js';
import {
  indexOfFavorite,
  withFavoriteRemoved,
  replaceFavorites,
} from '../favorites.js';
import { installFavoriteDrag } from './favorites-drag.js';

const UNDO_DWELL_MS = 5000;

function buildEmptyState() {
  const wrap = document.createElement('section');
  wrap.className = 'favorites-empty';
  const head = document.createElement('h2');
  head.textContent = 'No favourites yet';
  const body = document.createElement('p');
  body.textContent = 'Tap the heart on a station to add it here.';
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

// Build the body block — name + optional meta line. Mirrors the
// stationRow visual contract; the row root owns the click handler so
// the body is a layout span, not a button.
function buildBody({ entry }) {
  const body = document.createElement('span');
  body.className = 'station-row__body';

  const name = document.createElement('span');
  name.className = 'station-row__name';
  name.textContent = entry.name || entry.id;
  body.appendChild(name);

  if (entry.note) {
    const meta = document.createElement('span');
    meta.className = 'station-row__meta';
    const noteEl = document.createElement('span');
    noteEl.className = 'station-row__loc';
    noteEl.textContent = entry.note;
    meta.appendChild(noteEl);
    body.appendChild(meta);
  }

  return body;
}

// Build the inline edit form revealed under the row when the pencil
// is tapped. `seed` is the current entry; `onSave` receives a new
// entry object built from the form fields (id is preserved); `onCancel`
// tears the form down without writing.
function buildEditForm({ seed, onSave, onCancel }) {
  const form = document.createElement('form');
  form.className = 'station-row__edit';
  form.addEventListener('submit', (evt) => {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
  });
  // The row root owns the play click; any click inside the form (inputs,
  // labels) must not bubble up and trigger /play.
  form.addEventListener('click', (evt) => {
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
  });

  function fieldRow(labelText, inputType, value) {
    const wrap = document.createElement('label');
    wrap.className = 'station-row__edit-field';
    const lbl = document.createElement('span');
    lbl.className = 'station-row__edit-label';
    lbl.textContent = labelText;
    const input = document.createElement('input');
    input.type = inputType;
    input.className = 'station-row__edit-input';
    input.value = value || '';
    wrap.appendChild(lbl);
    wrap.appendChild(input);
    return { wrap, input };
  }

  const nameField = fieldRow('Name', 'text', seed.name);
  const artField  = fieldRow('Art URL', 'url',  seed.art);
  const noteField = fieldRow('Note', 'text', seed.note);

  form.appendChild(nameField.wrap);
  form.appendChild(artField.wrap);
  form.appendChild(noteField.wrap);

  const actions = document.createElement('div');
  actions.className = 'station-row__edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'station-row__edit-btn station-row__edit-btn--cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', (evt) => {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    onCancel();
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'station-row__edit-btn station-row__edit-btn--save';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', (evt) => {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    const nextName = String(nameField.input.value || '').trim();
    // Client-side validation: name is required. Falling back to the id
    // would silently swallow a "user cleared the name" edit; surface a
    // toast instead so the user can correct it.
    if (!nextName) {
      showToast('Name cannot be empty');
      return;
    }
    onSave({
      id:   seed.id,
      name: nextName,
      art:  String(artField.input.value  || '').trim(),
      note: String(noteField.input.value || '').trim(),
    });
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  form.appendChild(actions);

  return form;
}

function buildIconButton({ glyph, label, className, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.appendChild(icon(glyph, 18));
  btn.addEventListener('click', (evt) => {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
    onClick();
  });
  return btn;
}

// buildRow — one favourite entry rendered as the full management row.
// Returns { row, handle }; the caller hangs the row on the list and
// wires drag on the handle (drag plumbing needs the listEl + live
// store, both of which are owned at the buildList level).
function buildRow({ entry, store, onActivity }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'station-row station-row--crud';
  row.setAttribute('role', 'listitem');
  row.dataset.favId = entry.id;

  // [drag-handle] — wiring lives in views/favorites-drag.js and is
  // attached after the row joins the DOM (the controller needs the
  // list container as its parent).
  const handle = document.createElement('span');
  handle.className = 'station-row__drag';
  handle.setAttribute('aria-hidden', 'true');
  handle.appendChild(icon('drag-handle', 16));
  // A tap on the handle that doesn't escalate to a drag would otherwise
  // bubble to the row and fire /play. Block it.
  handle.addEventListener('click', (evt) => {
    if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
  });
  row.appendChild(handle);

  row.appendChild(stationArt({ url: entry.art || '', name: entry.name || entry.id, size: 40 }));

  // [body — name + optional meta]. The row itself is the play target.
  row.appendChild(buildBody({ entry }));

  // Body tap → play. Wire on the row root since the body is a layout
  // span (not a button) and the dom-shim doesn't bubble events.
  if (isPlayableSid(entry.id)) {
    row.setAttribute('aria-label', `Play ${entry.name || entry.id} on Bo`);
    row.addEventListener('click', (evt) => {
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      if (evt && typeof evt.stopPropagation === 'function') evt.stopPropagation();
      onActivity();
      playSid({ sid: entry.id, label: entry.name || entry.id });
    });
  } else {
    // Non-playable ids (shouldn't appear in favourites, but keep the
    // affordance honest) — render the row but disable the play action.
    row.disabled = true;
    row.classList.add('is-disabled');
  }

  // [pencil]
  let editForm = null;
  const pencil = buildIconButton({
    glyph: 'pencil',
    label: `Edit ${entry.name || entry.id}`,
    className: 'station-row__crud-edit',
    onClick: () => {
      onActivity();
      if (editForm) {
        // Toggle closes if pencil is tapped twice. Symmetric with
        // Cancel; either path lands on "no expanded row".
        editForm.remove();
        editForm = null;
        row.classList.remove('is-expanded');
        return;
      }
      editForm = buildEditForm({
        seed: entry,
        onSave: (next) => {
          const list = (store.state.speaker && store.state.speaker.favorites) || [];
          const idx = indexOfFavorite(list, entry.id);
          if (idx < 0) {
            // Edit raced with an external mutation that dropped the
            // entry. Tear the form down rather than silently re-adding.
            if (editForm) editForm.remove();
            editForm = null;
            row.classList.remove('is-expanded');
            return;
          }
          const prev = list.slice();
          const nextList = prev.slice();
          nextList[idx] = {
            id:   next.id,
            name: next.name,
            art:  next.art,
            note: next.note,
          };
          if (editForm) editForm.remove();
          editForm = null;
          row.classList.remove('is-expanded');
          replaceFavorites(store, nextList, prev, "Couldn't save favourite");
        },
        onCancel: () => {
          if (editForm) editForm.remove();
          editForm = null;
          row.classList.remove('is-expanded');
        },
      });
      row.classList.add('is-expanded');
      row.appendChild(editForm);
    },
  });
  row.appendChild(pencil);

  // [trash]
  const trash = buildIconButton({
    glyph: 'trash',
    label: `Delete ${entry.name || entry.id}`,
    className: 'station-row__crud-delete',
    onClick: () => {
      onActivity();
      const list = (store.state.speaker && store.state.speaker.favorites) || [];
      const idx = indexOfFavorite(list, entry.id);
      if (idx < 0) return;
      const prev = list.slice();
      // Drop the entry locally + POST immediately. The toast offers
      // Undo for 5 s; on timeout the deletion is permanent.
      const afterRemove = withFavoriteRemoved(prev, entry.id);
      replaceFavorites(store, afterRemove, prev, "Couldn't delete favourite");

      const undoToast = showActionToast({
        message: `Removed ${entry.name || entry.id}`,
        actionLabel: 'Undo',
        dwellMs: UNDO_DWELL_MS,
        onAction: () => {
          // Re-insert at the previous index; POST the restored list.
          const cur = (store.state.speaker && store.state.speaker.favorites) || [];
          const restoredPrev = cur.slice();
          // Defensive: if the entry got re-added in the meantime, skip.
          if (indexOfFavorite(cur, entry.id) >= 0) return;
          const restored = cur.slice();
          const insertAt = Math.min(idx, restored.length);
          restored.splice(insertAt, 0, prev[idx]);
          replaceFavorites(store, restored, restoredPrev, "Couldn't restore favourite");
        },
      });
      // Track the in-flight toast so any other user action collapses
      // it early (the contract per #127). The mount-level activity
      // hook does the dismissal.
      onActivity.registerToast(undoToast);
    },
  });
  row.appendChild(trash);

  return { row, handle };
}

function buildList({ entries, store, onActivity, onCleanup }) {
  const list = document.createElement('div');
  list.className = 'favorites-list';
  list.setAttribute('role', 'list');
  const built = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    const { row, handle } = buildRow({ entry, store, onActivity });
    list.appendChild(row);
    built.push({ entry, row, handle });
  }

  // Drag wiring (#128). Hung on each handle after the row joins the
  // list so the controller can re-parent its ghost / indicator inside
  // the live container. `getFromIdx` resolves the source index on
  // pointerdown so a between-renders mutation doesn't desync.
  for (const item of built) {
    installFavoriteDrag({
      handle: item.handle,
      row: item.row,
      listEl: list,
      getList: () => {
        const cur = store.state.speaker && store.state.speaker.favorites;
        return Array.isArray(cur) ? cur : [];
      },
      getFromIdx: () => {
        const cur = store.state.speaker && store.state.speaker.favorites;
        return indexOfFavorite(Array.isArray(cur) ? cur : [], item.entry.id);
      },
      onDrop: (next, prev) => {
        onActivity();
        replaceFavorites(store, next, prev, "Couldn't reorder favourite");
      },
      onCleanup,
    });
  }
  return list;
}

// Deep-link focus (#129). The Now-Playing favourites grid sets
// `#/favorites?focus=<id>` on long-press; the router decodes the query
// string and passes it through `ctx.query`. We honour it once at mount
// (and once after the initial render lands data) by scrolling the
// matching row into view and applying `.is-focused` for a brief flash.
const FOCUS_FLASH_MS = 1600;

function applyFocus(body, focusId) {
  if (!body || typeof focusId !== 'string' || !focusId) return false;
  const rows = body.querySelectorAll('.station-row--crud');
  for (const row of rows) {
    const favId = row.dataset && row.dataset.favId;
    if (favId !== focusId) continue;
    row.classList.add('is-focused');
    if (typeof row.scrollIntoView === 'function') {
      try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (_err) { /* JSDOM / xmldom — no-op */ }
    }
    setTimeout(() => row.classList.remove('is-focused'), FOCUS_FLASH_MS);
    return true;
  }
  return false;
}

export default defineView({
  mount(root, store, ctx, env) {
    mount(root, html`
      <section class="favorites" data-view="favorites">
        <div class="page-title-bar">
          <h1 class="page-title">Favourites</h1>
        </div>
        <div class="favorites-body"></div>
      </section>
    `);
    const body = root.querySelector('.favorites-body');

    // Activity hook: tracks the most recent action-toast so any other
    // user-initiated action collapses it early. An in-flight Undo toast
    // survives only until the next interaction.
    let inflightToast = null;
    function onActivity() {
      const t = inflightToast;
      inflightToast = null;
      if (t && typeof t.dismiss === 'function') t.dismiss('early');
    }
    onActivity.registerToast = (toast) => { inflightToast = toast; };

    // Deep-link target id, taken from `?focus=<id>` and honoured once
    // after the first render that contains a matching row. Cleared after
    // a successful match so subsequent re-renders don't keep re-flashing.
    let pendingFocusId = ctx && ctx.query && typeof ctx.query.focus === 'string'
      ? ctx.query.focus
      : '';

    function render() {
      const list = (store.state.speaker && store.state.speaker.favorites) || null;
      // null = unfetched. Show the empty state immediately so a slow
      // GET doesn't leave the body blank; reconcile-on-mount will land
      // shortly and re-render with the real list.
      const entries = Array.isArray(list) ? list : [];
      if (!body) return;
      if (entries.length === 0) {
        body.replaceChildren(buildEmptyState());
      } else {
        body.replaceChildren(buildList({
          entries, store, onActivity,
          onCleanup: env.onCleanup,
        }));
        if (pendingFocusId && applyFocus(body, pendingFocusId)) {
          pendingFocusId = '';
        }
      }
    }

    render();

    // Fetch on mount if we haven't yet (speaker-state's reconcile fires
    // at boot, but a deep-link to #/favorites before reconcile lands
    // shouldn't show a phantom empty state any longer than necessary).
    if (!Array.isArray(store.state.speaker.favorites)) {
      reconcileField(store, 'favorites').catch(() => { /* surfaced via store subscription */ });
    }

    // Visibility refetch — mirrors the now-playing pattern. Detaches
    // via env.onCleanup so we don't leak across route transitions.
    function onVisibilityChange() {
      if (typeof document === 'undefined') return;
      if (document.hidden) return;
      reconcileField(store, 'favorites').catch(() => {});
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      env.onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    }

    return {
      speaker() { render(); },
    };
  },
});
