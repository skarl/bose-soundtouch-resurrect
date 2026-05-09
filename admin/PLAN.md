# Admin web UI — design plan

A full speaker dashboard, hosted on the speaker itself. The admin
replaces the `build.py` + `scp` + `curl /storePreset` flow and grows
to cover everything the original SoundTouch app could do over the
LAN: now-playing, transport, volume, source switching, presets,
search & browse, settings.

**Status:** plan only. No implementation yet. This document is the
spec for that implementation.

**Release shape:** the admin ships across three minor releases —
**0.2 / 0.3 / 0.4** — instead of a single v1.0. Each is independently
deployable and useful on its own. Slips on later releases never block
earlier ones. See *Release seams* below.

## Release seams

### 0.2 — preset workflow with a UI (~3 days)

The minimum that replaces `python3 build.py` + `scp` +
`curl /storePreset`. The original pain.

- **Views:** browse (Genre / Location / Language trees), search,
  station detail, preset assignment.
- **Now-playing:** thin read-only header strip — current station name +
  art + slot 1–6 row, polled every 2s via REST. No transport, no
  volume, no source switching.
- **CGIs:** `tunein` (search/browse/probe forwarder), `presets`
  (GET + POST), `speaker` proxy with `/now_playing` + `/presets` only.
- **No WebSocket.** REST-only.
- Hash router, observable store, vanilla CSS, no build step.

### 0.3 — live remote (~2.5 days)

Promotes now-playing from header strip to interactive home view; adds
the speaker as a live-controlled surface.

- **WebSocket** with reconnect + REST polling fallback (subject to the
  pre-spike — see *Live updates*).
- **Now-playing view:** transport, volume slider, source picker,
  preset row tap-to-play, long-press → assign flow.
- Speaker proxy CGI grows: `/volume`, `/key`, `/select`,
  `/selectLocalSource`.
- WS-driven feel: "pressed on speaker" toasts, connection-state pill,
  live VU dot, dark mode.
- **Factory reset** (single button + confirm dialog) — promoted from
  0.4 because it's the recovery hatch when anything goes wrong.

### 0.4 — settings + high-variance polish (~3 days, wide error bars)

The long tail. Each settings sub-section is empirical
(test-on-real-speaker, fix surprises) — its own release where slips
don't block 0.2 / 0.3.

- Settings view: Speaker (name, power, sleep timer, low-power),
  Audio (bass, balance, mono/stereo), Bluetooth, Multi-room, Network
  (read-only), System (firmware, capabilities), Notifications gizmo.
- `refresh-all` CGI — on-speaker `build.py` equivalent.
- Polish: album-art-tinted hero (CORS-on-canvas risk),
  mobile-remote container queries, accessibility pass.

Out of scope across all three:

- Wi-Fi reconfiguration (deliberately not exposed — too easy to lock
  yourself out).
