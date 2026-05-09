#!/bin/sh
#
# Deploy the admin SPA on top of an already-installed resolver tree.
#
# Pre-requisites:
#   - SSH enabled on the speaker (see docs/opening-up-your-speaker.md).
#   - The resolver is already deployed (scripts/deploy.sh has been run
#     at least once for this speaker). The admin layers on top.
#
# Usage:
#   ./admin/deploy.sh <speaker-ip>
#
# What it does:
#   1. Sanity-checks SSH access and resolver presence on the speaker.
#   2. Substitutes ?v=$VERSION (from `git describe --tags --always`)
#      into a temp copy of admin/index.html.
#   3. Pushes index.html, style.css, app/, ws-test.html (if present)
#      to /mnt/nv/resolver/.
#   4. Pushes cgi-bin/api/v1/* (if present) and chmods +x.
#   5. Verifies http://<speaker>:8181/ returns 200 with the
#      <meta name="admin-version"> tag.
#
# Does NOT reboot. Does NOT touch resolver files. To remove the admin,
# use admin/uninstall.sh (lands in slice 7).

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip>}"

cd "$(dirname "$0")/.."
ROOT=$(pwd)
ADMIN="$ROOT/admin"

SSH="ssh -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10 -oBatchMode=yes"
SCP="scp -O -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10"

say()  { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "Pre-flight checks"

[ -f "$ADMIN/index.html" ] || fail "admin/index.html missing — repo is incomplete?"
[ -f "$ADMIN/style.css" ]  || fail "admin/style.css missing — repo is incomplete?"
[ -d "$ADMIN/app" ]        || fail "admin/app/ missing — repo is incomplete?"

# SSH reachability
$SSH root@"$SPEAKER" 'true' \
  || fail "cannot SSH to root@$SPEAKER. Did you enable SSH?
       See docs/opening-up-your-speaker.md."

# Resolver must already be installed. The admin layers on top of the
# resolver docroot; without it, busybox httpd isn't running on 8181.
$SSH root@"$SPEAKER" 'test -f /mnt/nv/resolver/bmx/registry/v1/services' \
  || fail "resolver not installed on $SPEAKER (no /mnt/nv/resolver/bmx/registry/v1/services).
       Run scripts/deploy.sh $SPEAKER first to install the resolver."

VERSION=$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo "unknown")
echo "Admin version: $VERSION"

say "Staging admin tree with cache-busting version"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM

# Substitute $VERSION into index.html. The template uses literal
# "$VERSION" so a single sed pass covers all three references
# (admin-version meta, style.css, main.js).
sed "s/\$VERSION/$VERSION/g" "$ADMIN/index.html" > "$STAGE/index.html"
cp "$ADMIN/style.css" "$STAGE/style.css"
cp -R "$ADMIN/app" "$STAGE/app"
[ -f "$ADMIN/ws-test.html" ] && cp "$ADMIN/ws-test.html" "$STAGE/ws-test.html"

say "Pushing admin shell to /mnt/nv/resolver/"
$SCP "$STAGE/index.html" root@"$SPEAKER":/mnt/nv/resolver/index.html
$SCP "$STAGE/style.css"  root@"$SPEAKER":/mnt/nv/resolver/style.css

# Recreate app/ on the speaker, then push every file under it. Doing it
# in two steps (mkdir + scp -r) keeps shellcheck happy and survives
# busybox's quirkier ssh.
$SSH root@"$SPEAKER" 'rm -rf /mnt/nv/resolver/app && mkdir -p /mnt/nv/resolver/app'
$SCP -r "$STAGE/app/." root@"$SPEAKER":/mnt/nv/resolver/app/

if [ -f "$STAGE/ws-test.html" ]; then
  $SCP "$STAGE/ws-test.html" root@"$SPEAKER":/mnt/nv/resolver/ws-test.html
fi

if [ -d "$ADMIN/cgi-bin/api/v1" ]; then
  say "Pushing CGI scripts"
  $SSH root@"$SPEAKER" 'mkdir -p /mnt/nv/resolver/cgi-bin/api/v1'
  $SCP -r "$ADMIN/cgi-bin/api/v1/." \
       root@"$SPEAKER":/mnt/nv/resolver/cgi-bin/api/v1/
  $SSH root@"$SPEAKER" 'chmod +x /mnt/nv/resolver/cgi-bin/api/v1/*'
fi

say "Verifying admin shell at http://$SPEAKER:8181/"
# Fetch from the laptop. busybox httpd is already serving the resolver
# tree — no service to restart.
BODY=$(curl -fsS "http://$SPEAKER:8181/" || true)
[ -n "$BODY" ] || fail "no response from http://$SPEAKER:8181/"

echo "$BODY" | grep -q 'name="admin-version"' \
  || fail "admin-version meta tag missing from served index.html"

echo "$BODY" | grep -q "content=\"$VERSION\"" \
  || fail "served version doesn't match deployed version ($VERSION)"

say "Done"
echo "Open http://$SPEAKER:8181/ in any LAN browser."
