// REST transport for /cgi-bin/api/v1/* — read (GET) + write (POST).
// Thin wrappers around fetch(). XML parsing has moved to ./speaker-xml.js;
// this file imports the parsers that the GET fetchers consume internally.
// See admin/PLAN.md § REST API.
//
// Surface:
//   tunein*              — TuneIn forwarder (search / browse / station / probe)
//   speakerNowPlaying()  — speaker proxy /now_playing
//   getNowPlaying()      — alias of speakerNowPlaying() (canonical name)
//   getVolume(), postVolume() — GET/POST /speaker/volume
//   getBass(), postBass()       — GET/POST /speaker/bass
//   getBassCapabilities()       — GET /speaker/bassCapabilities
//   getBalance(), postBalance() — GET/POST /speaker/balance
//   getBalanceCapabilities()    — GET /speaker/balanceCapabilities
//   getDSPMonoStereo(), postDSPMonoStereo() — GET/POST /speaker/DSPMonoStereo
//   getSources()         — GET /speaker/sources → array of source objects
//   postSelect()         — POST /speaker/select with a ContentItem (streaming sources)
//   postSelectLocalSource() — POST /speaker/selectLocalSource (AUX, BLUETOOTH)
//   getNetworkInfo()     — GET /networkInfo (read-only network metadata)
//   getCapabilities()    — GET /speaker/capabilities
//   getRecents()         — GET /speaker/recents
//   getZone()            — GET /speaker/getZone (multi-room zone state)
//   postSetZone(), postAddZoneSlave(), postRemoveZoneSlave()
//   getListMediaServers() — discovery surface; SoundTouch peers appear as
//     media_servers whose manufacturer contains "Bose"
//   presetsList(), presetsAssign() — presets CGI envelope client

import {
  parseNowPlayingXml,
  parseInfoXml,
  parseVolumeXml,
  parseBassXml,
  parseBassCapabilitiesXml,
  parseBalanceXml,
  parseBalanceCapabilitiesXml,
  parseDSPMonoStereoXml,
  parseSourcesXml,
  parseNetworkInfoXml,
  parseCapabilitiesXml,
  parseRecentsXml,
  parseNameXml,
  parseSystemTimeoutXml,
  parseBluetoothInfoXml,
  parseZoneXml,
  parseListMediaServersXml,
} from './speaker-xml.js';

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

// --- volume ---------------------------------------------------------

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

// --- capabilities ---------------------------------------------------

// GET /cgi-bin/api/v1/speaker/capabilities → parsed capabilities object.
// Surface used by the System settings section: bullet summary of feature
// flags and the named <capability/> entries.
export async function getCapabilities() {
  const res = await fetch(`${apiBase}/speaker/capabilities`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getCapabilities: HTTP ${res.status}`);
  const text = await res.text();
  return parseCapabilitiesXml(text);
}

// --- recents --------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/recents → array of recent items.
// Each entry:
//   { utcTime, source, sourceAccount, type, location, itemName, containerArt }
// Returned in the order the firmware emits them (newest first on Bo).
export async function getRecents() {
  const res = await fetch(`${apiBase}/speaker/recents`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getRecents: HTTP ${res.status}`);
  const text = await res.text();
  return parseRecentsXml(text);
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

// --- multi-room zone -----------------------------------------------

// GET /cgi-bin/api/v1/speaker/getZone → parsed zone object.
// Bose firmware accepts only GET on /getZone (POST returns 400).
export async function getZone() {
  const res = await fetch(`${apiBase}/speaker/getZone`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getZone: HTTP ${res.status}`);
  return parseZoneXml(await res.text());
}

// POST /cgi-bin/api/v1/speaker/setZone — replace the current zone.
// Body shape (from libsoundtouch's _create_zone):
//   <zone master="MASTER_DEVID" senderIPAddress="MASTER_IP">
//     <member ipaddress="SLAVE_IP">SLAVE_DEVID</member>
//   </zone>
//
// `zone` arg: { master, senderIPAddress?, members: [{deviceID, ipAddress}, ...] }.
export async function postSetZone(zone) {
  const body = buildZoneXml(zone, { includeSenderIP: true });
  const res = await fetch(`${apiBase}/speaker/setZone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postSetZone: HTTP ${res.status}`);
}

// POST /cgi-bin/api/v1/speaker/addZoneSlave — extend an existing zone.
// libsoundtouch omits `senderIPAddress` here (only `master`).
export async function postAddZoneSlave(zone) {
  const body = buildZoneXml(zone, { includeSenderIP: false });
  const res = await fetch(`${apiBase}/speaker/addZoneSlave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postAddZoneSlave: HTTP ${res.status}`);
}

// POST /cgi-bin/api/v1/speaker/removeZoneSlave — drop slaves from a zone.
// Same body shape as addZoneSlave. Per libsoundtouch: removing the last
// slave dissolves the zone; from the slave's side, the documented "leave"
// is the master invoking removeZoneSlave on that member.
export async function postRemoveZoneSlave(zone) {
  const body = buildZoneXml(zone, { includeSenderIP: false });
  const res = await fetch(`${apiBase}/speaker/removeZoneSlave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`postRemoveZoneSlave: HTTP ${res.status}`);
}

function buildZoneXml(zone, { includeSenderIP }) {
  const master = (zone && zone.master) || '';
  const senderIP = (zone && zone.senderIPAddress) || '';
  const members = (zone && Array.isArray(zone.members)) ? zone.members : [];
  const attrs = `master="${master}"` +
    (includeSenderIP && senderIP ? ` senderIPAddress="${senderIP}"` : '');
  const memberXml = members.map((m) => {
    const ip = m.ipAddress || '';
    const id = m.deviceID || '';
    return `<member ipaddress="${ip}">${id}</member>`;
  }).join('');
  return `<zone ${attrs}>${memberXml}</zone>`;
}

// --- discovery (multi-room peer picker) -----------------------------

// GET /cgi-bin/api/v1/speaker/listMediaServers → array of peer objects.
// SoundTouch firmware emits this via UPnP/SSDP discovery, which on a
// single-speaker network returns DLNA media servers (router etc.) but
// no SoundTouch peers. parseListMediaServersEl filters to Bose-marked
// entries so the multi-room picker doesn't show the user's FRITZ!Box.
//
// Returns [] on no peers, null on parse failure.
export async function getListMediaServers() {
  const res = await fetch(`${apiBase}/speaker/listMediaServers`, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`getListMediaServers: HTTP ${res.status}`);
  return parseListMediaServersXml(await res.text());
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

// POST /refresh-all — bulk re-probe each preset slot, atomically rewrite
// resolver JSON files whose stream URLs have drifted. Returns the
// envelope verbatim so callers can render per-slot status:
//   { ok:true, data: { updated:[sid...], unchanged:[sid...],
//                      failed:[{sid, error}, ...] } }
// Transport errors throw; structured `{ok:false, error}` envelopes
// resolve normally.
export async function postRefreshAll() {
  const res = await fetch(`${apiBase}/refresh-all`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`postRefreshAll: malformed response (HTTP ${res.status})`);
  }
  return body;
}
