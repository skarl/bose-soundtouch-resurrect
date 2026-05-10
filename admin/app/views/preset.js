// preset — #/preset/N modal overlay for reassigning a preset slot.
//
// Renders a full-screen modal (on mobile) / centred dialog (desktop)
// over the now-playing view. Body hosts either the search view or the
// browse view; the user switches between them via a tab-style button.
// On station pick the existing presetsAssign() POST is called; success
// closes the modal via history.back().
//
// See admin/PLAN.md § Routing (#/preset/N).

import { defineView, mountChild } from '../dom.js';
import { store } from '../state.js';
import { showToast } from '../toast.js';
import { probe, assignToPreset } from '../probe.js';
import searchView from './search.js';
import browseView from './browse.js';

async function doAssign(slot, sid, name) {
  let p;
  try { p = await probe(sid); }
  catch (err) { showToast(`Assign failed: ${err.message || 'probe error'}`); return; }
  let envelope;
  try { envelope = await assignToPreset(p, slot, { name, art: '' }); }
  catch (err) { showToast(`Assign failed: ${err.message || 'transport error'}`); return; }
  if (envelope.ok) { showToast(`Saved to preset ${slot}`); location.hash = '#/'; }
  else        { showToast(`Assign failed (${envelope.error?.code || 'unknown'})`); }
}

export default defineView({
  mount(root, _store, ctx, env) {
    const slotParam = ctx && ctx.params && ctx.params.slot;
    const slot = Number(slotParam);
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
      location.replace('#/');
      return {};
    }

    store.state.ui.presetModal = { slot, returnTo: '#/' };

    const backdrop = document.createElement('div');
    backdrop.className = 'preset-modal-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'preset-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `Replace preset ${slot}`);

    const header = document.createElement('div');
    header.className = 'preset-modal-header';

    const title = document.createElement('h2');
    title.className = 'preset-modal-title';
    title.textContent = `Replace preset ${slot}`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'preset-modal-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => { location.hash = '#/'; });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const tabs = document.createElement('div');
    tabs.className = 'preset-modal-tabs';

    const switchSearchBtn = document.createElement('button');
    switchSearchBtn.type = 'button';
    switchSearchBtn.className = 'preset-modal-tab';
    switchSearchBtn.textContent = 'Search';
    switchSearchBtn.dataset.active = 'true';

    const switchBrowseBtn = document.createElement('button');
    switchBrowseBtn.type = 'button';
    switchBrowseBtn.className = 'preset-modal-tab';
    switchBrowseBtn.textContent = 'Browse';
    switchBrowseBtn.dataset.active = 'false';

    tabs.appendChild(switchSearchBtn);
    tabs.appendChild(switchBrowseBtn);

    const body = document.createElement('div');
    body.className = 'preset-modal-body';

    const paneSearch = document.createElement('div');
    paneSearch.className = 'preset-modal-pane';
    paneSearch.hidden = false;

    const paneBrowse = document.createElement('div');
    paneBrowse.className = 'preset-modal-pane';
    paneBrowse.hidden = true;

    body.appendChild(paneSearch);
    body.appendChild(paneBrowse);

    dialog.appendChild(header);
    dialog.appendChild(tabs);
    dialog.appendChild(body);
    backdrop.appendChild(dialog);

    root.replaceChildren(backdrop);

    function showPane(which) {
      paneSearch.hidden = which !== 'search';
      paneBrowse.hidden = which !== 'browse';
      switchSearchBtn.dataset.active = which === 'search' ? 'true' : 'false';
      switchBrowseBtn.dataset.active = which === 'browse' ? 'true' : 'false';
      if (which === 'search') {
        const input = paneSearch.querySelector('input[type="search"]');
        if (input) input.focus();
      }
    }
    switchSearchBtn.addEventListener('click', () => showPane('search'));
    switchBrowseBtn.addEventListener('click', () => showPane('browse'));

    mountChild(paneSearch, searchView, _store, {}, env);
    mountChild(paneBrowse, browseView, _store, {}, env);

    // Intercept clicks on station-cards inside the modal body. Cards are
    // <a href="#/station/sNNN"> elements; we prevent navigation and
    // assign the station to the active slot instead.
    function interceptCardClick(evt) {
      const card = evt.target.closest('.station-card[data-sid]');
      if (!card) return;
      evt.preventDefault();
      evt.stopPropagation();
      const sid = card.dataset.sid;
      if (!sid) return;
      doAssign(slot, sid, card.querySelector('.station-card__name')?.textContent || sid);
    }
    paneSearch.addEventListener('click', interceptCardClick, true);
    paneBrowse.addEventListener('click', interceptCardClick, true);
    env.onCleanup(() => {
      paneSearch.removeEventListener('click', interceptCardClick, true);
      paneBrowse.removeEventListener('click', interceptCardClick, true);
    });

    const searchInput = paneSearch.querySelector('input[type="search"]');
    if (searchInput) searchInput.focus();

    backdrop.addEventListener('click', (evt) => {
      if (evt.target === backdrop) location.hash = '#/';
    });

    const onKeydown = (evt) => {
      if (evt.key === 'Escape') location.hash = '#/';
    };
    document.addEventListener('keydown', onKeydown);
    env.onCleanup(() => document.removeEventListener('keydown', onKeydown));

    return {};
  },
});
