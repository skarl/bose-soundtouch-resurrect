// API client. Same-origin fetch against the speaker's busybox httpd.
// Slices 6 and 7 will extend this with speaker-proxy methods + a small
// XML parser for <nowPlaying>/<presets>. Keep additions structured so
// the file doesn't sprawl.
//
// See admin/PLAN.md § REST API.

export const apiBase = '/cgi-bin/api/v1';

// --- TuneIn forwarder (slice 2) -------------------------------------
//
// All four methods return the raw TuneIn JSON body, verbatim. No
// envelope; classification (gated / dark / playable) lives in
// app/reshape.js and lands in slice 4.

async function getJson(path) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

export function tuneinSearch(q) {
  const qs = new URLSearchParams({ q, type: 'station' }).toString();
  return getJson(`/tunein/search?${qs}`);
}

export function tuneinBrowse(id) {
  const path = id ? `/tunein/browse?id=${encodeURIComponent(id)}` : '/tunein/browse';
  return getJson(path);
}

export function tuneinStation(sid) {
  return getJson(`/tunein/station/${encodeURIComponent(sid)}`);
}

export function tuneinProbe(sid) {
  return getJson(`/tunein/probe/${encodeURIComponent(sid)}`);
}
