#!/bin/sh
#
# Prepare a USB stick to enable SSH on a Bose SoundTouch speaker.
#
# Pass the path to the mounted USB stick. The stick MUST be formatted
# FAT32 already (this script doesn't reformat — that's destructive and
# you should do it deliberately).
#
# Usage:
#   ./scripts/enable-ssh-stick.sh /Volumes/USBSTICK     # macOS
#   ./scripts/enable-ssh-stick.sh /media/$USER/USBSTICK # Linux
#
# Then power off the speaker, insert the stick (you need a micro-USB
# OTG adapter — see docs/opening-up-your-speaker.md), power back on,
# wait for full boot, pull the stick.
#
# After SSH is up, ssh in and `touch /mnt/nv/remote_services` to
# persist it across future reboots.
#
# Windows users: see docs/opening-up-your-speaker.md for the PowerShell
# version; this shell script doesn't run there.

set -eu

if [ $# -ne 1 ]; then
    echo "usage: $0 <path-to-mounted-stick>" >&2
    echo "  e.g.  $0 /Volumes/USBSTICK   (macOS)" >&2
    echo "        $0 /media/\$USER/USBSTICK   (Linux)" >&2
    exit 1
fi

STICK="$1"

if [ ! -d "$STICK" ]; then
    echo "error: $STICK is not a mounted directory" >&2
    exit 1
fi

# Verify it looks like FAT32 (best-effort; varies by OS)
case "$(uname -s)" in
    Darwin)
        FS=$(diskutil info "$STICK" 2>/dev/null | awk -F: '/File System Personality/{gsub(/^ */,"",$2); print $2}')
        case "$FS" in
            "MS-DOS FAT32"|"MS-DOS"|"FAT32"|"") ;;  # accept (empty if can't detect)
            *) echo "error: $STICK appears to be $FS, not FAT32. Reformat first." >&2; exit 1 ;;
        esac
        ;;
    Linux)
        FS=$(stat -f -c '%T' "$STICK" 2>/dev/null || true)
        case "$FS" in
            msdos|vfat|fat|"") ;;
            *) echo "warning: $STICK is filesystem '$FS' — speaker requires FAT32. Continuing anyway." >&2 ;;
        esac
        ;;
esac

echo "Creating remote_services marker on $STICK..."
touch "$STICK/remote_services"

echo "Stripping macOS hidden files (if any) so the speaker firmware doesn't choke on them..."
rm -rf "$STICK/.fseventsd" "$STICK/.Spotlight-V100" 2>/dev/null || true
rm -f "$STICK"/._* 2>/dev/null || true
# macOS-only: tell Spotlight to leave the stick alone going forward
if [ "$(uname -s)" = "Darwin" ]; then
    mdutil -i off "$STICK" 2>/dev/null || true
fi

sync

echo
echo "Stick is ready. Listing root contents:"
ls -la "$STICK"
echo
echo "Next steps:"
echo "  1. Power OFF the speaker (unplug)."
echo "  2. Insert the stick via your micro-USB OTG adapter."
echo "  3. Power ON. Wait for full boot (front LED stops blinking)."
echo "  4. Pull the stick. Try SSH:"
echo "     ssh -oHostKeyAlgorithms=+ssh-rsa root@<speaker-ip>"
echo "  5. Once in, persist SSH across reboots:"
echo "     touch /mnt/nv/remote_services"
