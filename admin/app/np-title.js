// renderNowPlayingTitle — single source of truth for the title row
// the shell mini-player and the now-playing view both render.
//
// Picks the firmware's resolved <itemName> first (it's the canonical
// human-friendly label), falling back to the streaming <track> line
// when the speaker hasn't surfaced an itemName yet, and finally to
// the empty string. Empty strings are treated as missing (logical-OR
// fall-through) so a stray '' on either field doesn't paint a blank
// row when the other field has a usable value.
//
// `withMetadata` is reserved for callers that want title + a compact
// metadata trailer in a single string (e.g. `Title · TUNEIN · 128 kbps`).
// Today both callers render title and metadata as separate DOM nodes,
// so the option is a no-op — the seam exists for the eventual third
// caller that wants the combined form.

export function renderNowPlayingTitle(np, _opts) {
  if (!np) return '';
  return np?.item?.name || np?.track || '';
}
