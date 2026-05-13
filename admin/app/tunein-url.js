// tunein-url — single home for TuneIn OPML URL operations.
//
// The client emits Browse / Search URLs in several contexts and the
// service is finicky about URL shape. § 7 of docs/tunein-api.md
// captures the rules. This module is the executable form of those
// rules:
//
//   canonicaliseBrowseUrl(rawUrl) — given a URL the API itself emitted
//     (e.g. a row's `URL` field or a `nextStations` cursor), return a
//     URL the client should actually fetch. Applies the language-tree
//     rewrite (`id=c424724/5/6&filter=l<N>` → `c=music/talk/sports
//     &filter=l<N>`, § 7.3); re-appends `render=json` (§ 6.1); refuses
//     the colon form `filter=l:N` which the service silently ignores
//     (§ 7.3).
//
//   extractDrillKey(url) — pure parse of a Browse URL into its
//     constituent drill keys (`id` / `c` / `filter` / `pivot` /
//     `offset`).
//
//   composeDrillUrl(parts) — inverse of extractDrillKey: emit a
//     Browse.ashx query string from a parts object. Always appends
//     `render=json`. Refuses colon-form lcode filters for symmetry
//     with canonicaliseBrowseUrl.
//
//   isValidLcode(code) — boolean: is `code` (e.g. `'l109'`) present
//     in the cached `Describe.ashx?c=languages` catalogue? The
//     catalogue is fetched once at app load (admin/app/main.js) and
//     stashed in sessionStorage under LCODE_CACHE_KEY. § 7.5.
//
// All four functions are pure. The sessionStorage read in
// isValidLcode is the only side-effect surface; tests stub it via
// the global `sessionStorage` shim.

export const LCODE_CACHE_KEY = 'tunein.lcodes';

// The three category IDs that the service emits in language-tree
// URLs but which return the empty tombstone when followed verbatim.
// See § 7.3 and § 8.1.
const LANG_TREE_REWRITES = {
  c424724: 'music',
  c424725: 'talk',
  c424726: 'sports',
};

// Strip the magic params and any `render` echo so the caller is
// free to re-attach the canonical `render=json`. Returns a fresh
// URLSearchParams.
function stripMagicAndRender(params) {
  params.delete('formats');
  params.delete('lang');
  params.delete('render');
  return params;
}

// Pull the path-and-query out of a raw URL. Accepts either an
// absolute URL (`http://opml.radiotime.com/Browse.ashx?...`) or a
// bare query string starting with `?` or `Browse.ashx?...`. Returns
// { path, params } where `path` is the file portion (e.g.
// `Browse.ashx`) and `params` is a URLSearchParams.
function splitUrl(rawUrl) {
  const s = String(rawUrl || '');
  const qIdx = s.indexOf('?');
  if (qIdx < 0) return { path: s, params: new URLSearchParams() };
  const head = s.slice(0, qIdx);
  const query = s.slice(qIdx + 1);
  // The path is the final segment (`Browse.ashx`) — drop scheme + host
  // so the rewritten URL stays scheme-relative.
  const slash = head.lastIndexOf('/');
  const path = slash >= 0 ? head.slice(slash + 1) : head;
  return { path, params: new URLSearchParams(query) };
}

// Detect the colon-form lcode that the service silently ignores
// (`filter=l:NNN` instead of `filter=l<NNN>`). § 7.3.
function isColonFormLcode(filterValue) {
  if (typeof filterValue !== 'string') return false;
  // Match `l:<digits>` either as the whole value or as a comma-
  // separated token within a compound filter.
  return /(^|,)l:\d+(?=,|$)/.test(filterValue);
}

