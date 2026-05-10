// Read-side XML parsing layer for the Bose SoundTouch admin SPA.
//
// Each speaker field exposes a parser pair:
//   parseXxxXml(text) — entry point for REST fetchers in api.js; parses
//                       a string body and delegates to parseXxxEl.
//   parseXxxEl(el)    — entry point for the WS dispatch path in
//                       speaker-state.js; parses an already-resolved DOM
//                       element from inside an <updates> envelope.
//
// Both forms converge on the same field mapping so REST and WS produce
// identical shapes. Pure / fixture-testable — no fetch, no DOM mutation,
// no module state. Uses getElementsByTagName throughout so the parsers
// work in both browser (DOMParser) and @xmldom/xmldom (test runtime).
//
// Consumers:
//   - admin/app/api.js          — REST getXxx() fetchers call parseXxxXml.
//   - admin/app/speaker-state.js — FIELDS[].parseInline calls parseXxxEl.
//
// XML *builders* (xmlEscape, buildZoneXml, inline string-template XML in
// postX functions) live in api.js — this module is read-only.

// --- nowPlaying -----------------------------------------------------

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

  // <connectionStatusInfo deviceName="…" status="CONNECTED" /> rides
  // alongside the BLUETOOTH source on /now_playing — Bo's firmware does
  // not expose the active BT pairing anywhere else. Surfaced here so the
  // settings/bluetooth view can read it without a second parse pass.
  const csi = g(np, 'connectionStatusInfo');
  const connection = csi ? {
    deviceName: csi.getAttribute('deviceName') || '',
    status:     csi.getAttribute('status') || '',
  } : null;

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
    connection,
  };
}

// --- info -----------------------------------------------------------

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

// --- sources --------------------------------------------------------

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

// --- capabilities ---------------------------------------------------

// Parse the speaker's <capabilities> XML into:
//   { deviceID, dspMonoStereo, lrStereoCapable, bcoresetCapable,
//     disablePowerSaving, lightswitch, clockDisplay, capabilities: [{name,url}] }
//
// Reference shape (Bo's firmware — docs are out of date):
//   <capabilities deviceID="...">
//     <networkConfig>...</networkConfig>
//     <dspCapabilities>
//       <dspMonoStereo available="false"/>
//     </dspCapabilities>
//     <lightswitch>false</lightswitch>
//     <clockDisplay>false</clockDisplay>
//     <capability name="systemtimeout" url="/systemtimeout" info=""/>
//     <capability name="rebroadcastlatencymode" url="/rebroadcastlatencymode" info=""/>
//     <lrStereoCapable>true</lrStereoCapable>
//     <bcoresetCapable>false</bcoresetCapable>
//     <disablePowerSaving>true</disablePowerSaving>
//   </capabilities>
export function parseCapabilitiesXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('capabilities');
  if (!els || !els[0]) return null;
  return parseCapabilitiesEl(els[0]);
}

export function parseCapabilitiesEl(el) {
  if (!el) return null;

  // Boolean leaves can either appear as a child with text content or be
  // missing entirely. Treat missing as false; "true"/"false" as expected.
  const boolText = (tag) => {
    const col = el.getElementsByTagName(tag);
    if (!col || !col[0] || col[0].parentNode !== el) return false;
    return (col[0].textContent || '').trim() === 'true';
  };

  // dspMonoStereo lives inside <dspCapabilities> and reports an
  // available="…" attribute, not a text body.
  let dspMonoStereo = false;
  const dspCaps = el.getElementsByTagName('dspCapabilities');
  if (dspCaps && dspCaps[0]) {
    const dms = dspCaps[0].getElementsByTagName('dspMonoStereo');
    if (dms && dms[0]) {
      dspMonoStereo = dms[0].getAttribute('available') === 'true';
    }
  }

  const capItems = el.getElementsByTagName('capability');
  const capabilities = [];
  for (let i = 0; i < capItems.length; i++) {
    const c = capItems[i];
    capabilities.push({
      name: c.getAttribute('name') || '',
      url:  c.getAttribute('url')  || '',
    });
  }

  return {
    deviceID:           el.getAttribute('deviceID') || '',
    dspMonoStereo,
    lrStereoCapable:    boolText('lrStereoCapable'),
    bcoresetCapable:    boolText('bcoresetCapable'),
    disablePowerSaving: boolText('disablePowerSaving'),
    lightswitch:        boolText('lightswitch'),
    clockDisplay:       boolText('clockDisplay'),
    capabilities,
  };
}

// --- recents --------------------------------------------------------

// Parse the speaker's <recents> XML into an array. Empty <recents/> → [].
//
// Reference shape (captured from Bo):
//   <recents>
//     <recent deviceID="..." utcTime="1778423423" id="...">
//       <contentItem source="TUNEIN" type="stationurl"
//                    location="/v1/playback/station/s10637"
//                    sourceAccount="" isPresetable="true">
//         <itemName>95.5 Charivari</itemName>
//         <containerArt>https://.../logo.jpg</containerArt>
//       </contentItem>
//     </recent>
//     ...
//   </recents>
//
// `itemName` and `containerArt` may be absent on bare contentItem nodes.
export function parseRecentsXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('recents');
  if (!els || !els[0]) return null;
  return parseRecentsEl(els[0]);
}

