#!/bin/sh
#
# Capture on-speaker diagnostic state to a local timestamped folder.
#
# Run this first when a contributor reports their speaker doesn't work
# after deploy. The bundle this produces is enough to diff a broken
# install against a known-working one. It captures, in order:
#
#   Identity / health:   firmware Variant, model, region, and resource
#     state (free memory, df, uptime, load, kernel) — a full /mnt/nv or
#     OOM/reboot pressure shows up here and nowhere else.
#   Install footprint:   OverrideSdkPrivateCfg.xml, shepherd-resolver
#     config, the resolver file tree.
#   Boot / Shepherd:     the *full* /opt/Bose/etc listing (catches
#     configs our Shepherd-*.xml glob misses), the contents of every
#     stock Shepherd config (per-variant daemon set + recovery= attrs),
#     override dir, pids, mtimes.
#   Runtime / network:   process list, bound listeners, loopback-vs-
#     LAN-IP HTTP reachability per port, iptables (all tables) +
#     routing, and the /proc/net/tcp + net-namespace view for our ports.
#   Source / token:      Sources.xml service keys + live /sources status
#     (the "Speaker rejected the stream" failure mode). Tokens are never
#     emitted — only the service keys and status.
#   Logs:                dmesg tail and /var/log/messages tail.
#
# Every probe is read-only — no writes, no reboots, nothing that touches
# playback. The interactive captures from past threads (tcpdump,
# alt-port httpd, two-terminal SYN tests) stay ad-hoc; they can't be
# one-shot. Each item is lifted from a real report: boot/Shepherd
# (#143/#160), reachability (#159), source/token state (#156).
#
# ANONYMISATION IS ON BY DEFAULT. The bundle is post-processed so MACs,
# LAN IPs, serial numbers, the account UUID, the speaker name, and any
# SSID are replaced with stable pseudonyms (MAC_1, IP_1, SERIAL_1, ...).
# The replacement is deterministic: the same real value always maps to
# the same placeholder across every file, so structural facts survive
# (e.g. deviceID == the SCM MAC; SCM and SMSC sharing one IP) while the
# identities are gone. Pass --raw to skip this when capturing your own
# bench speaker.
#
# Captures that fail or aren't present on this firmware do not abort the
# run — they emit a [FAIL]/[SKIP] line and the script continues.
#
# Usage:
#   ./scripts/capture-state.sh [--raw] <speaker-ip>

set -u

RAW=0
SPEAKER=""
for a in "$@"; do
    case "$a" in
        --raw) RAW=1 ;;
        -h|--help) echo "usage: $0 [--raw] <speaker-ip>"; exit 0 ;;
        -*) echo "unknown option: $a" >&2; echo "usage: $0 [--raw] <speaker-ip>" >&2; exit 2 ;;
        *)  SPEAKER="$a" ;;
    esac
done
[ -n "$SPEAKER" ] || { echo "usage: $0 [--raw] <speaker-ip>" >&2; exit 1; }

# Same flag-string convention as scripts/deploy.sh and scripts/ssh-speaker.sh.
SSH="ssh -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10 -oBatchMode=yes"

# Pre-flight: a single SSH probe so we fail fast on the obvious case.
# Done before mkdir so a typo'd IP doesn't litter the cwd with empty folders.
if ! $SSH root@"$SPEAKER" 'true' 2>/dev/null; then
    echo "error: cannot SSH to root@$SPEAKER" >&2
    echo "       check the IP, SSH-enable state, and -oHostKeyAlgorithms=+ssh-rsa." >&2
    exit 1
fi

