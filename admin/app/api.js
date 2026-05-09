// REST client for /cgi-bin/api/v1/*. Thin wrappers around fetch().
// See admin/PLAN.md § REST API.
//
// 0.2 contributors:
//   slice 2 — TuneIn forwarder (search / browse / station / probe)
//   slice 6 — speaker proxy reads + <nowPlaying> XML parser
//   slices 4, 5 will add presets and reshape contract usage.

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

// --- speaker proxy (slice 6) ----------------------------------------

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

// --- XML parsing (slice 6) ------------------------------------------

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
