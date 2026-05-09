#!/bin/sh
#
# Partial uninstall: removes the admin SPA tree but leaves the
# resolver intact. After this runs, `scripts/verify.sh <speaker>`
# should still pass (resolver paths untouched), and the speaker
# keeps using its on-box `/mnt/nv/resolver/` for TuneIn presets.
#
# Use this when you want to drop just the admin without rolling the
# speaker back to stock. For full project removal (including the
# resolver), use scripts/uninstall.sh instead.
#
# Usage:
#   ./admin/uninstall.sh <speaker-ip>

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip>}"

SSH="ssh -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10 -oBatchMode=yes"

say()  { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "Pre-flight checks"

# SSH reachability — same probe as admin/deploy.sh.
$SSH root@"$SPEAKER" 'true' \
  || fail "cannot SSH to root@$SPEAKER. Did you enable SSH?
       See docs/opening-up-your-speaker.md."

say "Removing admin tree from /mnt/nv/resolver/"
# rm -f / rm -rf — silent when paths don't exist, so re-runs are safe.
# We deliberately do NOT touch resolver files (bmx/, marge/,
# stations.json, etc). scripts/verify.sh asserts the resolver still
# serves after this.
$SSH root@"$SPEAKER" '
    rm -f  /mnt/nv/resolver/index.html
    rm -f  /mnt/nv/resolver/style.css
    rm -f  /mnt/nv/resolver/ws-test.html
    rm -rf /mnt/nv/resolver/app
    rm -rf /mnt/nv/resolver/cgi-bin/api/v1
    sync
'

say "Done"
echo "Admin removed. Resolver still serving on $SPEAKER:8181."
echo "Run scripts/verify.sh $SPEAKER to confirm the resolver is healthy."