export function parseRecentsEl(el) {
  if (!el) return null;
  const items = el.getElementsByTagName('recent');
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const cis = r.getElementsByTagName('contentItem');
    const ci = cis && cis[0];
    if (!ci) continue;

    const inner = (tag) => {
      const c = ci.getElementsByTagName(tag);
      return c && c[0] ? (c[0].textContent || '').trim() : '';
    };

    const utc = parseInt(r.getAttribute('utcTime') || '', 10);
    out.push({
      utcTime:       isNaN(utc) ? null : utc,
      source:        ci.getAttribute('source') || '',
      sourceAccount: ci.getAttribute('sourceAccount') || '',
      type:          ci.getAttribute('type') || '',
      location:      ci.getAttribute('location') || '',
      itemName:      inner('itemName'),
      containerArt:  inner('containerArt'),
    });
  }
  return out;
}

// --- speaker name ---------------------------------------------------

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

// --- sleep timer / system timeout -----------------------------------

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

// --- bluetooth ------------------------------------------------------

// Parse the speaker's <BluetoothInfo> XML into:
//   { macAddress }
//
// Reference shape (verified on Bo with iPhone actively paired):
//   <BluetoothInfo BluetoothMACAddress="0CB2B709F837"/>
//
// The firmware never materialises a <pairedList> — earlier releases of
// this admin parsed one speculatively; the populated shape was never
// observed in the wild. The currently-connected device is exposed via
// /now_playing's <connectionStatusInfo> instead (see parseNowPlayingEl).
//
// Defensive: tolerates either tag-case (BluetoothInfo / bluetoothInfo).
export function parseBluetoothInfoXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  let root = doc.getElementsByTagName('BluetoothInfo');
  if (!root || !root[0]) root = doc.getElementsByTagName('bluetoothInfo');
  if (!root || !root[0]) return null;

  return parseBluetoothInfoEl(root[0]);
}

// Parse an already-resolved <BluetoothInfo> DOM element. Reads only the
// speaker's own MAC; ignores any speculative children.
export function parseBluetoothInfoEl(el) {
  if (!el) return null;
  const macAddress = el.getAttribute('BluetoothMACAddress') ||
                     el.getAttribute('macAddress') ||
                     '';
  return { macAddress };
}

// --- multi-room zone -----------------------------------------------

// Parse the speaker's <zone> XML into:
//   { master, masterIpAddress, isMaster, members: [{ipAddress, deviceID, role}, ...] }
//
// Reference shapes:
//
//   Standalone (captured from Bo, single-speaker network):
//     <zone />
//
//   Master (synthesised from libsoundtouch/bosesoundtouchapi clients):
//     <zone master="MASTER_DEVID">
//       <member ipaddress="..." role="LEFT">SLAVE_DEVID</member>
//     </zone>
//
//   Member (synthesised, slave-side view):
//     <zone master="MASTER_DEVID" senderIPAddress="MASTER_IP" senderIsMaster="false">
//       <member ipaddress="..." [role="..."]>DEVID</member>
//     </zone>
//
// `senderIPAddress` is set on the slave's view (forwarded from master)
// and absent on the master's own /getZone response. We use that as the
// master/member discriminator (matches libsoundtouch's `is_master`).
//
// Standalone returns a non-null object with master='' and members=[]
// so the view can branch on `members.length` and presence of `master`.
export function parseZoneXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('zone');
  if (!els || !els[0]) return null;
  return parseZoneEl(els[0]);
}

export function parseZoneEl(el) {
  if (!el) return null;
  const master          = el.getAttribute('master') || '';
  const masterIpAddress = el.getAttribute('senderIPAddress') || '';
  const isMaster        = !!master && masterIpAddress === '';

  const memberEls = el.getElementsByTagName('member');
  const members = [];
  for (let i = 0; i < memberEls.length; i++) {
    const m = memberEls[i];
    members.push({
      deviceID:  (m.textContent || '').trim(),
      ipAddress: m.getAttribute('ipaddress') || '',
      role:      m.getAttribute('role') || '',
    });
  }

  return { master, masterIpAddress, isMaster, members };
}

// --- discovery (multi-room peer picker) -----------------------------

// Parse <ListMediaServersResponse> XML. Reference shape (from Bo):
//   <ListMediaServersResponse>
//     <media_server id="..." mac="..." ip="..." manufacturer="..."
//                   model_name="..." friendly_name="..."
//                   model_description="..." location="..."/>
//     ...
//   </ListMediaServersResponse>
export function parseListMediaServersXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) return null;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const els = doc.getElementsByTagName('ListMediaServersResponse');
  if (!els || !els[0]) return null;
  return parseListMediaServersEl(els[0]);
}

// Filters to entries the firmware identifies as Bose/SoundTouch. We
// keep `mac`, `ip`, and `name` (preferring friendly_name) — that's
// everything the picker needs to render and to call addZoneSlave.
export function parseListMediaServersEl(el) {
  if (!el) return null;
  const items = el.getElementsByTagName('media_server');
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const manuf = m.getAttribute('manufacturer') || '';
    const model = m.getAttribute('model_name') || '';
    const desc  = m.getAttribute('model_description') || '';
    if (!/Bose/i.test(manuf) && !/SoundTouch/i.test(model) && !/SoundTouch/i.test(desc)) {
      continue;
    }
    const name = (m.getAttribute('friendly_name') || '').trim() ||
                 (m.getAttribute('model_name') || '').trim() ||
                 'SoundTouch speaker';
    out.push({
      mac:  m.getAttribute('mac') || '',
      ip:   m.getAttribute('ip')  || '',
      name,
      model,
    });
  }
  return out;
}
