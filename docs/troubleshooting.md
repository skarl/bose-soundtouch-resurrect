# Troubleshooting

Diagnose top-down: override XML → resolver httpd on speaker → resolver
tree contents → upstream stream URL. Most failures collapse to one of
these.

For the rest of this doc, `SPEAKER_IP` stands for your speaker's LAN IP.

**Filing a compatibility issue?** Run
`scripts/capture-state.sh $SPEAKER_IP` first — it bundles `/info`,
health (memory / disk / load), the full `/opt/Bose/etc/` listing, the
Shepherd override directory + stock config contents, the live process
list, port reachability, firewall/routing, and the dmesg / messages
tails into a timestamped folder. It **anonymises MACs, LAN IPs, serial
numbers, the account UUID and the speaker name by default** (and never
captures the TuneIn token at all), so the bundle is safe to paste into
a public issue. Pass `--raw` only when capturing your own bench
speaker.

## If the speaker won't boot at all (no SSH, no WiFi, no LAN)

Symptoms: the speaker no longer joins WiFi, isn't reachable over LAN,
SSH connects refuse or time out, and the standard Bose factory reset
(hold `Preset 1` + `Vol −` until the speaker beeps) does nothing —
userland isn't running far enough to register the button event.

The most common cause is a speaker that ran the pre-0.8 `deploy.sh`
(see #144): it created `/mnt/nv/shepherd/` with only the resolver
config inside and no stock variant files alongside, which made
`shepherdd` stop supervising `BoseApp`, `WebServer`, `NetManager`,
and the other daemons that bring the speaker up at boot. The deploy
path was fixed in v0.8 **for the SoundTouch 10**; this section is for
anyone whose speaker is still stuck in that state.

> **⚠ SoundTouch 20 (and untested models): do not just re-run
> `deploy.sh`.** In
> [#160](https://github.com/skarl/bose-soundtouch-resurrect/issues/160)
> a real ST 20 boot-loops after `deploy.sh` even on 0.8.2 — and
> re-running deploy after a hard reset re-bricks it. The 0.8 fix is
> only validated on the ST 10. If you're on an ST 20 or any model not
> marked **Tested** in [compatibility.md](compatibility.md), recover
> with the button sequence below, then **stop** and capture state with
> `scripts/capture-state.sh` rather than redeploying.

USB-stick `Update.stu` re-flash does not help (the bug lives in
`/mnt/nv/`, not in the firmware image), and the USB-cable-to-laptop
SSH path does not help either (userland is too degraded to expose
the USB-network gadget).

[@dimmu311](https://github.com/dimmu311) documented a two-stage
button-press sequence in [#143](https://github.com/skarl/bose-soundtouch-resurrect/issues/143)
that reaches the bootloader / early-boot button handler at the
right moment to trigger a deeper reset than the userland one:

1. AC unplug.
2. Press and hold `1` + `Vol −`.
3. AC plug back in.
4. After a few seconds the LEDs sweep left to right:
   **orange, blue, white, orange**.
5. Release the buttons. Be careful at this moment — timing matters.
6. The LEDs briefly all go off.
7. The second LED comes up blue. Press and hold `1` + `Vol −` again.
8. After about 15 seconds the first LED lights blue and all others
   are off. Release.

The speaker's setup-mode hotspot is now active — re-onboard via the
SoundTouch mobile app as you would with a new speaker.

This procedure is verified on the **SoundTouch 10**. Other models in
the family very likely have an equivalent bootloader-level reset
combo, but the exact buttons and LED cues may differ — see
[compatibility.md](compatibility.md) for the per-model evidence
matrix. If you recover an ST 20, ST 30, or other model with a
different combination, please open an issue so the next person can
find it.

## Admin unreachable on :8181 (but the resolver works)

Symptoms: the resolver install succeeds, `verify.sh` is happy, and on
the speaker `busybox httpd` is bound to `0.0.0.0:8181` with loopback
(`curl http://127.0.0.1:8181/` on the speaker) returning the admin
HTML — yet `http://<speaker-ip>:8181/` from a browser or `curl` on the
LAN gets an instant connection refused, from every device including a
phone on the same Wi-Fi.

This is **not your router** (verified in
[#159](https://github.com/skarl/bose-soundtouch-resurrect/discussions/159):
the same ports are reachable when served from a PC/Pi on the same LAN).
On at least the **SoundTouch Portable** (`taigan`), the speaker's own
network path doesn't expose :8181 externally even though the socket is
healthy — the maintainer reproduced LAN reachability on an ST 10 at the
identical firmware, so it's hardware-specific to that unit, and the
mechanism isn't yet understood. The four ports the firmware itself
advertises (8080 / 8090 / 8091 / 8200) stay reachable; arbitrary
Linux-side ports like 8181 don't.

**Workaround — reach the admin over an SSH tunnel.** Forward **both**
the admin port (8181) and the WebSocket port (8080):

```bash
ssh -oHostKeyAlgorithms=+ssh-rsa \
    -L 8181:localhost:8181 \
    -L 8080:localhost:8080 \
    root@<speaker-ip>
```

Leave that running and open `http://localhost:8181/` in your browser.

## Admin loads over an SSH tunnel but the speaker reboots

Symptoms (continuing from the tunnel above): the admin loads and shows
your presets for a few seconds, then floods "Speaker isn't responding"
toasts; the SSH terminal prints `accept: Too many open files`; the
speaker eventually hangs or reboots.

Cause: you forwarded **only 8181**. The admin's live-update WebSocket
lives on **port 8080**, so with 8080 untunnelled the socket can never
connect, and the SPA falls back to *polling* the speaker every two
seconds — each poll fanning out into ~14 proxied requests at once. On a
small embedded box squeezed through a single tunnel that exhausts file
descriptors (`Too many open files`), requests time out, and the speaker
falls over.

**Fix:** add the `-L 8080:localhost:8080` forward shown in the previous
section. With the WebSocket connected the SPA stops polling and the
hammering stops. (0.8.3 also hardens the SPA so a persistently
unreachable WebSocket backs off instead of storming the speaker.)

## "Speaker rejected the stream" / every preview 502s

Symptoms: tapping any station in the admin SPA toasts "Speaker rejected
the stream"; the admin's `/preview` CGI returns 502 `SELECT_REJECTED`;
`/sources` on the Speaker omits `TUNEIN` entirely;
`/select source="TUNEIN"` returns
`HTTP 500 <error value="1005" name="UNKNOWN_SOURCE_ERROR">`.

Root cause: BoseApp persists per-source authentication tokens in
`/mnt/nv/BoseApp-Persistence/1/Sources.xml`, and Bose's cloud was the
only thing that ever issued the anonymous-account TuneIn token. Since
the 2026-05-06 shutdown a factory reset wipes the token and nothing
re-issues it. Without a TUNEIN `<source>` block in that file, BoseApp
refuses to register TUNEIN as a known source at boot — every downstream
selection then fails closed.

**Self-diagnose** in one line:

```bash
ssh root@$SPEAKER_IP 'grep -c "<sourceKey type=\"TUNEIN\"" /mnt/nv/BoseApp-Persistence/1/Sources.xml'
```

Expect `1`. `0` (or `grep: No such file`) confirms this failure mode.

**Fix:** re-run `scripts/deploy.sh`. As of v0.8.2 the deploy synthesises
a TUNEIN token block on the Speaker iff one is missing — idempotent, so
running it against a Speaker that still carries a real pre-shutdown
token is a strict no-op. BoseApp does not validate the token against
anything external; a synthetic UUID is accepted on the next boot.

Only TUNEIN is synthesised. RADIOPLAYER's upstream is dead at the
network layer and `LOCAL_INTERNET_RADIO` has no admin surface — re-
issuing those would be ceremony with no user-visible value.

## Nothing plays after pressing a preset

Symptoms: pressing a preset, `/now_playing` shows source `STANDBY` or
`source="TUNEIN"` but no audio.

### 1. Is the resolver httpd running?

```bash
ssh -oHostKeyAlgorithms=+ssh-rsa root@$SPEAKER_IP '
  ps w | grep -E "httpd" | grep -v grep
  netstat -ln | grep 8181
'
```

Expect a line like
`/bin/httpd -f -p 0.0.0.0:8181 -h /mnt/nv/resolver` and a listening
socket on `0.0.0.0:8181`. If not, see step 2.

### 2. Did `shepherdd` pick up the resolver config?

```bash
ssh root@$SPEAKER_IP 'cat /mnt/nv/shepherd/pids'
```

`/bin/httpd` should be in the list. If it's missing,
`Shepherd-resolver.xml` either isn't there or is malformed:

```bash
ssh root@$SPEAKER_IP '
  ls -la /mnt/nv/shepherd/Shepherd-resolver.xml
  cat   /mnt/nv/shepherd/Shepherd-resolver.xml
'
```

`shepherdd` reads the directory at boot time only — fix the file and
reboot.

### 3. Does the override actually point at the resolver?

```bash
ssh root@$SPEAKER_IP 'grep -E "ServerUrl|RegistryUrl|UpdateUrl" /mnt/nv/OverrideSdkPrivateCfg.xml'
```

All four URLs should point at `http://127.0.0.1:8181/...`. If they
point at a real Bose hostname (`streaming.bose.com` etc.), the
override didn't take effect — re-deploy and reboot.

### 4. Does the resolver actually serve the right station?

```bash
ssh root@$SPEAKER_IP 'wget -qO - http://127.0.0.1:8181/bmx/tunein/v1/playback/station/sNNNNN' | head -c 200
```

Replace `sNNNNN` with the ID of the station that's failing. You
should see Bose-shaped JSON with a `streamUrl`. If you see a 404 or
empty body, the file isn't there — re-run `python3 resolver/build.py`
and re-push.

### 5. Is the stream URL itself dead?

TuneIn rotates partner-routed URLs occasionally. Pull the resolver
JSON and check the URL works from a laptop:

```bash
ssh root@$SPEAKER_IP 'cat /mnt/nv/resolver/bmx/tunein/v1/playback/station/sNNNNN' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["audio"]["streamUrl"])'

# Try playing it from a laptop:
ffplay -nodisp -autoexit "$URL"
```

If the URL 404s or times out, re-run `python3 resolver/build.py` to
fetch fresh URLs.

## macOS: cannot reach speaker from CLI

Symptoms: `curl http://$SPEAKER_IP:8090/info` fails with
`Couldn't connect to server` in `0 ms`. `ssh` fails with `No route to
host`. ARP entry shows `(incomplete)`. **But Safari can hit
`http://$SPEAKER_IP:8090/info` fine.**

This is **macOS Local Network privacy** (Sonoma / 14.x and later). The
kernel returns `EHOSTUNREACH` immediately for LAN connections from
apps that haven't been granted permission. Browsers are pre-allowed.
CLI processes (Terminal, ssh, curl, your IDE's terminal) need
permission per parent app.

**Diagnostic signature:**

- Connection fails in `0 ms` (kernel-level, not a network timeout).
- Other LAN hosts also fail; the gateway IP often "works" because
  it's special-cased.
- mDNS resolution returns the right IP (from cache), but follow-up
  TCP connect still fails.
- The routing table looks healthy.

**Fix:** System Settings → Privacy & Security → Local Network →
enable the toggle for whatever app is the parent of your shell. If
the app isn't in the list, fire off any LAN connection — the OS
prompts on first connect. You may need to restart the offending app
afterwards.

## Speaker silently dropped its preset list

Symptom: `curl http://$SPEAKER_IP:8090/presets` returns an empty list,
or fewer items than you stored.

Causes:

- Factory reset.
- A failed firmware-update attempt that wiped state (rare).
- The speaker booted while it couldn't reach any cloud endpoint and
  decided things were inconsistent.

Re-store each preset — easiest route is the browser admin
([customizing-presets.md](customizing-presets.md) § "Option B"); the
raw API call lives in § "Option C" if you'd rather drive it from a
terminal.

## SSH refused after a reboot

```
ssh: connect to host <ip> port 22: Connection refused
```

The SSH-enable marker is missing. Likely:

- You enabled SSH via the USB stick but forgot
  `touch /mnt/nv/remote_services` (so SSH only persisted in `/tmp/`,
  which is RAM and lost on reboot).
- A factory reset wiped `/mnt/nv/remote_services`.

Re-do the USB stick step from
[opening-up-your-speaker.md](opening-up-your-speaker.md). Once back in,
this time also `touch /mnt/nv/remote_services` so it survives.

## SSH refused with `no matching host key type`

You're missing `-oHostKeyAlgorithms=+ssh-rsa`. The speaker uses an
older RSA host key that modern OpenSSH refuses by default. Add the
flag.

## After firmware update, override stopped working

Modern firmware (27.x+) reads `OverrideSdkPrivateCfg.xml` from
`/mnt/nv/`. If your firmware predates that, it might use a different
override file name (`SoundTouchSdkPrivateCfg.xml` directly, in some
older releases) or not honour the override at all.

Inspect what the firmware actually parses:

```bash
ssh root@$SPEAKER_IP '
  ls /opt/Bose/etc/ | grep -i SdkPrivate
  ls /mnt/nv/ | grep -i SdkPrivate
'
```

If the firmware-shipped name is different, name your override file to
match (just with `Override` prefix).

## Speaker still tries to phone home about firmware updates

Symptoms: speaker LED blinks an "update" pattern, or the system log
shows repeated requests to `/updates/soundtouch`.

This project's static resolver returns a 404 for that path because we
don't ship a stub response. The speaker handles the 404 gracefully on
firmware 27.x — no boot loop, no degraded behaviour. The blinking is
just the periodic check; let it run.

If you want a tidier "no update available" response, drop a stub at:

```bash
ssh root@$SPEAKER_IP '
  mkdir -p /mnt/nv/resolver/updates
  cat > /mnt/nv/resolver/updates/soundtouch <<EOF
<?xml version="1.0"?><updates></updates>
EOF
'
```

(The exact XML the firmware expects on this endpoint isn't fully
documented — patches confirming the right shape welcome.)

## deploy.sh fails on the laptop (before it reaches the speaker)

Two host-side prerequisites bite people whose laptop isn't macOS:

- **`uuidgen: command not found`** (or deploy aborting at the TUNEIN
  token step) — `uuidgen` isn't installed. On Debian/Ubuntu/Mint it's
  in `uuid-runtime`: `sudo apt-get install uuid-runtime`.
- **`UnicodeEncodeError` while building station files** — your shell
  locale isn't UTF-8 and Python can't encode a non-ASCII station name.
  Re-run with `PYTHONIOENCODING=utf-8 ./scripts/deploy.sh "$SPEAKER_IP"`.

Both were reported in [#156](https://github.com/skarl/bose-soundtouch-resurrect/issues/156).

## Last-resort logs to capture

If nothing above narrows it down:

```bash
ssh root@$SPEAKER_IP '
  dmesg | tail -200            > /tmp/speaker-dmesg.txt
  ls -la /mnt/nv/              > /tmp/speaker-nv.txt
  cat /mnt/nv/OverrideSdkPrivateCfg.xml > /tmp/speaker-cfg.xml
  cat /mnt/nv/shepherd/pids    > /tmp/speaker-pids.txt
  ps w                         > /tmp/speaker-ps.txt
  netstat -ln                  > /tmp/speaker-ports.txt
'

scp -O -oHostKeyAlgorithms=+ssh-rsa root@$SPEAKER_IP:/tmp/speaker-*.txt .
scp -O -oHostKeyAlgorithms=+ssh-rsa root@$SPEAKER_IP:/tmp/speaker-cfg.xml .
```

These six files are usually enough to diagnose any setup-time issue.
Strip personal data before pasting them anywhere public.