- Firmware updates (deliberately blocked).
- Spotify account binding (cloud-coupled; gone).
- Authentication (LAN trust model — see `../SECURITY.md`).
- Multi-speaker control (one speaker per admin instance).
- Internationalisation (English-only strings; the architecture
  doesn't block adding more later).

## Architecture

```
Browser (any LAN device)
  │
  │  Static SPA + REST CGIs (HTTP)
  │  WebSocket (live updates, 0.3+)
  │
  ▼
Speaker, port 8181 (LAN-exposed)  ← admin SPA + CGIs + resolver tree
Speaker, port 8090 (LAN-exposed)  ← speaker's own local API
                                    (only via the speaker proxy CGI;
                                     never direct from browser)
Speaker, port 8080 (LAN-exposed)  ← WebSocket events (0.3+)
Speaker, port 80   (LAN-exposed)  ← UNCHANGED — Bose's PtsServer keeps
                                    serving captive portal in setup
                                    mode. We don't touch port 80.
```

### Single HTTP server, single docroot

The admin lives at `http://<speaker>:8181/`, served by the **same**
busybox httpd that already serves the resolver tree. The docroot
gains admin files alongside the existing resolver paths:

```
/mnt/nv/resolver/
├── index.html              ← admin SPA shell             (admin)
├── style.css               ← vanilla CSS                  (admin)
├── app/                    ← ES module tree               (admin)
│   ├── main.js
│   ├── router.js
│   ├── state.js
│   ├── api.js
│   ├── reshape.js
│   ├── dom.js
│   ├── ws.js                                              (0.3+)
│   └── views/
│       ├── browse.js
│       ├── search.js
│       ├── station.js
│       ├── now-playing.js                                 (0.3+)
│       └── settings.js                                    (0.4)
├── cgi-bin/api/v1/         ← REST endpoints (shell CGIs)
│   ├── tunein
│   ├── presets
│   ├── speaker
│   └── refresh-all                                        (0.4)
├── ws-test.html            ← WS diagnostic page          (0.2)
└── bmx/, marge/, v1/       ← existing resolver tree
                              (unchanged; same docroot)
```

The admin paths (`/`, `/style.css`, `/app/*`,
`/cgi-bin/api/v1/*`, `/ws-test.html`) and the resolver paths
(`/bmx/*`, `/marge/*`, `/v1/*`) don't collide. No URL rewriting, no
`httpd.conf` shaping.

**Port 80 is intentionally not touched.** The firmware's `PtsServer`
keeps doing its captive-portal job during AP-setup mode; we don't
replicate `is_setup_mode()` or override Shepherd configs. Users
bookmark `http://<speaker>:8181/` once. The complexity of port-80
takeover is not justified by the bookmark-once ergonomic win, and
getting the setup-mode detection wrong would block Wi-Fi
re-onboarding.

## Routing — hash-based

The SPA uses URL hashes for navigation. busybox httpd doesn't do URL
rewrites, and we don't ship `httpd.conf` shaping. Hash routing means
a single `index.html` + JS reading `location.hash`; deep links and
browser back/forward work; no server config.

| Hash route                 | View              | Release    | Notes |
| -------------------------- | ----------------- | ---------- | ----- |
| `#/`                       | now-playing       | 0.2 / 0.3  | 0.2: thin read-only header. 0.3: full transport + volume + source + preset row. |
| `#/browse`                 | browse root       | 0.2        | Tabs: Genre / Location / Language. |
| `#/browse?id=<g\|c\|r>NN`  | browse drill      | 0.2        | Children of any TuneIn taxonomy node. Breadcrumb. |
| `#/search`                 | search empty      | 0.2        | Empty input + "popular" suggestions. |
| `#/search?q=...`           | search results    | 0.2        | Debounced; results filtered to stations. |
| `#/station/sNNN`           | station detail    | 0.2        | Describe.ashx info + probe state + 6 assign buttons + test-play. |
| `#/preset/N`               | preset modal      | 0.3        | Triggered from now-playing's preset row; opens search/browse to replace this slot. |
| `#/settings`               | settings          | 0.4        | Sub-sections; collapsible. |

## State management

**Split observable store.** Global state is bounded to four top-level
keys. Transient view state lives in the view module, derived from URL
hash where possible.

```js
// app/state.js (global store)
export const state = observable({
  speaker: {
    info:       null,   // {deviceID, name, type, firmwareVersion, ...}
    nowPlaying: null,   // {source, item, track, artist, art, playStatus}
    presets:    null,   // [{slot, source, type, location, itemName, art}, ...] (length 6)
    volume:     null,   // {actualVolume, targetVolume, muteEnabled}    (0.3+)
    sources:    null,   // [{source, status: READY|UNAVAILABLE, ...}]    (0.3+)
    bass:       null,   // {actualBass, targetBass, range}               (0.4)
    balance:    null,   // (0.4)
    zone:       null,   // (0.4)
    bluetooth:  null,   // (0.4)
    network:    null,   // (0.4)
    recents:    null,   // (0.4)
  },
  caches: {
    probe:          new Map(),  // sid → {ok, kind, url, expires} (10 min TTL, browser-local)
    recentlyViewed: [],         // most-recent station IDs, persisted in localStorage
  },
  ws: { connected: false, lastEvent: null },   // 0.3+
  ui: { toast: null, testPlaying: null },
});
```

Per-view transient state (browse drill items, search query, station
detail) lives as locals in the view module, cleared on `unmount()`.
Hash routes (`#/browse?id=g22`, `#/search?q=jazz`) carry enough info
to re-derive view state on re-entry — no stale store entries to
clean up.

### Subscription granularity

**Coarse, top-level only.** Mutators subscribe to one of `speaker`,
`caches`, `ws`, `ui`. The store emits `(state, changedTopLevelKey)`
on any change beneath that key; mutators decide what changed and
update their DOM. Keeps `state.js` ~30 lines instead of a path-walker.

### Render strategy — init-once + per-view mutators

Each view module exports `{ init(root, state), update(state, changedKey) }`:

- `init` mounts a static DOM tree once, using `html\`...\`` tagged
  templates from `app/dom.js`. Returns the rendered subtree.
- `update` is a `switch (changedKey) { ... }` that mutates only the
  affected DOM (`slider.value = state.speaker.volume.actualVolume`)
  rather than re-rendering and re-parsing.

This preserves input focus, scroll position, IME state, and `:active`
across WS events. **No virtual DOM, no full re-render, no diffing.**
Static views (browse, station detail) just don't subscribe — their
`init` does the work and returns. Add this rule as a one-liner
comment in `app/dom.js` so future contributors don't reinvent
re-rendering:

```
// All views init once; reactivity is via per-view mutators on
// state-path subscriptions, not via re-rendering. Re-rendering
// inputs/sliders/scroll-containers breaks them.
```

## REST API — `/cgi-bin/api/v1/*`

Most endpoints return a consistent envelope:

```json
{ "ok": true,  "data": ... }
{ "ok": false, "error": { "code": "TUNEIN_GATED", "message": "..." } }
```

Every CGI sets `Content-Type: application/json; charset=utf-8` and
`Cache-Control: no-store`. Implemented as small busybox-shell CGIs.

### `tunein` — dumb forwarder, no envelope

A single ~30-line CGI switches on `PATH_INFO` and forwards to TuneIn.
Adds magic params (`formats=mp3,aac`, `lang=de-de`, `render=json`)
and `User-Agent: Bose_Lisa/27.0.6`. Pipes the response back verbatim
with permissive CORS headers.

```
GET /cgi-bin/api/v1/tunein/search?q=jazz&type=station
GET /cgi-bin/api/v1/tunein/browse              → root nodes
GET /cgi-bin/api/v1/tunein/browse?id=g22       → children of node
GET /cgi-bin/api/v1/tunein/station/sNNN        → Describe.ashx
GET /cgi-bin/api/v1/tunein/probe/sNNN          → Tune.ashx
```

**No `{ok, data}` envelope on `/tunein/*`.** The HTTP status + raw
TuneIn JSON is the contract. **No CGI-side classification** — the
browser parses the response and classifies in `app/reshape.js`:

```js
// app/reshape.js
export function classify(tuneinJson) {
  const url = tuneinJson?.body?.[0]?.url ?? '';
  if (url.includes('notcompatible')) return { kind: 'gated', reason: url };
  if (url.includes('nostream'))      return { kind: 'dark',  reason: url };
  return { kind: 'playable', streams: filterPlayable(tuneinJson.body) };
}
```

Browser caches probe results 10 minutes per station ID
(`state.caches.probe`).

### `presets` — list + atomic save+store

```
GET  /cgi-bin/api/v1/presets                       → 6 slots (envelope)
POST /cgi-bin/api/v1/presets/:slot                 → save+store atomically
```

`GET` calls speaker `/presets` via the speaker-proxy machinery, parses
XML in `app/api.js`, returns
`{ok, data: [{slot, source, type, location, itemName, art}, ...]}`.

`POST` body is `{id, slot, name, kind, json}`:

- `id` matches `^s[0-9]+$` (validated)
- `slot` is 1–6 (validated)
- `kind` must be the literal `"playable"` (validated; gated/dark refused)
- `name` is the display name (escaped for XML when calling storePreset)
- `json` is the Bose-shaped station response (browser reshaped from the
  TuneIn probe; CGI writes verbatim)

The CGI:

1. Validates id, slot, kind, name.
2. Writes `json` to `/mnt/nv/resolver/bmx/tunein/v1/playback/station/<id>.tmp`,
   then `mv` (atomic on same fs).
3. Calls speaker `/storePreset?id=<slot>` via wget with the
   `<preset id="N"><ContentItem .../></preset>` shape.
4. Returns the new full presets list as `data`.

**No rollback on storePreset failure.** Failure modes:

| Failure | Resulting state | Severity |
|---|---|---|
| File-write fails (disk full / IO) | No file change, no storePreset call | Clean abort, return error |
| File-write OK, storePreset rejected (new station ID) | Stray JSON file in resolver, speaker unchanged | ~2 KB wasted NVRAM |
| File-write OK, storePreset rejected (overwriting existing ID) | Refreshed JSON for that ID, speaker unchanged | Other slot pointing to that ID gets a free stream-URL refresh |

In every case, the CGI returns
`{ok: false, error: {code: "STOREPRESET_REJECTED", ...}}`; the browser
refetches `/presets` to show actual speaker state. Implementing
file-rollback is more code with more bugs than the failure mode
justifies.

### `speaker` — wildcard proxy with Origin check

A single CGI proxies any path under `/cgi-bin/api/v1/speaker/X` to
`http://localhost:8090/X`, forwarding method, query string, and body.
Adds permissive CORS headers.

**Browser never talks to speaker:8090 directly.** Every call is
proxied. This sidesteps the firmware-CORS-posture unknown — same
origin from the browser's POV.

CSRF guard via `Origin` header on `POST` / `PUT` / `DELETE` only:

```sh
case "$REQUEST_METHOD" in
  POST|PUT|DELETE)
    case "${HTTP_ORIGIN:-}" in
      "http://${HTTP_HOST}"|"") ;;        # same-origin or curl (no Origin)
      *) emit_error 403 CSRF_BLOCKED \
           "cross-origin mutating request rejected"; exit ;;
    esac ;;
esac
```

`GET` skips the Origin check (idempotent; cross-origin response is
blocked by browser CORS default anyway).

Endpoints used (all via the proxy):

```
GET  /cgi-bin/api/v1/speaker/now_playing       (0.2)
GET  /cgi-bin/api/v1/speaker/presets           (0.2)
GET  /cgi-bin/api/v1/speaker/info              (0.3)
GET  /cgi-bin/api/v1/speaker/sources           (0.3)
GET  /cgi-bin/api/v1/speaker/volume            (0.3)
POST /cgi-bin/api/v1/speaker/volume            (0.3)
POST /cgi-bin/api/v1/speaker/key               (0.3)
POST /cgi-bin/api/v1/speaker/select            (0.3)
POST /cgi-bin/api/v1/speaker/selectLocalSource (0.3)
…plus name, bass, balance, balanceCapabilities, DSPMonoStereo,
  systemtimeout, lowPowerStandby, getZone, setZone, bluetoothInfo,
  enterBluetoothPairing, clearBluetoothPaired, networkInfo,
  notification, capabilities, recents                          (0.4)
```

Wildcard proxy means new endpoints work without CGI changes.

### `refresh-all` — bulk stream-URL refresh (0.4)

```
POST /cgi-bin/api/v1/refresh-all
```

For each preset slot, fetch the current station ID, run probe, and
rewrite the resolver JSON file if streams changed. Returns
`{updated: [...], unchanged: [...], failed: [...]}`. On-speaker
equivalent of `python3 build.py` from a laptop.

## Live updates — WebSocket (0.3)

### Pre-spike — VERIFIED 2026-05-10

Spike done against firmware `trunk r46330 v4 epdbuild hepdswbld04`.
**WebSocket works, but only when the client negotiates the `gabbo`
subprotocol on the handshake.** Without it, the connection succeeds
and the speaker emits its `<SoundTouchSdkInfo>` hello frame, but no
state-change events flow afterwards — which is what the original
`docs/api-reference.md` got wrong with its "subscribe once, receive
forever" claim. (`docs/api-reference.md` has been corrected.)

```bash
# Reproduce:
wscat -s gabbo -c ws://<speaker-ip>:8080/
```

```js
// In the SPA:
const ws = new WebSocket(`ws://${location.hostname}:8080/`, 'gabbo');
```

The `gabbo` magic string is the same one already required as the
`<key sender="Gabbo">` value (Bose's internal SDK uses it in both
contexts). Confirmed in two open-source clients:
[CharlesBlonde/libsoundtouch](https://github.com/CharlesBlonde/libsoundtouch/blob/master/libsoundtouch/device.py)
and
[thlucas1/bosesoundtouchapi](https://github.com/thlucas1/bosesoundtouchapi/blob/main/bosesoundtouchapi/ws/soundtouchwebsocket.py).

### Event envelope

Events arrive wrapped in `<updates deviceID="…">…</updates>`. The
inner element is the actual event. `app/ws.js`'s parser must unwrap
before dispatching:

```js
function handleSpeakerEvent(xmlText) {
  const doc  = new DOMParser().parseFromString(xmlText, 'application/xml');
  const root = doc.documentElement;
  if (root.tagName === 'updates') {
    for (const inner of root.children) dispatchEvent(inner);
  } else {
    dispatchEvent(root);   // <userActivityUpdate/>, <SoundTouchSdkInfo/> are unwrapped
  }
}
```

### Events handled

| Event (inside `<updates>` unless noted) | State update                                                       |
| --------------------------------------- | ------------------------------------------------------------------ |
| `<volumeUpdated>`                       | `state.speaker.volume`                                             |
| `<bassUpdated>` (0.4)                   | `state.speaker.bass`                                               |
| `<balanceUpdated>` (0.4)                | `state.speaker.balance`                                            |
| `<nowPlayingUpdated>`                   | `state.speaker.nowPlaying` (incl. STANDBY transitions)             |
| `<nowSelectionUpdated>`                 | "Preset N selected" toast + reconcile `state.speaker.presets`       |
| `<sourcesUpdated>`                      | `state.speaker.sources`                                            |
| `<presetsUpdated>`                      | `state.speaker.presets` + toast "Presets changed"                  |
| `<keyEvent>`                            | toast "Preset N pressed on speaker" — see note below               |
| `<connectionStateUpdated>`              | `state.ws` plus header pill                                        |
| `<zoneUpdated>` (0.4)                   | `state.speaker.zone`                                               |
| `<recentsUpdated>` (0.4)                | `state.speaker.recents`                                            |
| `<userActivityUpdate />` (unwrapped)    | Optional: feed a "user is active" timer for screen-wake heuristics |
| `<SoundTouchSdkInfo>` (unwrapped)       | Set `state.ws.connected = true` — readiness signal (stronger than TCP-open) |

`<userActivityUpdate />` and `<SoundTouchSdkInfo>` arrive **outside**
the `<updates>` envelope. Treat them as top-level cases in the parser.

**Note on `<keyEvent>`:** the spike observed `<nowSelectionUpdated>`
on physical preset-button presses but no `<keyEvent>`. `<keyEvent>`
may fire only for some keys, or only on hardware-button press without
release. Investigate during 0.3 build; if it doesn't fire reliably,
source the "pressed on speaker" toast from `<nowSelectionUpdated>`
(preset) + `<volumeUpdated>` (volume) — those *do* fire reliably.

### Reconnect + fallback

Reconnect with exponential backoff capped at 30s. If WS drops, the
SPA falls back to REST polling at 2s while a tab is visible. Re-fetch
full state on reconnect (the speaker doesn't replay missed events).

A minimal `admin/ws-test.html` (~20 lines, must use the `gabbo`
subprotocol) ships with 0.2's deploy as a diagnostic page — open in
any browser to check WS health on a given speaker, or to debug after
a firmware-update incident.

### Kill criterion (kept as a contingency)

If a future firmware update breaks the gabbo subprotocol or any
similar protocol-level regression makes events stop flowing, apply
the kill criterion: **drop WS-dependent features.** Don't build a
WS-proxy daemon. REST polling becomes primary; "pressed on speaker"
toasts and the live VU dot are cut. The plan was originally drafted
with this contingency for the case where the spike failed; the spike
passed, but the criterion remains useful documentation if the
firmware ever changes.

## View specs

### now-playing (`#/`)

**0.2:** thin read-only header strip. Current station name + art +
slot 1–6 row, polled every 2s. No transport/volume/source.

**0.3:** full home view.

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

Behaviours (0.3):

- Active source highlighted; click changes source via `/select` or
  `/selectLocalSource`.
- Volume slider sends throttled `POST /volume` with `<volume>NN</volume>`
  body; updates eagerly, reconciles via WS.
- Preset card click → `POST /key PRESET_N press/release`.
- Long-press / right-click on preset → modal: "Replace this preset"
  → navigates to `#/search` with a `slot=N` context that comes back
  here after assignment.
- Album art: tinted hero background (sample dominant colour from the
  `<art>` URL via canvas; fall back to neutral if CORS blocks). (0.4)

### browse (`#/browse`) — 0.2

Three tabs at the top (Genre / Location / Language). Each shows the
top-level outline children. Click any item → drill via
`#/browse?id=<id>` with breadcrumb. Each `audio`-typed leaf shows as
a station card linking to `#/station/sNNN`.

### search (`#/search` and `#/search?q=...`) — 0.2

Sticky search input at top. Debounced 300ms. Hits
`/cgi-bin/api/v1/tunein/search?q=...&type=station`. Results render as
the same cards as browse.

Empty state (no `q` yet): show "Recently viewed" (from localStorage)
and "Popular" (from `/Browse.ashx?c=local`).

### station detail (`#/station/sNNN`) — 0.2

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
3. If probe is **gated** or **dark**, replace the preset buttons
   with a message "This station isn't available from this client
   right now." plus a "More like this" link.

Test-play: `POST /api/v1/speaker/select` with the speaker's
`<ContentItem>` shape. Doesn't store as preset; doesn't touch
`/mnt/nv/resolver/`. "Cancel test" sends `POST /key POWER` to standby.

Set-as-preset: `POST /api/v1/presets/:slot` with the probed Bose JSON
plus `kind: "playable"`. The CGI does the resolver write +
storePreset call atomically.

### settings (`#/settings`) — 0.4

Single page with collapsible sections. Each section reads its state
via the speaker proxy on view-entry; writes go through the proxy too.

| Section                | Content                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| **Speaker**            | Name (editable), power state, sleep timer (`/systemtimeout`), low-power standby |
| **Audio**              | Bass slider, balance slider, mono/stereo switch                         |
| **Bluetooth**          | Paired devices list, "Enter pairing mode" button, "Clear pairings"      |
| **Multi-room**         | Current zone (master/members), add/remove slaves (DLNA discovery list)  |
| **Network**            | SSID (read-only), IP, MAC, signal strength                              |
| **System**             | Firmware version, MAC, capabilities, supported endpoints, "Send test notification", **Factory reset** (with confirm dialog showing what gets wiped) |
| **Notifications gizmo**| Free-text input → `POST /notification` to the speaker. Banner appears on the speaker. |

Note: factory reset itself ships in **0.3** as a single button with
confirm dialog (the recovery hatch). 0.4 wraps it into the settings
view alongside the rest.

## Polish features ("the gizmos")

| Feature | Release |
|---|---|
| "Pressed on speaker" toasts (`<keyEvent>` from WS → corner toast) | 0.3 (if WS spike succeeds) |
| Connection-state pill ("live" / "reconnecting" / "polling" / "speaker asleep") | 0.3 |
| Live VU dot — subtle pulse while `playStatus === "PLAY_STATE"` | 0.3 |
| Dark mode (auto via `prefers-color-scheme` + manual toggle) | 0.3 |
| Album-art-tinted hero (Canvas.getImageData → CSS custom property) | 0.4 (CORS-on-canvas risk) |
| Mobile-remote layout (container queries; phone-shaped at narrow widths) | 0.4 |
| Accessibility pass (focus rings, ARIA, keyboard nav) | 0.4 |

## File layout (repo source)

```
admin/
├── PLAN.md                  ← this doc
├── index.html               ← shell, references app/main.js + style.css
│                              with ?v=$VERSION query strings
├── style.css                ← vanilla, mobile-first
├── app/                     ← ES module tree, no build step
│   ├── main.js              ← entry: wires router + state + (0.3+) WS
│   ├── router.js            ← hash router (~50 lines)
│   ├── state.js             ← split observable store (~30 lines)
│   ├── api.js               ← API client + speaker XML parsers
│   ├── reshape.js           ← TuneIn JSON classify + → Bose JSON
│   │                          (mirror of resolver/build.py;
│   │                           drift caught by CI fixtures)
│   ├── dom.js               ← html`...` tagged template + mount helper
│   ├── ws.js                ← WebSocket client + reconnect (0.3+)
│   └── views/
│       ├── browse.js
│       ├── search.js
│       ├── station.js
│       ├── now-playing.js
│       └── settings.js                                           (0.4)
├── cgi-bin/api/v1/
│   ├── tunein               ← TuneIn forwarder
│   ├── presets              ← list + atomic save+store
│   ├── speaker              ← wildcard proxy + Origin check
│   └── refresh-all          ← bulk re-probe + rewrite             (0.4)
├── ws-test.html             ← WS diagnostic page                  (0.2)
├── test/
│   ├── test_reshape.js      ← `node --test` against fixtures
│   └── fixtures/            ← shared TuneIn↔Bose pairs
│       ├── sNNNN.tunein.json
│       └── sNNNN.bose.json
├── deploy.sh                ← installer (separate from scripts/deploy.sh)
└── uninstall.sh             ← partial uninstall (admin only)
```

After deploy, the admin lands at:

```
/mnt/nv/resolver/{index.html, style.css, app/, cgi-bin/api/v1/, ws-test.html}
```

(No port-80 changes, no Shepherd modifications, no `port80-router.sh`.)

## Build, deploy, uninstall

**No build step.** Pure static files + ES modules + shell CGIs.
`git clone` and you can deploy.

### `admin/deploy.sh <speaker-ip>`

1. Sanity-check SSH access and that the resolver is already deployed
   (`ssh <speaker> test -f /mnt/nv/resolver/bmx/registry/v1/services`).
   The admin layers on top of `scripts/deploy.sh`.
2. Substitute `?v=$VERSION` into `index.html` from `git describe --tags`.
3. Push `index.html`, `style.css`, `app/`, `ws-test.html` to
   `/mnt/nv/resolver/`.
4. Push `cgi-bin/api/v1/*` to `/mnt/nv/resolver/cgi-bin/api/v1/`,
   `chmod +x`.
5. Verify `http://<speaker>:8181/` returns the SPA shell (200 with
   the `<meta name="admin-version">` tag present).

### `admin/uninstall.sh <speaker-ip>`

Removes the admin tree (`index.html`, `style.css`, `app/`,
`cgi-bin/api/v1/`, `ws-test.html`) but leaves the resolver intact.
The existing `scripts/uninstall.sh` continues to handle full project
removal.

### Cache busting + version drift

`index.html` references `app/main.js?v=$VERSION` and
`style.css?v=$VERSION`. Bumping `$VERSION` invalidates the browser
cache for all references at once.

A `<meta name="admin-version" content="$VERSION">` tag carries the
version at runtime. On `visibilitychange → 'visible'`, the SPA
fetches `/index.html?_=ts` (cache-busted), parses the meta tag, and
shows a non-dismissable "new version available, reload to update"
banner if it differs from the in-memory version. (Doesn't auto-reload
— might interrupt the user mid-action.)

### `scripts/verify.sh` extension

Adds three probes:

```sh
# 1. admin shell
curl -fsS "http://$SPEAKER:8181/" | grep -q 'admin-version'

# 2. presets envelope
curl -fsS "http://$SPEAKER:8181/cgi-bin/api/v1/presets" \
  | grep -q '"ok":true'

# 3. resolver still serving (admin didn't break the existing tree)
curl -fsS "http://$SPEAKER:8181/bmx/registry/v1/services" \
  | grep -q '{'
```

## Testing strategy

Three layers:

1. **Unit-testable in node + python:** ID validators, URL parsers,
   reshape contract.
   - `admin/test/test_reshape.js` (`node --test`) asserts
     `reshape(tunein) === bose` for each fixture.
   - `resolver/test_build.py` (`python -m unittest`) asserts
     `make_bose(tunein) === bose` for the **same** fixtures.
   - **CI runs both** and either fails individually if its output
     doesn't match the fixture. Catches drift between
     `app/reshape.js` and `resolver/build.py` as a red CI build, not
     as a silent runtime bug.
2. **CGI integration:** `cgi-bin/*` exercised with `curl` against a
   deployed speaker. Document curl invocations in this doc.
3. **End-to-end UX:** manual on a real speaker. `scripts/verify.sh`
   probes the admin URL.

A `mock-speaker.py` for offline iteration is **out of scope** for
0.2 / 0.3 / 0.4. Candidate for 1.x.

## Failure modes covered explicitly

| Failure                                          | UX                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| WebSocket connect fails (or pre-spike showed it can't work) | Connection pill says "polling"; SPA uses REST polling primarily |
| `Tune.ashx` returns `notcompatible`              | Station detail shows "Not available from this client" + "More like this" |
| `Tune.ashx` returns `nostream`                   | Station detail shows "This station is currently off-air"            |
| Speaker port 8090 unreachable                    | Blocking error screen "Speaker may be asleep or off-network"; retry |
| `presets` POST file-write fails (disk full / IO) | Toast with the CGI error code; preset assignment aborted            |
| `presets` POST file-write OK, storePreset rejected | Toast `STOREPRESET_REJECTED`; SPA refetches `/presets`              |
| Cross-origin POST attempt to speaker proxy       | CGI returns `CSRF_BLOCKED`; never reaches the speaker               |
| Network slow                                     | Skeleton loaders for cards; debounced search input                  |
| Multiple admins open at once                     | Each has its own WS; presetsUpdated event keeps them in sync        |
| Speaker rebooted while admin open                | WS disconnects → reconnects on backoff; refresh state on reconnect  |
| Stale tab after redeploy                         | Visibility-change banner: "new version available, reload to update" |

## Estimated effort

| Release | Includes | Days |
| ------- | -------- | ---- |
| **0.2** | Hash router, state.js, dom.js, api client, tunein forwarder CGI, presets CGI, speaker GET-only proxy, fixtures + CI tests, browse/search/station views, thin polled now-playing header, deploy.sh, verify.sh extension, ws-test.html | ~3 |
| **0.3** | WebSocket (gabbo subprotocol) + reconnect, full now-playing view (transport, volume, source, preset row), speaker proxy POST endpoints, "pressed on speaker" toasts, connection pill, live VU dot, dark mode, factory reset | ~2.5 |
| **0.4** | Settings view (7 sub-sections), refresh-all CGI, album-art tint, mobile-remote container queries, accessibility pass | ~3 (wide error bars) |
| **Total** | | **~8.5** |

## Open questions to resolve during build

1. **busybox httpd CGI behaviour:** verify shell scripts in
   `cgi-bin/` execute without explicit `httpd.conf` config. If they
   need shaping, ship an `httpd.conf` alongside.
2. **Speaker WS reliability:** how often does the connection drop?
   How does it behave during STANDBY (the `<nowPlayingUpdated
   source="STANDBY">` event was observed in the spike — does the WS
   stay open when the speaker sleeps)? Tune reconnect backoff
   accordingly.
3. **`<keyEvent>` payload variance:** the spike showed
   `<nowSelectionUpdated>` on physical preset-button presses but no
   `<keyEvent>`. Characterise which keys do/don't emit `<keyEvent>`,
   and decide whether to source the "pressed on speaker" toast from
   `<nowSelectionUpdated>` + `<volumeUpdated>` instead.
4. **`<presetsUpdated>` payload shape:** not documented; capture one
   to confirm.
5. **Speaker `/storePreset` side effects:** the audit found
   `storePreset` can reorder/drop other slots when the speaker is
   currently playing. Need to characterise and either work around
   or warn users.
