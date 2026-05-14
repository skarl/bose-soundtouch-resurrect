#!/bin/sh
#
# test_cgi_common_lib — unit tests for admin/cgi-bin/lib/cgi-common.sh.
#
# Sources the library directly (so it runs anywhere, no live speaker
# required) and exercises the pure helpers: json_escape, xml_escape,
# slurp_body, csrf_guard, emit_error.
#
# Run with: sh admin/test/test_cgi_common/test_cgi_common_lib.sh
# Exits non-zero on any failure.

set -u

THIS_DIR=$(cd "$(dirname "$0")" && pwd)
LIB="$THIS_DIR/../../cgi-bin/lib/cgi-common.sh"

if [ ! -f "$LIB" ]; then
    printf 'fixture missing: %s\n' "$LIB" >&2
    exit 1
fi

# shellcheck source=../../cgi-bin/lib/cgi-common.sh
. "$LIB"

ok=0
fail=0

assert_eq() {
    label=$1; expected=$2; actual=$3
    if [ "$expected" = "$actual" ]; then
        printf '  [ OK ] %s\n' "$label"
        ok=$((ok + 1))
    else
        printf '  [FAIL] %s\n    expected: %s\n    actual:   %s\n' \
            "$label" "$expected" "$actual"
        fail=$((fail + 1))
    fi
}

printf '\n=== xml_escape ===\n'
assert_eq 'amp+lt+gt' '&amp;&lt;&gt;' "$(xml_escape '&<>')"
assert_eq 'quote+apos' '&quot;&apos;' "$(xml_escape "\"'")"
assert_eq 'plain text untouched' 'Fresh Air' "$(xml_escape 'Fresh Air')"

printf '\n=== json_escape ===\n'
assert_eq 'backslash escaped first' '\\' "$(json_escape '\')"
assert_eq 'double-quote escaped' '\"' "$(json_escape '"')"
assert_eq 'plain text untouched' 'hello world' "$(json_escape 'hello world')"

printf '\n=== slurp_body ===\n'
# CONTENT_LENGTH=0 → empty file (busybox httpd quirks fall here too).
TMP="${TMPDIR:-/tmp}/cgi-common-test.$$"
trap 'rm -f "$TMP"' EXIT INT TERM
CONTENT_LENGTH=0 slurp_body "$TMP" </dev/null
[ ! -s "$TMP" ] && {
    printf '  [ OK ] %s\n' 'zero-length body produces empty file'
    ok=$((ok + 1))
} || {
    printf '  [FAIL] %s\n' 'zero-length body produces empty file'
    fail=$((fail + 1))
}

# Non-zero CONTENT_LENGTH copies that many bytes from stdin.
printf 'abcdef' | CONTENT_LENGTH=6 slurp_body "$TMP"
contents=$(cat "$TMP")
assert_eq 'CONTENT_LENGTH=6 captures 6 bytes' 'abcdef' "$contents"

printf '\n=== csrf_guard: same-origin Origin passes ===\n'
# Capture stdout of csrf_guard via a subshell — if it emits a 403
# envelope we'll see it; on pass it produces nothing and returns 0.
out=$(HTTP_HOST='localhost' HTTP_ORIGIN='http://localhost' HTTP_REFERER='' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'|rc=0'*) printf '  [ OK ] %s\n' 'same-origin Origin accepted'
                ok=$((ok + 1)) ;;
    *)         printf '  [FAIL] %s\n    out: %s\n' 'same-origin Origin accepted' "$out"
                fail=$((fail + 1)) ;;
esac

# Same-origin via https scheme should also pass.
out=$(HTTP_HOST='admin.local' HTTP_ORIGIN='https://admin.local' HTTP_REFERER='' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'|rc=0'*) printf '  [ OK ] %s\n' 'same-origin https Origin accepted'
                ok=$((ok + 1)) ;;
    *)         printf '  [FAIL] %s\n    out: %s\n' 'same-origin https Origin accepted' "$out"
                fail=$((fail + 1)) ;;
esac

printf '\n=== csrf_guard: cross-origin Origin rejected with CSRF_BLOCKED ===\n'
out=$(HTTP_HOST='localhost' HTTP_ORIGIN='http://evil.example' HTTP_REFERER='' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'Status: 403'*'CSRF_BLOCKED'*'|rc=1'*)
        printf '  [ OK ] %s\n' 'cross-origin Origin → 403 + rc=1'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    out: %s\n' 'cross-origin Origin → 403 + rc=1' "$out"
        fail=$((fail + 1)) ;;
esac

printf '\n=== csrf_guard: cross-origin Referer rejected (busybox quirk) ===\n'
# busybox httpd v1.19.4 doesn't always forward Origin, so the guard
# falls back to Referer. A cross-origin Referer with empty Origin
# must still be blocked.
out=$(HTTP_HOST='localhost' HTTP_ORIGIN='' HTTP_REFERER='http://evil.example/page' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'CSRF_BLOCKED'*'|rc=1'*)
        printf '  [ OK ] %s\n' 'cross-origin Referer → 403 + rc=1'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    out: %s\n' 'cross-origin Referer → 403 + rc=1' "$out"
        fail=$((fail + 1)) ;;
esac

# Mismatched Referer host MUST reject even when Origin is empty.
out=$(HTTP_HOST='speaker.lan' HTTP_ORIGIN='' HTTP_REFERER='http://other.host/path?q=1' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'CSRF_BLOCKED'*'|rc=1'*)
        printf '  [ OK ] %s\n' 'mismatched Referer host → 403 + rc=1'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    out: %s\n' 'mismatched Referer host → 403 + rc=1' "$out"
        fail=$((fail + 1)) ;;