OUT="soundtouch-capture-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# capture <out-file> <remote-shell-command>
#
# Runs the remote command, writes stdout to $OUT/<out-file>, and
# classifies the result:
#   [ OK ]  - command exit 0, file non-empty
#   [SKIP]  - command exit 0, file empty (path/file doesn't exist on this firmware)
#   [FAIL]  - command exit non-zero
#
# Empty captures are removed from the output folder so a missing
# /var/log/messages doesn't leave a misleading empty file behind.
#
# Multi-step probes are built as single-quoted heredocs into a variable
# and passed as $cmd, so embedded quotes pass through to the speaker's
# shell untouched. Each such snippet ends in `true` so a non-zero last
# command (e.g. a curl to an unreachable port) doesn't get the whole,
# still-useful capture marked [FAIL] and deleted.
capture() {
    outfile="$1"
    cmd="$2"
    path="$OUT/$outfile"

    if $SSH root@"$SPEAKER" "$cmd" >"$path" 2>/dev/null; then
        size=$(wc -c <"$path" | tr -d ' ')
        if [ "$size" -gt 0 ]; then
            printf '[ OK ] %-28s (%s bytes)\n' "$outfile" "$size"
        else
            rm -f "$path"
            printf '[SKIP] %-28s (not present on this firmware)\n' "$outfile"
        fi
    else
        rc=$?
        rm -f "$path"
        printf '[FAIL] %-28s (ssh/cmd exit %d)\n' "$outfile" "$rc"
    fi
}

if [ "$RAW" -eq 1 ]; then
    echo "Capturing state from $SPEAKER -> $OUT/   (mode: RAW — not anonymised)"
else
    echo "Capturing state from $SPEAKER -> $OUT/   (mode: anonymised; pass --raw for unredacted)"
fi
echo

# --- Identity / health ----------------------------------------------

# /info — model, Variant, firmware, MAC, region. The single most
# important file: every compat report turns on Variant.
capture "info.xml"                   "curl -s --max-time 5 http://localhost:8090/info"

# Resource state — a full /mnt/nv, memory pressure, or high load explain
# boot loops, deploy failures, and the spontaneous reboots from #159.
HEALTH=$(cat <<'REMOTE'
echo "== free =="; free 2>&1
echo "== df -h =="; df -h 2>&1
echo "== uptime =="; uptime 2>&1
echo "== loadavg =="; cat /proc/loadavg 2>&1
echo "== kernel =="; cat /proc/version 2>&1
true
REMOTE
)
capture "health.txt"                 "$HEALTH"

# Mount info — writability of /opt/Bose (squashfs, ro) and /mnt/nv (rw).
capture "mounts.txt"                 "mount"

# --- Install footprint ----------------------------------------------

# NV-flash root — surfaces everything we've left behind (the override
# XML, resolver/, the shepherd dir, remote_services marker, etc.).
capture "mnt-nv.txt"                 "ls -la /mnt/nv/ 2>/dev/null"

# The override XML BoseApp reads at boot — confirms the four cloud URLs
# all redirect to 127.0.0.1:8181.
capture "override-xml.txt"           "cat /mnt/nv/OverrideSdkPrivateCfg.xml 2>/dev/null"

# Resolver file tree — are the per-station JSONs, registry, and scmudc
# heartbeat sink actually present (the #156 'rejected stream' surface).
capture "resolver-tree.txt"          "find /mnt/nv/resolver -type f 2>/dev/null | head -200"

# --- Boot / Shepherd ------------------------------------------------

# FULL /opt/Bose/etc listing — NOT the Shepherd-*.xml glob. This is the
# blind spot deploy and the old capture both shared: a boot-critical
# config our glob doesn't match (e.g. a dash-less Shepherd.xml) only
# shows up here. Central to the #160 ST 20 boot loop.
capture "etc-listing.txt"            "ls -la /opt/Bose/etc/ 2>/dev/null"

# Stock Shepherd config listing — focused view; the full picture is in
# etc-listing.txt above.
capture "shepherd-stock-configs.txt" "ls -la /opt/Bose/etc/Shepherd-*.xml 2>/dev/null"

