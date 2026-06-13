#!/bin/sh
#
# test_select_shepherd_configs — unit tests for
# scripts/select-shepherd-configs.sh.
#
# The selector reproduces the firmware's own Shepherd-config selection
# (/etc/init.d/SoundTouch) when we take over the override directory. The
# regression this guards is issue #160: on a multi-product firmware image
# the old deploy.sh linked every Shepherd-*.xml and the speaker boot-looped.
# These cases drive the selector against the two real inventories we have
# captures for:
#
#   1. ST 10 (rhino): /opt/Bose/etc ships {core,hsp,noncore,product,rhino}
#      -> all five linked. (Identical to the maintainer's working override
#      dir; proves zero regression on the only model we can test live.)
#   2. ST 20 (spotty): /opt/Bose/etc ships 10 configs for 7 products
#      -> ONLY {noncore,spotty} linked; the eight foreign-product configs
#      must NOT be linked. This is the #160 fix.
#   3. Stale-link sweep: an override dir left over from an over-linking
#      deploy must be cleaned to the stock subset, while our own
#      Shepherd-resolver.xml (a regular file) survives untouched.
#   4. Brick guard: an unrecognised variant must abort non-zero WITHOUT
#      creating the override dir.
#   5. Variant derivation from $VARIANT_FILE — including the
#      no-trailing-newline edge that a `read || =unknown` idiom would
#      mis-handle, and the empty-file guard.
#   6. Idempotency: a second run yields a byte-identical link set.
#
# Run with: sh scripts/test/test_select_shepherd_configs.sh
# Exits non-zero on any failure.

set -u

THIS_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$THIS_DIR/../.." && pwd)
SCRIPT="$REPO/scripts/select-shepherd-configs.sh"

[ -x "$SCRIPT" ] || chmod +x "$SCRIPT"

WORK=$(mktemp -d 2>/dev/null || echo "/tmp/test_select_shepherd.$$")
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT INT TERM

ok=0
fail=0
note_ok()   { printf '  [ OK ] %s\n' "$1"; ok=$((ok + 1)); }
note_fail() { printf '  [FAIL] %s\n' "$1"; fail=$((fail + 1)); }

# Build a fake /opt/Bose/etc containing the given Shepherd-<name>.xml
# stubs. $1 = dir, $2.. = variant names.
make_etc() {
    d=$1; shift
    mkdir -p "$d"
    for name in "$@"; do
        printf '<ShepherdConfig><!-- %s --></ShepherdConfig>\n' "$name" \
            > "$d/Shepherd-$name.xml"
    done
}

# Print the sorted basenames of the Shepherd-*.xml links in an override dir.
linked_set() {
    ( cd "$1" 2>/dev/null && for f in Shepherd-*.xml; do
        [ -e "$f" ] && printf '%s\n' "$f"
      done | sort )
}

# ---------------------------------------------------------------------
# Case 1: ST 10 (rhino) — single-product image, all five configs linked.
# ---------------------------------------------------------------------
printf '\n--- Case 1: ST 10 / rhino inventory ---\n'

ETC1="$WORK/etc-st10"
OV1="$WORK/ov-st10"
make_etc "$ETC1" core hsp noncore product rhino

if sh "$SCRIPT" "$ETC1" "$OV1" rhino >/dev/null; then
    note_ok "selector returns 0"
else
    note_fail "selector returned non-zero"
fi

EXPECT1="Shepherd-core.xml
Shepherd-hsp.xml
Shepherd-noncore.xml
Shepherd-product.xml
Shepherd-rhino.xml"
GOT1=$(linked_set "$OV1")
if [ "$GOT1" = "$EXPECT1" ]; then
    note_ok "links exactly {core,hsp,noncore,product,rhino}"
else
    note_fail "wrong link set; got:
$GOT1"
fi

# Every link must be a symlink pointing back into the stock etc dir.
all_symlinks=1
for f in "$OV1"/Shepherd-*.xml; do
    [ -L "$f" ] || all_symlinks=0
done
if [ "$all_symlinks" -eq 1 ]; then
    note_ok "every entry is a symlink into the stock dir"
else
    note_fail "an entry is not a symlink"
fi

# ---------------------------------------------------------------------
# Case 2: ST 20 (spotty) — multi-product image, ONLY noncore+spotty. #160.
# ---------------------------------------------------------------------
printf '\n--- Case 2: ST 20 / spotty inventory (the #160 fix) ---\n'

ETC2="$WORK/etc-st20"
OV2="$WORK/ov-st20"
make_etc "$ETC2" bardeen bardeen_linus binky burns ginger mojo \
                 noncore noncore_linus rhino spotty

if sh "$SCRIPT" "$ETC2" "$OV2" spotty >/dev/null; then
    note_ok "selector returns 0"
else
    note_fail "selector returned non-zero"
fi

EXPECT2="Shepherd-noncore.xml
Shepherd-spotty.xml"
GOT2=$(linked_set "$OV2")
if [ "$GOT2" = "$EXPECT2" ]; then
    note_ok "links exactly {noncore,spotty} — no foreign products"
else
    note_fail "wrong link set; got:
$GOT2"
fi

# Explicit negative assertions: the eight foreign-product configs that
# caused the boot loop must be absent.
foreign_present=0
for name in bardeen bardeen_linus binky burns ginger mojo rhino noncore_linus; do
    if [ -e "$OV2/Shepherd-$name.xml" ]; then
        printf '    leaked foreign config: Shepherd-%s.xml\n' "$name"
        foreign_present=1
    fi
done
if [ "$foreign_present" -eq 0 ]; then
    note_ok "none of the 8 foreign-product configs are linked"
