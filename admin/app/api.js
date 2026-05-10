// REST client for /cgi-bin/api/v1/*. Thin wrappers around fetch().
// See admin/PLAN.md § REST API.
//
// Surface:
//   tunein*              — TuneIn forwarder (search / browse / station / probe)
//   speakerNowPlaying()  — speaker proxy /now_playing
//   getNowPlaying()      — alias of speakerNowPlaying() (canonical name)
//   parseNowPlayingXml() — shared parser used by REST and WS paths
//   parseNowPlayingEl()  — same parser for an already-parsed DOM element
//   getVolume(), postVolume() — GET/POST /speaker/volume
//   parseVolumeXml(), parseVolumeEl() — shared volume parser (REST + WS)
//   getSources()         — GET /speaker/sources → array of source objects
//   postSelect()         — POST /speaker/select with a ContentItem (streaming sources)
//   postSelectLocalSource() — POST /speaker/selectLocalSource (AUX, BLUETOOTH)
//   parseSourcesXml()    — parse <sources> XML into source array
//   parseSourcesEl()     — same for an already-parsed <sources> DOM element
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
  // Browser signals parse failure via a <parsererror> child; @xmldom/xmldom
  // (test runtime) does not have querySelector, so check getElementsByTagName.
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  const nps = doc.getElementsByTagName('nowPlaying');
  if (!nps || !nps[0]) return null;

  return parseNowPlayingEl(nps[0]);
}

// Parse an already-resolved <nowPlaying> DOM element — used by the WS
// dispatch path (nowPlayingUpdated handler) so both REST and WS converge
// on the same field mapping.
// Uses getElementsByTagName so it works in both browser (DOMParser) and
// @xmldom/xmldom (test runtime, which lacks querySelector).
export function parseNowPlayingEl(np) {
  if (!np) return null;

  const g = (parent, tag) => {
    const col = parent.getElementsByTagName(tag);
    return col && col[0] ? col[0] : null;
  };

  const ci = g(np, 'ContentItem');
  const itemNameEl = ci ? g(ci, 'itemName') : null;

  const text = (tag) => {
    const el = g(np, tag);
    return el && el.textContent != null ? el.textContent : '';
  };

  return {
    source:        np.getAttribute('source') || '',
    sourceAccount: np.getAttribute('sourceAccount') || '',
    item: {
      name:     itemNameEl ? (itemNameEl.textContent || '') : '',
      location: ci ? (ci.getAttribute('location') || '') : '',
      type:     ci ? (ci.getAttribute('type') || '') : '',
    },
    track:      text('track'),
    artist:     text('artist'),
    art:        text('art'),
    playStatus: text('playStatus'),
  };
}

// getNowPlaying is the canonical name; speakerNowPlaying is kept as an
// alias because the polling path in views/now-playing.js imports it directly.
export { speakerNowPlaying as getNowPlaying };

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

// GET /cgi-bin/api/v1/speaker/info → parsed info object.
// Fields: deviceID, name, type, firmwareVersion (plus any others present).
export async function getSpeakerInfo() {
  const res = await fetch(`${apiBase}/speaker/info`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getSpeakerInfo: HTTP ${res.status}`);
  const text = await res.text();
  return parseInfoXml(text);
}

// Parse the speaker's <info> XML into:
//   { deviceID, name, type, firmwareVersion }
//
// Reference shape (from the 8090 /info endpoint):
//   <info deviceID="...">
//     <name>My SoundTouch</name>
//     <type>SoundTouch 10</type>
//     <components>
//       <component>
//         <componentCategory>SCM</componentCategory>
//         <softwareVersion>27.0.6.29798 epdbuild hepdswbld04 (Sep 20 2016 12:19:09)</softwareVersion>
//         <serialNumber>...</serialNumber>
//       </component>
//     </components>
//   </info>
//
// Defensive: any field may be missing on unknown firmware revisions.
export function parseInfoXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const info = doc.querySelector('info');
  if (!info) return null;

  const text = (sel) => {
    const el = info.querySelector(sel);
    return el && el.textContent != null ? el.textContent.trim() : '';
  };

  // Firmware version lives in the first SCM component's softwareVersion.
  let firmwareVersion = '';
  for (const comp of info.querySelectorAll('component')) {
    const cat = comp.querySelector('componentCategory');
    if (cat && cat.textContent.trim() === 'SCM') {
      const sv = comp.querySelector('softwareVersion');
      if (sv) firmwareVersion = sv.textContent.trim();
      break;
    }
  }

  return {
    deviceID:        info.getAttribute('deviceID') || '',
    name:            text('name'),
    type:            text('type'),
    firmwareVersion,
  };
}

// --- volume ---------------------------------------------------------

// Parse the speaker's <volume> XML into:
//   { targetVolume, actualVolume, muteEnabled }
//
// Reference shape:
//   <volume>
//     <targetvolume>32</targetvolume>
//     <actualvolume>32</actualvolume>
//     <muteenabled>false</muteenabled>
//   </volume>
//
// Uses getElementsByTagName so it works in both browser and @xmldom/xmldom.
export function parseVolumeXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const vols = doc.getElementsByTagName('volume');
  if (!vols || !vols[0]) return null;
  return parseVolumeEl(vols[0]);
}

// Parse an already-resolved <volume> DOM element — used by the WS
// dispatch path (volumeUpdated handler).
export function parseVolumeEl(el) {
  if (!el) return null;
  const g = (tag) => {
    const col = el.getElementsByTagName(tag);
    return col && col[0] ? col[0].textContent : '';
  };
  const target = parseInt(g('targetvolume'), 10);
  const actual = parseInt(g('actualvolume'), 10);
  const mute   = g('muteenabled');
  if (isNaN(target) && isNaN(actual)) return null;
  return {
    targetVolume: isNaN(target) ? 0 : target,
    actualVolume: isNaN(actual) ? 0 : actual,
    muteEnabled:  mute === 'true',
  };
}

// GET /cgi-bin/api/v1/speaker/volume
export async function getVolume() {
  const res = await fetch(`${apiBase}/speaker/volume`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getVolume: HTTP ${res.status}`);
  const text = await res.text();
  return parseVolumeXml(text);
}

