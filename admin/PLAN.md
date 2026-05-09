# Admin web UI — design plan

A full speaker dashboard, hosted on the speaker itself. The admin replaces
not just the `build.py` + `scp` + `curl /storePreset` flow, but everything
the original SoundTouch app could do over the LAN: now-playing, transport,
volume, source switching, presets, search & browse, settings.

**Status:** plan only. No implementation yet. This document is the spec
for that implementation.

## Goals (v1.0)

1. **Replace the SoundTouch app for everything LAN-side.** Pairing, volume,
   source switching, presets, current track display, bass/balance,
   Bluetooth pairing, multi-room.
2. **Browse and search TuneIn from the speaker.** Genre tree, location
   tree, language tree, search, station detail, assign-to-preset.
3. **Live updates from the speaker** via the firmware's existing
   WebSocket on TCP 8080.
4. **Run entirely on the speaker.** No laptop dependency once deployed.
   Reachable at `http://<speaker-name>/` (port 80) so any browser on the
   LAN — phone, tablet, laptop — opens it without remembering a port.

Out of scope for v1.0:

- Wi-Fi reconfiguration (deliberately not exposed — too easy to lock
  yourself out).
- Firmware updates (deliberately blocked).
- Spotify account binding (cloud-coupled; gone).
- Authentication (LAN trust model — see `../SECURITY.md`).
- Multi-speaker control (one speaker per admin instance for v1).
- Internationalisation (English-only strings; the architecture won't
  block adding more later).

## Architecture

```
Browser (any LAN device)
  │
  │  Static SPA + REST CGIs (HTTP)
  │  WebSocket (live updates)
  │
  ▼
Speaker, port 80 (LAN-exposed)
 ┌─────────────────────────────────────────────────┐
 │  port80-router.sh                               │
 │   ├─ if hostapd / setup-AP-IP detected:         │
 │   │    exec /opt/Bose/PtsServer pts-handler 80  │  ← captive portal
 │   └─ else:                                       │   preserved
 │        exec busybox httpd -h /mnt/nv/resolver   │  ← admin SPA + CGIs
 └─────────────────────────────────────────────────┘
                              │
                              ▼
                /mnt/nv/resolver/  (single docroot, two purposes)
                ├── index.html          ← admin SPA shell
                ├── style.css
                ├── app/                ← ES module tree
                │   ├── main.js
                │   ├── router.js
                │   ├── state.js
                │   ├── api.js
                │   ├── reshape.js
                │   ├── dom.js
                │   ├── ws.js
                │   └── views/
                │       ├── now-playing.js
                │       ├── browse.js
                │       ├── search.js
                │       ├── station.js
                │       └── settings.js
                ├── cgi-bin/api/v1/     ← REST endpoints (shell CGIs)
                │   ├── tunein
                │   ├── presets
                │   ├── speaker
                │   └── refresh-all
                └── bmx/, marge/, v1/   ← existing resolver tree
                                            (loopback-only via :8181)

Speaker, port 8181 (loopback only)  ← unchanged: BoseApp's metadata calls
Speaker, port 8090 (LAN-exposed)    ← unchanged: speaker's own local API
Speaker, port 8080 (LAN-exposed)    ← unchanged: WebSocket events
```

### The two HTTP servers

After the admin is installed, the speaker runs **two** busybox httpd
processes plus the existing port-80 router:

| Port              | Listener                  | Purpose                                                                   |
| ----------------- | ------------------------- | ------------------------------------------------------------------------- |
| `0.0.0.0:80`      | port80-router.sh wrapper  | Admin in connected mode; falls back to PtsServer in setup-AP mode |
| `127.0.0.1:8181`  | busybox httpd (resolver)  | BoseApp's metadata lookups (loopback only — never LAN-exposed) |
| `0.0.0.0:8080`    | speaker firmware          | WebSocket events (consumed by admin)                                      |
| `0.0.0.0:8090`    | speaker firmware          | Local control API (consumed by admin)                                     |

The admin SPA talks to all three of those last entries. The port-80 admin
serves the SPA and proxies TuneIn calls; the SPA talks directly to 8090
and 8080 from the browser.

