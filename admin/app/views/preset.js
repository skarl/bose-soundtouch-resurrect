// preset — #/preset/N modal overlay for reassigning a preset slot.
//
// Renders a full-screen modal (on mobile) / centred dialog (desktop)
// over the now-playing view. Body hosts either the search view or the
// browse view; the user switches between them via a tab-style button.
// On station pick the existing presetsAssign() POST is called; success
// closes the modal via history.back().
//
// See admin/PLAN.md § Routing (#/preset/N).

import { store } from '../state.js';
import { presetsAssign, presetsList, tuneinProbe } from '../api.js';
import { showToast } from '../toast.js';
import { classify, reshape } from '../reshape.js';
import searchView from './search.js';
import browseView from './browse.js';

// Which pane is showing inside the modal body.
let activePane = 'search';  // 'search' | 'browse'

// The slot number this modal is operating on (1-6).
let activeSlot = 0;

// The sub-root elements for each pane.
let searchRoot = null;
let browseRoot = null;
let paneSearch = null;
let paneBrowse = null;
let switchBrowseBtn = null;
let switchSearchBtn = null;

// Station-card click intercept — we hijack navigation before it fires
// so we can do the assign instead of routing to #/station/sNNN.
let cardClickHandler = null;

function teardown() {
  if (cardClickHandler && searchRoot) {
    searchRoot.removeEventListener('click', cardClickHandler, true);
  }
  if (cardClickHandler && browseRoot) {
    browseRoot.removeEventListener('click', cardClickHandler, true);
  }
  cardClickHandler = null;
  searchRoot = null;
  browseRoot = null;
  paneSearch = null;
  paneBrowse = null;
  switchBrowseBtn = null;
  switchSearchBtn = null;
  activeSlot = 0;
  activePane = 'search';
}

function showPane(which) {
  activePane = which;
  paneSearch.hidden = which !== 'search';
  paneBrowse.hidden = which !== 'browse';
  if (switchSearchBtn) switchSearchBtn.dataset.active = which === 'search' ? 'true' : 'false';
  if (switchBrowseBtn) switchBrowseBtn.dataset.active = which === 'browse' ? 'true' : 'false';
  if (which === 'search' && searchRoot) {
    const input = searchRoot.querySelector('input[type="search"]');
    if (input) input.focus();
  }
}

// Intercept clicks on station-cards inside the modal body. Station cards
// are <a href="#/station/sNNN"> elements. We prevent navigation and
// instead attempt to assign the station to the active slot.
function buildCardClickHandler(slot) {
  return function interceptCardClick(evt) {
    const card = evt.target.closest('.station-card[data-sid]');
    if (!card) return;
    evt.preventDefault();
    evt.stopPropagation();
    const sid = card.dataset.sid;
    if (!sid) return;
    doAssign(slot, sid, card.querySelector('.station-card__name')?.textContent || sid);
  };
}

async function doAssign(slot, sid, stationName) {
  // Probe the station so we can reshape() a Bose payload — same path
  // the station detail view uses.
  const probeCache = store.state.caches.probe;
  let cachedVerdict = probeCache && probeCache.get ? probeCache.get(sid) : null;
  if (cachedVerdict && typeof cachedVerdict.expires === 'number' && cachedVerdict.expires <= Date.now()) {
    probeCache.delete(sid);
    cachedVerdict = null;
  }

  let tuneinJson = cachedVerdict ? cachedVerdict.tuneinJson : null;
  let verdict = cachedVerdict || null;

  if (!tuneinJson) {
    showToast('Probing stream…');
    try {
      tuneinJson = await tuneinProbe(sid);
      verdict = classify(tuneinJson);
    } catch (err) {
      showToast(`Assign failed: ${err.message || 'probe error'}`);
      return;
    }
  }

  if (!verdict || verdict.kind !== 'playable') {
    showToast('This station is not playable — pick another.');
    return;
  }

  const bose = reshape(tuneinJson, sid, stationName);
  if (!bose) {
    showToast(`Cannot assign: no playable streams for ${sid}`);
    return;
  }

  let envelope;
  try {
    envelope = await presetsAssign(slot, {
      id:   sid,
      slot,
      name: stationName,
      art:  '',
      kind: 'playable',
      json: bose,
    });
  } catch (err) {
    showToast(`Assign failed: ${err.message || 'transport error'}`);
    return;
  }

  if (envelope && envelope.ok && Array.isArray(envelope.data)) {
    store.update('speaker', (s) => { s.speaker.presets = envelope.data; });
    showToast(`Saved to preset ${slot}`);
    // Close the modal via history.
    location.hash = '#/';
    return;
  }

  const errObj = (envelope && envelope.error) || { code: 'UNKNOWN' };
  const detail = errObj.message ? `${errObj.code}: ${errObj.message}` : errObj.code;
  showToast(`Assign failed (${detail})`);
  presetsList().then((env) => {
    if (env && env.ok && Array.isArray(env.data)) {
      store.update('speaker', (s) => { s.speaker.presets = env.data; });
    }
  }).catch(() => {});
}

