// Theme module. Manages light/dark preference, persisted in localStorage.
// Must be initialised synchronously before the SPA mounts content to
// prevent a flash of the wrong theme.
//
// Preference values: 'auto' | 'light' | 'dark'. 'auto' defers to the
// OS prefers-color-scheme media query and installs a listener so live
// OS changes propagate without a reload.

const STORAGE_KEY = 'admin.theme';
const CYCLE = ['auto', 'light', 'dark'];

let _pref     = 'auto';
let _resolved = 'light';
let _mqListener = null;

function systemTheme() {
  if (typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function apply(resolved) {
  _resolved = resolved;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
  }
}

function clearMqListener() {
  if (_mqListener) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _mqListener);
    } catch (_err) {
      // Older Safari uses addListener/removeListener instead.
      try {
        window.matchMedia('(prefers-color-scheme: dark)').removeListener(_mqListener);
      } catch (_e) {}
    }
    _mqListener = null;
  }
}

function installMqListener() {
  clearMqListener();
  _mqListener = (e) => apply(e.matches ? 'dark' : 'light');
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  try {
    mq.addEventListener('change', _mqListener);
  } catch (_err) {
    mq.addListener(_mqListener);
  }
}

function resolve(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemTheme();
}

function loadPref() {
  try {
    if (typeof localStorage === 'undefined') return 'auto';
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
    return 'auto';
  } catch (_err) {
    return 'auto';
  }
}

function savePref(pref) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch (_err) {
    // Private mode / quota — non-fatal.
  }
}

export function init() {
  _pref = loadPref();
  apply(resolve(_pref));
  if (_pref === 'auto') installMqListener();
}

export function toggle() {
  const idx  = CYCLE.indexOf(_pref);
  _pref      = CYCLE[(idx + 1) % CYCLE.length];
  savePref(_pref);

  clearMqListener();
  if (_pref === 'auto') installMqListener();

  apply(resolve(_pref));
}

export function current() {
  return { preference: _pref, resolved: _resolved };
}
