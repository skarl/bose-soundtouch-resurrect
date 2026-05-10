# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
