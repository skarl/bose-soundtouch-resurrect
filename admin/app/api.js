// REST client for /cgi-bin/api/v1/*. Thin wrappers around fetch().
// See admin/PLAN.md § REST API.
//
// Surface:
//   tunein*       — TuneIn forwarder (search / browse / station / probe)
//   speakerNowPlaying() — speaker proxy /now_playing parser
//   presetsList(), presetsAssign() — presets CGI envelope client

export const apiBase = '/cgi-bin/api/v1';

// --- TuneIn forwarder -----------------------------------------------
//
// All four methods return the raw TuneIn JSON body, verbatim. No
// envelope; classification (gated / dark / playable) lives in
// app/reshape.js.

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
  // TuneIn's Search.ashx expects `query=`; sending `q=` returns
  // {head: {status: 400, fault: "Empty Query specified"}} with no body.
  const qs = new URLSearchParams({ query: q, type: 'station' }).toString();
  return getJson(`/tunein/search?${qs}`);
}

// tuneinBrowse() with no args returns the root taxonomy.
// tuneinBrowse('g22') drills into a genre/category/region node.
// tuneinBrowse({ c: 'music' }) hits the c-style top-level (Browse.ashx
// uses both `id=` and `c=`; see docs/tunein-api.md).
export function tuneinBrowse(arg) {
  let qs = '';
  if (typeof arg === 'string') {
    qs = `?id=${encodeURIComponent(arg)}`;
  } else if (arg && typeof arg === 'object') {
    qs = '?' + new URLSearchParams(arg).toString();
  }
  return getJson(`/tunein/browse${qs}`);
}

export function tuneinStation(sid) {
  return getJson(`/tunein/station/${encodeURIComponent(sid)}`);
}

export function tuneinProbe(sid) {
  return getJson(`/tunein/probe/${encodeURIComponent(sid)}`);
}

// --- speaker proxy --------------------------------------------------

// GET /cgi-bin/api/v1/speaker/now_playing → parsed nowPlaying object.
export async function speakerNowPlaying() {
  const res = await fetch(`${apiBase}/speaker/now_playing`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`speakerNowPlaying: HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseNowPlayingXml(text);
}

// --- XML parsing ----------------------------------------------------

// Parse the speaker's <nowPlaying> XML into:
//   { source, sourceAccount, item: {name, location, type}, track,
//     artist, art, playStatus }
//
// Reference shape (from the 8090 API):
//   <nowPlaying source="TUNEIN" sourceAccount="">
//     <ContentItem source="TUNEIN" type="stationurl"
//                  location="/v1/playback/station/s12345"
//                  isPresetable="true">
//       <itemName>Example Radio</itemName>
//     </ContentItem>
//     <track>Sweet Dreams</track>
//     <artist>La Bouche</artist>
//     <art artImageStatus="IMAGE_PRESENT">http://.../logo.png</art>
//     <playStatus>PLAY_STATE</playStatus>
//   </nowPlaying>
//
// Defensive: any field may be missing (STANDBY, AUX, BLUETOOTH, etc.).
export function parseNowPlayingXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;

  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const np = doc.querySelector('nowPlaying');
  if (!np) return null;

  const ci = np.querySelector('ContentItem');
  const itemName = ci && ci.querySelector('itemName');

  const text = (sel) => {
    const el = np.querySelector(sel);
    return el && el.textContent != null ? el.textContent : '';
  };

  return {
    source:        np.getAttribute('source') || '',
    sourceAccount: np.getAttribute('sourceAccount') || '',
    item: {
      name:     itemName && itemName.textContent ? itemName.textContent : '',
      location: ci ? (ci.getAttribute('location') || '') : '',
      type:     ci ? (ci.getAttribute('type') || '') : '',
    },
    track:      text('track'),
    artist:     text('artist'),
    art:        text('art'),
    playStatus: text('playStatus'),
  };
}

// --- presets --------------------------------------------------------
//
// Both methods return the parsed CGI envelope. Transport errors throw;
// `{ok:false, error}` envelopes resolve normally so the caller can route
// the structured error to a toast and decide whether to refetch.

// GET /presets → { ok:true, data:[6 slots] } | { ok:false, error }
export async function presetsList() {
  const res = await fetch(`${apiBase}/presets`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  // Even on 4xx/5xx the CGI emits a JSON envelope, so we parse rather
  // than treat HTTP status as the only signal.
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`presetsList: malformed response (HTTP ${res.status})`);
  }
  return body;
}

// POST /preview with {id, name, json} — writes the per-station Bose
// JSON atomically and asks the speaker to /select it. Used by the
// station-detail audition button so the user can hear the chosen
// stream on Bo before committing it as a preset.
export async function previewStream(payload) {
  const res = await fetch(`${apiBase}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  let body;
  try { body = await res.json(); }
  catch (err) { throw new Error(`previewStream: malformed response (HTTP ${res.status})`); }
  return body;
}

// POST /speaker/key — hardware key event. Used to send POWER for
// "stop preview" (the speaker treats POWER as standby).
export async function speakerKey(name, state) {
  const xml = `<key state="${state}" sender="Gabbo">${name}</key>`;
  const res = await fetch(`${apiBase}/speaker/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`speakerKey: HTTP ${res.status}`);
  return true;
}

// POST /presets/:slot with {id, slot, name, kind, json}.
// Slot is 1..6; payload must include matching `slot` and `kind:"playable"`
// (the CGI rejects anything else with a structured error).
export async function presetsAssign(slot, payload) {
  const res = await fetch(`${apiBase}/presets/${encodeURIComponent(slot)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`presetsAssign: malformed response (HTTP ${res.status})`);
  }
  return body;
}