// Pull the `id=` value out of a parsed param set and, if it maps
// to one of the three language-tree containers, rewrite to the
// equivalent `c=` short form. Mutates `params` in place. Returns
// true if a rewrite happened (for test assertions).
function maybeRewriteLanguageTree(params) {
  const id = params.get('id');
  const filter = params.get('filter') || '';
  if (!id) return false;
  // Only rewrite when a language filter accompanies the id — that's
  // the broken shape § 7.3 documents. Drilling into c424724 without
  // a language filter is undocumented but we don't want to mangle it.
  if (!/(^|,)l\d+(,|$)/.test(filter)) return false;
  const target = LANG_TREE_REWRITES[id];
  if (!target) return false;
  params.delete('id');
  // URLSearchParams preserves insertion order; set `c=` first so
  // the emitted URL reads naturally (`c=music&filter=l109`).
  const rest = Array.from(params.entries());
  for (const [k] of rest) params.delete(k);
  params.set('c', target);
  for (const [k, v] of rest) params.append(k, v);
  return true;
}

// Compose a `Browse.ashx?...` URL from a parsed params set. Always
// ends in `&render=json`.
function emitBrowseUrl(path, params) {
  // Ensure render=json is present and last.
  params.delete('render');
  // URLSearchParams uses `+` for spaces; the OPML service is happy
  // with either, but switch to `%20` so emitted URLs match the form
  // the service itself emits (no `+` outside of `query=` text).
  const qs = params.toString().replace(/\+/g, '%20');
  const prefix = path || 'Browse.ashx';
  return `${prefix}?${qs}${qs ? '&' : ''}render=json`;
}

// Public: given a URL the API itself emitted, return a URL the
// client should actually fetch.
export function canonicaliseBrowseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return rawUrl;
  const { path, params } = splitUrl(rawUrl);
  const filter = params.get('filter');
  if (isColonFormLcode(filter)) {
    throw new Error(`tunein-url: refusing colon-form lcode filter "${filter}"`);
  }
  stripMagicAndRender(params);
  maybeRewriteLanguageTree(params);
  return emitBrowseUrl(path, params);
}

// Public: parse a Browse.ashx URL (or any URL with these params) into
// a plain object. Missing keys are omitted (not set to undefined).
export function extractDrillKey(rawUrl) {
  const out = {};
  if (typeof rawUrl !== 'string' || rawUrl === '') return out;
  const { params } = splitUrl(rawUrl);
  for (const key of ['id', 'c', 'filter', 'pivot', 'offset']) {
    const v = params.get(key);
    if (v != null && v !== '') out[key] = v;
  }
  return out;
}

// Public: compose a Browse.ashx URL from a parts object. Order of
// emitted keys matches the order the service itself emits. Always
// appends `render=json`. Refuses colon-form lcode filters.
export function composeDrillUrl(parts) {
  const p = parts && typeof parts === 'object' ? parts : {};
  if (typeof p.filter === 'string' && isColonFormLcode(p.filter)) {
    throw new Error(`tunein-url: refusing colon-form lcode filter "${p.filter}"`);
  }
  const params = new URLSearchParams();
  // Service-natural ordering: id|c, then filter, pivot, offset.
  if (p.id != null && p.id !== '') params.set('id', String(p.id));
  if (p.c  != null && p.c  !== '') params.set('c',  String(p.c));
  if (p.filter != null && p.filter !== '') params.set('filter', String(p.filter));
  if (p.pivot  != null && p.pivot  !== '') params.set('pivot',  String(p.pivot));
  if (p.offset != null && p.offset !== '') params.set('offset', String(p.offset));
  return emitBrowseUrl('Browse.ashx', params);
}

// --- lcode allow-list cache ----------------------------------------
//
// Populated once at app load via cacheLcodesFromDescribe() and read by
// isValidLcode() + lcodeLabel(). Storage backend is sessionStorage so
// the cache is scoped to the current admin SPA tab — it survives soft
// navigations but not a full reload (which is fine; one fetch per
// session).
//
// Shape on disk: `{ "l109": "German", "l216": "English", ... }`. The
// label half drives the breadcrumb + drill-header rendering for any
// lcode filter (issues #89, #90). Tolerant of legacy string-array
// inputs from older test fixtures — those round-trip to an entry with
// an empty label, so isValidLcode still works while lcodeLabel falls
// back to undefined.

