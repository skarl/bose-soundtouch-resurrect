// Theme module. Manages the active palette preference, persisted in
// localStorage. Must be initialised synchronously before the SPA mounts
// content to prevent a flash of the wrong theme.
//
// Preference values: 'auto' | 'graphite' | 'cream' | 'terminal'.
//   - 'auto' defers to OS prefers-color-scheme: graphite on light,
//     terminal on dark. A media-query listener keeps 'auto' live.
//   - 'cream' is a manual middle palette — never the resolved value
//     of 'auto'.
//
// Legacy values from previous releases ('light', 'dark') migrate on
// load: light → graphite, dark → terminal.

const STORAGE_KEY = 'admin.theme';
const CYCLE = ['auto', 'graphite', 'cream', 'terminal'];
const VALID = new Set(CYCLE);

const LEGACY_MIGRATION = {
  light: 'graphite',
  dark:  'terminal',
};

let _pref     = 'auto';
let _resolved = 'graphite';
let _mqListener = null;

function systemTheme() {
  if (typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'terminal';
  }
  return 'graphite';
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
  _mqListener = (e) => apply(e.matches ? 'terminal' : 'graphite');
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  try {
    mq.addEventListener('change', _mqListener);
  } catch (_err) {
    mq.addListener(_mqListener);
  }
}

export function resolve(pref) {
  if (pref === 'graphite' || pref === 'cream' || pref === 'terminal') return pref;
  return systemTheme();
}

export function migrateStoredPref(raw) {
  if (raw == null) return 'auto';
  if (Object.prototype.hasOwnProperty.call(LEGACY_MIGRATION, raw)) {
    return LEGACY_MIGRATION[raw];
  }
  if (VALID.has(raw)) return raw;
  return 'auto';
}

function readRawPref() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  } catch (_err) {
    return null;
  }
}

function loadPref({ persist } = { persist: false }) {
  const raw = readRawPref();
  const migrated = migrateStoredPref(raw);
  if (persist && migrated !== raw) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, migrated);
      }
    } catch (_e) {}
  }
  return migrated;
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
  _pref = loadPref({ persist: true });
  apply(resolve(_pref));
  if (_pref === 'auto') installMqListener();
}

export function toggle() {
  const idx  = CYCLE.indexOf(_pref);
  setTheme(CYCLE[(idx + 1) % CYCLE.length]);
}

// Set the active theme preference. Validates input against the cycle;
// unknown values fall back to 'auto'. Mirrors toggle()'s side-effects:
// persists the choice, applies the resolved palette synchronously, and
// installs/removes the OS-prefers MQ listener as needed.
export function setTheme(name) {
  const next = VALID.has(name) ? name : 'auto';
  _pref = next;
  savePref(_pref);

  clearMqListener();
  if (_pref === 'auto') installMqListener();

  apply(resolve(_pref));
}

export function current() {
  return { preference: _pref, resolved: _resolved };
}

export const _internals = { CYCLE, LEGACY_MIGRATION, STORAGE_KEY };

// Apply the resolved theme synchronously on first import so the
// document never paints with the default attribute. init() will run
// again from main.js to install the MQ listener and persist any
// legacy-pref migration.
if (typeof document !== 'undefined') {
  apply(resolve(loadPref()));
}
