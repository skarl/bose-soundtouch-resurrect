# Installation

The install has two layers, both served by the speaker's own busybox
httpd:

1. **Resolver** (mandatory) — the tiny static-file responder that
   replaces the four Bose-hosted services the speaker expects to talk
   to. Without it the preset buttons stay silent.
2. **Browser admin SPA** (recommended) — the everyday post-cloud-shutdown
   interface for search, browse, favourites, and assigning stations to
   preset slots. Reachable at `http://<speaker-ip>:8181/` from any LAN
   browser. Skip this layer if you only want hardware preset playback
   and you're happy editing `resolver/stations.json` by hand.

The resolver goes on first (it provides the httpd the admin SPA is
served from); the admin SPA layers on top.

**Prerequisite:** SSH must be enabled on the speaker. If you haven't
done that, follow [opening-up-your-speaker.md](opening-up-your-speaker.md)
first.

For the rest of this doc, set:

```bash
SPEAKER_IP=<your-speaker-ip>     # e.g. 192.168.1.42
```

Find your speaker's IP via your router's DHCP table, the SoundTouch
app, or mDNS:

```bash
# macOS:
dns-sd -B _soundtouch._tcp local.

# Linux:
avahi-browse -rt _soundtouch._tcp
```

## macOS prerequisite — grant Local Network access

If you're on macOS Sonoma or later, the operating system will block
LAN connections from CLI tools (Terminal, ssh, curl) until you grant
permission per-app. Without it you'll see "No route to host" errors
that look like network problems but aren't.

System Settings → Privacy & Security → Local Network → enable the
toggle for whatever terminal app you launched these scripts from. If
the app isn't in the list, fire off any LAN connection from it and the
OS prompts on first connect.

(See [troubleshooting.md](troubleshooting.md) § "macOS: cannot reach
speaker from CLI" for diagnostic signatures.)

## Step 1 — One-shot deploy

The repo includes a deploy script that handles everything end-to-end:
creating directories on the speaker, pushing the resolver tree, dropping
the daemon config, and writing the override XML.

```bash
./scripts/deploy.sh "$SPEAKER_IP"
```

This is the path of least resistance for the resolver. To also install
the browser admin, continue with Step 1b. To verify a resolver-only
install, skip to Step 4.

If you'd rather do the resolver by hand (to understand each step, or if
`deploy.sh` fails partway), continue with Step 2.

## Step 1b — Deploy the browser admin (recommended)

With the resolver in place, the speaker's busybox httpd is now serving
`http://<speaker-ip>:8181/`. Layer the admin SPA on top:

```bash
./admin/deploy.sh "$SPEAKER_IP"
```

The script sanity-checks SSH access and resolver presence, pushes the
admin shell (`index.html`, `style.css`, the `app/` ES modules, the
self-hosted Geist fonts), pushes the `cgi-bin/api/v1/` shell CGIs,
substitutes the build version into the HTML, and verifies the response.
It does **not** reboot the speaker and does **not** touch the resolver
files.

