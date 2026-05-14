#!/bin/sh
#
# test_favorites_cgi — unit tests for admin/cgi-bin/api/v1/favorites.
#
# Drives the CGI as a subprocess with CGI env vars set in-line, and
# overrides FAV_DIR via the FAV_DIR_OVERRIDE escape hatch so we don't
# need /mnt/nv to exist locally. No live speaker required.
#
# Run with: sh admin/test/test_favorites_cgi/test_favorites_cgi.sh
# Exits non-zero on any failure.

set -u

THIS_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$THIS_DIR/../../.." && pwd)
CGI="$REPO/admin/cgi-bin/api/v1/favorites"

if [ ! -x "$CGI" ]; then
    chmod +x "$CGI"
fi

WORK=$(mktemp -d 2>/dev/null || echo "/tmp/test_favorites_cgi.$$")
mkdir -p "$WORK"
FAV_DIR="$WORK/admin-data"
trap 'rm -rf "$WORK"' EXIT INT TERM

ok=0
fail=0

assert_contains() {
    label=$1; needle=$2; haystack=$3
    case "$haystack" in
        *"$needle"*)
            printf '  [ OK ] %s\n' "$label"
            ok=$((ok + 1)) ;;
        *)
            printf '  [FAIL] %s\n    needle: %s\n    body:   %s\n' \
                "$label" "$needle" "$haystack"
            fail=$((fail + 1)) ;;
    esac
}

assert_not_contains() {
    label=$1; needle=$2; haystack=$3
    case "$haystack" in
        *"$needle"*)
            printf '  [FAIL] %s\n    forbidden needle present: %s\n' \
                "$label" "$needle"
            fail=$((fail + 1)) ;;
        *)
            printf '  [ OK ] %s\n' "$label"
            ok=$((ok + 1)) ;;
    esac
}

# call_cgi <method> <body-file-or-empty> → emits CGI response on stdout.
# Sets HTTP_HOST so the CSRF guard's empty-Origin path passes (same as
# curl with no Origin/Referer).
call_cgi() {
    method=$1
    body=$2
    cl=0
    if [ -n "$body" ] && [ -f "$body" ]; then
        cl=$(wc -c <"$body" | tr -d ' ')
    fi
    if [ "$cl" -gt 0 ]; then
        FAV_DIR_OVERRIDE="$FAV_DIR" \
        REQUEST_METHOD="$method" \
        HTTP_HOST="localhost" \
        HTTP_ORIGIN="" \
        HTTP_REFERER="" \
        CONTENT_LENGTH="$cl" \
        sh "$CGI" <"$body"
    else
        FAV_DIR_OVERRIDE="$FAV_DIR" \
        REQUEST_METHOD="$method" \
        HTTP_HOST="localhost" \
        HTTP_ORIGIN="" \
        HTTP_REFERER="" \
        CONTENT_LENGTH="0" \
        sh "$CGI" </dev/null
    fi
}

# Extract just the JSON body (drop Status/Content-Type/etc. headers).
# Reads stdin via the awk default; no positional args needed.
strip_headers() {
    awk 'BEGIN { body = 0 } { if (body) { print } else if ($0 == "" || $0 == "\r") body = 1 }'
}

# --- GET: empty store → empty data array --------------------------

