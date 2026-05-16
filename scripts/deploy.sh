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
( cd "$ROOT/resolver" && rm -f s[0-9]* 2>/dev/null; python3 build.py )

STATION_COUNT=$(find "$ROOT/resolver" -maxdepth 1 -type f -name 's[0-9]*' 2>/dev/null | wc -l | tr -d ' ')
[ "$STATION_COUNT" -gt 0 ] \
  || fail "build.py produced no station files. See above for errors."
echo "Built $STATION_COUNT station file(s)."

say "Looking up speaker MAC for the heartbeat sink"
# The firmware emits the device's primary MAC as the deviceID attribute on
# the root <info> element. There are also <networkInfo type="SCM"> /
# <networkInfo type="SMSC"> blocks each with their own <macAddress>; we use
# deviceID because it's the one the resolver heartbeat sink path is keyed
# under.
#
# Brick-class fallback: port 8090 is served by BoseApp, which is exactly the
# stock daemon that doesn't come up on a speaker whose Shepherd override
# directory is missing its stock-config symlinks (the failure mode this
# release recovers from — see docs/adr/0004-shepherd-override-replaces-not-merges.md).
# On such a speaker SSH still works, so we can recover the same MAC kernel-side
# from the device tree, which u-boot populates from the SCM module's OTP at
# boot independent of any userspace daemon.
#
# Verified on the maintainer's ST 10 (variant rhino): /proc/device-tree/ocp/
# macaddr/mac-address is the SCM MAC (matches deviceID), populated by u-boot
# regardless of BoseApp state. /sys/class/net/*/address on ST 10 only exposes
# the SMSC + USB MACs (different from deviceID), so the device-tree path is
# the only kernel-side source that yields the deviceID-matching value.
MAC=$($SSH root@"$SPEAKER" 'curl -s --max-time 3 http://localhost:8090/info 2>/dev/null' \
      | sed -n 's|.*<info deviceID="\([0-9A-Fa-f]\{12\}\)".*|\1|p')
if [ -z "$MAC" ]; then
  echo "  port 8090 returned nothing (likely brick-class state) — falling back to kernel-side MAC lookup"
  # od outputs " 34 15 13 9a bd 77\n"; strip whitespace and uppercase to
  # match the deviceID format (12 uppercase hex chars, no separators) so
  # the heartbeat sink path key below still matches.
  MAC=$($SSH root@"$SPEAKER" 'od -An -tx1 /proc/device-tree/ocp/macaddr/mac-address 2>/dev/null' \
        | tr -d ' \n' | tr 'a-f' 'A-F')
  # Sanity-check the kernel-side value: must be exactly 12 hex chars.
  case "$MAC" in
    [0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]) ;;
    *) MAC= ;;
  esac
fi
[ -n "$MAC" ] || fail "couldn't read speaker MAC: port 8090 dead AND /proc/device-tree/ocp/macaddr/mac-address unreadable.
       Try: ssh root@$SPEAKER 'od -An -tx1 /proc/device-tree/ocp/macaddr/mac-address'"
echo "Speaker MAC: $MAC"

say "Creating directories on the speaker"
$SSH root@"$SPEAKER" '
  mkdir -p /mnt/nv/resolver/bmx/tunein/v1/playback/station
  mkdir -p /mnt/nv/resolver/bmx/registry/v1
  mkdir -p /mnt/nv/resolver/marge/streaming
  mkdir -p /mnt/nv/resolver/v1/scmudc
  mkdir -p /mnt/nv/shepherd
'

say "Linking stock Shepherd configs into the override directory"
# When /mnt/nv/shepherd/ exists, shepherdd reads from there *instead
# of* /opt/Bose/etc/ — link every stock config in or its daemons
# (BoseApp, WebServer, the per-variant daemon, etc.) stop being
# supervised. See docs/adr/0004-shepherd-override-replaces-not-merges.md.
$SSH root@"$SPEAKER" '
  for stock in /opt/Bose/etc/Shepherd-*.xml; do
    ln -sf "$stock" "/mnt/nv/shepherd/$(basename "$stock")"
  done
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
$SCP "$ROOT"/resolver/s[0-9]* \
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
