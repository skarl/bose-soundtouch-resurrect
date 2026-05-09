#!/bin/sh
#
# Capture current speaker state to a local timestamped folder.
#
# Useful before any change: get a snapshot of preset assignments,
# sources, BT pairings, etc., so you can roll back or re-create.
#
# Usage:
#   ./scripts/backup-presets.sh <speaker-ip>

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip>}"

OUT="soundtouch-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

ENDPOINTS="info presets sources now_playing getZone listMediaServers \
           bassCapabilities bass name volume trackInfo balance \
           supportedURLs"

# `-f` makes curl exit non-zero (and suppress the body) on HTTP 4xx/5xx so a
# 404 doesn't end up saved as an "OK" file with the error body inside.
# Some endpoints (e.g. trackInfo) only return content when the speaker
# isn't in standby; those will report FAILED in standby — that's
# expected, not an error.
for ep in $ENDPOINTS; do
    if curl -sSf --max-time 5 "http://$SPEAKER:8090/$ep" -o "$OUT/$ep.xml" 2>/dev/null; then
        printf '  %-22s -> %s/%s.xml (%d bytes)\n' \
            "$ep" "$OUT" "$ep" "$(wc -c < "$OUT/$ep.xml")"
    else
        rm -f "$OUT/$ep.xml"
        printf '  %-22s -> not available (4xx/5xx or speaker in standby)\n' "$ep"
    fi
done

echo
echo "Saved to $OUT/"
echo "(This folder is gitignored — keep it locally as a safety net.)"
