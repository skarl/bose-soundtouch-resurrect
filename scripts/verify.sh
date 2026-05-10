#!/bin/sh
#
# Post-install sanity check.
#
# Usage:
#   ./scripts/verify.sh <speaker-ip>
#
# Exits non-zero on any failure so it composes with deploy.sh.

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip>}"

SSH="ssh -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10 -oBatchMode=yes"

ok=0
fail=0

check() {
    label=$1; shift
    # We rely on the caller passing $SSH unquoted so the shell splits its
    # multi-flag string into argv. Intentional; don't quote $SSH at the
    # call sites either.
    if "$@" >/dev/null 2>&1; then
        printf '  [ OK ] %s\n' "$label"
        ok=$((ok + 1))
    else
        printf '  [FAIL] %s\n' "$label"
        fail=$((fail + 1))
    fi
}

printf '\n=== SSH reachability ===\n'
check "ssh root@$SPEAKER works" $SSH root@"$SPEAKER" 'true'

printf '\n=== Resolver httpd ===\n'
check "/bin/httpd process is running" \
    $SSH root@"$SPEAKER" 'ps w | grep -q "[h]ttpd .*-h /mnt/nv/resolver"'
check "TCP 8181 is listening" \
    $SSH root@"$SPEAKER" 'netstat -ln | grep -q ":8181 "'
check "shepherdd has /bin/httpd in pids" \
    $SSH root@"$SPEAKER" 'grep -q "/bin/httpd" /mnt/nv/shepherd/pids'

printf '\n=== Resolver tree ===\n'
check "/mnt/nv/resolver/bmx/registry/v1/services exists" \
    $SSH root@"$SPEAKER" 'test -s /mnt/nv/resolver/bmx/registry/v1/services'
check "/mnt/nv/resolver/marge/streaming/sourceproviders exists" \
    $SSH root@"$SPEAKER" 'test -s /mnt/nv/resolver/marge/streaming/sourceproviders'
check "/mnt/nv/resolver/bmx/tunein/v1/playback/station/ has at least one station" \
    $SSH root@"$SPEAKER" 'ls /mnt/nv/resolver/bmx/tunein/v1/playback/station/ | grep -q "^s[0-9]"'

printf '\n=== Override XML points at 127.0.0.1:8181 ===\n'
check "/mnt/nv/OverrideSdkPrivateCfg.xml exists" \
    $SSH root@"$SPEAKER" 'test -s /mnt/nv/OverrideSdkPrivateCfg.xml'
check "margeServerUrl points at 127.0.0.1" \
    $SSH root@"$SPEAKER" 'grep -q "margeServerUrl>http://127.0.0.1:8181" /mnt/nv/OverrideSdkPrivateCfg.xml'
check "bmxRegistryUrl points at 127.0.0.1" \
    $SSH root@"$SPEAKER" 'grep -q "bmxRegistryUrl>http://127.0.0.1:8181" /mnt/nv/OverrideSdkPrivateCfg.xml'

printf '\n=== Resolver responds on the speaker ===\n'
check "registry endpoint returns content" \
    $SSH root@"$SPEAKER" 'wget -qO - http://127.0.0.1:8181/bmx/registry/v1/services | grep -q bmx_services'
check "sourceproviders endpoint returns content" \
    $SSH root@"$SPEAKER" 'wget -qO - http://127.0.0.1:8181/marge/streaming/sourceproviders | grep -q sourceProviders'

printf '\n=== Speaker local API responding ===\n'
check "port 8090 /info returns XML" \
    $SSH root@"$SPEAKER" 'curl -s http://localhost:8090/info | grep -q "<info"'
check "port 8090 /now_playing returns XML" \
    $SSH root@"$SPEAKER" 'curl -s http://localhost:8090/now_playing | grep -q "<nowPlaying"'

printf '\n=== Admin SPA (skipped if not deployed) ===\n'
# Probe via the speaker (matches the existing wget/curl-through-ssh
# pattern). The admin is optional: skip cleanly if index.html isn't
# served, but if it IS served, assert the meta tag. Also assert the
# resolver's services endpoint still serves — admin install must not
# break the resolver tree.
#
# busybox wget exits 0 on 2xx and nonzero on 4xx/5xx/network error,
# so existence-probing is just the exit status. (Don't use `-S` —
# busybox wget doesn't support it.)
if $SSH root@"$SPEAKER" 'wget -q -O /dev/null http://127.0.0.1:8181/' 2>/dev/null; then
    check "admin index has admin-version meta tag" \
        $SSH root@"$SPEAKER" 'wget -qO - http://127.0.0.1:8181/ | grep -q "admin-version"'
else
    printf '  [SKIP] admin shell not deployed\n'
fi

check "resolver services endpoint still serves" \
    $SSH root@"$SPEAKER" 'wget -qO - http://127.0.0.1:8181/bmx/registry/v1/services | grep -q "{"'

