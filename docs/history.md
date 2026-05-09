# Project history

How this project came about, and the decisions that shaped what's in
the repo today.

## Starting point

Bose shut down their SoundTouch cloud servers permanently on
2026-05-06. SoundTouch speakers are LAN devices — Wi-Fi, Bluetooth,
AUX, the local port-8090 API, the SoundTouch app's pairing and volume
control — none of those needed a cloud. But the **6 preset buttons**
and the **in-app TuneIn browse** were cloud-coupled in a way that
turned them into dead weight overnight.

This project is one solution to that.

## What the firmware actually needs

Reverse engineering of the speaker firmware (across several community
projects in the years before the shutdown) had established that the
firmware talks to four Bose cloud hostnames, one for each of:

- `streaming.bose.com` — playback metadata ("marge")
- `content.api.bose.io` — service registry, TuneIn resolve
- `worldwide.bose.com` — firmware updates
- `events.api.bosecm.com` — telemetry

These four URLs are configured in
`/opt/Bose/etc/SoundTouchSdkPrivateCfg.xml` on the speaker. Modern
firmware also honours an override at
`/mnt/nv/OverrideSdkPrivateCfg.xml`.

## Prior art: SoundCork-style emulators

By the time of the shutdown, two community projects had already built
out an emulator for these four endpoints — a Python/FastAPI service
collectively known as **SoundCork**, with a Docker harness on top. The
intended deployment was: SoundCork runs on a Pi or PC on your LAN,
override XML on the speaker points at that host, speaker thinks it's
still talking to Bose.

This works, and is a perfectly good answer for users who want the
fullest emulation (including the in-app browse / search). It's also
*more infrastructure than the speaker actually needs*, for the
preset-radio use case.

## The audio path is direct

The key insight that made this project's approach viable: the speaker
streams audio **directly** from the radio station's CDN. Once it has
the URL, the cloud isn't in the audio path — only the metadata
"what URL plays for preset 1?" is.

That metadata is small (~1 KB per station), changes rarely, and is
trivially serveable by anything that talks HTTP.

## The speaker has busybox httpd

A second insight: the SoundTouch firmware is built on a custom Bose
Linux that includes busybox, and busybox includes a working `httpd`.
The speaker also has ~30 MB of free space in `/mnt/nv` (its writable
NVRAM partition), and `shepherdd` (the Bose process supervisor) reads
its daemon list from `/mnt/nv/shepherd/Shepherd-*.xml` at boot.

So the metadata server can run **on the speaker itself**, with the
override XML pointing at `127.0.0.1:8181`. No external host needed.

## The DNS-redirect dead end

An earlier attempt skipped the SSH-enable step by redirecting DNS at
the router level — the four Bose hostnames pointed at the resolver
host. The speaker doesn't know it's been redirected, the override XML
stays untouched, and presumably this scales to multiple speakers
without per-speaker config.

This failed empirically. The firmware **strictly validates the TLS
certificate chain**: a self-signed cert returns
`TLS alert 48 (unknown_ca)` and the speaker refuses to proceed. Working
around that requires installing a CA cert into the speaker's trust
store, which needs SSH — and once SSH is available, the override-XML
approach is simpler and uses plain `http://` end-to-end.

So DNS redirect was abandoned as a strict regression.

## The TuneIn API quirk

`build.py` calls TuneIn's public OPML endpoint
(`https://opml.radiotime.com/Tune.ashx`) to fetch live stream URLs.
Naive calls return a placeholder
`http://cdn-cms.tunein.com/service/Audio/notcompatible.enUS.mp3` for
some stations — a "your client isn't allowed" sentinel.

Adding `formats=mp3,aac&lang=de-de` to the query unlocks the
partner-routed real URLs. This was found by trial and error and a bit
of curl tracing. If TuneIn changes their API in future, `build.py`
will need adjusting.

## Perl considered but rejected

Earlier iterations considered a dynamic Perl-CGI resolver that calls
`opml.radiotime.com` at request time, eliminating the periodic
`build.py` re-run. The speaker's firmware ships `/usr/bin/perl5.14.3`
— but on at least the firmware tested, **`libperl.so.5` and the entire
`@INC` module tree are absent**. The binary is unrunnable. Reviving
Perl on the speaker would require shipping a cross-compiled
`libperl.so.5` plus a full module tree to `/mnt/nv/`. Tractable but
not small.

A lighter alternative is a CGI in `awk` + `wget` — busybox has both,
no extra binaries. About 100 lines of awk. This wasn't built for v1
because the static-file approach was sufficient and the
`build.py` re-run is a 2-minute chore.

## Auto-start with shepherdd

`shepherdd` is the speaker's PID 1-equivalent process supervisor. It
launches Bose's own daemons (`BoseApp`, `WebServer`, `APServer`, etc.)
from a set of XML configs at `/opt/Bose/etc/Shepherd-*.xml`.
shepherdd's command line passes
`--recovery /mnt/nv/shepherd`, meaning it scans that directory at
startup and honours any `Shepherd-*.xml` it finds — including ours.

Earlier development notes in this project incorrectly claimed that
shepherdd ignored `Shepherd-resolver.xml`; that turned out to be a
deployment-order mistake (the file wasn't on disk at the boot in
question). On a clean reboot, the daemon starts reliably.

## Limits of the v1 design

Acknowledged trade-offs:

- **Stream URLs go stale** every few months/years. Manual `build.py`
  re-run fixes it.
- **In-app TuneIn browse / search** is not implemented. The
  `/v1/navigate` endpoints aren't mocked. SoundCork-style emulators
  do implement these; running one alongside this project is the
  workaround.
- **Multi-room / stereo pair** is untested. Probably needs SoundCork
  as well.
- **Firmware updates** are blocked (404 on `/updates/soundtouch`).
  Empirically harmless — the speaker keeps working — but tidier would
  be a stub "no update" response.

## Where it's going

A small browser-based admin UI is planned (see
[../admin/PLAN.md](../admin/PLAN.md)). The aim is to replace the
`build.py` + scp + curl-storePreset workflow with point-and-click,
hosted entirely on the speaker via static SPA + thin shell CGI.

Long-term, an awk-based dynamic resolver could eliminate the
periodic-refresh chore. Wanted but not needed yet.

## Acknowledgements

This project stands on prior community work documenting the SoundTouch
internals — the local API, the override-XML mechanism, the boot
sequence, the USB-stick SSH-enable trick. SoundCork (deborahgu's
original and timvw's Docker fork) was instrumental as a reference for
the response shapes the firmware expects.