## Port-80 takeover with captive-portal preservation

`PtsServer` (the firmware's port-80 listener) serves three things:

1. The **"SoundTouch Access Point Setup"** captive portal — used during
   initial Wi-Fi onboarding and after factory reset. Critical.
2. AirPlay2 album-art at `/var/run/AirPlay2/*.jpg` — minor side feature.
3. Diagnostic log dumps (`/logread.dat`, `/pts.dat`) — only available in
   setup mode; only meaningful for Bose support.

The speaker's `pts-handler` script has an `is_setup_mode()` function that
distinguishes between AP setup mode and normal connected mode. Our
wrapper replicates it:

```sh
#!/bin/sh
# /mnt/nv/bin/port80-router.sh
#
# Replaces the firmware's PtsServer entry. Decides at boot whether the
# speaker is in AP-setup mode (in which case Bose's captive portal is
# critical for re-onboarding Wi-Fi) or normal connected mode (in which
# case we serve the admin UI). Replicates pts-handler's is_setup_mode.

sleep 3   # let networking settle

is_setup_mode() {
    local module_type
    read module_type < /proc/module_type 2>/dev/null
    if [ "$module_type" = scm ]; then
        # Older "scm" hardware: AP-side IP on eth0
        ip addr show eth0 2>/dev/null | grep -q ' inet 192.168.1.1'
    else
        # Newer "sm2" / others: hostapd presence
        pgrep hostapd >/dev/null
    fi
}

if is_setup_mode; then
    exec /opt/Bose/PtsServer /opt/Bose/pts-handler 80
else
    exec /bin/httpd -f -p 0.0.0.0:80 -h /mnt/nv/resolver
fi
```

To replace PtsServer with this wrapper, override `/opt/Bose/etc/Shepherd-core.xml`
by writing a real `/mnt/nv/shepherd/Shepherd-core.xml` file (currently a
symlink) that drops the `<daemon name="PtsServer">` block, and add the
new daemon to `/mnt/nv/shepherd/Shepherd-resolver.xml`:

```xml
<ShepherdConfig>
  <daemon name="/bin/httpd">
    <arg>-f</arg>
    <arg>-p</arg>
    <arg>127.0.0.1:8181</arg>
    <arg>-h</arg>
    <arg>/mnt/nv/resolver</arg>
  </daemon>
  <daemon name="/bin/sh">
    <arg>/mnt/nv/bin/port80-router.sh</arg>
  </daemon>
</ShepherdConfig>
```

In normal connected mode, the LAN sees the admin at `http://<speaker>/`
(port 80) and `http://<speaker>:8181/` is loopback-only. In AP-setup mode,
the wrapper hands off to PtsServer and the captive portal works exactly
as it always did.

**Trade-off:** AirPlay2 album-art-via-HTTP at `/var/run/AirPlay2/*` is no
longer served in normal mode. Album art for AirPlay sessions can still
be fetched via the speaker's port-8090 `/art` endpoint, which the admin
uses.

**Reversal:** uninstall removes the wrapper and the Shepherd-core
override. shepherdd reads the original `/opt/Bose/etc/Shepherd-core.xml`
again on next boot. PtsServer is back. Factory reset has the same
effect (it wipes `/mnt/nv` entirely).

## Routing — hash-based

The SPA uses URL hashes for navigation. busybox httpd doesn't do URL
rewrites, and we don't want to ship `httpd.conf` shaping. Hash routing
means a single `index.html` + JS reading `location.hash`; deep links and
browser back/forward work; no server config.

| Hash route                 | View                          | Notes |
| -------------------------- | ----------------------------- | ----- |
| `#/`                       | now-playing                   | Default; what's playing now + transport + presets row + volume + source picker |
| `#/browse`                 | browse root                   | Tabs: Genre / Location / Language. Initial drilling target. |
| `#/browse?id=<g\|c\|r>NN`  | browse drill                  | Children of any TuneIn taxonomy node. Breadcrumb. |
| `#/search`                 | search empty                  | Empty input + "what's popular" suggestions |
| `#/search?q=...`           | search results                | Debounced; shows mixed-type results filtered to stations |
| `#/station/sNNN`           | station detail                | Full Describe.ashx info + probe state + 6 assign buttons + test-play |
| `#/preset/N`               | preset modal                  | Triggered from now-playing's preset row; opens search/browse to replace this slot |
| `#/settings`               | settings                      | Sub-sections (Speaker / Audio / Bluetooth / Multi-room / Network / System / Notifications) |

## State management

A single observable store. Each view is `render(state) → HTML string`.
State change → re-render the active view. No virtual DOM, no diffing —
fast enough for ~30 cards on screen at a time.

```js
// app/state.js
export const state = observable({
  // From the speaker (live via WebSocket; initial via REST)
  speaker: {
    info:     null,   // {deviceID, name, type, firmwareVersion, ...}
    nowPlaying: null, // {source, item, track, artist, art, playStatus}
    presets:  null,   // [{slot, source, type, location, itemName, art}, ...] (length 6)
    volume:   null,   // {actualVolume, targetVolume, muteEnabled}
    bass:     null,   // {actualBass, targetBass, range}
    sources:  null,   // [{source, status: READY|UNAVAILABLE, ...}]
    zone:     null,   // {master, members[]} or null if solo
    bluetooth: null,  // {paired[], state}
    network:  null,   // {ssid, ip, mac, ...}
  },

  // Browse + search transient state
  browse: { id: null, items: null, breadcrumbs: [], loading: false },
  search: { q: '', results: null, loading: false, error: null },
  station: { id: null, detail: null, probe: null, loading: false },

  // Per-session probe cache (10 min TTL) so flipping back to a station
  // doesn't re-probe Tune.ashx every time
  probeCache: new Map(), // id -> {ok, kind, url, expires}

  // UI bits
  ws: { connected: false, lastEvent: null },
  toast: null,
  testPlaying: null,    // station ID currently in test-play
});
```

## REST API — `/cgi-bin/api/v1/*`

All endpoints return a consistent envelope:

```json
{ "ok": true,  "data": ... }
{ "ok": false, "error": { "code": "TUNEIN_GATED", "message": "..." } }
```

Every CGI sets `Content-Type: application/json; charset=utf-8` and
`Cache-Control: no-store`. Implemented as small busybox-shell CGIs
(~30–60 lines each). Endpoints:

### `tunein` — TuneIn proxy

```
GET /cgi-bin/api/v1/tunein/search?q=jazz&type=station
GET /cgi-bin/api/v1/tunein/browse              → root nodes
GET /cgi-bin/api/v1/tunein/browse?id=g22       → children of node
GET /cgi-bin/api/v1/tunein/station/sNNN        → Describe.ashx
GET /cgi-bin/api/v1/tunein/probe/sNNN          → Tune.ashx + classify
```

The proxy injects `formats=mp3,aac` and `lang=de-de` (the magic params)
plus User-Agent `Bose_Lisa/27.0.6`. The `probe` endpoint classifies the
result:

```json
{ "ok": true, "data": { "kind": "playable", "streams": [...], "first": "..." } }
{ "ok": true, "data": { "kind": "gated",   "reason": "notcompatible.enUS.mp3" } }
{ "ok": true, "data": { "kind": "dark",    "reason": "nostream.enUS.mp3" } }
```

The browser caches probe results for 10 minutes per station ID so that
clicking around doesn't re-probe Tune.ashx unnecessarily.

### `presets` — the preset list

```
GET  /cgi-bin/api/v1/presets                       → 6 slots
POST /cgi-bin/api/v1/presets/:slot                 → save+store atomically
```

`POST` body is `{id, name, json}` where `json` is the Bose-shaped
station response (the SPA reshapes from the TuneIn probe; CGI doesn't
parse it). The CGI:

1. Validates `id` matches `^s[0-9]+$` and `slot` is 1–6.
2. Refuses if `kind` from the probe wasn't `playable` (probe required).
3. Writes `json` atomically to `/mnt/nv/resolver/bmx/tunein/v1/playback/station/<id>`.
4. Calls the speaker's port-8090 `/storePreset?id=<slot>` with the
   correct `<preset id="N"><ContentItem .../></preset>` shape.
5. Returns the new full presets list as `data`.

### `speaker` — proxy to the speaker's port-8090 API

The browser CAN call port 8090 directly when CORS permits. For some
endpoints it doesn't (the speaker firmware is conservative with CORS
headers). The `speaker` CGI is a permissive thin proxy that forwards the
exact path and method, and adds proper CORS headers. JSON-on-XML
translation isn't this CGI's job — the SPA is happy to parse XML.