function readLcodeCache() {
  try {
    const raw = (typeof sessionStorage !== 'undefined')
      ? sessionStorage.getItem(LCODE_CACHE_KEY)
      : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_err) {
    return null;
  }
}

// Stash a map of `l<NNN>` → label under LCODE_CACHE_KEY. Accepts
// either an array of `{id, name}` entries or an array of bare code
// strings (legacy / test-fixture path; labels default to ''). Public
// so admin/app/main.js can call it after fetching the catalogue and
// so tests can prime the cache directly.
export function cacheLcodes(entries) {
  if (!Array.isArray(entries)) return;
  const map = {};
  for (const entry of entries) {
    let id; let name = '';
    if (typeof entry === 'string') {
      id = entry;
    } else if (entry && typeof entry === 'object') {
      id = entry.id;
      if (typeof entry.name === 'string') name = entry.name;
    }
    if (typeof id === 'string' && /^l\d+$/.test(id)) map[id] = name;
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(LCODE_CACHE_KEY, JSON.stringify(map));
    }
  } catch (_err) {
    // sessionStorage may throw under quota / private-mode; isValidLcode
    // then returns false, which fails closed — the safe default.
  }
  // Broadcast that the catalogue is available so any view that
  // rendered before the boot-time fetch landed can patch in resolved
  // language names (drill header badge, breadcrumb anchors — #89, #90).
  // No-op in non-browser environments (tests run under @xmldom/xmldom,
  // which leaves `window` undefined).
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try { window.dispatchEvent(new Event(LCODES_LOADED_EVENT)); }
    catch (_err) { /* CustomEvent ctor may be unavailable; ignore */ }
  }
}

// Event name dispatched on `window` once cacheLcodes writes a fresh
// catalogue. Views that render filter-bearing crumbs / badges before
// the boot-time fetch lands subscribe to this to re-patch their DOM.
export const LCODES_LOADED_EVENT = 'tunein-lcodes-loaded';

// Public: is `code` (e.g. `'l109'`) present in the cached language
// catalogue? Returns false when the cache is empty or missing — the
// caller is responsible for not emitting bogus lcodes.
export function isValidLcode(code) {
  if (typeof code !== 'string' || !/^l\d+$/.test(code)) return false;
  const cache = readLcodeCache();
  if (!cache) return false;
  return Object.prototype.hasOwnProperty.call(cache, code);
}

// Public: resolve `code` (e.g. `'l109'`) to its human-readable
// language name (`'German'`). Returns undefined when the code is
// unknown, the cache is empty, or the entry has no recorded label
// (legacy string-only inputs). Used by the browse view's breadcrumb
// + drill-header to render readable filter chips (#89, #90).
export function lcodeLabel(code) {
  if (typeof code !== 'string' || !/^l\d+$/.test(code)) return undefined;
  const cache = readLcodeCache();
  if (!cache) return undefined;
  const v = cache[code];
  return (typeof v === 'string' && v !== '') ? v : undefined;
}

// Helper for app init: extract the `{guide_id, text}` pairs out of a
// `Describe.ashx?c=languages` response body and stash them.
// Tolerant of both the OPML body shape (array of outlines) and a
// pre-extracted array of `{id, name}` objects or bare code strings.
export function cacheLcodesFromDescribe(json) {
  if (!json) return;
  if (Array.isArray(json.body)) {
    const entries = [];
    for (const e of json.body) {
      const gid = e && (e.guide_id || e.id);
      if (typeof gid === 'string' && /^l\d+$/.test(gid)) {
        const name = (e && typeof e.text === 'string') ? e.text : '';
        entries.push({ id: gid, name });
      }
    }
    cacheLcodes(entries);
    return;
  }
  if (Array.isArray(json)) cacheLcodes(json);
}
