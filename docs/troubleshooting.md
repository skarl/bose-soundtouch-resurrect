# Troubleshooting

Diagnose top-down: override XML → resolver httpd on speaker → resolver
tree contents → upstream stream URL. Most failures collapse to one of
these.

For the rest of this doc, `SPEAKER_IP` stands for your speaker's LAN IP.

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
`/bin/httpd -f -p 127.0.0.1:8181 -h /mnt/nv/resolver` and a listening
socket on `127.0.0.1:8181`. If not, see step 2.

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

Re-store each preset using the API call from
[customizing-presets.md](customizing-presets.md) § "Option B".

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
