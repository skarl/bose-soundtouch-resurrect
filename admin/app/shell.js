// Four-zone app shell: header / body / mini player / tab bar.
// Owns the WS-aware status pill, the activeTab routing rule, and the
// mini-player visibility rule. Mounts once from main.js after store init.
//
// The mobile/desktop layout swap is pure CSS via @container — no JS
// ResizeObserver. The data-vp="mobile" attribute on .shell is static
// and informational; selectors target the container query directly.

import { pill } from './components.js';
import { icon } from './icons.js';
import { setArt } from './art.js';
import * as actions from './actions/index.js';
import * as theme from './theme.js';

// --- pill state computation ----------------------------------------

// WS-degraded states win over playback states. Returns a tone+text
// pair that the header pill renders verbatim. Pure — no DOM.
const WS_DEGRADED_STATES = {
  connecting:   { tone: 'warn',   text: 'connecting' },
  offline:      { tone: 'danger', text: 'offline' },
  reconnecting: { tone: 'warn',   text: 'reconnecting' },
  polling:      { tone: 'ok',     text: 'polling' },
};

export function computePillState(state) {
  const mode = (state && state.ws && state.ws.mode) || 'offline';
  if (mode !== 'ws') return WS_DEGRADED_STATES[mode] || WS_DEGRADED_STATES.offline;

  const np = state && state.speaker && state.speaker.nowPlaying;
  if (np && np.source === 'STANDBY') return { tone: 'ok',   text: 'standby' };
  if (np && np.playStatus === 'PLAY_STATE') return { tone: 'live', text: 'live' };
  return { tone: 'ok', text: 'paused' };
}

// --- activeTab routing rule ----------------------------------------

const TOP_LEVEL_TABS = {
  '/':         'now',
  '/search':   'search',
  '/browse':   'browse',
  '/settings': 'settings',
};

export function tabForPath(path) {
  if (Object.prototype.hasOwnProperty.call(TOP_LEVEL_TABS, path)) return TOP_LEVEL_TABS[path];
  return null;
}

function pathFromHash(hash) {
  return ((hash || '').replace(/^#/, '') || '/').split('?')[0] || '/';
}

// --- mini player visibility ----------------------------------------

const MINI_HIDDEN_PATHS = /^\/$|^\/preset\//;

export function shouldShowMini(state, hash) {
  const path = pathFromHash(hash);
  if (MINI_HIDDEN_PATHS.test(path)) return false;
  const mode = state && state.ws && state.ws.mode;
  if (mode === 'offline') return false;
  return true;
}

// --- DOM helpers ---------------------------------------------------

function tabButton(tab, label, iconName) {
  const a = document.createElement('a');
  a.className = 'shell-tab';
  a.href = `#${tab === 'now' ? '/' : '/' + tab}`;
  a.dataset.tab = tab;
  a.setAttribute('role', 'tab');
  a.setAttribute('aria-label', label);

  const ic = document.createElement('span');
  ic.className = 'shell-tab__icon';
  ic.appendChild(icon(iconName, 22));

  const lab = document.createElement('span');
  lab.className = 'shell-tab__label';
  lab.textContent = label;

  a.appendChild(ic);
  a.appendChild(lab);
  return a;
}

const TAB_DEFS = [
  { tab: 'now',      label: 'Now',      icon: 'play' },
  { tab: 'search',   label: 'Search',   icon: 'search' },
  { tab: 'browse',   label: 'Browse',   icon: 'list' },
  { tab: 'settings', label: 'Settings', icon: 'settings' },
];

function renderRail(railEl, store) {
  if (!railEl) return;

  const card = document.createElement('div');
  card.className = 'shell-rail__card';

  const nameLine = document.createElement('div');
  nameLine.className = 'shell-rail__name';
  const subLine = document.createElement('div');
  subLine.className = 'shell-rail__sub';

  const initial = computePillState(store.state);
  const pillEl = pill({ tone: initial.tone, text: initial.text, pulse: initial.tone === 'live' });
  pillEl.classList.add('shell-rail__pill');

  card.appendChild(nameLine);
  card.appendChild(subLine);
  card.appendChild(pillEl);

  const nav = document.createElement('nav');
  nav.className = 'shell-rail__nav';
  nav.setAttribute('role', 'tablist');

  const railTabs = TAB_DEFS.map((d) => {
    const a = document.createElement('a');
    a.className = 'shell-rail__item';
    a.href = `#${d.tab === 'now' ? '/' : '/' + d.tab}`;
    a.dataset.tab = d.tab;
    a.setAttribute('role', 'tab');

    const ic = document.createElement('span');
    ic.className = 'shell-rail__icon';
    ic.appendChild(icon(d.icon, 18));

    const lab = document.createElement('span');
    lab.className = 'shell-rail__label';
    lab.textContent = d.label;

    a.appendChild(ic);
    a.appendChild(lab);
    nav.appendChild(a);
    return a;
  });

  const foot = document.createElement('div');
  foot.className = 'shell-rail__foot';
  const fHost = document.createElement('div');
  const fIp   = document.createElement('div');
  const fRes  = document.createElement('div');
  fRes.textContent = 'resolver :8181';
  foot.appendChild(fHost);
  foot.appendChild(fIp);
  foot.appendChild(fRes);

  railEl.replaceChildren(card, nav, foot);

  function applyName() {
    const info = store.state.speaker.info || {};
    nameLine.textContent = info.name || '';
    const sub = [info.type, info.firmwareVersion].filter(Boolean).join(' · ');
    subLine.textContent = sub;
  }

  function applyPill() {
    const next = computePillState(store.state);
    pillEl.update({ tone: next.tone, text: next.text, pulse: next.tone === 'live' });
  }

  function applyActive() {
    const active = store.state.ui.activeTab;
    for (const a of railTabs) {
      const on = a.dataset.tab === active;
      a.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) a.classList.add('is-active');
      else    a.classList.remove('is-active');
    }
  }

  function applyFoot() {
    const net = store.state.speaker.network || {};
    const info = store.state.speaker.info || {};
    fHost.textContent = net.name || info.name || '';
    fIp.textContent = net.ipAddress || '';
  }

  applyName();
  applyPill();
  applyActive();
  applyFoot();

  store.subscribe('speaker', () => { applyName(); applyPill(); applyFoot(); });
  store.subscribe('ws',      applyPill);
  store.subscribe('ui',      applyActive);
}

function renderHeader(headerEl, store) {
  const name = document.createElement('span');
  name.className = 'shell-header__name';

  const initial = computePillState(store.state);
  const pillEl = pill({ tone: initial.tone, text: initial.text, pulse: initial.tone === 'live' });
  pillEl.classList.add('shell-header__pill');

  headerEl.replaceChildren(name, pillEl);

  function applyPill() {
    const next = computePillState(store.state);
    pillEl.update({ tone: next.tone, text: next.text, pulse: next.tone === 'live' });
  }

  function applyName() {
    name.textContent = (store.state.speaker.info && store.state.speaker.info.name) || '';
  }

  applyName();
  applyPill();

  store.subscribe('speaker', () => { applyName(); applyPill(); });
  store.subscribe('ws',      applyPill);
}

function renderTabs(tabsEl, store) {
  const tabs = TAB_DEFS.map((d) => tabButton(d.tab, d.label, d.icon));
  tabsEl.setAttribute('role', 'tablist');
  tabsEl.replaceChildren(...tabs);

  function applyActive() {
    const active = store.state.ui.activeTab;
    for (const t of tabs) {
      const on = t.dataset.tab === active;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) t.classList.add('is-active');
      else    t.classList.remove('is-active');
    }
  }

  function applyHash() {
    const hash = (typeof location !== 'undefined' ? location.hash : '');
    const path = pathFromHash(hash);
    tabsEl.hidden = /^\/preset\//.test(path);
    const tab = tabForPath(path);
    if (tab && store.state.ui.activeTab !== tab) {
      store.state.ui.activeTab = tab;
      store.touch('ui');
    } else {
      applyActive();
    }
  }

  store.subscribe('ui', applyActive);
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', applyHash);
  }
  applyHash();
}

