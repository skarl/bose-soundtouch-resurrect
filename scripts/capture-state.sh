#!/bin/sh
#
# Capture on-speaker diagnostic state to a local timestamped folder.
#
# Run this first when a contributor reports their speaker doesn't work
# after deploy. The bundle this produces is enough to diff a broken
# install against a known-working one: firmware Variant, the Shepherd
# override directory listing, stock Shepherd config listing, shepherdd
# pids, NV-flash root, mount info, dmesg tail, /var/log/messages tail,
# and an mtime snapshot of every Shepherd-*.xml under both load paths
# (surfaces manual edits vs stock firmware).
#
# Each capture is one file in the output folder so individual entries
# are easy to grep, diff, or paste. Captures that fail or aren't
# present on this firmware do not abort the run — they emit a
# [FAIL]/[SKIP] line and the script continues.
#
# Usage:
#   ./scripts/capture-state.sh <speaker-ip>

set -u

SPEAKER="${1:?usage: $0 <speaker-ip>}"

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

echo "Capturing state from $SPEAKER -> $OUT/"
echo

# /info — model, Variant, firmware, MAC, region. The single most
# important file: every compat report turns on Variant.
capture "info.xml"                   "curl -s --max-time 5 http://localhost:8090/info"

# Shepherd override directory — does it exist, what's in it, are the
# entries symlinks or regular files. This is the file that surfaced
# the 0.8 install bug (ADR-0004).
capture "shepherd-override-dir.txt"  "ls -la /mnt/nv/shepherd/ 2>/dev/null"

# Stock Shepherd configs — the read-only baseline shepherdd would load
# in the absence of the override directory. Compared against the
# override listing this tells you whether every stock config is being
# kept in supervision.
capture "shepherd-stock-configs.txt" "ls -la /opt/Bose/etc/Shepherd-*.xml 2>/dev/null"

# shepherdd's runtime view: what it's actually supervising right now.
capture "shepherd-pids.txt"          "cat /mnt/nv/shepherd/pids 2>/dev/null"

# NV-flash root — surfaces anything else we've left lying around
# (OverrideSdkPrivateCfg.xml, resolver/, remote_services marker, etc.)
capture "mnt-nv.txt"                 "ls -la /mnt/nv/ 2>/dev/null"

# Mount info — writability of /opt/Bose (squashfs, ro) and /mnt/nv (rw).
# Confirms the override-directory mechanism is the only viable write
# surface for shepherd configs.
capture "mounts.txt"                 "mount"

# Does this firmware have recovery="ignore" on SoftwareUpdate in any
# stock Shepherd config? Relevant for the "speaker tries to phone home
# about updates" failure mode.
capture "softwareupdate-recovery.txt" "grep -B1 -A2 SoftwareUpdate /opt/Bose/etc/Shepherd-*.xml 2>/dev/null"

# Mtimes on every Shepherd-*.xml under both load paths. Stock configs
# have firmware-build mtimes (years ago); manually-edited ones are
# recent. This is how the 0.8 symlink-bug investigation found that
# Bo's override directory was hand-curated.
capture "mtimes.txt"                 "find /opt/Bose/etc /mnt/nv/shepherd -name 'Shepherd-*.xml' -printf '%T@ %p\n' 2>/dev/null"

# Kernel ring — boot-stage anomalies (failed mounts, OOM, hardware errors).
capture "dmesg-tail.txt"             "dmesg 2>/dev/null | tail -200"

# Userspace log — shepherdd / BoseApp errors. Not all firmwares
# populate this file; SKIP is the expected outcome on the ones that
# log to a ring buffer instead.
capture "varlog-tail.txt"            "tail -200 /var/log/messages 2>/dev/null"

echo
echo "Saved to $OUT/"
echo
echo "Before pasting any of these files into a public issue or PR:"
echo "  - redact LAN IPs (e.g. 192.168.x.y, 10.x.y.z, fritz.box hostnames)"
echo "  - redact MAC addresses (deviceID, networkInfo blocks in info.xml)"
echo "  - redact any other identifying network names"
echo "See project memory: no private info in GitHub issues."