Once it's done, open `http://<speaker-ip>:8181/` in any browser on the
same LAN. See [README.md § The browser admin](../README.md#the-browser-admin)
for what's in the UI.

To remove the admin later without touching the resolver, run
`./admin/uninstall.sh "$SPEAKER_IP"`.

## Step 2 — Build the per-station resolver files

The speaker needs one JSON file per preset station, named after the
station's TuneIn ID. The supplied script fetches them from TuneIn's
public API and emits Bose-shaped JSON:

```bash
cd resolver/
cp stations.example.json stations.json
# Edit stations.json — see customizing-presets.md for how to find IDs.
python3 build.py
ls s[0-9]*    # one file per station ID, e.g. s12345, s23456, ...
cd ..
```

If you skip the `cp`, `build.py` will refuse with a helpful error and
print where the example lives.

## Step 3 — Push everything to the speaker

```bash
SSH="ssh -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10 -oBatchMode=yes"
SCP="scp -O -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10"

# Create directories
$SSH root@$SPEAKER_IP '
  mkdir -p /mnt/nv/resolver/bmx/tunein/v1/playback/station
  mkdir -p /mnt/nv/resolver/bmx/registry/v1
  mkdir -p /mnt/nv/resolver/marge/streaming
  mkdir -p /mnt/nv/resolver/v1/scmudc
'

# Static templates (registry + source providers + sinks)
$SCP resolver/responses/services.json \
     root@$SPEAKER_IP:/mnt/nv/resolver/bmx/registry/v1/services
$SCP resolver/responses/sourceproviders.xml \
     root@$SPEAKER_IP:/mnt/nv/resolver/marge/streaming/sourceproviders

# Heartbeat + report sinks (empty bodies)
# The deviceID attribute on /info's root <info> element is the MAC the
# speaker uses as its heartbeat sink path key.
$SSH root@$SPEAKER_IP '
  echo "{}" > /mnt/nv/resolver/bmx/tunein/v1/report
  echo "{}" > /mnt/nv/resolver/v1/scmudc/$(curl -s http://localhost:8090/info | sed -n "s|.*<info deviceID=\"\([0-9A-Fa-f]\{12\}\)\".*|\1|p")
'

# Per-station resolver files
$SCP resolver/s[0-9]* root@$SPEAKER_IP:/mnt/nv/resolver/bmx/tunein/v1/playback/station/

# Daemon config so busybox httpd auto-starts at boot
$SCP resolver/shepherd-resolver.xml \
     root@$SPEAKER_IP:/mnt/nv/shepherd/Shepherd-resolver.xml

# Override XML — point the speaker at its own loopback HTTP server
$SSH root@$SPEAKER_IP 'cat > /mnt/nv/OverrideSdkPrivateCfg.xml' <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<SoundTouchSdkPrivateCfg>
  <margeServerUrl>http://127.0.0.1:8181/marge</margeServerUrl>
  <statsServerUrl>http://127.0.0.1:8181</statsServerUrl>
  <swUpdateUrl>http://127.0.0.1:8181/updates/soundtouch</swUpdateUrl>
  <usePandoraProductionServer>true</usePandoraProductionServer>
  <isZeroconfEnabled>true</isZeroconfEnabled>
  <saveMargeCustomerReport>false</saveMargeCustomerReport>
  <bmxRegistryUrl>http://127.0.0.1:8181/bmx/registry/v1/services</bmxRegistryUrl>
</SoundTouchSdkPrivateCfg>
EOF

# Reboot so shepherdd picks up the new daemon config
$SSH root@$SPEAKER_IP reboot
```

Wait ~75 seconds for the speaker to come back.

## Step 4 — Verify

The repo includes a verifier that covers both layers:

```bash
./scripts/verify.sh "$SPEAKER_IP"
```

It checks: SSH works, the resolver httpd is listening, all expected
files are in `/mnt/nv/resolver/`, the override XML is in place, and
`/now_playing` reports a sane state. If the admin SPA is deployed it
additionally probes the admin shell and CGIs; if it isn't, those probes
auto-skip cleanly — a resolver-only install is a valid passing state.

To test playback by hand, press preset 1:

```bash
SPEAKER=$SPEAKER_IP
curl -X POST -H 'Content-Type: application/xml' \
  -d '<key state="press" sender="Gabbo">PRESET_1</key>' \
  http://$SPEAKER:8090/key
curl -X POST -H 'Content-Type: application/xml' \
  -d '<key state="release" sender="Gabbo">PRESET_1</key>' \
  http://$SPEAKER:8090/key
sleep 4
curl http://$SPEAKER:8090/now_playing
```

You should see `source="TUNEIN"`, `playStatus="PLAY_STATE"`, and the
station's `<itemName>`.

> **Note** — `sender="Gabbo"` is the only string the speaker accepts on
> the `/key` endpoint. `sender="api"` returns HTTP 400. The reason
> isn't documented; it's the name the SoundTouch app uses internally.

## Step 5 — When stream URLs go stale

Periodically — months or years apart — TuneIn will rotate the stream
URL for one of your presets. The preset will silently stop playing.
Refresh:

```bash
./scripts/refresh-streams.sh "$SPEAKER_IP"
```

It re-runs `build.py` and `scp`s the new station files. No reboot
needed — busybox httpd reads from disk on every request.

## Uninstall / rollback

```bash
$SSH root@$SPEAKER_IP '
  rm -rf /mnt/nv/resolver
  rm -f  /mnt/nv/shepherd/Shepherd-resolver.xml
  rm -f  /mnt/nv/OverrideSdkPrivateCfg.xml
  sync
  reboot
'
```

This puts the speaker back to its factory configuration, where it
attempts to reach the (offline) Bose cloud and effectively becomes
silent for preset playback. AUX, Bluetooth, and Spotify Connect will
still work; preset buttons won't. The `rm -rf /mnt/nv/resolver`
removes the admin SPA too, since it lives under the same tree — no
separate admin uninstall is needed when rolling all the way back.

To drop only the admin layer and keep the resolver, use
`./admin/uninstall.sh "$SPEAKER_IP"` instead.

To also disable SSH, see [opening-up-your-speaker.md](opening-up-your-speaker.md)
§ "Reverting".
