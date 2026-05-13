#!/bin/sh
#
# test_playback_lib — unit tests for admin/cgi-bin/lib/playback.sh.
#
# Sources the library directly (so it runs anywhere, no live speaker
# required) and exercises the pure helpers: json_escape, xml_escape,
# json_string_field, json_number_field, json_object_field, csrf_guard,
# build_content_item.
#
# Run with: sh admin/test/test_play_cgi/test_playback_lib.sh
# Exits non-zero on any failure.

set -u

# Resolve repo root from this script's location so the test works from
# any cwd. POSIX-portable: %P doesn't exist, but the worktree path
# always has admin/test/test_play_cgi as the deepest two segments.
THIS_DIR=$(cd "$(dirname "$0")" && pwd)
LIB="$THIS_DIR/../../cgi-bin/lib/playback.sh"

if [ ! -f "$LIB" ]; then
    printf 'fixture missing: %s\n' "$LIB" >&2
    exit 1
fi

# shellcheck source=../../cgi-bin/lib/playback.sh
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
# tab/newline/CR collapse to space (best-effort defang for short labels)
assert_eq 'tab folds to space' 'a b' "$(printf 'a\tb' | { read -r line; json_escape "$line"; })"

printf '\n=== json_string_field ===\n'
v=$(printf '{"id":"s24862","name":"SRF 3"}' | json_string_field id)
assert_eq 'id' 's24862' "$v"
v=$(printf '{"id":"s24862","name":"SRF 3"}' | json_string_field name)
assert_eq 'name' 'SRF 3' "$v"
v=$(printf '{"id":"s24862"}' | json_string_field nope)
assert_eq 'missing key returns empty' '' "$v"

printf '\n=== json_number_field ===\n'
v=$(printf '{"slot":3,"id":"s1"}' | json_number_field slot)
assert_eq 'slot=3' '3' "$v"
v=$(printf '{"slot":0,"id":"s1"}' | json_number_field slot)
assert_eq 'slot=0' '0' "$v"

printf '\n=== json_object_field ===\n'
v=$(printf '{"id":"s1","json":{"a":1,"b":"x"}}' | json_object_field)
assert_eq 'flat nested object' '{"a":1,"b":"x"}' "$v"
v=$(printf '{"json":{"outer":{"inner":2}}}' | json_object_field)
assert_eq 'nested objects balanced' '{"outer":{"inner":2}}' "$v"

printf '\n=== build_content_item ===\n'
ci=$(build_content_item 's24862' 'SRF 3')
expected='<ContentItem source="TUNEIN" type="stationurl" location="/v1/playback/station/s24862" sourceAccount="" isPresetable="true"><itemName>SRF 3</itemName></ContentItem>'
assert_eq 'ContentItem shape' "$expected" "$ci"

# Caller XML-escapes the name; the builder should embed it verbatim
# (no double-escape) — important because the presets CGI wraps the same
# string in a <preset> with optional <containerArt>.
ci=$(build_content_item 's24862' '&amp;Q')
case "$ci" in
    *'<itemName>&amp;Q</itemName>'*)
        printf '  [ OK ] %s\n' 'pre-escaped name passed through unchanged'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    got: %s\n' 'pre-escaped name passed through unchanged' "$ci"
        fail=$((fail + 1)) ;;
esac

printf '\n=== csrf_guard: same-origin passes ===\n'
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

printf '\n=== csrf_guard: cross-origin Origin rejected ===\n'
out=$(HTTP_HOST='localhost' HTTP_ORIGIN='http://evil.example' HTTP_REFERER='' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'CSRF_BLOCKED'*'|rc=1'*)
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

printf '\n=== csrf_guard: empty headers (curl) pass ===\n'
out=$(HTTP_HOST='localhost' HTTP_ORIGIN='' HTTP_REFERER='' \
    csrf_guard 2>&1; printf '|rc=%d' $?)
case "$out" in
    *'|rc=0'*) printf '  [ OK ] %s\n' 'curl-style (no headers) accepted'
                ok=$((ok + 1)) ;;
    *)         printf '  [FAIL] %s\n    out: %s\n' 'curl-style (no headers) accepted' "$out"
                fail=$((fail + 1)) ;;
esac

printf '\n=== emit_error: envelope shape ===\n'
env=$(emit_error '400 Bad Request' INVALID_ID 'bad id' 2>&1)
case "$env" in
    *'"ok":false'*'"error":{"code":"INVALID_ID","message":"bad id"}'*)
        printf '  [ OK ] %s\n' 'structured error envelope'
        ok=$((ok + 1)) ;;
    *)
        printf '  [FAIL] %s\n    env: %s\n' 'structured error envelope' "$env"
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

printf '\n=== Summary: %d ok, %d failed ===\n' "$ok" "$fail"

if [ "$fail" -gt 0 ]; then
    exit 1
fi
