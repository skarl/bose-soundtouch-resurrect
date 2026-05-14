# shellcheck shell=sh
#
# playback.sh — playback-family helpers (/play, /preview, /presets).
# Sourced via `. "$(dirname "$0")/../../lib/playback.sh"`.
#
# Cross-CGI primitives (emit_error, csrf_guard, slurp_body, json_escape,
# xml_escape, emit_ok_headers) live in cgi-common.sh, which this file
# sources. The helpers here are playback-specific: the /select POST,
# the <ContentItem> XML builder, the JSON body-field parsers, and the
# small `emit_ok_empty` / CORS-preflight conveniences used by the three
# playback CGIs.
#
# This file is sourced, not executed. It must:
#   - Be busybox-shell safe (no bash-isms, no `local`).
#   - Tolerate `set -u` in the caller.
#   - Not run any code at source time apart from defining functions and
#     a small set of read-only constants.

# Pull in the cross-CGI primitives unless the caller has already done so
# (e.g. a unit test that sourced cgi-common.sh first from a different
# location). Probing for one of its definitions keeps the source path
# resolution simple: `$(dirname "$0")` is the calling CGI's directory,
# so `../../lib/` reaches cgi-bin/lib/ both for /play and /preview etc.
# shellcheck source=cgi-common.sh
if ! command -v emit_error >/dev/null 2>&1; then
    . "$(dirname "$0")/../../lib/cgi-common.sh"
fi

# Resolver path for per-station Bose JSON. Same constant in all three
# playback CGIs pre-extract; centralised here to avoid drift.
# shellcheck disable=SC2034  # consumed by sourcing CGIs
PLAYBACK_RESOLVER_DIR='/mnt/nv/resolver/bmx/tunein/v1/playback/station'

# Localhost endpoint for the firmware's HTTP API. The CGIs POST to
# /select and /storePreset here.
PLAYBACK_SPEAKER_BASE='http://localhost:8090'

# Fallback for $TMPDIR when busybox httpd doesn't set one.
PLAYBACK_TMPDIR="${TMPDIR:-/tmp}"

# --- success-envelope conveniences --------------------------------
#
# emit_ok_empty — `{ok:true}` shorthand (preview / presets POST).
emit_ok_empty() {
    emit_ok_headers "${1:-POST, OPTIONS}"
    printf '{"ok":true}\n'
}

# --- CORS preflight ------------------------------------------------
#
# Callers invoke this BEFORE any work and exit if it returns 0.
# Returns 0 (i.e. "handled, please exit") iff REQUEST_METHOD == OPTIONS.
# The allowed-methods string is per-CGI (presets includes GET, the
# others don't), so callers pass it explicitly.
handle_cors_preflight() {
    if [ "${REQUEST_METHOD:-GET}" != 'OPTIONS' ]; then
        return 1
    fi
    printf 'Status: 204 No Content\r\n'
    printf 'Access-Control-Allow-Origin: *\r\n'
    printf 'Access-Control-Allow-Methods: %s\r\n' "${1:-POST, OPTIONS}"
    printf 'Access-Control-Allow-Headers: Content-Type\r\n'
    printf '\r\n'
    return 0
}

# --- JSON field parsers --------------------------------------------
#
# These read the JSON body from stdin (per CGI contract) and emit the
# raw field value on stdout. They don't handle escape sequences in the
# extracted value — id/slot/name/url in our payloads are short ASCII
# strings without `\uXXXX` or string escapes. busybox sed has no `q`
# between two commands on one line, so we `head -n 1` instead.

# json_string_field <key> < file
json_string_field() {
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" \
        | head -n 1
}

# json_number_field <key> < file
json_number_field() {
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" \
        | head -n 1
}

# json_object_field < file — pull the raw substring for the `json`
# field by walking braces. The resolver consumes the result verbatim,
# so we don't need to parse it; we just need to find a balanced `{...}`
# after `"json":`.
json_object_field() {
    awk '
        BEGIN { found = 0; depth = 0; out = "" }
        {
            if (!found) {
                idx = match($0, /"json"[[:space:]]*:[[:space:]]*\{/)
                if (idx == 0) { next }
                rest = substr($0, idx + RLENGTH - 1)
                found = 1
                line = rest
            } else {
                line = $0
            }
            for (i = 1; i <= length(line); i++) {
                c = substr(line, i, 1)
                out = out c
                if (c == "{") depth++
                else if (c == "}") {
                    depth--
                    if (depth == 0) { print out; exit }
                }
            }
            out = out "\n"
        }
    '
}

# --- ContentItem builder ------------------------------------------
#
# build_content_item <guide_id> <display-name-xml-escaped>
# Echoes the minimal <ContentItem> XML the firmware needs to /select a
# TUNEIN station. Caller XML-escapes the name; this helper does NOT,
# because the same name is sometimes wrapped in extra elements (e.g.
# the presets CGI's <preset> + <containerArt>) and double-escaping
# would surface the &amp;-decoded mess in the SoundTouch UI.
build_content_item() {
    pb_id="$1"
    pb_name_xml="$2"
    pb_loc="/v1/playback/station/$pb_id"
    printf '<ContentItem source="TUNEIN" type="stationurl" location="%s" sourceAccount="" isPresetable="true"><itemName>%s</itemName></ContentItem>' \
        "$pb_loc" "$pb_name_xml"
}

# --- /select POST helper ------------------------------------------
#
# select_post <xml-body> <response-file>
# POST a <ContentItem> (or <preset>) body to the speaker's /select
# endpoint. Writes the response body to <response-file>; echoes the
# HTTP status on stdout. busybox wget can't POST on this firmware, so
# we use /usr/bin/curl. Returns 0 always — caller checks the status
# string for failure ("000" or >=400) and inspects the response body
# for an <error> element.
select_post() {
    pb_body_file="$PLAYBACK_TMPDIR/playback.$$.sp.body"
    printf '%s' "$1" >"$pb_body_file"
    pb_status=$(/usr/bin/curl -s -o "$2" -w '%{http_code}' \
        -X POST -H 'Content-Type: application/xml' \
        --data-binary "@$pb_body_file" \
        --max-time 10 \
        "${PLAYBACK_SPEAKER_BASE}/select")
    rm -f "$pb_body_file"
    printf '%s' "$pb_status"
}

# select_failed_check <status> <response-file>
# Returns 0 if the /select call appears to have failed (transport error
# or upstream <error> element), 1 if it looks successful.
select_failed_check() {
    pb_st="$1"
    pb_rf="$2"
    if [ -z "$pb_st" ] || [ "$pb_st" = "000" ]; then
        return 0
    fi
    if [ "$pb_st" -ge 400 ] 2>/dev/null; then
        return 0
    fi
    if grep -q '<error' "$pb_rf" 2>/dev/null; then
        return 0
    fi
    return 1
}
