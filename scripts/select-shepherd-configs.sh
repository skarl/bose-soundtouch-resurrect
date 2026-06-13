#!/bin/sh
#
# select-shepherd-configs — populate the Shepherd override directory with
# EXACTLY the stock config set the firmware would load for this product,
# and nothing else.
#
# Background:
#   When /mnt/nv/shepherd/ exists, the firmware's init script
#   (/etc/init.d/SoundTouch) stops assembling /var/run/shepherd and uses
#   our directory verbatim — replacement, not merge. So we must reproduce
#   the stock config *selection* ourselves. The init script selects a
#   variant-specific subset, not every Shepherd-*.xml:
#
#       read variant </proc/variant
#       for i in core noncore product $variant hsp; do
#           cfg=/opt/Bose/etc/Shepherd-$i.xml
#           [ -e "$cfg" ] && ln -s "$cfg" "$rundir"
#       done
#       # + a Bardeen-Linus bonded substitution gated on a persistence marker
#
#   On a single-product firmware image (ST 10 / rhino ships only
#   {core,hsp,noncore,product,rhino}) linking every Shepherd-*.xml happens
#   to equal that subset. On a multi-product image (ST 20 / spotty ships 10
#   configs for 7 products) linking them all makes shepherdd supervise
#   conflicting per-product daemons (each declaring recovery="reboot"
#   BoseApp/APServer/WebServer/NetManager) and the speaker boot-loops.
#   That is issue #160. See docs/adr/0004-shepherd-override-replaces-not-merges.md.
#
#   The firmware additionally has a Bardeen-Linus *bonded* substitution
#   (swap the bardeen configs for their _linus variants when a persistence
#   marker exists). We deliberately do NOT reproduce it: this project
#   supports no bardeen-family product, has no such device to validate
#   against, and the marker is not variant-gated — reproducing it on a
#   non-bardeen speaker that happened to carry the marker would link a
#   foreign-product config into the override dir, i.e. re-create the very
#   #160 boot-loop class. If a bardeen-family report ever lands, add it
#   then, gated on the variant and validated against that device's capture.
#
# Usage:
#   select-shepherd-configs.sh <etc-dir> <override-dir> [variant]
#
#   <etc-dir>       stock config dir, normally /opt/Bose/etc
#   <override-dir>  override dir to populate, normally /mnt/nv/shepherd
#   [variant]       product variant; if omitted, derived exactly as the
#                   init script does (/opt/Bose/bin -> eddie, else read from
#                   $VARIANT_FILE, default /proc/variant). The explicit arg
#                   and the $VARIANT_FILE override let the unit tests drive
#                   this against fixtures off-speaker.
#
# Brick safety:
#   - The per-variant stock config is the anchor of the selection. If it is
#     absent from <etc-dir> we do not recognise this product and refuse to
#     populate the override dir at all (exit 1) — an override dir that is
#     present but missing brick-critical daemons is exactly what bricks a
#     speaker (no SSH recovery; ADR-0004). We abort BEFORE creating the dir.
#   - Existing Shepherd-resolver.xml (a regular file, not a symlink) is
#     preserved. Stale stock symlinks from an older over-linking deploy are
#     removed so the result is exactly the stock set + our resolver.
#
# Speaker-side constraints (also exercised on the laptop, so they bind
# here too): busybox sh — no bashisms, no GNU-only flags. Only
# sh / ln / rm / mkdir / printf / read / test and shell builtins.

set -eu

ETC="${1:?usage: $0 <etc-dir> <override-dir> [variant]}"
OVERRIDE="${2:?usage: $0 <etc-dir> <override-dir> [variant]}"
VARIANT="${3:-}"

# Where the variant is read from when not passed explicitly. Defaults to the
# firmware's /proc/variant; overridable so the unit tests can exercise the
# derivation (including the no-trailing-newline edge) off-speaker.
VARIANT_FILE="${VARIANT_FILE:-/proc/variant}"

# Derive the variant the way /etc/init.d/SoundTouch does, unless the caller
# passed one in (the tests do). We test emptiness rather than read's exit
# status: POSIX `read` returns non-zero at EOF even when it assigned a
# partial last line, so `read ... || VARIANT=unknown` would wrongly clobber a
# correctly-read variant on a file with no trailing newline. /proc/variant
# does end in a newline on the speakers we've seen, but we don't reproduce
# the firmware idiom's fragility.
if [ -z "$VARIANT" ]; then
    if [ -d /opt/Bose/bin ]; then
        VARIANT=eddie
    else
        VARIANT=unknown
        read -r VARIANT < "$VARIANT_FILE" 2>/dev/null || true
        [ -n "$VARIANT" ] || VARIANT=unknown
    fi
fi

# Brick guard, BEFORE we touch the override dir: the per-variant config
# anchors the whole selection. If it is missing we don't know what set is
# safe for this product — fail loud rather than assemble a guessed (and
# possibly brick-class) override dir.
if [ ! -e "$ETC/Shepherd-$VARIANT.xml" ]; then
    printf 'error: no stock config %s/Shepherd-%s.xml for variant "%s" — refusing to populate %s\n' \
        "$ETC" "$VARIANT" "$VARIANT" "$OVERRIDE" >&2
    printf '       (this product is not recognised; assembling an override dir here could brick it)\n' >&2
    exit 1
fi

mkdir -p "$OVERRIDE"

# Link the stock subset. `keep` accumulates the basenames we link so the
# stale-link sweep below knows what to preserve. Leading/trailing spaces
# make the `case` membership test unambiguous.
keep=" "
link_keep() {
    # $1 = target stock config, $2 = link basename to create in OVERRIDE
    ln -sf "$1" "$OVERRIDE/$2"
    keep="$keep$2 "
    printf 'linked %s -> %s\n' "$2" "$1"
}

for i in core noncore product "$VARIANT" hsp; do
    cfg="$ETC/Shepherd-$i.xml"
    if [ -e "$cfg" ]; then
        link_keep "$cfg" "Shepherd-$i.xml"
    fi
done

# NOTE: the firmware's Bardeen-Linus bonded substitution is deliberately
# NOT reproduced here — see the header. It is not variant-gated, so applying
# it on a non-bardeen speaker carrying the marker would link a foreign
# config (the #160 class). We support no bardeen-family product to validate
# it against.

# Sweep stale stock symlinks: anything matching Shepherd-*.xml that is a
# symlink and NOT in our keep-set is a leftover from an older over-linking
# deploy (e.g. a 0.8.3 ST-20 attempt that linked all 10 configs). Remove
# it so the override dir is exactly the stock subset + our resolver.
# Shepherd-resolver.xml is a regular file, so [ -L ] never matches it.
for f in "$OVERRIDE"/Shepherd-*.xml; do
    [ -e "$f" ] || continue          # unmatched glob stays literal -> skip
    [ -L "$f" ] || continue          # only ever remove symlinks, never files
    base=${f##*/}
    case "$keep" in
        *" $base "*) ;;              # kept this round -> leave it
        *) rm -f "$f"; printf 'removed stale link %s\n' "$base" ;;
    esac
done