export default {
  init(root, _store, ctx) {
    teardown();

    const slotParam = ctx && ctx.params && ctx.params.slot;
    const slot = Number(slotParam);
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) {
      location.replace('#/');
      return;
    }

    activeSlot = slot;
    store.state.ui.presetModal = { slot, returnTo: '#/' };

    // Build backdrop + dialog shell.
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

    // Pane switcher tabs.
    const tabs = document.createElement('div');
    tabs.className = 'preset-modal-tabs';

    switchSearchBtn = document.createElement('button');
    switchSearchBtn.type = 'button';
    switchSearchBtn.className = 'preset-modal-tab';
    switchSearchBtn.textContent = 'Search';
    switchSearchBtn.dataset.active = 'true';
    switchSearchBtn.addEventListener('click', () => showPane('search'));

    switchBrowseBtn = document.createElement('button');
    switchBrowseBtn.type = 'button';
    switchBrowseBtn.className = 'preset-modal-tab';
    switchBrowseBtn.textContent = 'Browse';
    switchBrowseBtn.dataset.active = 'false';
    switchBrowseBtn.addEventListener('click', () => showPane('browse'));

    tabs.appendChild(switchSearchBtn);
    tabs.appendChild(switchBrowseBtn);

    // Body holds two sub-containers — only one visible at a time.
    const body = document.createElement('div');
    body.className = 'preset-modal-body';

    paneSearch = document.createElement('div');
    paneSearch.className = 'preset-modal-pane';
    paneSearch.hidden = false;

    paneBrowse = document.createElement('div');
    paneBrowse.className = 'preset-modal-pane';
    paneBrowse.hidden = true;

    body.appendChild(paneSearch);
    body.appendChild(paneBrowse);

    dialog.appendChild(header);
    dialog.appendChild(tabs);
    dialog.appendChild(body);
    backdrop.appendChild(dialog);

    root.replaceChildren(backdrop);

    // Mount search and browse sub-views into their panes.
    searchRoot = paneSearch;
    browseRoot = paneBrowse;
    searchView.init(searchRoot, _store, {});
    browseView.init(browseRoot, _store, {});

    // Install the card-click interceptor on both panes (capture phase so
    // it fires before the anchor's default navigation).
    cardClickHandler = buildCardClickHandler(slot);
    searchRoot.addEventListener('click', cardClickHandler, true);
    browseRoot.addEventListener('click', cardClickHandler, true);

    // Focus the search input.
    const searchInput = searchRoot.querySelector('input[type="search"]');
    if (searchInput) searchInput.focus();

    // Dismiss on backdrop click (click outside the dialog).
    backdrop.addEventListener('click', (evt) => {
      if (evt.target === backdrop) location.hash = '#/';
    });

    // Dismiss on Escape.
    const onKeydown = (evt) => {
      if (evt.key === 'Escape') {
        document.removeEventListener('keydown', onKeydown);
        location.hash = '#/';
      }
    };
    document.addEventListener('keydown', onKeydown);
  },

  update() {
    // The modal itself has no store subscription — assign success
    // closes the route via location.hash, and the now-playing view
    // picks up presets from its existing 'speaker' subscription.
  },

  _teardown() {
    teardown();
  },
};