```
GET  /cgi-bin/api/v1/speaker/info             → /info passthrough
GET  /cgi-bin/api/v1/speaker/now_playing      → /now_playing passthrough
GET  /cgi-bin/api/v1/speaker/volume           → /volume passthrough
POST /cgi-bin/api/v1/speaker/volume           → POST /volume passthrough
GET  /cgi-bin/api/v1/speaker/bass             → ditto
…and so on for: name, sources, key, select, setPower, getZone, setZone,
bluetoothInfo, enterBluetoothPairing, clearBluetoothPaired, networkInfo,
notification, capabilities, recents, balance, balanceCapabilities,
DSPMonoStereo, systemtimeout, lowPowerStandby.
```

The CGI takes the path under `/cgi-bin/api/v1/speaker/` and forwards
verbatim to `localhost:8090`. The SPA then parses speaker XML using
small dedicated parsers in `app/api.js` — speaker XML is shallow and
predictable.

### `refresh-all` — bulk stream-URL refresh

```
POST /cgi-bin/api/v1/refresh-all
```

For each preset slot, fetch the current station ID, run probe, and
rewrite the resolver JSON file if the streams changed. Returns
`{updated: [...], unchanged: [...], failed: [...]}`. Equivalent of
running `python3 build.py` from a laptop, but on-speaker.

