# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`tunein` CGI 404 envelope shape** — as an intended side-effect of
  the shared CGI library extraction (#111), the `tunein` CGI's 404
  response now uses the structured error envelope shared by every
  other CGI under `admin/cgi-bin/api/v1`.
  - Old shape: `{"error": "..."}`
  - New shape: `{"ok": false, "error": {"code": "...", "message": "..."}}`
  - The SPA is unaffected — no in-tree caller hits a 404-producing
    `tunein` route. External scripted callers that parse the flat
    `error` field will need to read `error.message` (or branch on
    `error.code`) instead.

## [v0.4.0] - 2026-05-10

### Added

- **Settings page** (`#/settings`) with seven collapsible sub-sections:
  - **Appearance** — four-way theme picker (auto / graphite / cream /
    terminal); persists in `localStorage`.
  - **Speaker** — name (editable), power on/off, sleep timer.
  - **Audio** — bass slider, balance slider, mono/stereo switch.
  - **Bluetooth** — speaker MAC, currently-connected device (sourced
    from `/now_playing`'s `<connectionStatusInfo>`), enter-pairing and
    clear-paired actions.
  - **Multi-room** — placeholder explaining the section is parked
    pending a multi-speaker test rig. Underlying state, parsers, and
    actions all ship and stay testable for a future revival.
  - **Network** — read-only SSID, IP, MAC, signal bars (4-bar visual).
  - **System** — firmware version, MAC, capabilities, recently-played
    list, live WebSocket event log.
- **Four-zone app shell** — header / body / mini-player / bottom tabs.
  At ≥960px the bottom tabs migrate to a left side-rail. Pure CSS
  container queries; no JS resize observer.
- **SVG icon module** — 19 inline Lucide-flavoured glyphs plus an
  animated equalizer; replaces the Unicode-glyph fallbacks throughout.
- **Shared design components** — `pill`, `switch`, `slider`,
  `equalizer`, `stationArt`. Used across now-playing v2, station detail
  v2, browse + search v2, and every settings sub-view.
- **Now-playing v2** — compact card layout, dynamic source switcher
  (collapses to icons when sources exceed the row), three-column
  preset grid with art-style cards.
- **Browse + search v2** — visual station cards (`resultCard`) with
  art, location, genre, and bitrate pill. Empty-state search shows a
  two-column "Recently viewed" / "Popular" landing.
- **Station detail v2** — 3×2 preset assignment grid (slot number,
  current occupant, genre tag) plus a full-width gradient
  `Test play` CTA.
- **`refresh-all` CGI** — `POST /cgi-bin/api/v1/refresh-all` re-probes
  every preset slot against TuneIn and atomically rewrites any
  resolver JSON whose stream URLs have drifted. The on-speaker
  equivalent of running `python3 resolver/build.py` from a laptop.
- **Self-hosted Geist + Geist Mono fonts** — under `admin/fonts/`,
  served from `/fonts/` on the speaker. No CDN dependency: the admin
  works whether or not the user's home internet is up.
- **Album-art-tinted now-playing hero** — samples the dominant colour
  from the current artwork via canvas; falls back to a neutral tint
  if the host blocks `getImageData` (CORS).
- **Mobile-remote container queries** — phone-shaped layout at narrow
  widths; widens gracefully on tablet / desktop.
- **Accessibility pass** — visible focus rings on every interactive
  element, ARIA `valuetext` on sliders, roving `tabindex` for tab
  bars, full `prefers-reduced-motion` compliance.

### Changed

- **View shell refactor** — every view exports a `defineView()` shape
  with explicit `mount` / `update` / `unmount` hooks. Five existing
  views migrated. `mountChild()` cascades cleanup so nested sub-views
  tear down deterministically.
- **`speaker-state.js`** centralises per-section fetch + WS event
  wiring (volume, sources, bass, balance, DSPMonoStereo,
  bluetoothInfo, networkInfo, recents, zone, info). Each settings
  sub-view subscribes to its slice without re-deriving the seam.

### Fixed

- **Power toggles via `/key POWER`, not `/standby`**. Bo's firmware
  rejects every body shape we tried for `POST /standby`. The
  `/key POWER` press+release pair is honoured reliably and is what
  the SoundTouch app uses internally.

### Firmware quirks discovered

Calling these out so future maintainers don't re-derive them:

- **`/lowPowerStandby` is a one-shot trigger, not a toggle.** Every
  observed call (GET or POST, any body) puts the speaker into deep
  standby — its WiFi radio drops, the LAN can't reach it, recovery
  needs a hardware power-cycle. The admin deliberately omits this
  control and `scripts/verify.sh` deliberately never probes the
  endpoint.
- **`/notification` returns HTTP 500 `CLIENT_XML_ERROR 1019` for
  every body shape.** Verified across the wider open-source
  ecosystem (`libsoundtouch`, `bosesoundtouchapi`, openHAB, Home
  Assistant) — none has a working POST. The notifications gizmo
  was dropped from scope.
- **`/bluetoothInfo` only returns the speaker's own
  `BluetoothMACAddress`.** Verified on Bo with an iPhone actively
  paired and audio-routed: the `<pairedList>` element documented in
  some references never materialises. The admin reads the
  currently-connected device from `/now_playing`'s
  `<connectionStatusInfo>` instead.
- **`/standby` rejects every body shape** — use `/key POWER` instead.
- **`/setPower` 404s entirely** — not registered on this firmware.
- **`/balanceCapabilities` 404s** — the admin falls back to a default
  `{-7..7}` range.

### Deferred

- **Multi-room master/member rendering** — the standalone state
  ships, the settings sub-view is a one-line placeholder. Validating
  the picker UX needs a second SoundTouch on the LAN, which the
  test rig (Bo) doesn't have. State, parsers, actions, and tests all
  remain in the codebase for a future revival.

### Closed without shipping

- **Factory reset** — closed not-planned. The recovery hatch was
  promoted to 0.3 in PLAN.md but never implemented; the on-speaker
  hardware-button sequence remains the supported path.
- **Notifications gizmo** — closed not-planned (see firmware quirks).

## [v0.3.0] - 2026-05-10

### Added

- **WebSocket live connection** to the speaker's port 8080 with the mandatory
  `gabbo` subprotocol. Reconnect uses exponential backoff with full jitter;
  REST polling fallback kicks in after the first drop and continues until WS
  recovers. Tab visibility handling pauses reconnect/poll while the page is
  hidden and retries immediately on focus.
- **Now-playing home view** (full rebuild from the 0.2 stub): album art,
  station name, track/artist line (deduped against each other and the station
  name), source/type metadata pill.
- **Transport controls**: previous / play-pause / next, sent as `/key`
  press+release pairs via the speaker proxy CGI.
- **Volume slider** with throttle+coalesce so rapid drags produce at most one
  in-flight POST. Mute via `/key MUTE`. Both controls suppress redundant
  outbound POSTs when the WS event confirms the speaker already holds the
  queued value.
- **Source picker pills** (up to 16 sources): shows all sources, marks active
  and UNAVAILABLE states. Switching streaming sources uses `/select`; local
  sources (AUX, BT) use `/selectLocalSource`.
- **Preset card row** — 6 cards with art and station name, tap-to-play.
  **Firmware quirk:** `/key PRESET_N` returns 200 but silently no-ops on
  Bo's firmware (trunk r46330). Recall goes through `/select` with the
  preset's stored ContentItem instead. Documented in `docs/api-reference.md`.
- **Preset reassign modal** (`#/preset/N`) — long-press or right-click on a
  preset card navigates to the modal, which reuses the browse/search views for
  station selection and POSTs to the presets CGI on assign.
- **Live VU dot**: CSS keyframe pulse while `playStatus=PLAY_STATE`; stops on
  standby/pause.
- **"Pressed on speaker" toasts** (Option B): state changes that arrive via WS
  without a matching outgoing API call in the last 2 s are attributed to
  hardware button presses and surfaced as a toast (`<keyEvent>` is unreliable
  on this firmware).
- **Connection-state pill** in the header: connecting / live / reconnecting /
  polling / offline, updated in real time.
- **Theme module**: auto (respects `prefers-color-scheme`), light, dark. Cycles
  on button click; persists in `localStorage`.
- **Speaker name** hydrated via `/speaker/info` on boot; shown in the header.
- **9 new ES modules** under `admin/app/`: `ws.js`, `transport.js`, `theme.js`,
  `io-ledger.js`, `components.js`, `views/now-playing.js` (full rebuild),
  `views/preset.js`. No build step.
- **npm + `@xmldom/xmldom`** devDep for fixture-driven unit tests (WS dispatch,
  API XML parsers, backoff, transport/volume coalescer, io-ledger). CI extended
  with `npm ci` + `npm test`. 52 tests now run on every push.

### Fixed

- Speaker proxy CGI (`admin/cgi-bin/api/v1/speaker`): the `Content-Type`
  header was passed as unquoted argv tokens (`-H Content-Type: text/xml`),
  causing curl to misparse the arguments and return status `000`, which the
  proxy treated as 502 UPSTREAM_UNREACHABLE. Fixed by writing curl's
  `--config` file so the header value is never word-split.
- Proxy CGI now uses `--max-time 10` so slow `/select` switches (3–4 s while
  the speaker transitions) don't time out and return 502.
- CSRF guard updated to also check `HTTP_REFERER` because busybox httpd
  v1.19.4 does not forward the `Origin` header as `HTTP_ORIGIN` to CGI scripts.
- `scripts/verify.sh`: tunein CGI probe was truncating the response to 1 byte
  before grepping; the response starts with whitespace, so the `{` never
  matched. Fixed to grep the full response.

## [v0.1.0] - 2026-05-09

### Added
- Initial public release.
- On-speaker static-file resolver (`resolver/`), including:
  - `build.py` — fetch fresh stream URLs from TuneIn's public API and
    emit Bose-shaped JSON.
  - Static templates for the registry and source-provider responses.
  - `shepherd-resolver.xml` — daemon config so busybox `httpd` auto-starts
    at boot.
- Documentation (`docs/`) covering compatibility, opening up the speaker,
  installation, preset customisation, troubleshooting, architecture,
  the speaker's local API, and TuneIn's OPML API as used by `build.py`.
- Helper scripts (`scripts/`) for USB-stick prep, deployment,
  post-install verification, stream refresh, preset assignment,
  uninstall, and SSH wrapper.
- Design plan for a browser-based admin UI (`admin/PLAN.md`).
- CI: GitHub Actions workflow running shellcheck on `scripts/` and a
  Python compile + error-path check on `resolver/build.py`.

[v0.1.0]: https://github.com/skarl/bose-soundtouch-resurrect/releases/tag/v0.1.0
