#!/bin/sh
#
# Remove the on-speaker resolver and roll the speaker back to its
# stock configuration.
#
# After this runs:
#   - The speaker tries to reach the (offline) Bose cloud at boot.
#   - Preset buttons effectively don't work for TuneIn anymore.
#   - AUX, Bluetooth, Spotify Connect still work (they don't depend on
#     the cloud).
#   - SSH stays enabled. To also disable SSH, see
#     docs/opening-up-your-speaker.md § "Reverting".
#
# Usage:
#   ./scripts/uninstall.sh <speaker-ip>

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip>}"

SSH="ssh -oHostKeyAlgorithms=+ssh-rsa -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -oConnectTimeout=10 -oBatchMode=yes"

echo "This will remove:"
echo "  /mnt/nv/resolver/                              (resolver tree,"
echo "                                                  including httpd.conf"
echo "                                                  and cgi-bin/lib/)"
echo "  /mnt/nv/shepherd/                              (entire override dir:"
echo "                                                  every Shepherd-*.xml"
echo "                                                  symlink and our own"
echo "                                                  Shepherd-resolver.xml)"
echo "  /mnt/nv/OverrideSdkPrivateCfg.xml              (URL override)"
echo "and reboot the speaker."
echo
printf 'Continue? [y/N] '
read -r ans
case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
esac

# Reverse what deploy.sh writes. The override directory must be
# removed entirely, not just its contents: shepherdd reads from
# /mnt/nv/shepherd/ exclusively when it exists, so an empty directory
# hangs the speaker at boot (no Shepherd-*.xml found → no Stock daemons
# supervised → BoseApp / WebServer never start, LED stuck flickering).
# Stock speakers don't have this dir; the only reason for it to exist
# is our deploy populated it. See ADR-0004.
$SSH root@"$SPEAKER" '
    rm -rf /mnt/nv/resolver
    rm -rf /mnt/nv/shepherd
    rm -f  /mnt/nv/OverrideSdkPrivateCfg.xml
    sync
    reboot
'

echo "Speaker rebooting. The resolver is now uninstalled."
