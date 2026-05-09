#!/bin/sh
#
# Refresh stream URLs for all configured presets.
#
# When a preset suddenly stops playing, TuneIn has probably rotated
# its stream URL. Re-running build.py and re-pushing the JSON files
# fixes it. No reboot needed — busybox httpd reads from disk on every
# request.
#
# Usage:
#   ./scripts/refresh-streams.sh <speaker-ip>

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip>}"

cd "$(dirname "$0")/.."
ROOT=$(pwd)

SCP="scp -O -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10"

[ -f "$ROOT/resolver/stations.json" ] \
  || { echo "error: resolver/stations.json missing." >&2; exit 1; }

echo "=== Building station files ==="
( cd "$ROOT/resolver" && rm -f s* 2>/dev/null; python3 build.py )

echo
echo "=== Pushing to speaker ==="
$SCP "$ROOT"/resolver/s* \
     root@"$SPEAKER":/mnt/nv/resolver/bmx/tunein/v1/playback/station/

echo
echo "Done. Press the affected preset to test."
