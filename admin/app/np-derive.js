// np-derive — pure derivations for the now-playing view + mini-player.
//
// Extracted from views/now-playing.js so the view shrinks to lifecycle
// wiring + DOM mutation, the mini-player in shell.js can reuse the same
// derivations instead of duplicating them, and each helper stays
// fixture-testable in isolation. Byte-identical behaviour to the
// inline originals.

// Deduplicate track vs artist vs station name (case-insensitive) and
// join with em-dash. TuneIn streams often put the current song in
// <artist> and the station tagline in <track> — render whatever is
// distinct and non-empty.
export function pickTrackLine(np, stationName) {
  if (!np) return '';
  const norm = (s) => (typeof s === 'string' ? s.trim() : '');
  const station = (stationName || '').toLowerCase();
  const track  = norm(np.track);
  const artist = norm(np.artist);
  const useArtist = artist && artist.toLowerCase() !== station;
  const useTrack  = track && track.toLowerCase() !== station
                          && track.toLowerCase() !== artist.toLowerCase();
  const parts = [];
  if (useArtist) parts.push(artist);
  if (useTrack)  parts.push(track);
  return parts.join(' – ');
}

// "TUNEIN · 128 kbps · liveRadio" from the nowPlaying object.
// Fields are absent on STANDBY / AUX; returns '' rather than dots.
export function pickMetaLine(np) {
  if (!np) return '';
  const parts = [];
  if (np.source && np.source !== 'STANDBY') parts.push(np.source);
  const type = np.item && np.item.type;
  if (type) parts.push(type);
  return parts.join(' · ');
}

// Title-case an UPPER_SNAKE source key when the parser didn't supply a
// displayName (some firmware payloads ship empty <sourceItem> bodies).
export function humaniseSourceKey(key) {
  return String(key || '')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
