#!/bin/sh
#
# Deploy the on-speaker resolver end-to-end.
#
# Pre-requisites (one-time):
#   - SSH enabled on the speaker (see docs/opening-up-your-speaker.md)
#   - resolver/stations.json exists with your station list
#       (cp resolver/stations.example.json resolver/stations.json && edit)
#
# Usage:
#   ./scripts/deploy.sh <speaker-ip>
#
# What it does:
#   1. Sanity-checks SSH access and the local files we need to push.
#   2. Runs resolver/build.py to fetch fresh stream URLs.
#   3. Creates the resolver directory tree on the speaker.
#   4. Pushes the static templates + per-station JSON + shepherd config.
#   5. Writes the override XML pointing the speaker at 127.0.0.1:8181.
#   6. Reboots the speaker. Waits for it to come back.
#   7. Calls scripts/verify.sh to confirm everything's wired up.

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip>}"

cd "$(dirname "$0")/.."
ROOT=$(pwd)

SSH="ssh -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10 -oBatchMode=yes"
SCP="scp -O -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10"

say()  { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "Pre-flight checks"

[ -f "$ROOT/resolver/stations.json" ] \
  || fail "resolver/stations.json missing.
       cp resolver/stations.example.json resolver/stations.json
       and edit it for your stations. See docs/customizing-presets.md."

[ -f "$ROOT/resolver/responses/services.json" ] \
  || fail "resolver/responses/services.json missing — repo is incomplete?"

[ -f "$ROOT/resolver/responses/sourceproviders.xml" ] \
  || fail "resolver/responses/sourceproviders.xml missing — repo is incomplete?"

[ -f "$ROOT/resolver/shepherd-resolver.xml" ] \
  || fail "resolver/shepherd-resolver.xml missing — repo is incomplete?"

# SSH reachability
$SSH root@"$SPEAKER" 'true' \
  || fail "cannot SSH to root@$SPEAKER. Did you enable SSH?
       See docs/opening-up-your-speaker.md."

say "Building station files (TuneIn → Bose JSON)"
( cd "$ROOT/resolver" && rm -f s* 2>/dev/null; python3 build.py )

STATION_COUNT=$(ls "$ROOT/resolver/" 2>/dev/null | grep -c '^s[0-9]' || true)
[ "$STATION_COUNT" -gt 0 ] \
  || fail "build.py produced no station files. See above for errors."
echo "Built $STATION_COUNT station file(s)."

say "Looking up speaker MAC for the heartbeat sink"
# The firmware emits the device's primary MAC as the deviceID attribute on
# the root <info> element. There are also <networkInfo type="SCM"> /
# <networkInfo type="SMSC"> blocks each with their own <macAddress>; we use
# deviceID because it's the one the resolver heartbeat sink path is keyed
# under.
MAC=$($SSH root@"$SPEAKER" 'curl -s http://localhost:8090/info' \
      | sed -n 's|.*<info deviceID="\([0-9A-Fa-f]\{12\}\)".*|\1|p')
[ -n "$MAC" ] || fail "couldn't read speaker MAC from /info (deviceID attribute)"
echo "Speaker MAC: $MAC"

say "Creating directories on the speaker"
$SSH root@"$SPEAKER" '
  mkdir -p /mnt/nv/resolver/bmx/tunein/v1/playback/station
  mkdir -p /mnt/nv/resolver/bmx/registry/v1
  mkdir -p /mnt/nv/resolver/marge/streaming
  mkdir -p /mnt/nv/resolver/v1/scmudc
'

say "Pushing static templates"
$SCP "$ROOT/resolver/responses/services.json" \
     root@"$SPEAKER":/mnt/nv/resolver/bmx/registry/v1/services
$SCP "$ROOT/resolver/responses/sourceproviders.xml" \
     root@"$SPEAKER":/mnt/nv/resolver/marge/streaming/sourceproviders

say "Writing report and heartbeat sinks"
$SSH root@"$SPEAKER" "
  echo '{}' > /mnt/nv/resolver/bmx/tunein/v1/report
  echo '{}' > /mnt/nv/resolver/v1/scmudc/$MAC
"

say "Pushing per-station JSON files"
$SCP "$ROOT"/resolver/s* \
     root@"$SPEAKER":/mnt/nv/resolver/bmx/tunein/v1/playback/station/

say "Pushing shepherd-resolver.xml (auto-start at boot)"
$SCP "$ROOT/resolver/shepherd-resolver.xml" \
     root@"$SPEAKER":/mnt/nv/shepherd/Shepherd-resolver.xml

say "Writing OverrideSdkPrivateCfg.xml (point speaker at itself)"
$SSH root@"$SPEAKER" "cat > /mnt/nv/OverrideSdkPrivateCfg.xml" <<'EOF'
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

say "Rebooting the speaker"
$SSH root@"$SPEAKER" reboot || true

say "Waiting for speaker to come back"
sleep 60
i=0
while [ $i -lt 6 ]; do
  if $SSH root@"$SPEAKER" 'true' 2>/dev/null; then break; fi
  echo "  not yet, waiting another 15s..."
  sleep 15
  i=$((i+1))
done
$SSH root@"$SPEAKER" 'uptime' || fail "speaker didn't come back online"

say "Verifying"
"$ROOT/scripts/verify.sh" "$SPEAKER"

say "Done"
echo "Try a preset:"
echo "  curl -X POST -H 'Content-Type: application/xml' \\"
echo "    -d '<key state=\"press\" sender=\"Gabbo\">PRESET_1</key>' \\"
echo "    http://$SPEAKER:8090/key"
echo "  curl -X POST -H 'Content-Type: application/xml' \\"
echo "    -d '<key state=\"release\" sender=\"Gabbo\">PRESET_1</key>' \\"
echo "    http://$SPEAKER:8090/key"
echo "  curl http://$SPEAKER:8090/now_playing"