## Live updates — WebSocket

The speaker firmware's WebSocket on `ws://<speaker>:8080/` streams XML
events in real time. The SPA opens a connection on load:

```js
// app/ws.js
const ws = new WebSocket(`ws://${speakerHost}:8080/`);
ws.addEventListener('message', e => handleSpeakerEvent(e.data));
```

Events handled:

| Event                          | State update                  |
| ------------------------------ | ----------------------------- |
| `<volumeUpdated>`              | `state.speaker.volume`        |
| `<bassUpdated>`                | `state.speaker.bass`          |
| `<balanceUpdated>`             | `state.speaker.balance`       |
| `<nowPlayingUpdated>`          | `state.speaker.nowPlaying`    |
| `<sourcesUpdated>`             | `state.speaker.sources`       |
| `<presetsUpdated>`             | `state.speaker.presets` + toast "Presets changed" |
| `<keyEvent>`                   | toast "Preset N pressed on speaker" — feels alive |
| `<connectionStateUpdated>`     | `state.ws` plus a network-state pill in the header |
| `<zoneUpdated>`                | `state.speaker.zone`          |
| `<recentsUpdated>`             | `state.speaker.recents`       |

**Fallback:** if WS connection fails or drops, the SPA polls
`/now_playing` every 2 seconds while the now-playing tab is visible.
WebSocket reconnect logic uses exponential backoff capped at 30s.

## View specs

### now-playing (`#/`)

```
┌─────────────────────────────────────────────────────────┐
│  ◉ Bo                                ⏻  ●live  [⚙]      │  ← header
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌────────┐   Example Radio                            │
│   │  ART   │   La Bouche – Sweet Dreams                 │
│   │        │   TUNEIN · 128 kbps · liveRadio            │
│   └────────┘                                            │
│                                                         │
│        [⏮]   [▶/⏸]   [⏭]                                │
│                                                         │
│   ───●──────── Volume 32          [🔇]                  │
│                                                         │
│   Source:   ●TuneIn   ○AUX   ○Bluetooth   ○Spotify     │
│                                                         │
│   Presets:                                              │
│   ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐             │
│   │ 1  │ │ 2  │ │ 3  │ │ 4  │ │ 5  │ │ 6  │             │
│   │Ex. │ │... │ │... │ │... │ │... │ │... │             │
│   └────┘ └────┘ └────┘ └────┘ └────┘ └────┘             │
│   tap = play · long-press = replace                     │
└─────────────────────────────────────────────────────────┘
```

