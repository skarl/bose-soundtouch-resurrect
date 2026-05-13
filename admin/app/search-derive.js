// search-derive — pure derivations for the search view.
//
// Extracted from views/search.js so the view shrinks to input handling
// + DOM mutation, and the derivations stay fixture-testable in
// isolation. Byte-identical behaviour to the inline originals.

export const DEBOUNCE_MS = 300;
export const SEARCH_PLACEHOLDER = 'Search TuneIn — try "jazz", "bbc", "ffh"';
const STATION_GUIDE_ID = /^s\d+$/;

// Pull station leaves out of a TuneIn Search.ashx body — flat filter.
export function searchResultStations(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  return items.filter(
    (e) => e && e.type === 'audio' && typeof e.guide_id === 'string'
      && STATION_GUIDE_ID.test(e.guide_id)
  );
}

// Pull station leaves out of a Browse.ashx?c=local body — recurses one
// level so nested sections surface their leaves directly.
export function popularStations(json) {
  const items = Array.isArray(json && json.body) ? json.body : [];
  const out = [];
  const visit = (entry) => {
    if (!entry) return;
    if (Array.isArray(entry.children)) {
      for (const c of entry.children) visit(c);
      return;
    }
    if (entry.type === 'audio'
        && typeof entry.guide_id === 'string'
        && STATION_GUIDE_ID.test(entry.guide_id)) {
      out.push(entry);
    }
  };
  for (const e of items) visit(e);
  return out;
}