# Contents of every Shepherd config (stock + our resolver). Stock
# configs are firmware-shipped, identical across all units of a model —
# no personal data — and carry the per-variant daemon set plus the
# recovery= attributes that distinguish a reboot *loop* from a hang.
SHEP_CONTENT=$(cat <<'REMOTE'
for f in /opt/Bose/etc/Shepherd*.xml /mnt/nv/shepherd/Shepherd-resolver.xml; do
  [ -f "$f" ] || continue
  echo "===== $f ====="
  cat "$f" 2>&1
  echo
done
true
REMOTE
)
capture "shepherd-configs-content.txt" "$SHEP_CONTENT"

# Shepherd override directory — does it exist, what's in it, symlinks
# vs regular files. The file that surfaced the 0.8 install bug (ADR-0004).
capture "shepherd-override-dir.txt"  "ls -la /mnt/nv/shepherd/ 2>/dev/null"

# shepherdd's runtime view: what it's actually supervising right now.
capture "shepherd-pids.txt"          "cat /mnt/nv/shepherd/pids 2>/dev/null"

# Mtimes on every Shepherd-*.xml under both load paths — stock configs
# have firmware-build mtimes; manual edits are recent.
capture "mtimes.txt"                 "find /opt/Bose/etc /mnt/nv/shepherd -name 'Shepherd-*.xml' -printf '%T@ %p\n' 2>/dev/null"

# Does any stock config have recovery="ignore" on SoftwareUpdate?
capture "softwareupdate-recovery.txt" "grep -B1 -A2 SoftwareUpdate /opt/Bose/etc/Shepherd-*.xml 2>/dev/null"

# --- Runtime / network ----------------------------------------------

# The live process list — the supervised daemon set deploy must
# preserve. On a pre-deploy speaker this is the baseline to diff against.
capture "ps.txt"                     "ps"

# What's actually bound (resolver httpd on 8181, WS 8080, API 8090).
capture "listeners.txt"              "netstat -ltn 2>/dev/null"