function renderMini(miniEl, store) {
  const art = document.createElement('div');
  art.className = 'shell-mini__art';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  art.appendChild(img);

  const text = document.createElement('div');
  text.className = 'shell-mini__text';
  const title = document.createElement('div');
  title.className = 'shell-mini__title';
  const subtitle = document.createElement('div');
  subtitle.className = 'shell-mini__subtitle';
  text.appendChild(title);
  text.appendChild(subtitle);

  const body = document.createElement('button');
  body.type = 'button';
  body.className = 'shell-mini__body';
  body.setAttribute('aria-label', 'Open now playing');
  body.appendChild(art);
  body.appendChild(text);

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'shell-mini__play';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.appendChild(icon('play', 22));

  miniEl.replaceChildren(body, playBtn);

  let isStandby = false;

  body.addEventListener('click', () => {
    if (isStandby) {
      actions.pressKey('POWER').catch(() => {});
      return;
    }
    if (typeof location !== 'undefined') location.hash = '#/';
  });

  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isStandby) {
      actions.pressKey('POWER').catch(() => {});
      return;
    }
    const np = store.state.speaker.nowPlaying;
    const playing = np && np.playStatus === 'PLAY_STATE';
    actions.pressKey(playing ? 'PAUSE' : 'PLAY').catch(() => {});
  });

  function applyContent() {
    const np = store.state.speaker.nowPlaying;
    isStandby = !!(np && np.source === 'STANDBY');

    if (isStandby) {
      title.textContent = 'Speaker asleep';
      subtitle.textContent = 'Tap to wake';
      setArt(img, '', '');
      playBtn.setAttribute('aria-label', 'Wake speaker');
      playBtn.replaceChildren(icon('play', 22));
      return;
    }

    const itemName = (np && np.item && np.item.name) || np?.track || '';
    const artist   = (np && np.artist) || '';
    title.textContent = itemName || 'Idle';
    subtitle.textContent = artist;

    const url = np && typeof np.art === 'string' && np.art.startsWith('http') ? np.art : '';
    setArt(img, url, itemName);

    const playing = np && np.playStatus === 'PLAY_STATE';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 22));
  }

  function applyVisibility() {
    const hash = (typeof location !== 'undefined' ? location.hash : '');
    miniEl.hidden = !shouldShowMini(store.state, hash);
  }

  applyContent();
  applyVisibility();

  store.subscribe('speaker', () => { applyContent(); applyVisibility(); });
  store.subscribe('ws',      applyVisibility);
  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', applyVisibility);
  }
}

export function mountShell(store) {
  if (typeof document === 'undefined') return null;
  const headerEl = document.querySelector('.shell-header');
  const tabsEl   = document.querySelector('.shell-tabs');
  const miniEl   = document.querySelector('.shell-mini');
  const bodyEl   = document.querySelector('.shell-body');
  const railEl   = document.querySelector('.shell-rail');
  if (!headerEl || !tabsEl || !miniEl || !bodyEl) {
    throw new Error('shell: missing zone element(s) in index.html');
  }

  // theme.js stays imported (auto-applies on init); the user-facing
  // theme picker lives inside the Settings → Appearance sub-view.
  void theme;

  renderHeader(headerEl, store);
  renderTabs(tabsEl, store);
  renderMini(miniEl, store);
  if (railEl) renderRail(railEl, store);

  return bodyEl;
}