esac

# Same-host Referer (browser navigation) must pass.
out=$(HTTP_HOST='speaker.lan' HTTP_ORIGIN='' HTTP_REFERER='http://speaker.lan/admin/' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'|rc=0'*) printf '  [ OK ] %s\n' 'same-host Referer accepted'
                ok=$((ok + 1)) ;;
    *)         printf '  [FAIL] %s\n    out: %s\n' 'same-host Referer accepted' "$out"
                fail=$((fail + 1)) ;;
esac

printf '\n=== csrf_guard: absent Origin+Referer (curl) passes ===\n'
out=$(HTTP_HOST='localhost' HTTP_ORIGIN='' HTTP_REFERER='' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'|rc=0'*) printf '  [ OK ] %s\n' 'curl-style (no headers) accepted'
                ok=$((ok + 1)) ;;
    *)         printf '  [FAIL] %s\n    out: %s\n' 'curl-style (no headers) accepted' "$out"
                fail=$((fail + 1)) ;;
esac

printf '\n=== csrf_guard: GET bypasses (method gating in callers) ===\n'
# The guard itself is method-agnostic; callers only invoke it for
# mutating methods. Simulate the canonical call-site dispatch in a
# helper function so we can assert the GET path emits nothing and
# returns 0 without ever entering csrf_guard.
gated_csrf() {
    case "${REQUEST_METHOD:-GET}" in
        POST|PUT|DELETE) csrf_guard || return 1 ;;
    esac
    return 0
}
out=$(REQUEST_METHOD='GET' HTTP_HOST='localhost' \
    HTTP_ORIGIN='http://evil.example' HTTP_REFERER='' \
    gated_csrf 2>&1; printf '|rc=%d' $?)
case "$out" in
    *CSRF_BLOCKED*)
        printf '  [FAIL] %s\n    out: %s\n' 'GET should bypass CSRF entirely' "$out"
        fail=$((fail + 1)) ;;
    *'|rc=0'*)
        printf '  [ OK ] %s\n' 'GET with cross-origin Origin bypasses CSRF'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    out: %s\n' 'GET with cross-origin Origin bypasses CSRF' "$out"
        fail=$((fail + 1)) ;;
esac

# And the corollary: POST with cross-origin Origin DOES trigger
# CSRF_BLOCKED through the same dispatch.
out=$(REQUEST_METHOD='POST' HTTP_HOST='localhost' \
    HTTP_ORIGIN='http://evil.example' HTTP_REFERER='' \
    gated_csrf 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'CSRF_BLOCKED'*'|rc=1'*)
        printf '  [ OK ] %s\n' 'POST with cross-origin Origin triggers CSRF_BLOCKED'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    out: %s\n' 'POST with cross-origin Origin triggers CSRF_BLOCKED' "$out"
        fail=$((fail + 1)) ;;
esac

printf '\n=== emit_error: envelope shape matches existing CGIs ===\n'
env=$(emit_error '400 Bad Request' INVALID_ID 'bad id' 2>&1)
case "$env" in
    *'Status: 400 Bad Request'*'"ok":false'*'"error":{"code":"INVALID_ID","message":"bad id"}'*)
        printf '  [ OK ] %s\n' 'structured error envelope (status + JSON shape)'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    env: %s\n' 'structured error envelope (status + JSON shape)' "$env"
        fail=$((fail + 1)) ;;
esac

# Headers must include Content-Type, Cache-Control, CORS.
case "$env" in
    *'Content-Type: application/json'*'Cache-Control: no-store'*'Access-Control-Allow-Origin: *'*)
        printf '  [ OK ] %s\n' 'error envelope carries Content-Type / Cache-Control / CORS'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    env: %s\n' 'error envelope carries Content-Type / Cache-Control / CORS' "$env"
        fail=$((fail + 1)) ;;
esac

# A message with a double-quote must round-trip safely as JSON.
env=$(emit_error '500' WRITE_FAILED 'oh "noes"' 2>&1)
case "$env" in
    *'\"noes\"'*) printf '  [ OK ] %s\n' 'message double-quotes escaped'
                  ok=$((ok + 1)) ;;
    *)            printf '  [FAIL] %s\n    env: %s\n' 'message double-quotes escaped' "$env"
                  fail=$((fail + 1)) ;;
esac

printf '\n=== emit_ok_headers: success preamble ===\n'
hdr=$(emit_ok_headers 2>&1)
case "$hdr" in
    *'Status: 200 OK'*'Content-Type: application/json'*'Access-Control-Allow-Methods: POST, OPTIONS'*)
        printf '  [ OK ] %s\n' 'default allow-methods is POST, OPTIONS'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    hdr: %s\n' 'default allow-methods is POST, OPTIONS' "$hdr"
        fail=$((fail + 1)) ;;
esac

hdr=$(emit_ok_headers 'GET, POST, OPTIONS' 2>&1)
case "$hdr" in
    *'Access-Control-Allow-Methods: GET, POST, OPTIONS'*)
        printf '  [ OK ] %s\n' 'caller-supplied allow-methods override'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    hdr: %s\n' 'caller-supplied allow-methods override' "$hdr"
        fail=$((fail + 1)) ;;
esac

printf '\n=== Summary: %d ok, %d failed ===\n' "$ok" "$fail"

if [ "$fail" -gt 0 ]; then
    exit 1
fi
