# Architecture

How this project keeps a SoundTouch speaker working after the cloud
shutdown.

## What the speaker actually needs

When you press a preset button, the speaker firmware does *not* know
the radio station's stream URL. It has only the **TuneIn ID** (e.g.
`s12345`). To play, it has to look up the actual URL — historically
that was a call to Bose's cloud, which forwarded to TuneIn's own
backend.

Specifically, the firmware makes HTTP calls to four cloud hostnames:

| Hostname (original)         | XML element        | Role |
| --------------------------- | ------------------ | ---- |
| `streaming.bose.com`        | `margeServerUrl`   | "marge" — playback metadata |
| `content.api.bose.io`       | `bmxRegistryUrl`   | "bmx" — service registry, TuneIn resolve |
| `worldwide.bose.com`        | `swUpdateUrl`      | Firmware updates |
| `events.api.bosecm.com`     | `statsServerUrl`   | Telemetry / stats |

These four URLs live in
`/opt/Bose/etc/SoundTouchSdkPrivateCfg.xml` on the speaker's filesystem,
read at boot. The firmware also honours an override at
`/mnt/nv/OverrideSdkPrivateCfg.xml` if present — that's the hook this
project uses.

## The audio path is direct

A crucial property of the firmware: **only metadata** goes through the
cloud lookup. Once the speaker has the actual stream URL (e.g.
`https://streams.example.com/.../live.aac`), it streams audio from that
URL itself, directly. The cloud is never in the audio path.

```
preset press
     │
     ▼
speaker asks resolver: "what plays for s12345?"
     │
     ▼
resolver returns JSON: {"audio":{"streamUrl":"https://streams..../live.aac"}}
     │
     ▼
speaker opens HTTP audio stream from the URL itself
     │
     ▼
audio plays (resolver no longer involved)
```

Once a stream is playing, the resolver could go down and the audio
keeps going. Switching to a different preset is when the resolver gets
hit again.

This is why the metadata layer can be small and static-ish — it's
asked once per preset switch, not continuously.

## What we replace it with

```
            ┌──────────────────────────────────────────────┐
            │ Bose SoundTouch (your speaker)               │
            │                                              │
            │  ┌────────────────────────────────────────┐  │
            │  │ BoseApp                                │  │
            │  │   │                                    │  │
            │  │   │ HTTP to URLs in                    │  │
            │  │   │ /mnt/nv/OverrideSdkPrivateCfg.xml  │  │
            │  │   ▼                                    │  │
            │  │ 0.0.0.0:8181    busybox httpd          │  │
            │  │   │                                    │  │
            │  │   │ serves static JSON/XML from        │  │
            │  │   ▼                                    │  │
            │  │ /mnt/nv/resolver/                      │  │
            │  │   ├── bmx/registry/v1/services         │  │
            │  │   ├── bmx/tunein/v1/playback/station/  │  │
            │  │   ├── bmx/tunein/v1/report             │  │
            │  │   ├── marge/streaming/sourceproviders  │  │
            │  │   └── v1/scmudc/<MAC>                  │  │
            │  │                                        │  │
            │  │ audio output                           │  │
            │  └────────┬───────────────────────────────┘  │
            └───────────┼──────────────────────────────────┘
                        │ HTTP audio stream
                        │ (direct to public internet)
                        ▼
                  ┌────────────┐
                  │ TuneIn CDN │
                  └────────────┘
```

Every component lives on the speaker. No external host.

## The four enabling properties

This works because of four things about the speaker firmware:

1. **`busybox` includes `httpd`.** The speaker has a tiny but capable
   HTTP server already on disk (`/bin/httpd` symlinks to busybox). It
   can serve static files and execute CGI, both of which we use.

2. **`/mnt/nv` is writable, persistent NVRAM.** ~30 MB of free space on
   a separate UBIFS partition. Survives reboots and most upgrades;
   wiped only by factory reset.

3. **`shepherdd` is the Bose process supervisor.** It reads
   `Shepherd-*.xml` config files at startup and supervises any daemons
   listed there. If we drop a config in `/mnt/nv/shepherd/`, our daemon
   joins the supervision tree and gets started/restarted alongside
   Bose's own components.

4. **The override XML accepts plain `http://` URLs.** Even though the
   originals were `https://`, the firmware happily issues plain-HTTP
   requests when overridden. So we don't need TLS, certificates, or a
   trust-store install.

## Why not DNS-redirect instead?

