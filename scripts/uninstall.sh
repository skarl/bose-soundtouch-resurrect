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
echo "  /mnt/nv/resolver/                          (resolver tree)"
echo "  /mnt/nv/shepherd/Shepherd-resolver.xml     (auto-start config)"
echo "  /mnt/nv/OverrideSdkPrivateCfg.xml          (URL override)"
echo "and reboot the speaker."
echo
printf 'Continue? [y/N] '
read -r ans
case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
esac

$SSH root@"$SPEAKER" '
    rm -rf /mnt/nv/resolver
    rm -f  /mnt/nv/shepherd/Shepherd-resolver.xml
    rm -f  /mnt/nv/OverrideSdkPrivateCfg.xml
    sync
    reboot
'

echo "Speaker rebooting. The resolver is now uninstalled."
