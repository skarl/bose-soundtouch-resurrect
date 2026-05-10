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
//   getBass(), postBass()       — GET/POST /speaker/bass
//   parseBassXml(), parseBassEl() — shared bass parser (REST + WS)
//   getBassCapabilities(), parseBassCapabilitiesXml(), parseBassCapabilitiesEl()
//   getBalance(), postBalance() — GET/POST /speaker/balance
//   parseBalanceXml(), parseBalanceEl() — shared balance parser (REST + WS)
//   getBalanceCapabilities(), parseBalanceCapabilitiesXml(), parseBalanceCapabilitiesEl()
//   getDSPMonoStereo(), postDSPMonoStereo() — GET/POST /speaker/DSPMonoStereo
//   parseDSPMonoStereoXml(), parseDSPMonoStereoEl()
//   getSources()         — GET /speaker/sources → array of source objects
//   postSelect()         — POST /speaker/select with a ContentItem (streaming sources)
//   postSelectLocalSource() — POST /speaker/selectLocalSource (AUX, BLUETOOTH)
//   parseSourcesXml()    — parse <sources> XML into source array
//   parseSourcesEl()     — same for an already-parsed <sources> DOM element
//   getNetworkInfo()     — GET /networkInfo (read-only network metadata)
//   parseNetworkInfoXml(), parseNetworkInfoEl() — networkInfo parsers
//   presetsList(), presetsAssign() — presets CGI envelope client

export const apiBase = '/cgi-bin/api/v1';

// --- TuneIn forwarder -----------------------------------------------
//
// All four methods return the raw TuneIn JSON body, verbatim. No
// envelope; classification (gated / dark / playable) lives in
// app/reshape.js.

async function getJson(path, opts) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Accept: 'application/json' },
    signal: opts && opts.signal,
  });
  if (!res.ok) {
    throw new Error(`${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

export function tuneinSearch(q, opts) {
  // TuneIn's Search.ashx expects `query=`; sending `q=` returns
  // {head: {status: 400, fault: "Empty Query specified"}} with no body.
  const qs = new URLSearchParams({ query: q, type: 'station' }).toString();
  return getJson(`/tunein/search?${qs}`, opts);
}

// tuneinBrowse() with no args returns the root taxonomy.
// tuneinBrowse('g22') drills into a genre/category/region node.
// tuneinBrowse({ c: 'music' }) hits the c-style top-level (Browse.ashx
// uses both `id=` and `c=`; see docs/tunein-api.md).
export function tuneinBrowse(arg, opts) {
  let qs = '';
  if (typeof arg === 'string') {
    qs = `?id=${encodeURIComponent(arg)}`;
  } else if (arg && typeof arg === 'object') {
    qs = '?' + new URLSearchParams(arg).toString();
  }
  return getJson(`/tunein/browse${qs}`, opts);
}

export function tuneinStation(sid, opts) {
  return getJson(`/tunein/station/${encodeURIComponent(sid)}`, opts);
}

export function tuneinProbe(sid, opts) {
  return getJson(`/tunein/probe/${encodeURIComponent(sid)}`, opts);
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

// --- bass -----------------------------------------------------------

// Parse the speaker's <bass> XML into:
//   { targetBass, actualBass }
//
// Reference shape:
//   <bass>
//     <targetbass>-1</targetbass>
//     <actualbass>-1</actualbass>
//   </bass>
export function parseBassXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('bass');
  if (!els || !els[0]) return null;
  return parseBassEl(els[0]);
}

export function parseBassEl(el) {
  if (!el) return null;
  const g = (tag) => {
    const col = el.getElementsByTagName(tag);
    return col && col[0] ? col[0].textContent : '';
  };
  const target = parseInt(g('targetbass'), 10);
  const actual = parseInt(g('actualbass'), 10);
  if (isNaN(target) && isNaN(actual)) return null;
  return {
    targetBass: isNaN(target) ? 0 : target,
    actualBass: isNaN(actual) ? 0 : actual,
  };
}

// GET /cgi-bin/api/v1/speaker/bass
export async function getBass() {
  const res = await fetch(`${apiBase}/speaker/bass`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getBass: HTTP ${res.status}`);
  const text = await res.text();
  return parseBassXml(text);
}

