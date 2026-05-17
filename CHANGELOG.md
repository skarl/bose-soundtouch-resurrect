# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`scripts/deploy.sh` synthesises a TUNEIN token block in `Sources.xml` when one is missing.** Bose's cloud was the only thing that ever issued the anonymous-account TuneIn token persisted at `/mnt/nv/BoseApp-Persistence/1/Sources.xml`; since the 2026-05-06 shutdown a factory reset wipes that token and nothing re-issues it. Without the block, BoseApp omits TUNEIN from `/sources` and `/select source="TUNEIN"` returns HTTP 500 `UNKNOWN_SOURCE_ERROR` — which the admin surfaces as 502 `SELECT_REJECTED` on every preview ("Speaker rejected the stream"). Deploy now generates a fresh UUID on the laptop, base64-wraps it in `{"serial": "…"}`, and splices the resulting `<source>` block into the Speaker's `Sources.xml` immediately before `</sources>` using a busybox-safe read-loop. Idempotent: re-running on a Speaker that already carries a TUNEIN block (synthesised or original) is a strict no-op — byte-for-byte unchanged file, unchanged mtime. Other `<source>` blocks (AMAZON, SPOTIFY, AUX, INTERNET_RADIO, LOCAL_INTERNET_RADIO, RADIOPLAYER) survive byte-for-byte. BoseApp does not validate the token against anything external. Closes #157, completes the fix for #156.

### Added

- **`scripts/verify.sh` /select probe.** New check posts a TUNEIN `ContentItem` to `localhost:8090/select` and asserts HTTP 200 — the BoseApp → registry → source-resolution path that the missing-token bug breaks, which the existing wget-reachability probes never exercised. Snapshots `/now_playing` first and skips with `[SKIP]` when the Speaker is currently streaming anything other than `STANDBY`, so the probe never interrupts active playback.
- **`scripts/synthesize-tunein-token.sh`** — busybox-safe POSIX-`sh` splice helper called by deploy. Factored out so the four idempotency / splice / fresh-file / no-op branches are unit-tested on the laptop side against fixture `Sources.xml` files in `scripts/test/fixtures/`. Run the tests with `sh scripts/test/test_synthesize_tunein_token.sh`.

### Documentation

- **`docs/troubleshooting.md`** documents the "Speaker rejected the stream / every preview 502s" failure mode at the top, with the one-line `Sources.xml` grep readers can run to self-diagnose and a pointer to the deploy step that fixes it. Closes #157.

## [v0.8.1] - 2026-05-16

Recovery resilience release. Closes three gaps that surfaced once v0.8 went out: users whose speakers were already in the v0.8-fixed brick state still had no easy way out, the install guide didn't tell new users how to deploy the browser admin, and there was no documented path for a speaker that won't boot at all.

### Fixed

- **`scripts/deploy.sh` recovers brick-class speakers in one shot.** The MAC lookup at the top of the deploy used to query port 8090 — which is exactly the port that's dead when `shepherdd` isn't supervising `BoseApp`, the failure mode v0.8 closes for fresh installs. Users whose speakers were already in that state from the pre-0.8 deploy couldn't run `deploy.sh` to recover. The lookup now falls back to `/proc/device-tree/ocp/macaddr/mac-address` over the same SSH connection — u-boot populates that node from the SCM module's OTP at boot, independent of any userspace daemon. A running speaker takes the unchanged `/info` path; the fallback only fires when `/info` returns nothing. Format is identical (12 uppercase hex characters, no separators) so the resolver heartbeat sink path key still matches. Closes #152.

### Documentation