State dependencies: `speaker.{nowPlaying, volume, sources, presets, info}`.

Behaviours:

- Active source highlighted; click changes source via `/select` or
  `/selectLocalSource`.
- Volume slider sends throttled `POST /volume` with `<volume>NN</volume>`
  body; updates eagerly, reconciles via WS.
- Preset card click → `POST /key PRESET_N press/release`.
- Long-press / right-click on preset → modal: "Replace this preset" →
  navigates to `#/search` with a `slot=N` context that comes back here
  after assignment.
- Album art: tinted hero background (sample dominant colour from the
  `<art>` URL via canvas; fall back to neutral if CORS blocks).

### browse (`#/browse`)

Three tabs at the top (Genre / Location / Language). Each shows the
top-level outline children. Click any item → drill via
`#/browse?id=<id>` with breadcrumb. Each `audio`-typed leaf shows as a
station card linking to `#/station/sNN`.

### search (`#/search` and `#/search?q=...`)

Sticky search input at top. Debounced 300ms. Hits
`/cgi-bin/api/v1/tunein/search?q=...&type=station`. Results render as
the same cards as browse.

Empty state (no `q` yet): show "Recently viewed" (from localStorage)
and "Popular" (from `/Browse.ashx?c=local`).

### station detail (`#/station/sNNN`)

```
┌─────────────────────────────────────────────────────────┐
│  ←  Example Radio                                       │
├─────────────────────────────────────────────────────────┤
│  ┌────────┐  Example Radio                              │
│  │  LOGO  │  "Aktuelles aus den Charts, neue coole..."  │
│  └────────┘  London, UK · German · Pop · 88.1 FM        │
│                                                         │
│              4 streams · best: 168 kbps AAC · 99% ✓     │
│                                                         │
│              [▶ Test play]  [Cancel test]               │
│                                                         │
│  Set as preset:                                         │
│  [ 1 ]  [ 2 ]  [ 3 ]  [ 4 ]  [ 5 ]  [ 6 ]               │
│                                                         │
│  More like this →                                       │
└─────────────────────────────────────────────────────────┘
```

On view entry:
1. Fetch `Describe.ashx?id=<id>` → fill metadata.
2. Fetch `Tune.ashx?id=<id>` → set probe state (cached for 10 min).
3. If probe is **gated** or **dark**, replace the preset buttons with a
   message "This station isn't available from this client right now."
   plus a "More like this" link.

Test-play: `POST /api/v1/speaker/select` with the speaker's
`<ContentItem>` shape. Doesn't store as preset; doesn't touch
`/mnt/nv/resolver/`. "Cancel test" sends `POST /key POWER` to standby.

Set-as-preset: `POST /api/v1/presets/:slot` with the probed Bose JSON.
The CGI does the resolver write + storePreset call atomically.

### settings (`#/settings`)

Single tab with collapsible sections. Each section reads its state via
the speaker proxy at view-entry; writes go directly through the proxy
too.

| Section                | Content                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| **Speaker**            | Name (editable), power state, sleep timer (`/systemtimeout`), low-power standby |
| **Audio**              | Bass slider, balance slider, mono/stereo switch                         |
| **Bluetooth**          | Paired devices list, "Enter pairing mode" button, "Clear pairings"      |
| **Multi-room**         | Current zone (master/members), add/remove slaves (DLNA discovery list) |
| **Network**            | SSID (read-only), IP, MAC, signal strength                              |
| **System**             | Firmware version, MAC, capabilities, supported endpoints, "Send test notification", **Factory reset** (with confirm dialog showing what gets wiped) |
| **Notifications gizmo**| Free-text input → `POST /notification` to the speaker. Banner appears on the speaker — pure delight |

