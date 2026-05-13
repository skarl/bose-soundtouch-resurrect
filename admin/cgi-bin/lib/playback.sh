# shellcheck shell=sh
#
# playback.sh — shared helpers for the playback-family CGIs
# (/play, /preview, /presets). Sourced via `. "$(dirname "$0")/../../lib/playback.sh"`.
#
# This file is sourced, not executed. It must:
#   - Be busybox-shell safe (no bash-isms, no `local`).
#   - Tolerate `set -u` in the caller — every referenced env var defaults
#     via `${VAR:-}` and every helper documents its inputs.
#   - Not run any code at source time apart from defining functions and
#     a small set of read-only constants. Callers compose handlers.
#
# Error envelope: `{ ok:false, error: { code:"SHOUTY", message:"..." } }`.
# All three playback CGIs use this shape so the SPA's cgiErrorMessage()
# helper handles them uniformly. The /play CGI's pre-0.4.2 flat envelope
# (`{ok:false, error:"off-air"}`) is gone — see admin/app/error-messages.js
# for the client-side mapping that absorbs both shapes during transition.
#
# CSRF: busybox httpd v1.19.4 does not always forward Origin as
# HTTP_ORIGIN on this firmware, so we ALSO check HTTP_REFERER (which
# busybox does forward). Same shape as cgi-bin/api/v1/speaker — kept in
# one place here so the three playback CGIs can't drift apart again.

# Resolver path for per-station Bose JSON. Same constant in all three
# CGIs pre-extract; centralising it here avoids the three-copy drift.
# shellcheck disable=SC2034  # consumed by sourcing CGIs
PLAYBACK_RESOLVER_DIR='/mnt/nv/resolver/bmx/tunein/v1/playback/station'

# Localhost endpoint for the firmware's HTTP API. The CGIs POST to
# /select and /storePreset here.
PLAYBACK_SPEAKER_BASE='http://localhost:8090'

# Fallback for $TMPDIR when busybox httpd doesn't set one.
PLAYBACK_TMPDIR="${TMPDIR:-/tmp}"

# --- envelope emitters ---------------------------------------------
#
# emit_error <status-line> <SHOUTY_CODE> <message>
# emit_error_ok <SHOUTY_CODE> <message>   (200 OK with ok:false — used
#                                           for the placeholder-filter
#                                           outcomes that aren't really
#                                           transport errors)
#
# emit_ok_headers   — print the success preamble; caller writes the body.
# emit_ok_empty     — `{ok:true}` shorthand (preview / presets POST).

emit_error() {
    pb_status="$1"
    pb_code="$2"
    pb_msg="$3"
    printf 'Status: %s\r\n' "$pb_status"
    printf 'Content-Type: application/json; charset=utf-8\r\n'
    printf 'Cache-Control: no-store\r\n'
    printf 'Access-Control-Allow-Origin: *\r\n'
    printf '\r\n'
    pb_msg_j=$(json_escape "$pb_msg")
    printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' \
        "$pb_code" "$pb_msg_j"
}

emit_ok_headers() {
    printf 'Status: 200 OK\r\n'
    printf 'Content-Type: application/json; charset=utf-8\r\n'
    printf 'Cache-Control: no-store\r\n'
    printf 'Access-Control-Allow-Origin: *\r\n'
    printf 'Access-Control-Allow-Methods: %s\r\n' "${1:-POST, OPTIONS}"
    printf 'Access-Control-Allow-Headers: Content-Type\r\n'
    printf '\r\n'
}

emit_ok_empty() {
    emit_ok_headers "${1:-POST, OPTIONS}"
    printf '{"ok":true}\n'
}

# --- CORS preflight ------------------------------------------------
#
# Sources call this BEFORE doing any work and exit if it returns 0.
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

# --- CSRF guard ----------------------------------------------------
#
# Same shape as cgi-bin/api/v1/speaker: a request whose Origin OR
# Referer points at a different host than HTTP_HOST is rejected with
# 403 CSRF_BLOCKED. Empty Origin/Referer (curl, same-origin GET-style)
# passes freely.
#
# Returns 0 if the caller should continue, 1 if a 403 has already been
# emitted (caller exits). Honour: the caller is responsible for the
# `exit 0` — this helper does not call exit so it's safe under `set -u`.
csrf_guard() {
    case "${HTTP_ORIGIN:-}" in
        "http://${HTTP_HOST:-}"|"https://${HTTP_HOST:-}"|"")
            ;;
        *)
            emit_error 403 CSRF_BLOCKED \
                "cross-origin mutating request rejected"
            return 1
            ;;
    esac
    pb_ref_host=$(printf '%s' "${HTTP_REFERER:-}" | \
        sed 's|^https\{0,1\}://||; s|/.*||')
    if [ -n "$pb_ref_host" ] && [ "$pb_ref_host" != "${HTTP_HOST:-}" ]; then
        emit_error 403 CSRF_BLOCKED \
            "cross-origin mutating request rejected"
        return 1
    fi
    return 0
}

# --- escape helpers ------------------------------------------------

# JSON-escape a string for embedding as a JSON value. Handles the two
# JSON-mandatory escapes plus the common control chars. Doesn't escape
# Unicode — inputs are short and ASCII in practice.
json_escape() {
    printf '%s' "$1" \
        | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        | tr '\n' ' ' \
        | tr '\r' ' ' \
        | tr '\t' ' '
}

# XML-escape a string for embedding in an attribute or element value.
xml_escape() {
    printf '%s' "$1" | sed \
        -e 's/&/\&amp;/g' \
        -e 's/</\&lt;/g' \
        -e 's/>/\&gt;/g' \
        -e 's/"/\&quot;/g' \
        -e "s/'/\\&apos;/g"
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

# --- request-body slurp -------------------------------------------
#
# slurp_body <dest>
# Read up to CONTENT_LENGTH bytes from stdin into <dest>. Truncates the
# file if CONTENT_LENGTH is missing or zero. Callers own the file
# (path + trap-driven cleanup).
slurp_body() {
    pb_cl="${CONTENT_LENGTH:-0}"
    if [ "$pb_cl" -gt 0 ] 2>/dev/null; then
        dd bs=1 count="$pb_cl" of="$1" 2>/dev/null
    else
        : >"$1"
    fi
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
