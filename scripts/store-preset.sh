#!/bin/sh
#
# Assign a TuneIn station to one of the speaker's preset slots.
#
# This is a thin wrapper around the speaker's port-8090 /storePreset
# endpoint. It's the API equivalent of holding the preset button on
# the speaker hardware while a station is playing.
#
# Pre-requisite: the resolver JSON for that station must already be on
# the speaker (built by resolver/build.py and deployed). If it isn't,
# the speaker will store the preset but won't play anything when it's
# pressed.
#
# Usage:
#   ./scripts/store-preset.sh <speaker-ip> <slot> <station-id> <station-name>
#
# Example:
#   ./scripts/store-preset.sh 192.168.1.42 1 s12345 "My favourite station"

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip> <slot> <station-id> <station-name>}"
SLOT="${2:?usage: $0 <speaker-ip> <slot> <station-id> <station-name>}"
SID="${3:?usage: $0 <speaker-ip> <slot> <station-id> <station-name>}"
NAME="${4:?usage: $0 <speaker-ip> <slot> <station-id> <station-name>}"

case "$SLOT" in
    [1-6]) ;;
    *) echo "error: slot must be 1..6 (got '$SLOT')" >&2; exit 1 ;;
esac

case "$SID" in
    s[0-9]*) ;;
    *) echo "error: station ID must look like sNNNNN (got '$SID')" >&2; exit 1 ;;
esac

# Sanity-check the speaker is reachable on its local API port.
# (We don't probe the resolver here — the resolver's job comes later when
# the user actually presses the preset.)
if ! curl -sS --max-time 5 \
        "http://$SPEAKER:8090/info" >/dev/null 2>&1; then
    echo "error: speaker at $SPEAKER not reachable" >&2
    exit 1
fi

# Escape '<', '>', '&' in the name for safe XML
NAME_ESC=$(printf '%s' "$NAME" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')

# storePreset wants <preset id="N">…<ContentItem .../>…</preset>.
# A bare <ContentItem> on its own returns CLIENT_XML_ERROR (1019).
XML="<preset id=\"$SLOT\"><ContentItem source=\"TUNEIN\" type=\"stationurl\" \
location=\"/v1/playback/station/$SID\" sourceAccount=\"\" \
isPresetable=\"true\"><itemName>$NAME_ESC</itemName></ContentItem></preset>"

echo "=== Storing preset $SLOT → $SID ($NAME) ==="
RESP=$(curl -sS --max-time 5 -X POST \
    -H 'Content-Type: application/xml' \
    -d "$XML" \
    "http://$SPEAKER:8090/storePreset?id=$SLOT")

echo "Response: $RESP"
echo
echo "Verify:"
echo "  curl http://$SPEAKER:8090/presets"
