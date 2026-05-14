# shellcheck shell=sh
#
# cgi-common.sh — helpers shared by every CGI under admin/cgi-bin/api/v1.
# Sourced via `. "$(dirname "$0")/../../lib/cgi-common.sh"`.
#
# This file is sourced, not executed. It must:
#   - Be busybox-shell safe (no bash-isms, no `local`).
#   - Tolerate `set -u` in the caller — every referenced env var defaults
#     via `${VAR:-}` and every helper documents its inputs.
#   - Not run any code at source time apart from defining functions.
#
# Error envelope: `{ ok:false, error: { code:"SHOUTY", message:"..." } }`.
# Every CGI uses this shape so the SPA's cgiErrorMessage() helper
# handles them uniformly.
#
# CSRF: busybox httpd v1.19.4 does not always forward Origin as
# HTTP_ORIGIN on this firmware, so the guard ALSO checks HTTP_REFERER
# (which busybox does forward). Centralised here so the six CGIs can't
# drift apart.

# --- error envelope ------------------------------------------------
#
# emit_error <status-line> <SHOUTY_CODE> <message>
emit_error() {
    cc_status="$1"
    cc_code="$2"
    cc_msg="$3"
    printf 'Status: %s\r\n' "$cc_status"
    printf 'Content-Type: application/json; charset=utf-8\r\n'
    printf 'Cache-Control: no-store\r\n'
    printf 'Access-Control-Allow-Origin: *\r\n'
    printf '\r\n'
    cc_msg_j=$(json_escape "$cc_msg")
    printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' \
        "$cc_code" "$cc_msg_j"
}

# emit_ok_headers [<allow-methods>]   — success preamble; caller writes
# the body. Default allow-methods is "POST, OPTIONS"; pass an alternative
# string for CGIs that expose more verbs (e.g. presets allows GET).
emit_ok_headers() {
    printf 'Status: 200 OK\r\n'
    printf 'Content-Type: application/json; charset=utf-8\r\n'
    printf 'Cache-Control: no-store\r\n'
    printf 'Access-Control-Allow-Origin: *\r\n'
    printf 'Access-Control-Allow-Methods: %s\r\n' "${1:-POST, OPTIONS}"
    printf 'Access-Control-Allow-Headers: Content-Type\r\n'
    printf '\r\n'
}

# --- CSRF guard ----------------------------------------------------
#
# A request whose Origin OR Referer points at a different host than
# HTTP_HOST is rejected with 403 CSRF_BLOCKED. Empty Origin/Referer
# (curl, same-origin GET-style) passes freely.
#
# Returns 0 if the caller should continue, 1 if a 403 has already been
# emitted (caller exits). Honour: the caller is responsible for the
# `exit 0` — this helper does not call exit so it's safe under `set -u`.
#
# Method gating stays in callers because not every CGI mutates. The
# canonical site-call for a mutating endpoint is:
#   case "${REQUEST_METHOD:-GET}" in
#       POST|PUT|DELETE) csrf_guard || exit 0 ;;
#   esac
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
    cc_ref_host=$(printf '%s' "${HTTP_REFERER:-}" | \
        sed 's|^https\{0,1\}://||; s|/.*||')
    if [ -n "$cc_ref_host" ] && [ "$cc_ref_host" != "${HTTP_HOST:-}" ]; then
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

# --- request-body slurp -------------------------------------------
#
# slurp_body <dest>
# Read up to CONTENT_LENGTH bytes from stdin into <dest>. Truncates the
# file if CONTENT_LENGTH is missing or zero. Callers own the file
# (path + trap-driven cleanup).
slurp_body() {
    cc_cl="${CONTENT_LENGTH:-0}"
    if [ "$cc_cl" -gt 0 ] 2>/dev/null; then
        dd bs=1 count="$cc_cl" of="$1" 2>/dev/null
    else
        : >"$1"
    fi
}
