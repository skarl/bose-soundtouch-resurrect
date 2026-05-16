# bose-soundtouch-resurrect

Bring your Bose SoundTouch back to life after the 2026-05-06 cloud
shutdown — without depending on Bose, without depending on a separate
PC or Pi, without ongoing infrastructure to maintain.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The speaker still expects to talk to four Bose-hosted services to
resolve preset stations. This project replaces all four with a tiny
static HTTP responder running **on the speaker itself** under the
existing busybox httpd. Once installed, the speaker streams audio
directly from the radio station's CDN — no external host involved.

## What you get back

| Capability                                  | After install     |
| ------------------------------------------- | ----------------- |
| 6 preset buttons → TuneIn radio stations    | ✅ working         |
| Spotify Connect, AUX, Bluetooth             | ✅ unchanged       |
| Browser admin on any LAN device             | ✅ full UI         |
| Bose SoundTouch mobile app                  | ⚠ partial — WiFi onboarding + local controls work over LAN; cloud-routed catalogue browsing, firmware updates, and account features broke with the 2026-05-06 shutdown. See [docs/compatibility.md](docs/compatibility.md) |
| Stereo pair / multi-room                    | ⚠ partial — single-speaker test rig only |
| Firmware updates                            | ❌ frozen forever  |

## The browser admin

Open `http://<speaker>:8181/` from any browser on the same LAN. The
admin SPA is the everyday interface post-cloud-shutdown — the
SoundTouch mobile app still handles WiFi onboarding (useful after a
factory reset) but its catalogue browsing and account features went
away with the cloud.

- **Now playing** — compact card with album art, transport, dynamic
  source switcher, a 3×2 grid of art-style preset cards, and a 3×3
  preview of your first nine favourites below it
- **Favourites** — heart any station or show from any row; manage in
  the dedicated tab with inline edit, toast-undo delete, and drag
  reorder. Disjoint from the six hardware presets — same station can
  be both
- **Search + Browse** — search TuneIn directly; browse by genre /
  location / language; recently-viewed cache
- **Station detail** — preview-play, assign to a preset slot, see
  available stream URLs and probe state (playable / gated / off-air)
- **Settings** — seven collapsibles (Appearance, Speaker, Audio,
  Bluetooth, Multi-room, Network, System) with a four-way theme
  picker (auto / graphite / cream / terminal) and a live WebSocket
  event log
- Mobile shell at narrow widths (sticky mini-player + bottom tabs);
  desktop side-rail at ≥960px
- Self-hosted Geist fonts; zero CDN dependencies — works whether or
  not your home internet is up

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## How it works

```
       ┌────────────────────────────┐
       │  Bose SoundTouch           │
       │   BoseApp (closed-source)  │
       │      │ resolves URLs from  │
       │      │ /mnt/nv/Override*   │
       │      ▼                     │
       │   busybox httpd            │
       │      │ serves JSON + XML   │
       │      ▼                     │
       │   /mnt/nv/resolver/        │
       │      └── presets, registry │
       │                            │
       │   audio out                │
       └─────────┬──────────────────┘
                 │ HTTP audio stream
                 ▼
           ┌────────────┐
           │ TuneIn CDN │
           └────────────┘
```

The speaker streams audio direct to the radio CDN. Only metadata
("which URL plays for preset 1?") flows through the on-speaker
resolver. The Bose cloud is not in the path.

For the longer story see [docs/architecture.md](docs/architecture.md).

## Compatibility

Confirmed on **Bose SoundTouch 10, firmware 27.0.6**.

Likely to work on other ST-family models that share the same Linux /
shepherdd architecture (ST 20, ST 30, similar Wave variants), but
unverified. See [docs/compatibility.md](docs/compatibility.md) for
the full list and how to confirm yours.

## Prerequisites

- A SoundTouch speaker that's been online recently enough to have
  stored preset stations locally (the speaker's port-8090 API
  exposes them).
- A laptop with `python3`, `ssh`, and `scp`.
- A **micro-USB OTG adapter** (~€3) and a small **FAT32 USB stick** —
  needed once to enable SSH on the speaker.