printf '\n=== GET: absent file → ok:true, data:[] ===\n'
rm -rf "$FAV_DIR"
out=$(call_cgi GET '' 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'GET emits 200 OK status line' 'Status: 200 OK' "$out"
assert_contains 'GET body has ok:true' '"ok":true' "$body"
assert_contains 'GET body has empty data array' '"data":[]' "$body"

# --- POST: empty array writes and round-trips ----------------------

printf '\n=== POST: empty array → writes envelope, GET returns it ===\n'
empty_body="$WORK/empty.json"
printf '[]' >"$empty_body"
out=$(call_cgi POST "$empty_body" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'empty POST returns 200 OK' 'Status: 200 OK' "$out"
assert_contains 'empty POST body has ok:true' '"ok":true' "$body"
if [ ! -f "$FAV_DIR/favorites.json" ]; then
    printf '  [FAIL] favorites.json was not written\n'
    fail=$((fail + 1))
else
    printf '  [ OK ] favorites.json present on disk after empty POST\n'
    ok=$((ok + 1))
fi

# --- POST: valid one-entry list ------------------------------------

printf '\n=== POST: valid one-entry list ===\n'
one_body="$WORK/one.json"
printf '%s' '[{"id":"s12345","name":"R1","art":"http://x.png","note":"hi"}]' >"$one_body"
out=$(call_cgi POST "$one_body" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'one-entry POST returns 200 OK' 'Status: 200 OK' "$out"
assert_contains 'response carries the entry id' '"id":"s12345"' "$body"
assert_contains 'response carries the entry name' '"name":"R1"' "$body"
# GET after POST echoes back the same envelope.
get_out=$(call_cgi GET '' 2>/dev/null)
get_body=$(printf '%s\n' "$get_out" | strip_headers)
assert_contains 'subsequent GET returns the persisted entry' '"id":"s12345"' "$get_body"

# --- POST: INVALID_ID -----------------------------------------------

printf '\n=== POST: invalid id (g-prefix) → INVALID_ID ===\n'
bad_id="$WORK/bad_id.json"
printf '%s' '[{"id":"g22","name":"genre","art":"","note":""}]' >"$bad_id"
out=$(call_cgi POST "$bad_id" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'INVALID_ID returns 400' 'Status: 400 Bad Request' "$out"
assert_contains 'INVALID_ID envelope code' '"code":"INVALID_ID"' "$body"
assert_contains 'error envelope is an object, not a bare string' '"error":{' "$body"

printf '\n=== POST: invalid id (bare s) → INVALID_ID ===\n'
bare="$WORK/bare.json"
printf '%s' '[{"id":"s","name":"x","art":"","note":""}]' >"$bare"
out=$(call_cgi POST "$bare" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'bare-prefix is rejected' '"code":"INVALID_ID"' "$body"

# --- POST: INVALID_NAME ---------------------------------------------

printf '\n=== POST: empty name → INVALID_NAME ===\n'
no_name="$WORK/no_name.json"
printf '%s' '[{"id":"s12345","name":"","art":"","note":""}]' >"$no_name"
out=$(call_cgi POST "$no_name" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'empty name returns 400' 'Status: 400 Bad Request' "$out"
assert_contains 'INVALID_NAME envelope code' '"code":"INVALID_NAME"' "$body"

# --- POST: INVALID_ART ----------------------------------------------

printf '\n=== POST: bad art (not http/https) → INVALID_ART ===\n'
bad_art="$WORK/bad_art.json"
printf '%s' '[{"id":"s12345","name":"R1","art":"data:image/png;base64,XX","note":""}]' >"$bad_art"
out=$(call_cgi POST "$bad_art" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'bad-art returns 400' 'Status: 400 Bad Request' "$out"
assert_contains 'INVALID_ART envelope code' '"code":"INVALID_ART"' "$body"

# --- POST: DUPLICATE_ID ---------------------------------------------

printf '\n=== POST: duplicate id → DUPLICATE_ID ===\n'
dup="$WORK/dup.json"
printf '%s' '[{"id":"s1","name":"A","art":"","note":""},{"id":"s1","name":"B","art":"","note":""}]' >"$dup"
out=$(call_cgi POST "$dup" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'duplicate-id returns 400' 'Status: 400 Bad Request' "$out"
assert_contains 'DUPLICATE_ID envelope code' '"code":"DUPLICATE_ID"' "$body"

# --- POST: INVALID_JSON ---------------------------------------------

printf '\n=== POST: non-array body → INVALID_JSON ===\n'
bad_json="$WORK/bad_json.json"
printf '%s' '{"id":"s1"}' >"$bad_json"
out=$(call_cgi POST "$bad_json" 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'object-shaped body returns 400' 'Status: 400 Bad Request' "$out"
assert_contains 'INVALID_JSON envelope code' '"code":"INVALID_JSON"' "$body"

# --- failed-POST preserves the prior file ---------------------------

printf '\n=== POST failure leaves the previous file in place ===\n'
# Re-prime with a known-good entry.
ok_body="$WORK/ok.json"
printf '%s' '[{"id":"s2","name":"Keeper","art":"","note":""}]' >"$ok_body"
call_cgi POST "$ok_body" >/dev/null 2>&1
# Now POST a broken payload.
call_cgi POST "$bad_id" >/dev/null 2>&1
disk=$(cat "$FAV_DIR/favorites.json")
assert_contains 'prior good entry still on disk after a failed POST' '"id":"s2"' "$disk"
assert_not_contains 'failed-POST id never reached disk' '"id":"g22"' "$disk"

# --- atomic-replace tmp file cleaned up ----------------------------

if [ -f "$FAV_DIR/favorites.json.tmp" ]; then
    printf '  [FAIL] tmp file leaked: %s\n' "$FAV_DIR/favorites.json.tmp"
    fail=$((fail + 1))
else
    printf '  [ OK ] no tmp file leaked\n'
    ok=$((ok + 1))
fi

# --- METHOD_NOT_ALLOWED --------------------------------------------

printf '\n=== DELETE: method rejected ===\n'
out=$(call_cgi DELETE '' 2>/dev/null)
body=$(printf '%s\n' "$out" | strip_headers)
assert_contains 'DELETE returns 405' 'Status: 405 Method Not Allowed' "$out"
assert_contains 'METHOD_NOT_ALLOWED envelope code' '"code":"METHOD_NOT_ALLOWED"' "$body"

# --- OPTIONS preflight ---------------------------------------------

printf '\n=== OPTIONS: CORS preflight ===\n'
out=$(call_cgi OPTIONS '' 2>/dev/null)
assert_contains 'OPTIONS returns 204' 'Status: 204 No Content' "$out"
assert_contains 'preflight advertises POST in Allow-Methods' 'POST' "$out"
assert_contains 'preflight advertises GET in Allow-Methods' 'GET' "$out"

printf '\n=== Summary: %d ok, %d failed ===\n' "$ok" "$fail"

if [ "$fail" -gt 0 ]; then
    exit 1
fi
