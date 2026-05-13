#!/bin/sh
#
# test_play_cgi — exercise the /play CGI against a live speaker.
#
# Usage:
#   admin/test/test_play_cgi <speaker-ip>
#
# Cases:
#   1. Valid id resolves and selects (200, ok:true). now_playing reflects
#      the TUNEIN/stationurl ContentItem within a few seconds.
#   2. Missing id returns 400 with ok:false and error.code=INVALID_ID.
#   3. Bogus prefix (g22) returns 400 with ok:false and error.code=INVALID_ID.
#   4. GET method returns 405 with ok:false and error.code=METHOD_NOT_ALLOWED.
#   5. Off-air or not-available stations return 200 ok:false with the
#      structured error code (defence-in-depth placeholder filter).
#
# All envelopes since 0.4.2 use `{ok, error:{code,message}}` with SHOUTY
# codes — same shape /preview and /presets emit. See
# admin/cgi-bin/lib/playback.sh for the helpers.
#
# Exits non-zero on any failure so it composes with deploy verification.

set -u

SPEAKER="${1:?usage: $0 <speaker-ip>}"
BASE="http://$SPEAKER:8181/cgi-bin/api/v1/play"

ok=0
fail=0

# A station that is reliably playable and unlikely to be on a preset on
# every install: SRF 3 (Swiss public radio, mp3+aac, MAGIC_TUNE-compatible).
# If this id starts returning notcompatible in your region, swap it for
# a known-good public-radio guide_id.
GOOD_ID='s24862'
# A fake id that Tune.ashx returns nostream for.
OFFAIR_ID='t99999999'

check() {
    label=$1; shift
    if "$@" >/dev/null 2>&1; then
        printf '  [ OK ] %s\n' "$label"
        ok=$((ok + 1))
    else
        printf '  [FAIL] %s\n' "$label"
        fail=$((fail + 1))
    fi
}

printf '\n=== /play: valid id resolves and selects ===\n'
body=$(curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"id\":\"$GOOD_ID\"}" "$BASE" || true)
check "POST $GOOD_ID returns ok:true" \
    sh -c 'printf "%s" "$0" | grep -q "\"ok\":true"' "$body"

# Give the speaker a moment to actually start playing.
sleep 4
np=$(curl -fsS "http://$SPEAKER:8181/cgi-bin/api/v1/speaker/now_playing" || true)
check "speaker /now_playing source is TUNEIN" \
    sh -c 'printf "%s" "$0" | grep -q "source=\"TUNEIN\""' "$np"
check "speaker /now_playing location matches the id we played" \
    sh -c 'printf "%s" "$0" | grep -q "location=\"/v1/playback/station/'"$GOOD_ID"'\""' "$np"

printf '\n=== /play: placeholder URLs surface as structured errors ===\n'
body=$(curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"id\":\"$OFFAIR_ID\"}" "$BASE" || true)
check "POST $OFFAIR_ID returns ok:false / OFF_AIR-or-NOT_AVAILABLE-or-NO_STREAM" \
    sh -c 'printf "%s" "$0" | grep -qE "\"code\":\"(OFF_AIR|NOT_AVAILABLE|NO_STREAM)\""' "$body"

printf '\n=== /play: cached url skips Tune.ashx but still filters placeholders ===\n'
# A real URL is just passed through (and selected); the round-trip
# returns ok:true with the same URL echoed back, so the client cache
# stays consistent across the two paths.
body=$(curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"id\":\"$GOOD_ID\",\"url\":\"http://stream.example/test.mp3\"}" \
    "$BASE" || true)
check "cached-url path echoes the supplied URL back" \
    sh -c 'printf "%s" "$0" | grep -q "http://stream.example/test.mp3"' "$body"

# A cached placeholder URL must NOT reach /select. The defence-in-depth
# filter in the CGI catches it even though we skipped Tune.ashx.
body=$(curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"id\":\"$GOOD_ID\",\"url\":\"http://cdn-cms.tunein.com/service/Audio/nostream.enUS.mp3\"}" \
    "$BASE" || true)
check "cached placeholder URL is filtered (OFF_AIR)" \
    sh -c 'printf "%s" "$0" | grep -q "\"code\":\"OFF_AIR\""' "$body"

printf '\n=== /play: missing id returns 400 ===\n'
code=$(curl -s -o /tmp/test_play_cgi.body -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' -d '{}' "$BASE")
check "POST {} returns HTTP 400" \
    sh -c '[ "$0" = "400" ]' "$code"
check "missing-id body carries INVALID_ID error" \
    sh -c 'grep -q "\"code\":\"INVALID_ID\"" /tmp/test_play_cgi.body'

printf '\n=== /play: bogus prefix returns 400 ===\n'
code=$(curl -s -o /tmp/test_play_cgi.body -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' -d '{"id":"g22"}' "$BASE")
check "POST id=g22 returns HTTP 400" \
    sh -c '[ "$0" = "400" ]' "$code"
check "bogus-prefix body carries INVALID_ID error" \
    sh -c 'grep -q "\"code\":\"INVALID_ID\"" /tmp/test_play_cgi.body'

printf '\n=== /play: GET method rejected ===\n'
code=$(curl -s -o /tmp/test_play_cgi.body -w '%{http_code}' "$BASE")
check "GET returns HTTP 405" \
    sh -c '[ "$0" = "405" ]' "$code"
check "GET body carries METHOD_NOT_ALLOWED error" \
    sh -c 'grep -q "\"code\":\"METHOD_NOT_ALLOWED\"" /tmp/test_play_cgi.body'

printf '\n=== /play: envelope shape — error is always an object ===\n'
# The new envelope is `{ok:false, error:{code:"...",message:"..."}}`.
# Reject the legacy flat `{ok:false, error:"<kebab>"}` shape so we
# catch CGI regressions that drop back to the pre-0.4.2 form.
check "error field is an object, never a bare string" \
    sh -c 'grep -q "\"error\":{" /tmp/test_play_cgi.body'

rm -f /tmp/test_play_cgi.body

printf '\n=== Summary: %d ok, %d failed ===\n' "$ok" "$fail"

if [ "$fail" -gt 0 ]; then
    exit 1
fi