# Loopback vs the speaker's OWN LAN IP, per port. The single most
# decisive network probe: if loopback works but the LAN IP doesn't, the
# socket is healthy and something fronts the LAN (the #159 shape). The
# self-IP is read from /info so we don't repeat the `ip -br` faceplant.
REACH=$(cat <<'REMOTE'
IP=$(curl -s --max-time 5 http://localhost:8090/info 2>/dev/null | grep -oE '<ipAddress>[0-9.]+' | head -1 | cut -d'>' -f2)
echo "self LAN IP (from /info): ${IP:-<none>}"
for p in 8181 8080 8090; do
  echo "== port $p =="
  curl -sS -o /dev/null -w "  loopback     HTTP %{http_code}  %{time_total}s\n" --max-time 5 "http://127.0.0.1:$p/" 2>&1 || echo "  loopback     unreachable"
  if [ -n "$IP" ]; then
    curl -sS -o /dev/null -w "  self-LAN-IP  HTTP %{http_code}  %{time_total}s\n" --max-time 5 "http://$IP:$p/" 2>&1 || echo "  self-LAN-IP  unreachable"
  fi
done
true
REMOTE
)
capture "reachability.txt"           "$REACH"

# Firewall (all four tables, tolerating absent ones) + routing. Rules
# anywhere here would explain a port reachable on loopback but not LAN.
FWROUTE=$(cat <<'REMOTE'
for t in filter nat mangle raw; do
  echo "== iptables -t $t =="
  iptables -t "$t" -L -n -v 2>&1
done
echo "== ip route =="; ip route show 2>&1
echo "== ip rule =="; ip rule show 2>&1
true
REMOTE
)
capture "firewall-routing.txt"       "$FWROUTE"

# Socket table for our ports + net-namespace inodes (httpd vs BoseApp).
# A namespace difference would explain a daemon being unreachable
# despite a healthy listening socket.
SOCKETS=$(cat <<'REMOTE'
echo "== /proc/net/tcp (ports 8181=1FF5 8080=1F90 8090=1F9A) =="
awk '$2 ~ /:(1FF5|1F90|1F9A)$/ || $3 ~ /:(1FF5|1F90|1F9A)$/ {print}' /proc/net/tcp 2>/dev/null
echo "== net namespace per daemon =="
for name in /bin/httpd BoseApp; do
  pid=$(pgrep -f "$name" 2>/dev/null | head -1)
  echo "  $name (pid ${pid:-?}): $(readlink /proc/$pid/ns/net 2>/dev/null)"
done
true
REMOTE
)
capture "sockets.txt"                "$SOCKETS"

# --- Source / token state -------------------------------------------

# Sources.xml service keys (names only — tokens are never emitted) and
# live /sources source+status. The "Speaker rejected the stream" surface.
SOURCES=$(cat <<'REMOTE'
echo "== Sources.xml (presence + service keys only; tokens never emitted) =="
ls -la /mnt/nv/BoseApp-Persistence/1/Sources.xml 2>&1
grep -oE '(TUNEIN|RADIOPLAYER|LOCAL_INTERNET_RADIO)' /mnt/nv/BoseApp-Persistence/1/Sources.xml 2>/dev/null | sort | uniq -c
echo "== live /sources (source + status only) =="
curl -s --max-time 5 http://localhost:8090/sources 2>/dev/null | tr '<' '\n' | grep 'source=' | awk '{ s=""; t=""; for(i=1;i<=NF;i++){ if($i ~ /^source="/) s=$i; if($i ~ /^status="/) t=$i } if(s!="") print "  " s "  " t }'
true
REMOTE
)
capture "sources-tokens.txt"         "$SOURCES"

# --- Logs ------------------------------------------------------------

# Kernel ring — boot-stage anomalies (failed mounts, OOM, hardware).
capture "dmesg-tail.txt"             "dmesg 2>/dev/null | tail -200"

# Userspace log — shepherdd / BoseApp errors. Not all firmwares populate
# this; SKIP is expected on the ones that log to a ring buffer instead.
capture "varlog-tail.txt"            "tail -200 /var/log/messages 2>/dev/null"

# --- Anonymisation pass ---------------------------------------------
#
# Deterministic pseudonymisation, run locally over the captured files.
# Phase 1 builds one map of real-value -> placeholder, consistent across
# every file; phase 2 applies it with literal (regex-free) longest-first
# replacement so dotted IPs and the like substitute exactly.
anonymise_bundle() {
    set -- "$OUT"/*
    [ -e "$1" ] || return 0

    MAP="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/cs-map.$$")"

    # Phase 1a: structured pull from info.xml + generic scan of all files.
    awk '
        function add(real, kind,   ph) {
            if (real == "" || (real in seen)) return
            cnt[kind]++
            ph = kind "_" cnt[kind]
            seen[real] = ph
            print real "\t" ph
        }
        FILENAME ~ /info\.xml$/ {
            line = $0
            if (match(line, /deviceID="[0-9A-Fa-f]+"/)) { v=substr(line,RSTART,RLENGTH); gsub(/deviceID="|"/,"",v); add(v,"MAC") }
            tmp=line; while (match(tmp, /<macAddress>[0-9A-Fa-f]+<\/macAddress>/)) { v=substr(tmp,RSTART,RLENGTH); gsub(/<\/?macAddress>/,"",v); add(v,"MAC"); tmp=substr(tmp,RSTART+RLENGTH) }
            tmp=line; while (match(tmp, /<ipAddress>[0-9.]+<\/ipAddress>/)) { v=substr(tmp,RSTART,RLENGTH); gsub(/<\/?ipAddress>/,"",v); add(v,"IP"); tmp=substr(tmp,RSTART+RLENGTH) }
            tmp=line; while (match(tmp, /<serialNumber>[^<]+<\/serialNumber>/)) { v=substr(tmp,RSTART,RLENGTH); gsub(/<\/?serialNumber>/,"",v); add(v,"SERIAL"); tmp=substr(tmp,RSTART+RLENGTH) }
            if (match(line, /<margeAccountUUID>[^<]+<\/margeAccountUUID>/)) { v=substr(line,RSTART,RLENGTH); gsub(/<\/?margeAccountUUID>/,"",v); add(v,"ACCT") }
            if (match(line, /<name>[^<]+<\/name>/)) { v=substr(line,RSTART,RLENGTH); gsub(/<\/?name>/,"",v); add(v,"NAME") }
            if (match(line, /<ssid>[^<]+<\/ssid>/)) { v=substr(line,RSTART,RLENGTH); gsub(/<\/?ssid>/,"",v); add(v,"SSID") }
        }
        {
            s=$0
            while (match(s, /(10\.[0-9]+\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+)/)) {
                v=substr(s,RSTART,RLENGTH); add(v,"IP"); s=substr(s,RSTART+RLENGTH)
            }
            s=$0
            while (match(s, /([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/)) { v=substr(s,RSTART,RLENGTH); add(v,"MAC"); s=substr(s,RSTART+RLENGTH) }
        }
    ' "$OUT"/* > "$MAP" 2>/dev/null

    # Phase 1b: add each IP's little-endian /proc/net/tcp hex form,
    # mapped to the same placeholder, so the socket table anonymises too.
    awk -F'\t' '
        { print }
        $2 ~ /^IP_/ && $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {
            split($1, o, "."); printf "%02X%02X%02X%02X\t%s\n", o[4], o[3], o[2], o[1], $2
        }
    ' "$MAP" > "$MAP.2" && mv "$MAP.2" "$MAP"

    # Phase 2: literal longest-first replacement across every file.
    for f in "$OUT"/*; do
        [ -f "$f" ] || continue
        awk -v mapfile="$MAP" '
            function lit(s, find, repl,   o, p) {
                o=""
                while ((p=index(s, find)) > 0) { o = o substr(s,1,p-1) repl; s = substr(s, p+length(find)) }
                return o s
            }
            BEGIN {
                c=0
                while ((getline ln < mapfile) > 0) {
                    t=index(ln, "\t"); if (t==0) continue
                    reals[++c]=substr(ln,1,t-1); phs[c]=substr(ln,t+1)
                }
                for (i=1;i<=c;i++) for (j=i+1;j<=c;j++) if (length(reals[j])>length(reals[i])) { x=reals[i];reals[i]=reals[j];reals[j]=x; x=phs[i];phs[i]=phs[j];phs[j]=x }
            }
            { line=$0; for (i=1;i<=c;i++) if (reals[i]!="") line=lit(line, reals[i], phs[i]); print line }
        ' "$f" > "$f.anon" && mv "$f.anon" "$f"
    done

    n=$(wc -l <"$MAP" | tr -d ' ')
    rm -f "$MAP"
    echo "  anonymised ${n} distinct identifier(s) across the bundle"
}

echo
if [ "$RAW" -eq 1 ]; then
    echo "Saved to $OUT/   (RAW — contains real MACs/IPs/serials/account/name)"
    echo
    echo "Before pasting any of these files into a public issue or PR:"
    echo "  - redact LAN IPs (e.g. 192.168.x.y, 10.x.y.z, fritz.box hostnames)"
    echo "  - redact MAC addresses (deviceID, networkInfo blocks, socket tables, logs)"
    echo "  - redact serial numbers and the account UUID in info.xml"
    echo "  (or just re-run without --raw to get an anonymised bundle)"
else
    echo "Anonymising bundle..."
    anonymise_bundle
    echo
    echo "Saved to $OUT/   (anonymised — safe to paste into a public issue)"
    echo "  Identifiers are pseudonyms (MAC_1, IP_1, SERIAL_1, ...); the same"
    echo "  pseudonym always means the same real value, but the real values are"
    echo "  gone. The TuneIn account token is never captured at all. The one"
    echo "  thing pseudonyms can't catch is an unexpected secret in free-text"
    echo "  logs — so glance over dmesg-tail.txt / varlog-tail.txt before pasting."
fi