else
    note_fail "a foreign-product config was linked (boot-loop risk)"
fi

# ---------------------------------------------------------------------
# Case 3: stale-link sweep — clean an over-linked dir, keep the resolver.
# ---------------------------------------------------------------------
printf '\n--- Case 3: stale over-linked override dir is cleaned ---\n'

OV3="$WORK/ov-stale"
mkdir -p "$OV3"
# Simulate a prior over-linking deploy: all 10 stock configs symlinked in.
for name in bardeen bardeen_linus binky burns ginger mojo \
            noncore noncore_linus rhino spotty; do
    ln -sf "$ETC2/Shepherd-$name.xml" "$OV3/Shepherd-$name.xml"
done
# ...plus our own resolver config, which is a REGULAR FILE, not a symlink.
printf '<ShepherdConfig><!-- resolver --></ShepherdConfig>\n' \
    > "$OV3/Shepherd-resolver.xml"

if sh "$SCRIPT" "$ETC2" "$OV3" spotty >/dev/null; then
    note_ok "selector returns 0 over a populated dir"
else
    note_fail "selector returned non-zero over a populated dir"
fi

GOT3=$(linked_set "$OV3")
EXPECT3="Shepherd-noncore.xml
Shepherd-resolver.xml
Shepherd-spotty.xml"
if [ "$GOT3" = "$EXPECT3" ]; then
    note_ok "stale foreign links swept; only {noncore,spotty,resolver} remain"
else
    note_fail "unexpected contents after sweep; got:
$GOT3"
fi

if [ -f "$OV3/Shepherd-resolver.xml" ] && [ ! -L "$OV3/Shepherd-resolver.xml" ]; then
    note_ok "our Shepherd-resolver.xml regular file survived untouched"
else
    note_fail "Shepherd-resolver.xml was removed or replaced"
fi

# ---------------------------------------------------------------------
# Case 4: brick guard — unknown variant aborts, dir is NOT created.
# ---------------------------------------------------------------------
printf '\n--- Case 4: unrecognised variant is refused (brick guard) ---\n'

OV4="$WORK/ov-should-not-exist"
if sh "$SCRIPT" "$ETC2" "$OV4" no_such_variant >/dev/null 2>&1; then
    note_fail "selector returned 0 for an unknown variant"
else
    note_ok "selector aborts non-zero for an unknown variant"
fi

if [ -d "$OV4" ]; then
    note_fail "override dir was created despite the guard (brick risk)"
else
    note_ok "override dir was NOT created (no brick-class empty dir left)"
fi

# ---------------------------------------------------------------------
# Case 5: variant derivation from $VARIANT_FILE (no explicit variant arg).
# Covers the no-trailing-newline edge that a `read || =unknown` idiom
# mis-handles, plus the empty-file guard.
# ---------------------------------------------------------------------
printf '\n--- Case 5: variant derived from $VARIANT_FILE ---\n'

ETC5="$WORK/etc-derive"
make_etc "$ETC5" core noncore product rhino hsp

# 5a: a newline-terminated variant file derives the variant.
OV5a="$WORK/ov-derive-nl"
VF_NL="$WORK/variant-nl"
printf 'rhino\n' > "$VF_NL"
if VARIANT_FILE="$VF_NL" sh "$SCRIPT" "$ETC5" "$OV5a" >/dev/null 2>&1 \
   && [ -e "$OV5a/Shepherd-rhino.xml" ]; then
    note_ok "derives variant from a newline-terminated file"
else
    note_fail "failed to derive variant from a newline-terminated file"
fi

# 5b: a variant file with NO trailing newline must STILL derive the
# variant, not abort. This is the read-clobber regression: the old
# `read ... || VARIANT=unknown` idiom would have turned this into a bogus
# "product not recognised" abort.
OV5b="$WORK/ov-derive-nonl"
VF_NONL="$WORK/variant-nonl"
printf 'rhino' > "$VF_NONL"     # deliberately no trailing newline
if VARIANT_FILE="$VF_NONL" sh "$SCRIPT" "$ETC5" "$OV5b" >/dev/null 2>&1 \
   && [ -e "$OV5b/Shepherd-rhino.xml" ]; then
    note_ok "derives variant from a file with NO trailing newline"
else
    note_fail "aborted on a newline-less variant file (read-clobber regression)"
fi

# 5c: an empty variant file is unrecognised -> brick guard aborts, no dir.
OV5c="$WORK/ov-derive-empty"
VF_EMPTY="$WORK/variant-empty"
: > "$VF_EMPTY"
if VARIANT_FILE="$VF_EMPTY" sh "$SCRIPT" "$ETC5" "$OV5c" >/dev/null 2>&1; then
    note_fail "selector returned 0 for an empty variant file"
elif [ -d "$OV5c" ]; then
    note_fail "override dir created despite an empty variant file"
else
    note_ok "empty variant file -> guard aborts, nothing created"
fi

# ---------------------------------------------------------------------
# Case 6: idempotency — a second run is byte-for-byte the same link set.
# ---------------------------------------------------------------------
printf '\n--- Case 6: idempotency ---\n'

FIRST=$(linked_set "$OV2")
sh "$SCRIPT" "$ETC2" "$OV2" spotty >/dev/null 2>&1
SECOND=$(linked_set "$OV2")
if [ "$FIRST" = "$SECOND" ]; then
    note_ok "second run yields an identical link set"
else
    note_fail "link set changed on re-run"
fi

# ---------------------------------------------------------------------
printf '\n--- Summary: %d ok, %d failed ---\n' "$ok" "$fail"
[ "$fail" -eq 0 ] || exit 1