An obvious alternative: leave the override XML alone, point the four
Bose hostnames at our resolver via DNS (router-side or with a
forwarding service), and let the speaker think it's still talking to
the cloud.

Tried; doesn't work. The firmware **strictly validates the TLS
certificate chain** against its trust store. A self-signed cert
returns `TLS alert 48 (unknown_ca)` and the speaker refuses to
proceed. Working around that requires installing a CA cert into the
speaker's trust store via SSH — at which point you've already done
the SSH step that the override-XML approach also needs, and DNS-redirect
has no remaining advantage.

So: override XML with `http://`, no DNS redirect, no certificates.

## Why not run a Pi or a PC?

Earlier iterations of this kind of project (and the
[`deborahgu/soundcork`](https://github.com/deborahgu/soundcork) /
[`timvw/soundcork`](https://github.com/timvw/soundcork) branch of
prior work) emulate the cloud on a separate Linux host (Pi, NAS, or
PC) and point the speaker at it. That works. It's also more moving
parts than the speaker actually needs:

- The host has to be online when you press a preset.
- Power cost (~5 W for a Pi continuously).
- An update / failure on the host is one more thing to keep an eye on.
- For a single speaker with a fixed set of presets, the host is
  doing very little — preset-switch metadata is a few KB per press.

Hosting on the speaker eliminates all of this. The trade-off is that
some features need either external help or further development:

- **In-app TuneIn browse / search** (the "explore stations" UI in
  the SoundTouch mobile app) calls navigation endpoints we haven't
  mocked. The on-speaker resolver returns 404 for those. SoundCork-style
  emulators implement the full set.
- **Multi-room / stereo pair** uses cloud-coordinated discovery in some
  firmware versions. Untested with on-speaker-only.

If you need these, run an external SoundCork-style emulator alongside
this project (or instead of it). They're complementary, not exclusive.

## What lives on the speaker after install

```
/mnt/nv/
├── OverrideSdkPrivateCfg.xml         four URLs all → http://127.0.0.1:8181
├── remote_services                   SSH persistence marker
├── shepherd/
│   ├── Shepherd-{core,noncore,product,...}.xml   symlinks to /opt/Bose/etc/
│   └── Shepherd-resolver.xml         starts /bin/httpd at boot
└── resolver/
    ├── bmx/registry/v1/services      static JSON
    ├── bmx/tunein/v1/playback/station/sNNNNN   one per preset (built by build.py)
    ├── bmx/tunein/v1/report          static (telemetry sink)
    ├── marge/streaming/sourceproviders   static XML
    └── v1/scmudc/<your-MAC>          static (heartbeat sink)
```

## Refresh cycle

Stream URLs occasionally rotate (TuneIn's choice, not ours — typically
months apart). When that happens, the affected preset stops playing
silently. Two ways to fix:

- From a laptop: rerun `resolver/build.py` and re-push the station
  files. The resolver picks up new files immediately; no reboot.
- From a browser on the LAN: open the admin at
  `http://<speaker>:8181/`, hit **Settings → Speaker → Refresh all
  presets**. The on-speaker `refresh-all` CGI re-probes TuneIn for
  every slot and atomically rewrites any drifted JSON in place.

This is the only ongoing maintenance the project asks of you.

## The browser admin (added in 0.4)

The admin SPA is a single-page app served by the same `busybox httpd`
that serves the resolver tree. Same docroot, no separate process, no
extra port — `http://<speaker>:8181/` returns `index.html` and
everything under `/app/`, `/cgi-bin/api/v1/`, and `/fonts/` is the
admin; everything under `/bmx/`, `/marge/`, `/v1/` is the resolver.

Architecture in three layers:

1. **Static SPA** — `index.html` + `style.css` + an ES-module tree
   under `/app/`. No build step (vanilla CSS, native ES modules,
   tagged-template DOM). Cache-busted via `?v=<git-describe>` query
   strings rewritten at deploy time. Every primary view wraps its
   body in a shared `.page` outer chrome with a `.page-title-bar`
   pill (Browse, Search, Favourites, Settings); shared row primitives
   live in `components.js` (`stationRow`, `pillInput`, `stationArt`,
   etc.) with rendering helpers hoisted into `row-internals.js` so
   the Now-Playing show-hero and the browse station-row share the
   same meta-separator, genre-chip, and favourite-heart code paths.
   The browse outline-render pipeline threads an explicit render
   context (`ctx = {childCrumbs, currentParts}`) through every
   render entry-point — no module-level slots.
2. **Shell CGIs under `/cgi-bin/api/v1/`** — `tunein` (forwarder for
   browse / search / probe), `presets` (atomic file-write +
   `/storePreset`), `favorites` (atomic JSON write for the admin-owned
   favourites list, disjoint from the firmware presets),
   `speaker` (wildcard proxy to `localhost:8090` with a same-origin
   CSRF guard), `refresh-all` (bulk re-probe + atomic resolver
   rewrite). All busybox-shell, all linted by shellcheck. Mutating
   endpoints use POST — busybox httpd v1.19.4 (2017) returns 501 for
   PUT before the CGI runs.
3. **WebSocket client** — connects to the speaker's port 8080 with the
   `gabbo` subprotocol. Reconnect with exponential backoff + full
   jitter; REST polling fallback when WS is down. The admin reflects
   speaker state in real time and surfaces side-channel changes
   ("pressed on speaker") as toasts.

The admin is **self-contained on the speaker**. Fonts (Geist + Geist
Mono) live under `/mnt/nv/resolver/fonts/` and are referenced by
relative URL — the LAN can be cut off from the public internet and
the admin still loads. No CDN, no Google Fonts, no `unpkg`.

User-facing surface as of 0.7.1:

- Now-playing — transport, volume, source picker, preset row,
  long-press to assign, 3×3 favourites preview grid below the preset
  grid (long-press on a favourite card jumps to the Favourites tab
  focused on that entry).
- Browse — Genre / Location / Language drill via TuneIn's outline.
  Every playable row carries an inline heart toggle.
- Search — debounced TuneIn search; landing page shows recently
  viewed and popular. Every playable result carries the heart.
- Station detail — metadata, probe state, 3×2 preset grid, test-play,
  inline heart next to the station name.
- Favourites — dedicated tab with full CRUD (drag reorder,
  expand-in-place edit, toast-undo delete) and a pill filter input
  above the list (drag is disabled while a filter is active).
  Persists in a JSON file at
  `/mnt/nv/resolver/admin-data/favorites.json`. Disjoint from the
  six firmware-owned hardware presets — a station can be both. See
  [adr/0003-favourites-stay-fetch-only.md](adr/0003-favourites-stay-fetch-only.md)
  for why the favourites field is fetch-only with no push channel.
- Settings — Appearance (theme), Speaker (name / power / sleep),
  Audio (bass / balance / mono-stereo), Bluetooth (own MAC + active
  device), Multi-room (placeholder), Network (signal bars),
  System (firmware / capabilities / WS log).

What the admin deliberately does **not** expose:

- `/lowPowerStandby` — a one-shot trigger that suspends the speaker's
  WiFi radio and locks the LAN out. Even idempotent reads would
  trigger it on this firmware.
- `/notification` — handler returns HTTP 500 `CLIENT_XML_ERROR` for
  every observed body shape; verified across the open-source
  ecosystem to be non-functional on this firmware family.
- Wi-Fi reconfiguration — easy to lock yourself out.
- Firmware updates — already blocked by the cloud shutdown.

## The TuneIn API quirk

`build.py` calls TuneIn's public OPML endpoint at
`https://opml.radiotime.com/Tune.ashx?id=sNNNNN`. Two parameters
are essential:

- `formats=mp3,aac` — without this, some stations return a placeholder
  `notcompatible.enUS.mp3` "this client isn't allowed" URL instead of
  the real partner-routed stream.
- `lang=de-de` (or another locale) — same. The `lang` param appears to
  signal "I'm a partner-aware client" alongside `formats`.

These were discovered empirically. Other projects accessing the same
API have had to find the same incantation. If TuneIn changes their API
in future, `build.py` will need adjusting; opening an issue is the
fastest path to a fix.

## Failure modes and fallbacks

- **Resolver httpd dies at runtime.** `shepherdd` restarts it
  automatically, like any of Bose's own daemons.
- **Resolver returns malformed JSON for a station.** BoseApp likely
  goes into an error state for that preset; pressing a different
  preset recovers. Fix the JSON file and the next press picks up the
  fix.
- **`/mnt/nv` fills up.** Unlikely (~30 MB free, the whole resolver
  tree is < 100 KB) but if it happens, prune log directories under
  `/mnt/nv/BoseLog/`.
- **Factory reset.** Wipes `/mnt/nv` entirely — both the SSH-enable
  marker and the resolver. Re-do the USB-stick step
  ([opening-up-your-speaker.md](opening-up-your-speaker.md)) and
  re-run the deploy.