printf '\n=== Admin CGIs (skipped if not deployed) ===\n'
# Each probe checks the CGI exists (wget exit status) before asserting
# response shape. Skips cleanly when a CGI isn't installed.

if $SSH root@"$SPEAKER" 'wget -q -O /dev/null http://127.0.0.1:8181/cgi-bin/api/v1/presets' 2>/dev/null; then
    check "presets CGI returns ok-envelope" \
        $SSH root@"$SPEAKER" 'wget -qO - http://127.0.0.1:8181/cgi-bin/api/v1/presets | grep -q "\"ok\":true"'
else
    printf '  [SKIP] presets CGI not deployed\n'
fi

# refresh-all CGI — POST round-trip; expects {ok:true, data:{updated, unchanged, failed}}.
# Probed via curl from the laptop so we hit the real busybox httpd
# CGI dispatch path (busybox wget on Bo is GET-only).
if curl -fsS -o /dev/null -X POST "http://$SPEAKER:8181/cgi-bin/api/v1/refresh-all" 2>/dev/null; then
    check "refresh-all CGI returns ok-envelope" \
        sh -c 'curl -fsS -X POST "http://'"$SPEAKER"':8181/cgi-bin/api/v1/refresh-all" | grep -q "\"ok\":true"'
else
    printf '  [SKIP] refresh-all CGI not deployed\n'
fi

if $SSH root@"$SPEAKER" 'wget -q -O /dev/null http://127.0.0.1:8181/cgi-bin/api/v1/tunein/browse' 2>/dev/null; then
    check "tunein CGI returns JSON or array" \
        $SSH root@"$SPEAKER" 'wget -qO - http://127.0.0.1:8181/cgi-bin/api/v1/tunein/browse | grep -qE "[\\[{]"'
else
    printf '  [SKIP] tunein CGI not deployed\n'
fi

printf '\n=== 0.3 WS + speaker proxy probes ===\n'
# These probes run from the laptop (not via SSH), testing port 8080 and
# the speaker proxy CGI on 8181. They require the 0.3 admin to be deployed.

# WS handshake — curl sends the Upgrade headers; expect 101 and
# Sec-WebSocket-Protocol: gabbo in the response. curl blocks after the
# handshake (the speaker keeps the WS open), so --max-time 3 is enough
# to capture the response headers before timing out. curl exits 28 on
# timeout, which is after a successful 101, so we capture stdout first.
ws_response=$(curl -si \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Protocol: gabbo' \
    --max-time 3 \
    "http://$SPEAKER:8080/" 2>/dev/null || true)
check "WS port 8080 returns 101 Switching Protocols" \
    sh -c 'printf "%s" "$0" | grep -q "101 Switching"' "$ws_response"
check "WS response carries Sec-WebSocket-Protocol: gabbo" \
    sh -c 'printf "%s" "$0" | grep -qi "Sec-WebSocket-Protocol: gabbo"' "$ws_response"

# Speaker proxy POST round-trip — read current volume, POST the same
# level back (no audible change), expect 2xx from the proxy.
# Requires the CGI proxy fix from slice 10 (--config Content-Type header).
if curl -fsS "http://$SPEAKER:8181/cgi-bin/api/v1/speaker/volume" \
        -o /dev/null 2>/dev/null; then
    vol=$(curl -fsS "http://$SPEAKER:8181/cgi-bin/api/v1/speaker/volume" 2>/dev/null \
        | grep -o '<actualvolume>[0-9]*</actualvolume>' \
        | grep -o '[0-9]*' || echo 20)
    check "speaker proxy POST /volume round-trip returns 2xx" \
        curl -fsS -X POST \
            -H 'Content-Type: application/xml' \
            -d "<volume>${vol:-20}</volume>" \
            "http://$SPEAKER:8181/cgi-bin/api/v1/speaker/volume"
    # Origin guard — same POST but with a Referer from a foreign host.
    # busybox httpd v1.19.4 does not forward the Origin header; the proxy
    # CGI uses HTTP_REFERER as the CSRF signal instead. Expect 403.
    check "speaker proxy rejects cross-origin Referer (CSRF guard, expect 403)" \
        sh -c 'code=$(curl -s -o /dev/null -w "%{http_code}" \
            -X POST \
            -H "Content-Type: application/xml" \
            -H "Referer: http://evil.example/page" \
            -d "<volume>'"${vol:-20}"'</volume>" \
            "http://'"$SPEAKER"':8181/cgi-bin/api/v1/speaker/volume"); \
            [ "$code" = "403" ]'
else
    printf '  [SKIP] speaker proxy not deployed (skipping 0.3 proxy probes)\n'
fi

printf '\n=== Summary: %d ok, %d failed ===\n' "$ok" "$fail"

if [ "$fail" -gt 0 ]; then
    printf '\nSome checks failed. See docs/troubleshooting.md.\n' >&2
    exit 1
fi