// POST /cgi-bin/api/v1/speaker/bass with body <bass>NN</bass>.
export async function postBass(level) {
  const res = await fetch(`${apiBase}/speaker/bass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<bass>${Math.round(level)}</bass>`,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postBass: HTTP ${res.status}`);
}

// Parse the speaker's <bassCapabilities> XML into:
//   { bassMin, bassMax, bassDefault }
//
// Reference shape:
//   <bassCapabilities>
//     <bassMin>-9</bassMin>
//     <bassMax>0</bassMax>
//     <bassDefault>0</bassDefault>
//   </bassCapabilities>
export function parseBassCapabilitiesXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('bassCapabilities');
  if (!els || !els[0]) return null;
  return parseBassCapabilitiesEl(els[0]);
}

export function parseBassCapabilitiesEl(el) {
  if (!el) return null;
  const g = (tag) => {
    const col = el.getElementsByTagName(tag);
    return col && col[0] ? col[0].textContent : '';
  };
  const min = parseInt(g('bassMin'), 10);
  const max = parseInt(g('bassMax'), 10);
  const def = parseInt(g('bassDefault'), 10);
  if (isNaN(min) && isNaN(max)) return null;
  return {
    bassMin:     isNaN(min) ? 0 : min,
    bassMax:     isNaN(max) ? 0 : max,
    bassDefault: isNaN(def) ? 0 : def,
  };
}

// GET /cgi-bin/api/v1/speaker/bassCapabilities
export async function getBassCapabilities() {
  const res = await fetch(`${apiBase}/speaker/bassCapabilities`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getBassCapabilities: HTTP ${res.status}`);
  const text = await res.text();
  return parseBassCapabilitiesXml(text);
}

// --- balance --------------------------------------------------------

// Parse the speaker's <balance> XML into:
//   { targetBalance, actualBalance }
//
// Reference shape:
//   <balance>
//     <targetbalance>0</targetbalance>
//     <actualbalance>0</actualbalance>
//   </balance>
export function parseBalanceXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('balance');
  if (!els || !els[0]) return null;
  return parseBalanceEl(els[0]);
}

export function parseBalanceEl(el) {
  if (!el) return null;
  const g = (tag) => {
    const col = el.getElementsByTagName(tag);
    return col && col[0] ? col[0].textContent : '';
  };
  const target = parseInt(g('targetbalance'), 10);
  const actual = parseInt(g('actualbalance'), 10);
  if (isNaN(target) && isNaN(actual)) return null;
  return {
    targetBalance: isNaN(target) ? 0 : target,
    actualBalance: isNaN(actual) ? 0 : actual,
  };
}

// GET /cgi-bin/api/v1/speaker/balance
export async function getBalance() {
  const res = await fetch(`${apiBase}/speaker/balance`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getBalance: HTTP ${res.status}`);
  const text = await res.text();
  return parseBalanceXml(text);
}

// POST /cgi-bin/api/v1/speaker/balance with body <balance>NN</balance>.
export async function postBalance(level) {
  const res = await fetch(`${apiBase}/speaker/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<balance>${Math.round(level)}</balance>`,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postBalance: HTTP ${res.status}`);
}

// Parse the speaker's <balanceCapabilities> XML into:
//   { balanceMin, balanceMax, balanceDefault }
//
// Reference shape:
//   <balanceCapabilities>
//     <balanceMin>-7</balanceMin>
//     <balanceMax>7</balanceMax>
//     <balanceDefault>0</balanceDefault>
//   </balanceCapabilities>
export function parseBalanceCapabilitiesXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('balanceCapabilities');
  if (!els || !els[0]) return null;
  return parseBalanceCapabilitiesEl(els[0]);
}

export function parseBalanceCapabilitiesEl(el) {
  if (!el) return null;
  const g = (tag) => {
    const col = el.getElementsByTagName(tag);
    return col && col[0] ? col[0].textContent : '';
  };
  const min = parseInt(g('balanceMin'), 10);
  const max = parseInt(g('balanceMax'), 10);
  const def = parseInt(g('balanceDefault'), 10);
  if (isNaN(min) && isNaN(max)) return null;
  return {
    balanceMin:     isNaN(min) ? 0 : min,
    balanceMax:     isNaN(max) ? 0 : max,
    balanceDefault: isNaN(def) ? 0 : def,
  };
}

// GET /cgi-bin/api/v1/speaker/balanceCapabilities
export async function getBalanceCapabilities() {
  const res = await fetch(`${apiBase}/speaker/balanceCapabilities`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getBalanceCapabilities: HTTP ${res.status}`);
  const text = await res.text();
  return parseBalanceCapabilitiesXml(text);
}

// --- DSP mono/stereo ------------------------------------------------

// Parse the speaker's <DSPMonoStereo> XML into:
//   { mode: 'mono' | 'stereo' }
//
// Reference shape:
//   <DSPMonoStereo>
//     <mono enabled="false"/>
//   </DSPMonoStereo>
export function parseDSPMonoStereoXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('DSPMonoStereo');
  if (!els || !els[0]) return null;
  return parseDSPMonoStereoEl(els[0]);
}

export function parseDSPMonoStereoEl(el) {
  if (!el) return null;
  const monoEls = el.getElementsByTagName('mono');
  const monoEl = monoEls && monoEls[0];
  const enabled = monoEl ? monoEl.getAttribute('enabled') === 'true' : false;
  return { mode: enabled ? 'mono' : 'stereo' };
}

// GET /cgi-bin/api/v1/speaker/DSPMonoStereo
export async function getDSPMonoStereo() {
  const res = await fetch(`${apiBase}/speaker/DSPMonoStereo`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getDSPMonoStereo: HTTP ${res.status}`);
  const text = await res.text();
  return parseDSPMonoStereoXml(text);
}