- Speaker and laptop on the same LAN.

## Quick start

Five steps. Each one links to the full doc.

1. **Confirm your speaker is supported** —
   [docs/compatibility.md](docs/compatibility.md).
2. **Open up your speaker** (one-time, enables SSH) —
   [docs/opening-up-your-speaker.md](docs/opening-up-your-speaker.md).
   Format USB stick FAT32, drop a marker file, plug in, boot.
3. **Install the resolver** —
   [docs/installation.md](docs/installation.md). Pushes static files
   to `/mnt/nv/resolver/`, drops a daemon config that binds
   `0.0.0.0:8181` (loopback for the SDK; LAN-reachable for the admin
   SPA), points the speaker at `127.0.0.1:8181`, reboots.
4. **Customise your presets** —
   [docs/customizing-presets.md](docs/customizing-presets.md). Either
   copy `resolver/stations.example.json` to `resolver/stations.json`,
   edit it, and run `build.py`, or use the browser admin: search →
   assign to slot.
5. **Verify** with `scripts/verify.sh <speaker-ip>` and press a
   preset button on the speaker.

## The recurring chore

TuneIn rotates partner-routed stream URLs every so often. When a
preset suddenly stops playing, run `./scripts/refresh-streams.sh
<speaker-ip>` (or click *Refresh stream URLs* in the admin's System
settings). Roughly two minutes of work per drift.

## What this doesn't do

Several Bose-firmware constraints shape what's feasible. Calling them
out so you know what to expect:

- **No firmware patches.** Bose stopped shipping updates. If a
  security issue surfaces in the speaker's firmware, this project
  can't ship a fix.
- **No `/lowPowerStandby` toggle.** Enabling deep standby drops the
  speaker's WiFi radio — recovery requires a hardware power-cycle.
  The admin deliberately omits the control.
- **No on-speaker notifications gizmo.** The `/notification`
  endpoint returns HTTP 500 for every body shape we (and the wider
  open-source ecosystem: libsoundtouch, bosesoundtouchapi, openHAB,
  Home Assistant) have tried.
- **No factory reset from the admin.** Use the on-speaker hardware
  button sequence.
- **Multi-room view is parked.** State, parsers, and actions all
  ship; the picker UI awaits a multi-speaker test rig.
- **Bose mobile app is partial.** WiFi onboarding and local
  controls still work over LAN — re-onboarding a freshly factory-reset
  speaker via the app is a viable recovery path. Catalogue browsing,
  account features, and firmware-update prompts went away with the
  cloud. The browser admin is the everyday interface.

If you specifically want the SoundTouch mobile app's catalogue
back, run an external SoundCork-style emulator alongside this
project. See [docs/architecture.md](docs/architecture.md).

## Repo layout

```
.
├── docs/         User-facing documentation + ADRs
├── resolver/     The on-speaker static-file resolver + build script
├── admin/        Browser admin SPA (HTML / CSS / ES modules / shell CGIs)
└── scripts/      Install, verify, deploy, refresh, backup, ssh helpers
```

## Project documents

- [CHANGELOG.md](CHANGELOG.md) — release notes, including the
  firmware quirks discovered along the way
- [CONTRIBUTING.md](CONTRIBUTING.md) — bug reports, PRs, compat
  reports
- [MAINTAINING.md](MAINTAINING.md) — release process, branch
  protection, adding maintainers
- [SECURITY.md](SECURITY.md) — threat model and disclosure
- [LICENSE](LICENSE) — MIT
- [docs/troubleshooting.md](docs/troubleshooting.md) — when things
  go wrong

## Acknowledgements

Builds on prior community work on the SoundTouch platform — chiefly
SoundCork-style emulators, the various reverse-engineering writeups
that documented the speaker's local API and the override-XML
mechanism, and TuneIn's public OPML API
(`opml.radiotime.com`) which provides the stream URLs the speaker
would otherwise have asked the Bose cloud for.
