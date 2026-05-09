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
            │  │ 127.0.0.1:8181  busybox httpd          │  │
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
silently. The fix is rerunning `resolver/build.py` and re-pushing the
station files; the resolver picks up new files immediately, no
reboot.

This is the only ongoing maintenance the project asks of you.

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