## Polish features ("the gizmos")

- **Album-art-tinted hero.** Sample the dominant colour from the album
  art via `Canvas.getImageData` and use it as the page accent (CSS
  custom property updated). Falls back to a neutral default if the
  image is CORS-blocked or unloaded.
- **"Pressed on speaker" toasts.** `<keyEvent>` from WebSocket → toast
  "Preset 3 pressed on the speaker" in the corner, fades after 4s.
  Makes the admin feel connected to the physical hardware.
- **Live VU dot on the now-playing card.** Subtle pulse while
  `playStatus === "PLAY_STATE"`.
- **Mobile-remote layout.** At narrow widths the now-playing view
  collapses to a phone-remote shape: big art top, big buttons. Container
  queries do this in CSS, no JS.
- **Dark mode** — auto via `prefers-color-scheme` + manual toggle in
  Settings.
- **Connection-state pill** — "live" (WebSocket connected),
  "reconnecting" (between WS attempts), "polling" (WS gave up,
  REST-only), "speaker asleep" (now_playing returns STANDBY).

## File layout (repo source)

```
admin/
├── PLAN.md                  ← this doc
├── index.html               ← shell, links app/main.js + style.css
├── style.css                ← vanilla, mobile-first, ~5 KB
├── app/                     ← ES module tree, no build step
│   ├── main.js              ← entry: wires router + state + WS
│   ├── router.js            ← hash router (~50 lines)
│   ├── state.js             ← observable store (~40 lines)
│   ├── api.js               ← API client + speaker XML parsers
│   ├── reshape.js           ← TuneIn → Bose JSON (mirrors resolver/build.py)
│   ├── dom.js               ← html`...` tagged template + render helpers
│   ├── ws.js                ← WebSocket client + reconnect
│   └── views/
│       ├── now-playing.js
│       ├── browse.js
│       ├── search.js
│       ├── station.js
│       └── settings.js
├── cgi-bin/api/v1/
│   ├── tunein               ← TuneIn proxy + classify
│   ├── presets              ← list + atomic save+store
│   ├── speaker              ← thin proxy to port 8090
│   └── refresh-all          ← bulk re-probe + rewrite
├── port80-router.sh         ← AP-mode-aware port-80 handoff
├── shepherd-core-override.xml ← Shepherd-core sans PtsServer
└── deploy.sh                ← installer (separate from scripts/deploy.sh)
```

After deploy, the admin lands at:

```
/mnt/nv/resolver/{index.html, style.css, app/, cgi-bin/api/v1/}
/mnt/nv/bin/port80-router.sh
/mnt/nv/shepherd/Shepherd-core.xml      ← real file, replacing the symlink
/mnt/nv/shepherd/Shepherd-resolver.xml  ← updated to add port80-router daemon
```

## Build, deploy, uninstall

**No build step.** Pure static files + ES modules + shell CGIs. `git clone`
and you can deploy.

`admin/deploy.sh <speaker-ip>` does the full install:

1. Sanity-check SSH access and the resolver is already deployed
   (this admin is layered on top of `scripts/deploy.sh`).
2. Push `admin/index.html`, `style.css`, `app/` to
   `/mnt/nv/resolver/`.
3. Push `admin/cgi-bin/api/v1/*` to `/mnt/nv/resolver/cgi-bin/api/v1/`,
   `chmod +x`.
4. Push `admin/port80-router.sh` to `/mnt/nv/bin/port80-router.sh`,
   `chmod +x`.
5. Push `admin/shepherd-core-override.xml` to
   `/mnt/nv/shepherd/Shepherd-core.xml`, replacing the symlink to
   `/opt/Bose/etc/Shepherd-core.xml`.
6. Update `/mnt/nv/shepherd/Shepherd-resolver.xml` to add the
   port80-router daemon entry.
7. Reboot.
8. Verify `http://<speaker>/` returns the SPA shell HTML.

`scripts/uninstall.sh` (the existing one) gets extended to also remove
`/mnt/nv/bin/`, restore the `Shepherd-core.xml` symlink to the
firmware version, and revert `Shepherd-resolver.xml` to just the
loopback httpd.

