# bose-soundtouch-resurrect

Bring your Bose SoundTouch back to life after the 2026-05-06 cloud
shutdown — without depending on Bose, without depending on a separate
PC or Pi, without ongoing infrastructure to maintain.

This project replaces the four cloud services your speaker still
expects to talk to with a tiny static HTTP responder running **on the
speaker itself**. The speaker resolves preset stations from its own
filesystem and streams audio directly from the radio station's CDN.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What this gets you back

| Feature                                     | After install      |
| ------------------------------------------- | ------------------ |
| 6 preset buttons (TuneIn radio)             | ✅ working          |
| Bose SoundTouch app — pairing, presets, vol | ✅ working          |
| Spotify Connect, AUX, Bluetooth             | ✅ working (always was) |
| Bose SoundTouch app — in-app station browse | ⚠ partial — see [docs/compatibility.md](docs/compatibility.md) |
| Stereo pair / multi-room                    | ⚠ partial — untested |
| Firmware updates                            | ❌ blocked — speaker firmware is frozen forever |

## How it works

```
                ┌──────────────────────────────┐
                │ Bose SoundTouch              │
                │   BoseApp                    │
                │     │                        │
                │     │ resolves URLs from     │
                │     │ /mnt/nv/OverrideSdk... │
                │     ▼                        │
                │   busybox httpd  (localhost) │
                │     │                        │
                │     │ serves static JSON/XML │
                │     ▼                        │
                │   /mnt/nv/resolver/          │
                │     ├── bmx/...              │
                │     ├── marge/...            │
                │     └── v1/...               │
                │                              │
                │   audio out                  │
                └─────────┬────────────────────┘
                          │ HTTP audio stream
                          ▼
                    ┌────────────┐
                    │ TuneIn CDN │
                    └────────────┘
```

The speaker's audio path is **direct to the radio CDN**. Only metadata
("what URL plays for preset 1?") goes through the on-speaker resolver.
Once the speaker has the URL, it streams from the public internet
itself.

For the longer story see [docs/architecture.md](docs/architecture.md).

## Compatibility — does this work for me?

Confirmed on **Bose SoundTouch 10, firmware 27.0.6**.

Likely to work on other ST-family models that share the same Linux /
shepherdd architecture (ST 20, ST 30, similar Wave variants), but
unverified. See [docs/compatibility.md](docs/compatibility.md) for the
full list and how to confirm yours.

## Prerequisites

- A SoundTouch speaker that's been online recently enough to have stored
  preset stations locally (the speaker's port-8090 API exposes them).
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
   Format USB stick FAT32, drop a marker file, plug into speaker, boot.

3. **Install the resolver** —
   [docs/installation.md](docs/installation.md). Push static files to
   `/mnt/nv/resolver/`, drop a daemon config, point the speaker at
   `127.0.0.1:8181`, reboot.

4. **Customise your presets** —
   [docs/customizing-presets.md](docs/customizing-presets.md). Find your
   stations on tunein.com, edit `resolver/stations.example.json`, run
   `python3 resolver/build.py`, redeploy.

5. **Verify** with `scripts/verify.sh <speaker-ip>` and press a preset
   button on the speaker.

## When things go wrong

[docs/troubleshooting.md](docs/troubleshooting.md) — the most common
failures and how to diagnose. If you're stuck, open an issue with the
output of `scripts/verify.sh`.

## What's in this repo

```
.
├── docs/                         User-facing documentation.
│   ├── compatibility.md
│   ├── opening-up-your-speaker.md   The USB-OTG SSH-enable trick.
│   ├── installation.md
│   ├── customizing-presets.md
│   ├── troubleshooting.md
│   ├── architecture.md
│   ├── api-reference.md          The speaker's local port-8090 API.
│   ├── tunein-api.md             TuneIn's OPML API, as used by build.py + admin.
│   └── history.md                How this project came about.
│
├── resolver/                     The on-speaker resolver.
│   ├── build.py                  Fetch fresh stream URLs from TuneIn.
│   ├── stations.example.json     Example preset list — edit for yours.
│   ├── responses/                Static templates (registry, etc.).
│   └── shepherd-resolver.xml     Daemon config for auto-start at boot.
│
├── admin/                        Browser-based admin UI (planned).
│   └── PLAN.md                   Design plan.
│
└── scripts/                      Helpers.
    ├── enable-ssh-stick.sh        Prep a USB stick for the SSH-enable trick.
    ├── deploy.sh                  End-to-end install on a speaker.
    ├── verify.sh                  Post-install sanity check.
    ├── refresh-streams.sh         Re-fetch stream URLs and push (the recurring chore).
    ├── store-preset.sh            Assign a station to preset slot 1..6 via the speaker API.
    ├── backup-presets.sh          Capture current speaker state to a local timestamped folder.
    ├── uninstall.sh               Remove the resolver, roll back to stock config.
    └── ssh-speaker.sh             SSH wrapper with the right flags.
```

## Limitations

- **Stream URLs occasionally rotate.** TuneIn changes the partner-routed
  stream URL for a given station every so often. When a preset suddenly
  stops playing, run `./scripts/refresh-streams.sh <speaker-ip>`. About
  two minutes of work.
- **In-app station browse / search** isn't fully covered — the
  on-speaker resolver answers preset playback but not the
  `/v1/navigate` and `/v1/search` calls the SoundTouch app uses to
  browse the catalogue. If you need that, run an external
  SoundCork-style emulator on the side; this project does not include
  one. See [docs/architecture.md](docs/architecture.md) for what's
  emulated and what isn't.
- **No firmware patches.** Bose stopped issuing updates. If a security
  issue surfaces in the speaker's firmware, this project can't ship a
  fix.

## Status

Working in production on a SoundTouch 10. All six preset buttons drive
TuneIn streams via the on-speaker resolver. No external host required.

## Project documents

- [LICENSE](LICENSE) — MIT.
- [CHANGELOG.md](CHANGELOG.md) — release notes.
- [CONTRIBUTING.md](CONTRIBUTING.md) — bug reports, PRs, compat reports.
  Outside contributors fork-and-PR; only listed maintainers merge.
- [MAINTAINING.md](MAINTAINING.md) — for maintainers: branch protection
  setup, release process, adding new maintainers.
- [SECURITY.md](SECURITY.md) — threat model and how to disclose.

## Acknowledgements

Builds on prior community work on the SoundTouch platform — chiefly
SoundCork-style emulators, the various reverse-engineering writeups
that documented the speaker's local API and the override-XML mechanism,
and TuneIn's public OPML API (`opml.radiotime.com`) which provides the
stream URLs the speaker would otherwise have asked the Bose cloud for.
