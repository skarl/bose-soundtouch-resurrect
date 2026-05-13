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

// Default per-method timeouts. Reads stay short so REST polling can't
// stall behind a hung GET; writes match the server-side `curl --max-time 10`
// on /select so the client gives the speaker the full window the CGI
// allows before giving up.
export const DEFAULT_READ_TIMEOUT_MS = 5000;
export const DEFAULT_WRITE_TIMEOUT_MS = 10000;

// fetchWithTimeout — fetch() wrapped in an AbortController that fires
// after `timeoutMs`. On timeout we throw a tagged Error (name
// 'TimeoutError') so callers can distinguish a stalled speaker from a
// real abort coming from the view's unmount signal.
//
// The timer is cleared in both the success and the failure path so a
// long polling loop doesn't leak a setTimeout/AbortController pair per
// request. If the caller passes their own AbortSignal via opts.signal,
// we honour it: aborting that signal cancels the fetch and clears the
// timeout the same as a natural completion.
export async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const externalSignal = opts && opts.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const merged = Object.assign({}, opts || {}, { signal: controller.signal });
    return await fetch(url, merged);
  } catch (err) {
    if (timedOut) {
      throw Object.assign(new Error(`${url} timed out after ${timeoutMs}ms`), {
        name: 'TimeoutError',
        url,
        timeoutMs,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// Envelope-shape sentinel for the structured-error endpoints
// (playGuideId / previewStream / presetsAssign). Matches the
// `{ok:false, error:{code, message}}` schema introduced in #95 so
// callers can treat a timeout the same as any other structured failure.
function timeoutEnvelope() {
  return {
    ok: false,
    error: { code: 'TIMEOUT', message: 'Speaker did not respond in time' },
  };
}

// --- upstream-failure observable ------------------------------------
//
// Every speaker-proxy fetcher routes through this seam: TimeoutError
// from fetchWithTimeout, UPSTREAM_UNREACHABLE envelopes from the speaker
// CGI (HTTP 502 with `{ok:false,error:{code:'UPSTREAM_UNREACHABLE'}}`),
// and the TIMEOUT envelope returned by playGuideId/previewStream/
// presetsAssign all surface as a `failure` notification. Any successful
// speaker-proxy call (HTTP 2xx with no error envelope) surfaces as a
// `success` notification so the blocking-error overlay in shell.js can
// auto-dismiss on the next WS frame or REST poll.
//
// The contract is intentionally small: one listener list, two helpers
// (notifyUpstreamFailure / notifyUpstreamSuccess), and a subscribe API
// that returns an unsubscribe function. TuneIn fetchers (tuneinSearch
// etc.) deliberately do NOT signal, because their failure mode is
// orthogonal to "speaker on port 8090 is asleep" — and the blocking
// overlay should only fire on the latter.

const upstreamListeners = new Set();

// Listener signature: ({ kind: 'failure'|'success', reason?: 'UPSTREAM_UNREACHABLE'|'TIMEOUT' }) => void
export function onUpstreamFailure(listener) {
  upstreamListeners.add(listener);
  return () => upstreamListeners.delete(listener);
}

function notify(event) {
  for (const fn of upstreamListeners) {
    try { fn(event); } catch (_e) { /* swallow */ }
  }
}

function notifyUpstreamFailure(reason) {
  notify({ kind: 'failure', reason });
}

function notifyUpstreamSuccess() {
  notify({ kind: 'success' });
}

// Inspect a parsed JSON envelope for the UPSTREAM_UNREACHABLE / TIMEOUT
// codes the speaker CGI and our wrappers emit. Returns the reason string
// when present, null otherwise. Used by the envelope-returning wrappers
// to fan a notification before resolving with the envelope verbatim.
function upstreamFailureReason(envelope) {
  if (!envelope || envelope.ok !== false || !envelope.error) return null;
  const code = typeof envelope.error === 'string' ? envelope.error : envelope.error.code;
  if (code === 'UPSTREAM_UNREACHABLE' || code === 'TIMEOUT') return code;
  return null;
}

// Try to read a UPSTREAM_UNREACHABLE envelope from a failed-HTTP xmlGet/
// xmlPost response. The speaker CGI emits the envelope as JSON with
// HTTP 502 + content-type application/json (see admin/cgi-bin/api/v1/speaker).
// If we can parse the body and it carries UPSTREAM_UNREACHABLE, fan a
// failure notification. Errors (non-JSON body, etc.) are swallowed —
// the caller still throws on the non-2xx status as before.
async function detectUpstreamFailureFromHttpError(res) {
  const ct = (res && res.headers && typeof res.headers.get === 'function') ? res.headers.get('content-type') : '';
  if (!ct || !/json/i.test(ct)) return;
  let body;
  try { body = await res.clone().json(); }
  catch (_e) { return; }
  const reason = upstreamFailureReason(body);
  if (reason) notifyUpstreamFailure(reason);
}

// --- transport helpers ---------------------------------------------
//
// xmlGet / xmlPost are the single seam every speaker fetcher routes
// through. URL composition, XML headers, no-store caching, and HTTP
// error mapping live here once; per-endpoint functions become a
// one-line binding of `path` + `parser`.

async function xmlGet(path, parser) {
  let res;
  try {
    res = await fetchWithTimeout(`${apiBase}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/xml, text/xml' },
      cache: 'no-store',
    }, DEFAULT_READ_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'TimeoutError') notifyUpstreamFailure('TIMEOUT');
    throw err;
  }
  if (!res.ok) {
    await detectUpstreamFailureFromHttpError(res);
    throw new Error(`${path} failed: HTTP ${res.status}`);
  }
  const value = parser(await res.text());
  notifyUpstreamSuccess();
  return value;
}

async function xmlPost(path, body) {
  let res;
  try {
    res = await fetchWithTimeout(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
      cache: 'no-store',
    }, DEFAULT_WRITE_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'TimeoutError') notifyUpstreamFailure('TIMEOUT');
    throw err;
  }
  if (!res.ok) {
    await detectUpstreamFailureFromHttpError(res);
    throw new Error(`${path} failed: HTTP ${res.status}`);
  }
  notifyUpstreamSuccess();
}

// --- TuneIn forwarder -----------------------------------------------
//
// All four methods return the raw TuneIn JSON body, verbatim. No
// envelope; classification (gated / dark / playable) lives in
// app/reshape.js.

async function getJson(path, opts) {
  const res = await fetchWithTimeout(`${apiBase}${path}`, {
    headers: { Accept: 'application/json' },
    signal: opts && opts.signal,
  }, DEFAULT_READ_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

// tuneinSearch(q, opts) — TuneIn's Search.ashx, no upstream filter by
// default so the response interleaves stations (`s`), shows (`p`),
// topics (`t`), and artists (`m`). The 0.4.2 search reframe makes the
// search surface the universal "find anything Bo can play" view — see
// docs/tunein-api.md and issue #80.
//
//   opts.stationsOnly = true   → re-apply filter=s:popular (the old
//                                pre-0.4.2 behaviour, kept for power
//                                users who want the stations-only list).
//
// TuneIn's Search.ashx expects `query=`; sending `q=` returns
// {head: {status: 400, fault: "Empty Query specified"}} with no body.
export function tuneinSearch(q, opts) {
  const params = { query: q };
  if (opts && opts.stationsOnly) params.filter = 's:popular';
  const qs = new URLSearchParams(params).toString();
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

// tuneinDescribe({ c: 'languages' }) → Describe.ashx?c=languages.
// Used at app load to populate the lcode allow-list (see § 7.5).
// Accepts the same shape as tuneinBrowse for symmetry.
export function tuneinDescribe(arg, opts) {
  let qs = '';
  if (arg && typeof arg === 'object') {
    qs = '?' + new URLSearchParams(arg).toString();
  }
  return getJson(`/tunein/describe${qs}`, opts);
}

export function tuneinStation(sid, opts) {
  return getJson(`/tunein/station/${encodeURIComponent(sid)}`, opts);
}

export function tuneinProbe(sid, opts) {
  return getJson(`/tunein/probe/${encodeURIComponent(sid)}`, opts);
}

// --- speaker proxy --------------------------------------------------

export function speakerNowPlaying() {
  return xmlGet('/speaker/now_playing', parseNowPlayingXml);
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
  let res;
  try {
    res = await fetchWithTimeout(`${apiBase}/presets`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }, DEFAULT_READ_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'TimeoutError') notifyUpstreamFailure('TIMEOUT');
    throw err;
  }
  // Even on 4xx/5xx the CGI emits a JSON envelope, so we parse rather
  // than treat HTTP status as the only signal.
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`presetsList: malformed response (HTTP ${res.status})`);
  }
  const reason = upstreamFailureReason(body);
  if (reason) notifyUpstreamFailure(reason);
  else if (body && body.ok) notifyUpstreamSuccess();
  return body;
}

// POST /preview with {id, name, json} — writes the per-station Bose
// JSON atomically and asks the speaker to /select it. Used by the
// station-detail audition button so the user can hear the chosen
// stream on Bo before committing it as a preset.
export async function previewStream(payload) {
  let res;
  try {
    res = await fetchWithTimeout(`${apiBase}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    }, DEFAULT_WRITE_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      notifyUpstreamFailure('TIMEOUT');
      return timeoutEnvelope();
    }
    throw err;
  }
  let body;
  try { body = await res.json(); }
  catch (err) { throw new Error(`previewStream: malformed response (HTTP ${res.status})`); }
  const reason = upstreamFailureReason(body);
  if (reason) notifyUpstreamFailure(reason);
  else if (body && body.ok) notifyUpstreamSuccess();
  return body;
}

// POST /play with {id:<guide_id>} — ephemeral playback. Resolves the
// guide_id via Tune.ashx on-device, filters the two known placeholder
// URLs, and asks the speaker to /select the resolved stream. Returns
// the CGI envelope verbatim:
//   { ok: true,  url: "<resolved-stream-url>" }                  on success
//   { ok: false, error: { code: "OFF_AIR",        message } }    nostream
//   { ok: false, error: { code: "NOT_AVAILABLE",  message } }    notcompatible
//   { ok: false, error: { code: "INVALID_ID",     message } }    etc.
//
// The pre-0.4.2 /play CGI emitted a flat `{ok, error: "off-air"}`
// envelope with lowercase-kebab codes. The new envelope nests
// `{code, message}` to match /preview and /presets. cgiErrorMessage()
// in admin/app/error-messages.js absorbs both shapes so legacy speaker
// builds keep producing usable toasts during the rollout window.
//
// Transport errors throw; structured `{ok:false, error}` envelopes
// resolve normally so the caller can route the error to a toast.
//
// Unlike previewStream, no name/json is passed — the CGI does its own
// Tune.ashx lookup and stages a minimal resolver entry only when none
// exists, so preset entries with hand-curated names survive.
//
// `cachedUrl` (optional): a previously-resolved stream URL the caller
// pulled from tunein-cache. When present, the CGI skips Tune.ashx and
// goes straight to /select, but still applies the placeholder filter
// so a stale cache entry can never select a tombstone.
export async function playGuideId(guideId, name, cachedUrl) {
  // #99: `name` is structurally required. The CGI writes it into both
  // the resolver's `name` field and <itemName> on the /select POST;
  // without it the mini-player surfaces the raw guide_id (the c9d8396
  // regression). Throw synchronously so the bug is caught at the
  // callsite rather than waiting for the user to see the sid live.
  if (typeof name !== 'string' || !name) {
    throw new Error('playGuideId: label is required');
  }
  const payload = { id: guideId, name };
  if (typeof cachedUrl === 'string' && cachedUrl) payload.url = cachedUrl;
  let res;
  try {
    res = await fetchWithTimeout(`${apiBase}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    }, DEFAULT_WRITE_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      notifyUpstreamFailure('TIMEOUT');
      return timeoutEnvelope();
    }
    throw err;
  }
  let body;
  try { body = await res.json(); }
  catch (err) { throw new Error(`playGuideId: malformed response (HTTP ${res.status})`); }
  const reason = upstreamFailureReason(body);
  if (reason) notifyUpstreamFailure(reason);
  else if (body && body.ok) notifyUpstreamSuccess();
  return body;
}

// POST /speaker/key — hardware key event. Used to send POWER for
// "stop preview" (the speaker treats POWER as standby).
export async function speakerKey(name, state) {
  await xmlPost('/speaker/key', `<key state="${state}" sender="Gabbo">${name}</key>`);
  return true;
}

// GET /cgi-bin/api/v1/speaker/info → parsed info object.
// Fields: deviceID, name, type, firmwareVersion (plus any others present).
export function getSpeakerInfo() {
  return xmlGet('/speaker/info', parseInfoXml);
}

// --- volume ---------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/volume
export function getVolume() {
  return xmlGet('/speaker/volume', parseVolumeXml);
}

// POST /cgi-bin/api/v1/speaker/volume with body <volume>NN</volume>.
// Throws on non-2xx.
export function postVolume(level) {
  return xmlPost('/speaker/volume', `<volume>${Math.round(level)}</volume>`);
}

// --- bass -----------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/bass
export function getBass() {
  return xmlGet('/speaker/bass', parseBassXml);
}

// POST /cgi-bin/api/v1/speaker/bass with body <bass>NN</bass>.
export function postBass(level) {
  return xmlPost('/speaker/bass', `<bass>${Math.round(level)}</bass>`);
}

// GET /cgi-bin/api/v1/speaker/bassCapabilities
export function getBassCapabilities() {
  return xmlGet('/speaker/bassCapabilities', parseBassCapabilitiesXml);
}

// --- balance --------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/balance
export function getBalance() {
  return xmlGet('/speaker/balance', parseBalanceXml);
}

// POST /cgi-bin/api/v1/speaker/balance with body <balance>NN</balance>.
export function postBalance(level) {
  return xmlPost('/speaker/balance', `<balance>${Math.round(level)}</balance>`);
}

// GET /cgi-bin/api/v1/speaker/balanceCapabilities
export function getBalanceCapabilities() {
  return xmlGet('/speaker/balanceCapabilities', parseBalanceCapabilitiesXml);
}

// --- DSP mono/stereo ------------------------------------------------

// GET /cgi-bin/api/v1/speaker/DSPMonoStereo
export function getDSPMonoStereo() {
  return xmlGet('/speaker/DSPMonoStereo', parseDSPMonoStereoXml);
}

// POST /cgi-bin/api/v1/speaker/DSPMonoStereo with body
// <DSPMonoStereo><mono enabled="true|false"/></DSPMonoStereo>.
// mode ∈ 'mono' | 'stereo'.
export function postDSPMonoStereo(mode) {
  const enabled = mode === 'mono' ? 'true' : 'false';
  return xmlPost('/speaker/DSPMonoStereo', `<DSPMonoStereo><mono enabled="${enabled}"/></DSPMonoStereo>`);
}

// --- sources --------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/sources → array of source objects.
// Shape per element: { source, sourceAccount, status, isLocal, displayName }
export function getSources() {
  return xmlGet('/speaker/sources', parseSourcesXml);
}

// POST /cgi-bin/api/v1/speaker/select — switch to a streaming source.
// contentItem: { source, sourceAccount, type?, location? }
// Sends a minimal <ContentItem> that resumes the speaker's last-known
// position for that source. Station-level deep-link is a future improvement.
export function postSelect(contentItem) {
  const { source, sourceAccount = '', type = '', location = '' } = contentItem;
  const xml = `<ContentItem source="${source}" sourceAccount="${sourceAccount}" type="${type}" location="${location}"/>`;
  return xmlPost('/speaker/select', xml);
}

// POST /cgi-bin/api/v1/speaker/selectLocalSource — switch to a local
// source (AUX, BLUETOOTH). Names follow Bose convention: 'AUX', 'BLUETOOTH'.
export function postSelectLocalSource(name) {
  return xmlPost('/speaker/selectLocalSource', `<selectLocalSource>${name}</selectLocalSource>`);
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
export function getNetworkInfo() {
  return xmlGet('/speaker/networkInfo', parseNetworkInfoXml);
}

// --- capabilities ---------------------------------------------------

// GET /cgi-bin/api/v1/speaker/capabilities → parsed capabilities object.
// Surface used by the System settings section: bullet summary of feature
// flags and the named <capability/> entries.
export function getCapabilities() {
  return xmlGet('/speaker/capabilities', parseCapabilitiesXml);
}

// --- recents --------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/recents → array of recent items.
// Each entry:
//   { utcTime, source, sourceAccount, type, location, itemName, containerArt }
// Returned in the order the firmware emits them (newest first on Bo).
export function getRecents() {
  return xmlGet('/speaker/recents', parseRecentsXml);
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

export function getName() {
  return xmlGet('/speaker/name', parseNameXml);
}

export function postName(name) {
  return xmlPost('/speaker/name', `<name>${xmlEscape(name)}</name>`);
}

export function getSystemTimeout() {
  return xmlGet('/speaker/systemtimeout', parseSystemTimeoutXml);
}

// `minutes=0` is the firmware's "never" sentinel; we send enabled=false
// with minutes=0 so /systemtimeout reflects the off-state on read-back.
export function postSystemTimeout(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const enabled = m > 0;
  return xmlPost(
    '/speaker/systemtimeout',
    `<systemtimeout><enabled>${enabled}</enabled><minutes>${m}</minutes></systemtimeout>`,
  );
}

// --- bluetooth ------------------------------------------------------

// GET /cgi-bin/api/v1/speaker/bluetoothInfo → { paired: [{name, mac}, ...] }.
// The speaker reports its paired-devices list; pairing-mode state is not in
// this payload (no reliable WS event observed either), so the view uses a
// transient client-side hint after enterBluetoothPairing().
export function getBluetoothInfo() {
  return xmlGet('/speaker/bluetoothInfo', parseBluetoothInfoXml);
}

// POST /cgi-bin/api/v1/speaker/enterBluetoothPairing — one-shot. Bo's
// firmware accepts an empty body; the proxy just forwards it.
export function postEnterBluetoothPairing() {
  return xmlPost('/speaker/enterBluetoothPairing', '');
}

// POST /cgi-bin/api/v1/speaker/clearBluetoothPaired — one-shot. Empty body.
export function postClearBluetoothPaired() {
  return xmlPost('/speaker/clearBluetoothPaired', '');
}

// --- multi-room zone -----------------------------------------------

// GET /cgi-bin/api/v1/speaker/getZone → parsed zone object.
// Bose firmware accepts only GET on /getZone (POST returns 400).
export function getZone() {
  return xmlGet('/speaker/getZone', parseZoneXml);
}

// POST /cgi-bin/api/v1/speaker/setZone — replace the current zone.
// Body shape (from libsoundtouch's _create_zone):
//   <zone master="MASTER_DEVID" senderIPAddress="MASTER_IP">
//     <member ipaddress="SLAVE_IP">SLAVE_DEVID</member>
//   </zone>
//
// `zone` arg: { master, senderIPAddress?, members: [{deviceID, ipAddress}, ...] }.
export function postSetZone(zone) {
  return xmlPost('/speaker/setZone', buildZoneXml(zone, { includeSenderIP: true }));
}

// POST /cgi-bin/api/v1/speaker/addZoneSlave — extend an existing zone.
// libsoundtouch omits `senderIPAddress` here (only `master`).
export function postAddZoneSlave(zone) {
  return xmlPost('/speaker/addZoneSlave', buildZoneXml(zone, { includeSenderIP: false }));
}

// POST /cgi-bin/api/v1/speaker/removeZoneSlave — drop slaves from a zone.
// Same body shape as addZoneSlave. Per libsoundtouch: removing the last
// slave dissolves the zone; from the slave's side, the documented "leave"
// is the master invoking removeZoneSlave on that member.
export function postRemoveZoneSlave(zone) {
  return xmlPost('/speaker/removeZoneSlave', buildZoneXml(zone, { includeSenderIP: false }));
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
export function getListMediaServers() {
  return xmlGet('/speaker/listMediaServers', parseListMediaServersXml);
}

// POST /presets/:slot with {id, slot, name, kind, json}.
// Slot is 1..6; payload must include matching `slot` and `kind:"playable"`
// (the CGI rejects anything else with a structured error).
export async function presetsAssign(slot, payload) {
  let res;
  try {
    res = await fetchWithTimeout(`${apiBase}/presets/${encodeURIComponent(slot)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    }, DEFAULT_WRITE_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      notifyUpstreamFailure('TIMEOUT');
      return timeoutEnvelope();
    }
    throw err;
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`presetsAssign: malformed response (HTTP ${res.status})`);
  }
  const reason = upstreamFailureReason(body);
  if (reason) notifyUpstreamFailure(reason);
  else if (body && body.ok) notifyUpstreamSuccess();
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
  let res;
  try {
    res = await fetchWithTimeout(`${apiBase}/refresh-all`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }, DEFAULT_WRITE_TIMEOUT_MS);
  } catch (err) {
    if (err && err.name === 'TimeoutError') notifyUpstreamFailure('TIMEOUT');
    throw err;
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`postRefreshAll: malformed response (HTTP ${res.status})`);
  }
  const reason = upstreamFailureReason(body);
  if (reason) notifyUpstreamFailure(reason);
  else if (body && body.ok) notifyUpstreamSuccess();
  return body;
}