`scripts/verify.sh` adds a check that `http://<speaker>:80/` returns
the admin SPA shell (200 with `<title>` containing the speaker name).

## Testing strategy

Three layers:

1. **Unit-testable in node:** `app/reshape.js`, ID validators, URL
   parsers in `app/router.js`. Ship a small `admin/test/` directory
   with `*.test.js` files runnable via `node --test`.
2. **CGI integration:** `cgi-bin/*` can be exercised with `curl` from a
   laptop pointed at a deployed speaker. Document the curl invocations
   in `admin/PLAN.md` § "API Reference" so contributors can test.
3. **End-to-end UX:** manual on a real speaker. The repo's existing
   audit/verify cycle (`scripts/verify.sh`) gets extended to probe the
   admin URL.

A `mock-speaker.py` for offline iteration is **out of scope for v1.0**
but a candidate for v1.x — would let contributors hack on the SPA
without a real speaker.

## Failure modes covered explicitly

| Failure                                     | UX                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| WebSocket connect fails                     | Connection pill says "polling"; SPA falls back to REST polling       |
| `Tune.ashx` returns `notcompatible`         | Station detail shows "Not available from this client" + "More like this" |
| `Tune.ashx` returns `nostream`              | Station detail shows "This station is currently off-air"               |
| Speaker port 8090 unreachable               | Blocking error screen "Speaker may be asleep or off-network"; retry   |
| `save_station` fails (disk full / IO error) | Toast with the CGI error; preset assignment aborted before storePreset|
| Speaker rejects storePreset                 | Toast "Speaker rejected the request"; resolver file is rolled back   |
| Network slow                                | Skeleton loaders for cards; debounced search input                    |
| Multiple admins open at once                | Each has its own WS; presetsUpdated WS event keeps them in sync       |
| Speaker rebooted while admin open           | WS disconnects → reconnects on backoff; refresh state on reconnect    |

## Estimated effort

| Phase | Includes | Days |
| ----- | -------- | ---- |
| Foundation | router, state, dom helpers, api client, WS + reconnect, port80-router + Shepherd overrides, deploy.sh, verify.sh extension | 1 |
| now-playing view | the home view with WS-driven live updates, transport, volume, source, preset row | 1.5 |
| Browse + search + station detail | three views, three CGI endpoints (tunein search/browse/probe), reshape, probe cache | 2 |
| Settings — Speaker, Audio, BT, Multi-room | speaker proxy CGI, four sub-sections | 1.5 |
| Settings — Network, System, Notifications, factory reset | three sub-sections + the gizmo | 0.5 |
| Polish | album-art tint, mobile-remote layout, dark mode, "pressed on speaker" toasts, accessibility pass | 1.5 |
| **Total** | | **~8 days** |

## Open questions to resolve during build

1. **CORS from browser → speaker:8090**: speaker firmware's CORS
   posture is unknown without testing. The plan assumes most endpoints
   don't need preflight (GET / `application/xml` POST without custom
   headers). If they do, the `speaker` CGI is the fallback for
   everything.
2. **CORS from browser → speaker:8080 WebSocket**: WS doesn't use CORS
   the same way; the only requirement is that the WS handshake's
   `Origin` is acceptable to the server. Bose's WS server doesn't
   appear to validate Origin (untested but likely) — if it does, the
   admin would proxy WS through a CGI, which is awkward but possible.
3. **busybox httpd CGI behaviour**: verify scripts in `cgi-bin/`
   execute without explicit `httpd.conf` config. If they don't, ship
   an `httpd.conf` alongside.
4. **Speaker WS reliability**: how often does it drop? How does it
   behave during STANDBY? Test before relying on it.
5. **PresetsUpdated WS event payload**: not documented; need to capture
   one to confirm shape.
6. **Speaker `/storePreset` side effects**: the audit found that
   `storePreset` can reorder/drop other slots when the speaker is
   currently playing. Need to characterise and either work around or
   warn users.