- **Install guide covers both layers explicitly.** `docs/installation.md` now leads with the two-layer model — mandatory **Resolver** plus the recommended **Browser admin SPA** — and a new "Step 1b" documents `admin/deploy.sh` alongside `scripts/deploy.sh`. The "Verify" section notes that `scripts/verify.sh` auto-skips admin probes when the SPA isn't deployed, so a resolver-only install is a valid passing state. README Quick-start updated to match (no longer implies the admin appears automatically). Closes #154.
- **Troubleshooting guide for the "won't boot at all" failure mode.** New top-of-file section in `docs/troubleshooting.md` for SoundTouch 10 speakers that don't respond to SSH, WiFi, or LAN and don't accept the standard Bose factory reset. Documents the two-stage button-press sequence (`Preset 1` + `Vol −` held during power-on, release on the orange/blue/white/orange LED sweep, hold again for ~15s once the second LED goes blue) that [@dimmu311](https://github.com/dimmu311) found in [#143](https://github.com/skarl/bose-soundtouch-resurrect/issues/143). Reaches the bootloader-level reset handler when userland-dependent recovery paths can't. Closes #153.

## [v0.8] - 2026-05-16

Onboarding hardening release. Closes a class of bug where the documented install path was non-reproducible because it required invisible manual sysadmin state on the maintainer's NV flash to work — every fresh user (especially on a different SoundTouch model) was walking off a cliff. Discovered when external contributor David reported a boot hang at ~90% on his ST 20 (discussion #121) that we couldn't reproduce on the maintainer's ST 10. Validated end-to-end on the test speaker after a clean shepherd-state reset: `scripts/verify.sh` reported 30 OK / 0 failed across resolver, admin SPA, CGIs, WebSocket, and speaker-proxy probes.

### Fixed

- **`scripts/deploy.sh` populates `/mnt/nv/shepherd/` with symlinks to every stock `Shepherd-*.xml`.** The firmware's process supervisor (**shepherdd**) reads daemon configs from `/mnt/nv/shepherd/` *instead of* `/opt/Bose/etc/` when that directory exists. Until this release our deploy created the directory and dropped only our resolver config into it — silently stopping every stock daemon (BoseApp, WebServer, the per-**variant** daemon, etc.) from being supervised on any fresh speaker. The deploy step is now a variant-agnostic loop: links every `/opt/Bose/etc/Shepherd-*.xml` into the override directory before pushing our own `Shepherd-resolver.xml`. Works identically on ST 10, ST 20, ST 30. See [ADR-0004](docs/adr/0004-shepherd-override-replaces-not-merges.md). Closes #144.
- **`resolver/build.py` exits 0 on partial success** so a single failed station no longer aborts deploy under `set -eu`. Returns 0 iff at least one station file was written, non-zero only when zero succeeded. Always prints a `built N of M station(s); K failed` summary line. The abort gate moves up the stack to `deploy.sh`'s existing `STATION_COUNT > 0` check, which is the correct place to express "we have something to push." Closes #145.
- **`scripts/uninstall.sh` fully reverses what deploy writes**, including the entire Shepherd override directory (`rm -rf /mnt/nv/shepherd` — the directory itself, never just its contents; the trailing `/*` form leaves an empty directory which is the same brick state in a different costume). The banner now also explicitly lists `httpd.conf` and `cgi-bin/lib/` (already transitively removed by `rm -rf /mnt/nv/resolver`). Closes #146.
- **`scripts/verify.sh` shepherd-symlink probe uses busybox-compatible `-type l`.** busybox 1.19.4 on the SoundTouch firmware doesn't support `find -lname`. Without this fix the otherwise-correct deploy reported `[FAIL] override directory contains stock-config symlinks` against a valid install.

### Added

- **`scripts/capture-state.sh <speaker-ip>`** — diagnostic capture for compatibility investigations. One-paste-back bundle: `/info` (model + **variant** + firmware), Shepherd override directory listing, stock Shepherd configs listing, shepherdd pids, NV-flash root, mounts, Shepherd-config mtimes, dmesg tail, `/var/log/messages` tail. Output to a timestamped local folder à la `scripts/backup-presets.sh`. `docs/troubleshooting.md` now points at it as the first step for filing a compat issue. Closes #147.
- **[ADR-0004 — shepherd-override-replaces-not-merges](docs/adr/0004-shepherd-override-replaces-not-merges.md)** — documents the architectural decision behind the symlink-population step, the symlinks-vs-copies tradeoff, and the explicit "never leave the override directory present-but-empty" rule with the recovery procedure if you do.
- **CONTEXT.md glossary additions** — Shepherdd, Shepherd config, Shepherd override directory, Variant, Stock daemon. Plus disambiguation of Override XML (SDK URL redirect, separate concern from the Shepherd override directory). Plus two new relationships covering the boot supervision flow.
- **Pre-release validation procedure in `MAINTAINING.md`** — documented shepherd-state-only reset workflow as the regression gate before any release that touches `/mnt/nv/`. Explicit WARNING about the `/mnt/nv/shepherd/*` (contents-only) footgun and recovery path if you trip on it.

### Changed

- **README compat table** reclassifies the SoundTouch mobile app from end-of-life to **partial**. WiFi onboarding and local control over LAN still work; only cloud-routed features (catalogue browsing, account, firmware updates) broke with the 2026-05-06 shutdown. Re-onboarding a freshly factory-reset speaker via the app is a viable recovery path. Closes #148.
- **`docs/compatibility.md` adopts a three-state rubric**: **Tested** (maintainer ran end-to-end on this model + firmware), **Confirmed** (external contributor reported success), **Inferred** (community evidence, no independent confirmation). One row per known model, each citing the evidence for its state. ST 10 = Tested, ST 20 / ST 30 = Inferred. Includes pointer to `scripts/capture-state.sh` for contributor onboarding. Closes #150.

### Documented

- **Pre-release shepherd-state-only reset executed against the test speaker on 2026-05-16.** Reset → factory-app confirmation → `scripts/deploy.sh` → 19 supervised daemons (18 stock + our resolver httpd) → `admin/deploy.sh` → `scripts/verify.sh` returned 30 OK / 0 failed. Empirically confirms the slice 1–4 fixes close the bug class that bit discussion #121. Closes #149.

## [v0.7.2] - 2026-05-15

### Fixed

- **`deploy.sh` no longer wipes `resolver/stations.json`.** The
  cleanup step before `build.py` used `rm -f s*`, which matched
  `stations.json`, `stations.example.json`, and `shepherd-resolver.xml`
  alongside the intended per-station output files. Narrowed both the
  cleanup and the matching SCP upload globs in
  `scripts/deploy.sh` and `scripts/refresh-streams.sh` to `s[0-9]*` —
  the same pattern `deploy.sh:59` already uses to count the produced
  station files, and `verify.sh:50` uses to detect them on the
  speaker. Also narrowed the same glob in the docs' manual SCP / `ls`
  examples (`resolver/build.py` docstring, `docs/installation.md`,
  `docs/customizing-presets.md`) and corrected `README.md` Quick-start
  step 4 to say copy-then-edit `stations.example.json` instead of
  editing it in place. Reported externally against the 0.5.0 tag
  (#141).

## [v0.7.1] - 2026-05-15

### Added

- **Favourites filter** — pill input above the Favourites tab list
  filters by name and id substring (case-insensitive). Drag reorder
  is disabled while a filter is active so the filtered subset can't
  be reordered against the unfiltered ground truth. The predicate is
  exported as `filterFavorites(list, query)` from
  `admin/app/favorites.js`.
- **Shared `pillInput({...})` primitive** in
  `admin/app/components.js` — leading-icon + clear-button text input
  used by the Search bar and the Favourites filter. CSS namespace is
  `.pill-input*` (renamed from the previous `.search-input*`).
- **Shared `.page` outer wrapper + `.page-title` / `.page-title-bar`
  primitive** — every primary view (Browse, Search, Favourites,
  Settings) wraps its body in `.page` for normalised vertical chrome
  and renders its title in a subtle pill box that visually rhymes
  with the filter input. Favourites list renders as one continuous
  rounded card.
- **`admin/app/row-internals.js`** — new module hoisting the
  helpers `appendMetaSeparator`, `genreChipEl`, `browseUrlToHash`,
  and `buildFavoriteHeart` that were previously duplicated between
  `components.js` (`stationRow`) and `show-hero.js` (`showHero`).
  Both call sites now import from `row-internals.js`.
- **ADR 0003** —
  [`docs/adr/0003-favourites-stay-fetch-only.md`](docs/adr/0003-favourites-stay-fetch-only.md).
  Documents why the Favourites field stays a fetch-only Field
  reconciled on boot + `visibilitychange`, and why no
  resolver-to-SPA push channel is being added.

### Changed

- **Now-Playing heart captures the station label, not the sid.** The
  heart on the Now-Playing card now resolves the entry's `name`
  through `renderNowPlayingTitle(np)` (the same source of truth used
  to render the visible title) instead of falling back to the sid.
  Hearting from the NP card now seeds `name` consistently with
  hearting from any row.
- **`toggleFavorite` collapsed into a thin wrapper over
  `replaceFavorites`.** The two action shapes now share one
  optimistic-write + rollback + toast path; `toggleFavorite`
  validates the id, computes the next list, and delegates.
- **Favourites row uses the shared station-row skin.** The dedicated
  `.favorites-row*` CSS namespace is gone; favourites rows render
  through `.station-row` with a `.station-row--crud` modifier that
  adds the drag-handle / pencil / trash affordances and the
  expand-in-place edit row.
- **`joinFilters` lives in `crumb-parts.js`.** Filter normalisation
  consolidated into the pure crumb-parts module;
  `outline-render.js` imports both `stringifyCrumbs` and
  `joinFilters` from there.
- **Outline-render takes an explicit render context.** Every render
  entry-point in `admin/app/views/browse/outline-render.js` now
  receives `ctx = {childCrumbs, currentParts}` from the navigation
  seam in `browse.js`. The old module-level `_childCrumbs` /
  `_currentParts` slots are gone — render state threads through
  arguments end-to-end, so two parallel renders can no longer race
  the same module slots.

### Fixed

- **Mobile horizontal-overflow** on `.section-h__meta` and
  `.settings-segment__opt`. Both elements force-wrap inside narrow
  viewports rather than triggering a horizontal scrollbar.
- **Mini-player title clamps on narrow viewports.** Adds
  `min-width: 0` to `.shell-mini` so the grid item lets long station
  names ellipsis instead of widening the row.
- **Inline CSS dropped from JS-emitted DOM.** The speaker-unreachable
  modal moved its chrome to dedicated `.speaker-unreachable*` rules
  in `style.css`; the `stationArt` `size` parameter is gone (the
  size lives entirely in CSS now). Several duplicate CSS blocks
  consolidated.
- **Search sticky bar aligns with sibling views.** Vertical padding
  on the Search tab's sticky filter bar is dropped so the input row
  sits on the same baseline as the title-pill rows in Favourites /
  Browse / Settings.

## [v0.7.0] - 2026-05-14

### Added

- **Favourites** — admin-owned record of hearted stations and shows,
  persisted on the speaker. Disjoint from the firmware-owned six
  hardware **Presets**: a TuneIn id can appear as a favourite, a preset,
  both, or neither. Favourites do not own the **Stream URL**; playback
  routes through the resolver's per-station entry under
  `/v1/playback/station/<id>`, the same source of truth the presets,
  preview, and inline-play paths already use.
  - **Persistent store** at `/mnt/nv/resolver/admin-data/favorites.json`.
    JSON array; array index = position. Atomic tmp+mv writes.
  - **CGI** at `admin/cgi-bin/api/v1/favorites` — GET / POST,
    structured-envelope errors (`INVALID_ID`, `INVALID_NAME`,
    `INVALID_ART`, `DUPLICATE_ID`, `INVALID_JSON`), CSRF guard + CORS
    preflight via the shared `playback.sh` lib (mirrors the `presets`
    CGI shape).
  - **Inline heart on every playable row + the Now-Playing card** —
    search rows, browse rows, show-landing rows, recently-viewed and
    popular rows in the search empty state, and the Now-Playing card
    next to the station name. Heart replaces the row's trailing chevron
    where present; the row body remains a link to station-detail. Heart
    visibility everywhere: `^[sp]\d+$` only — topic (`t`), artist (`m`),
    and non-Bose entries render no heart. The Now-Playing card heart
    additionally hides on AUX / BLUETOOTH / STANDBY.
  - **Favourites tab** (`#/favorites`) in the rail between Browse and
    Settings. Each row carries always-on affordances:
    `[drag-handle] [body — tap to play] [pencil] [trash]`. Pencil
    expands the row vertically in place for name / art / note editing
    (Save commits + POSTs; Cancel collapses without writing). Trash
    optimistically removes + POSTs immediately and surfaces a 5-second
    toast with Undo; tapping Undo restores at the previous index and
    POSTs the restored list. Drag-handle uses the same pointer-events
    idiom as the preset long-press detector — ghost row + drop
    indicator during drag, splice + POST on pointerup, pointercancel /
    Escape aborts with no POST.
  - **Now-Playing 3×3 preview grid** below the preset grid, rendering
    the first 9 entries. 0 favourites hides the section; 1–8 renders
    only the present cards (no placeholder slots). Tap = play; long-press
    / right-click = `#/favorites?focus=<id>` deep-link that scrolls the
    matching entry into view with a brief highlight on mount. Visual
    style mirrors preset cards (tinted background per `hashHue(name)`).
- **`resolveBrowseDrill` seam** at `admin/app/tunein-drill.js` —
  consolidates the **TuneIn drill** one-shot fetch policy behind a
  single tagged-result interface
  (`{kind:'ok'|'empty'|'error'}`). Browse's `renderDrill` and
  show-landing's browse half both consume the seam; `renderOutline`'s
  empty-body and single-tombstone branches move upstream of the
  renderer. Adding a new wire-shape case is now a single-file change
  in one classification table.
- **`Crumb stack` split** — `admin/app/views/browse/crumbs.js` splits
  into a pure `crumb-parts.js` (value type + label-resolution reads, no
  DOM, no `api.js` import; only depends on `tunein-cache` +
  `tunein-url`) and a DOM-bound `crumb-renderer.js` (pillbar render +
  async hydration). `outline-render.js` imports `stringifyCrumbs` from
  `crumb-parts` cleanly, deleting the local duplicate that worked
  around the previous import cycle.

### Changed

- **Favourites CGI uses POST, not PUT.** Bo's firmware ships busybox
  httpd v1.19.4 (2017) which returns `501 Not Implemented` for PUT
  before the CGI runs. POST is the only mutating method that reaches
  CGI scripts on the speaker; mirrors the `presets` convention.
- **`renderOutline` no longer owns body-level emptiness.** Top-level
  `rawItems.length === 0` and single-tombstone branches now live in
  the `resolveBrowseDrill` classifier. Per-section emptiness inside a
  non-empty body stays in `renderOutline` (sectioned bodies can still
  contain individual empty sections).

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

[v0.7.1]: https://github.com/skarl/bose-soundtouch-resurrect/releases/tag/v0.7.1
[v0.7.0]: https://github.com/skarl/bose-soundtouch-resurrect/releases/tag/v0.7.0
[v0.1.0]: https://github.com/skarl/bose-soundtouch-resurrect/releases/tag/v0.1.0