// POST /cgi-bin/api/v1/speaker/volume with body <volume>NN</volume>.
// Throws on non-2xx.
export async function postVolume(level) {
  const res = await fetch(`${apiBase}/speaker/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<volume>${Math.round(level)}</volume>`,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postVolume: HTTP ${res.status}`);
}

// --- sources --------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/sources → array of source objects.
// Shape per element: { source, sourceAccount, status, isLocal, displayName }
export async function getSources() {
  const res = await fetch(`${apiBase}/speaker/sources`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getSources: HTTP ${res.status}`);
  const text = await res.text();
  return parseSourcesXml(text);
}

// POST /cgi-bin/api/v1/speaker/select — switch to a streaming source.
// contentItem: { source, sourceAccount, type?, location? }
// Sends a minimal <ContentItem> that resumes the speaker's last-known
// position for that source. Station-level deep-link is a future improvement.
export async function postSelect(contentItem) {
  const { source, sourceAccount = '', type = '', location = '' } = contentItem;
  const xml = `<ContentItem source="${source}" sourceAccount="${sourceAccount}" type="${type}" location="${location}"/>`;
  const res = await fetch(`${apiBase}/speaker/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postSelect: HTTP ${res.status}`);
}

// POST /cgi-bin/api/v1/speaker/selectLocalSource — switch to a local
// source (AUX, BLUETOOTH). Names follow Bose convention: 'AUX', 'BLUETOOTH'.
export async function postSelectLocalSource(name) {
  const xml = `<selectLocalSource>${name}</selectLocalSource>`;
  const res = await fetch(`${apiBase}/speaker/selectLocalSource`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postSelectLocalSource: HTTP ${res.status}`);
}

// Parse the speaker's <sources> XML into an array.
// Returns [] on no sources, null on empty/invalid input.
//
// Reference shape (from the 8090 /sources endpoint):
//   <sources deviceID="000C8AABCDEF">
//     <sourceItem source="TUNEIN" sourceAccount="" status="READY" isLocal="false">TuneIn</sourceItem>
//     <sourceItem source="AUX" sourceAccount="AUX" status="READY" isLocal="true">AUX</sourceItem>
//   </sources>
export function parseSourcesXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;

  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  const sourcesEls = doc.getElementsByTagName('sources');
  if (!sourcesEls || !sourcesEls[0]) return null;

  return parseSourcesEl(sourcesEls[0]);
}

// Parse an already-resolved <sources> DOM element — used by the WS
// dispatch path. Uses getElementsByTagName for @xmldom/xmldom compat.
export function parseSourcesEl(el) {
  if (!el) return null;

  const items = el.getElementsByTagName('sourceItem');
  const result = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    result.push({
      source:        item.getAttribute('source') || '',
      sourceAccount: item.getAttribute('sourceAccount') || '',
      status:        item.getAttribute('status') || '',
      isLocal:       item.getAttribute('isLocal') === 'true',
      displayName:   item.textContent || '',
    });
  }
  return result;
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