// POST /cgi-bin/api/v1/speaker/DSPMonoStereo with body
// <DSPMonoStereo><mono enabled="true|false"/></DSPMonoStereo>.
// mode ∈ 'mono' | 'stereo'.
export async function postDSPMonoStereo(mode) {
  const enabled = mode === 'mono' ? 'true' : 'false';
  const xml = `<DSPMonoStereo><mono enabled="${enabled}"/></DSPMonoStereo>`;
  const res = await fetch(`${apiBase}/speaker/DSPMonoStereo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postDSPMonoStereo: HTTP ${res.status}`);
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

// --- network info ---------------------------------------------------

// GET /cgi-bin/api/v1/speaker/networkInfo → parsed network object.
// Fields: macAddress, ipAddress, ssid, signal, name, type, state,
// frequencyKHz, mode (only on the active interface).
//
// The endpoint may list several <interface> entries (wlan0/wlan1). We
// surface the first one that's connected (has an ipAddress); falling
// back to the first interface so disconnected speakers still expose
// their MAC.
export async function getNetworkInfo() {
  const res = await fetch(`${apiBase}/speaker/networkInfo`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getNetworkInfo: HTTP ${res.status}`);
  const text = await res.text();
  return parseNetworkInfoXml(text);
}

// Parse the speaker's <networkInfo> XML into:
//   { macAddress, ipAddress, ssid, signal, frequencyKHz, name, type,
//     state, mode }
//
// Reference shape (from the 8090 /networkInfo endpoint):
//   <networkInfo wifiProfileCount="2">
//     <interfaces>
//       <interface type="WIFI_INTERFACE" name="wlan0"
//                  macAddress="0CB2B709F837" ipAddress="192.168.178.36"
//                  ssid="WLAN-Oben" frequencyKHz="5240000"
//                  state="NETWORK_WIFI_CONNECTED" signal="GOOD_SIGNAL"
//                  mode="STATION"/>
//       <interface type="WIFI_INTERFACE" name="wlan1"
//                  macAddress="0CB2B709F838"
//                  state="NETWORK_WIFI_DISCONNECTED"/>
//     </interfaces>
//   </networkInfo>
export function parseNetworkInfoXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('networkInfo');
  if (!els || !els[0]) return null;
  return parseNetworkInfoEl(els[0]);
}

// Parse an already-resolved <networkInfo> DOM element.
// Picks the first <interface> with an ipAddress (i.e. connected); falls
// back to the first interface so the MAC is still visible offline.
export function parseNetworkInfoEl(el) {
  if (!el) return null;
  const ifaces = el.getElementsByTagName('interface');
  if (!ifaces || ifaces.length === 0) return null;

  let active = null;
  for (let i = 0; i < ifaces.length; i++) {
    if ((ifaces[i].getAttribute('ipAddress') || '') !== '') {
      active = ifaces[i];
      break;
    }
  }
  if (!active) active = ifaces[0];

  const freqRaw = active.getAttribute('frequencyKHz') || '';
  const freq = parseInt(freqRaw, 10);

  return {
    macAddress:   active.getAttribute('macAddress') || '',
    ipAddress:    active.getAttribute('ipAddress')  || '',
    ssid:         active.getAttribute('ssid')       || '',
    signal:       active.getAttribute('signal')     || '',
    frequencyKHz: isNaN(freq) ? null : freq,
    name:         active.getAttribute('name')       || '',
    type:         active.getAttribute('type')       || '',
    state:        active.getAttribute('state')      || '',
    mode:         active.getAttribute('mode')       || '',
  };
}

// --- speaker name / sleep timer / low-power / power -----------------

// Bose firmware accepts only the literal characters [<>&'"] as XML
// metacharacters in element bodies. Speaker names round-trip through
// /info, so escape on POST and let the speaker echo back unescaped.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function parseNameEl(el) {
  if (!el || el.textContent == null) return null;
  return { name: el.textContent.trim() };
}

export function parseNameXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('name');
  if (!els || !els[0]) return null;
  return parseNameEl(els[0]);
}

export async function getName() {
  const res = await fetch(`${apiBase}/speaker/name`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getName: HTTP ${res.status}`);
  return parseNameXml(await res.text());
}

export async function postName(name) {
  const res = await fetch(`${apiBase}/speaker/name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<name>${xmlEscape(name)}</name>`,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postName: HTTP ${res.status}`);
}

// Reference shape (from /systemtimeout):
//   <systemtimeout>
//     <enabled>true</enabled>
//     <minutes>20</minutes>
//   </systemtimeout>
// `minutes=0` (with enabled=false) means "never".
export function parseSystemTimeoutEl(el) {
  if (!el) return null;
  const g = (tag) => {
    const col = el.getElementsByTagName(tag);
    return col && col[0] ? col[0].textContent : '';
  };
  const minutes = parseInt(g('minutes'), 10);
  const enabled = g('enabled');
  return {
    enabled: enabled === 'true',
    minutes: isNaN(minutes) ? 0 : minutes,
  };
}

export function parseSystemTimeoutXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('systemtimeout');
  if (!els || !els[0]) return null;
  return parseSystemTimeoutEl(els[0]);
}

export async function getSystemTimeout() {
  const res = await fetch(`${apiBase}/speaker/systemtimeout`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getSystemTimeout: HTTP ${res.status}`);
  return parseSystemTimeoutXml(await res.text());
}

// `minutes=0` is the firmware's "never" sentinel; we send enabled=false
// with minutes=0 so /systemtimeout reflects the off-state on read-back.
export async function postSystemTimeout(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const enabled = m > 0;
  const xml = `<systemtimeout><enabled>${enabled}</enabled><minutes>${m}</minutes></systemtimeout>`;
  const res = await fetch(`${apiBase}/speaker/systemtimeout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postSystemTimeout: HTTP ${res.status}`);
}

export async function postStandby() {
  const res = await fetch(`${apiBase}/speaker/standby`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: '<standby/>',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postStandby: HTTP ${res.status}`);
}

// /setPower wakes from standby. `state` is a string the firmware
// accepts ('ON' / 'OFF'); leaving the wrapper generic so callers can
// experiment without an action-layer rewrite.
export async function postSetPower(state) {
  const xml = `<setPower>${xmlEscape(state)}</setPower>`;
  const res = await fetch(`${apiBase}/speaker/setPower`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postSetPower: HTTP ${res.status}`);
}


// --- bluetooth ------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/bluetoothInfo → { paired: [{name, mac}, ...] }.
// The speaker reports its paired-devices list; pairing-mode state is not in
// this payload (no reliable WS event observed either), so the view uses a
// transient client-side hint after enterBluetoothPairing().
export async function getBluetoothInfo() {
  const res = await fetch(`${apiBase}/speaker/bluetoothInfo`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getBluetoothInfo: HTTP ${res.status}`);
  const text = await res.text();
  return parseBluetoothInfoXml(text);
}

// Parse the speaker's <BluetoothInfo> XML into:
//   { paired: [{ name, mac }, ...] }
//
// Reference shapes (firmware does not publish a schema; observed):
//   Empty:
//     <BluetoothInfo/>
//   or
//     <BluetoothInfo><pairedList/></BluetoothInfo>
//   Populated:
//     <BluetoothInfo>
//       <pairedList>
//         <pairedDevice mac="AA:BB:CC:DD:EE:FF">My Phone</pairedDevice>
//         ...
//       </pairedList>
//     </BluetoothInfo>
//
// Defensive: tolerates either tag-case (BluetoothInfo / bluetoothInfo) and
// missing pairedList.
export function parseBluetoothInfoXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  let root = doc.getElementsByTagName('BluetoothInfo');
  if (!root || !root[0]) root = doc.getElementsByTagName('bluetoothInfo');
  if (!root || !root[0]) return null;

  return parseBluetoothInfoEl(root[0]);
}

// Parse an already-resolved <BluetoothInfo> DOM element.
export function parseBluetoothInfoEl(el) {
  if (!el) return null;
  const devices = el.getElementsByTagName('pairedDevice');
  const paired = [];
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const mac = d.getAttribute('mac') || d.getAttribute('MAC') || '';
    const name = (d.textContent || '').trim();
    paired.push({ name, mac });
  }
  return { paired };
}

// POST /cgi-bin/api/v1/speaker/enterBluetoothPairing — one-shot. Bo's
// firmware accepts an empty body; the proxy just forwards it.
export async function postEnterBluetoothPairing() {
  const res = await fetch(`${apiBase}/speaker/enterBluetoothPairing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: '',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postEnterBluetoothPairing: HTTP ${res.status}`);
}

// POST /cgi-bin/api/v1/speaker/clearBluetoothPaired — one-shot. Empty body.
export async function postClearBluetoothPaired() {
  const res = await fetch(`${apiBase}/speaker/clearBluetoothPaired`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: '',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postClearBluetoothPaired: HTTP ${res.status}`);
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
