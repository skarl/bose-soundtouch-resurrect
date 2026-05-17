#!/bin/sh
#
# test_synthesize_tunein_token — unit tests for
# scripts/synthesize-tunein-token.sh.
#
# Exercises the four fixture cases the issue spec calls out:
#   1. Sources.xml has AMAZON + SPOTIFY blocks but no TUNEIN → splice;
#      pre-existing blocks must survive byte-for-byte.
#   2. Sources.xml is the minimal stub (declaration + empty <sources>) →
#      splice; the result must contain the new TUNEIN block.
#   3. Sources.xml does not exist at all → write a fresh minimal file
#      with just the TUNEIN block.
#   4. Sources.xml already has a TUNEIN row → no-op, byte-identical
#      output and unchanged mtime.
#
# Run with: sh scripts/test/test_synthesize_tunein_token.sh
# Exits non-zero on any failure.

set -u

THIS_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$THIS_DIR/../.." && pwd)
SCRIPT="$REPO/scripts/synthesize-tunein-token.sh"
FIXTURES="$THIS_DIR/fixtures"

[ -x "$SCRIPT" ] || chmod +x "$SCRIPT"

WORK=$(mktemp -d 2>/dev/null || echo "/tmp/test_synth_tunein.$$")
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT INT TERM

ok=0
fail=0

note_ok()   { printf '  [ OK ] %s\n' "$1"; ok=$((ok + 1)); }
note_fail() { printf '  [FAIL] %s\n' "$1"; fail=$((fail + 1)); }

# A representative TUNEIN block, identical in shape to what deploy.sh
# builds at runtime. The UUID is a frozen test value — anything that
# parses as a serial is fine for BoseApp; we just need to assert the
# script splices what we hand it.
BLOCK="$WORK/tunein-block.xml"
cat > "$BLOCK" <<'EOF'
    <source secret="eyJzZXJpYWwiOiAiZGVhZGJlZWYtYmVlZi1iZWVmLWJlZWYtZGVhZGJlZWZkZWFkIn0=" secretType="token">
        <sourceKey type="TUNEIN" account="" />
    </source>
EOF

# ---------------------------------------------------------------------
# Case 1: existing AMAZON / SPOTIFY survive; TUNEIN block is spliced in.
# ---------------------------------------------------------------------
printf '\n--- Case 1: existing user-account tokens + no TUNEIN ---\n'

CASE1="$WORK/case1-sources.xml"
cp "$FIXTURES/sources-with-user-tokens-no-tunein.xml" "$CASE1"

if sh "$SCRIPT" "$CASE1" "$BLOCK"; then
    note_ok "synthesis returns 0"
else
    note_fail "synthesis returned non-zero"
fi

if grep -q '<sourceKey type="TUNEIN"' "$CASE1"; then
    note_ok "TUNEIN block present after splice"
else
    note_fail "TUNEIN block missing after splice"
fi

if grep -q '<sourceKey type="AMAZON"' "$CASE1" \
   && grep -q '<sourceKey type="SPOTIFY"' "$CASE1" \
   && grep -q '<sourceKey type="AUX"' "$CASE1" \
   && grep -q '<sourceKey type="INTERNET_RADIO"' "$CASE1" \
   && grep -q '<sourceKey type="LOCAL_INTERNET_RADIO"' "$CASE1" \
   && grep -q '<sourceKey type="RADIOPLAYER"' "$CASE1"; then
    note_ok "all pre-existing sourceKey blocks survive"
else
    note_fail "a pre-existing sourceKey block was lost"
fi

# Stronger: every line of the original fixture must still be present in
# the same order. Compare via grep -F line-by-line; the splice only adds
# lines, never removes or reorders them.
case1_loss=0
while IFS= read -r line; do
    case "$line" in
        ''|'</sources>'*) continue ;;
    esac
    if ! grep -qF -- "$line" "$CASE1"; then
        printf '    missing original line: %s\n' "$line"
        case1_loss=1
    fi
done < "$FIXTURES/sources-with-user-tokens-no-tunein.xml"
if [ "$case1_loss" -eq 0 ]; then
    note_ok "every original line of the fixture is still present"
else
    note_fail "at least one original line was lost"
fi

# The TUNEIN block must land before the closing </sources> tag, not
# after — otherwise BoseApp won't parse it as a child of <sources>.
if grep -n '<sourceKey type="TUNEIN"\|</sources>' "$CASE1" \
   | sort -n \
   | head -1 \
   | grep -q TUNEIN; then
    note_ok "TUNEIN block is spliced before </sources>"
else
    note_fail "TUNEIN block landed after </sources>"
fi

# ---------------------------------------------------------------------
# Case 2: minimal stub (declaration + empty <sources>) → splice.
# ---------------------------------------------------------------------
printf '\n--- Case 2: minimal stub Sources.xml ---\n'

CASE2="$WORK/case2-sources.xml"
cp "$FIXTURES/sources-minimal-stub.xml" "$CASE2"

if sh "$SCRIPT" "$CASE2" "$BLOCK"; then
    note_ok "synthesis returns 0"
else
    note_fail "synthesis returned non-zero"
fi

if grep -q '<sourceKey type="TUNEIN"' "$CASE2"; then
    note_ok "TUNEIN block present in stub after splice"
else
    note_fail "TUNEIN block missing in stub after splice"
fi

if grep -q '^<?xml ' "$CASE2" && grep -q '^<sources>' "$CASE2" && grep -q '^</sources>' "$CASE2"; then
    note_ok "XML declaration + <sources> wrapper preserved"
else
    note_fail "XML declaration or <sources> wrapper missing"
fi

# ---------------------------------------------------------------------
# Case 3: file does not exist at all → fresh minimal file is created.
# ---------------------------------------------------------------------
printf '\n--- Case 3: Sources.xml does not exist ---\n'

CASE3_DIR="$WORK/case3-fresh-tree/BoseApp-Persistence/1"
CASE3="$CASE3_DIR/Sources.xml"
# Intentionally do NOT mkdir -p — the synthesis script is responsible
# for creating parent directories when the speaker has a fresh NV.

if sh "$SCRIPT" "$CASE3" "$BLOCK"; then
    note_ok "synthesis returns 0"
else
    note_fail "synthesis returned non-zero"
fi

if [ -f "$CASE3" ]; then
    note_ok "fresh Sources.xml was created"
else
    note_fail "Sources.xml was not created"
fi

if [ -f "$CASE3" ] && grep -q '<sourceKey type="TUNEIN"' "$CASE3"; then
    note_ok "fresh file contains the TUNEIN block"
else
    note_fail "fresh file does not contain the TUNEIN block"
fi

if [ -f "$CASE3" ] \
    && grep -q '<?xml ' "$CASE3" \
    && grep -q '<sources>' "$CASE3" \
    && grep -q '</sources>' "$CASE3"; then
    note_ok "fresh file is well-formed (declaration + wrapper)"
else
    note_fail "fresh file is malformed"
fi

# ---------------------------------------------------------------------
# Case 4: file already has TUNEIN → no-op, byte-identical, mtime stable.
# ---------------------------------------------------------------------
printf '\n--- Case 4: Sources.xml already has TUNEIN (idempotency) ---\n'

CASE4="$WORK/case4-sources.xml"
cp "$FIXTURES/sources-with-existing-tunein.xml" "$CASE4"

# Capture pre-state: byte content + mtime. Backdate the mtime so we
# can prove the script doesn't touch it even if our timer's resolution
# is coarse. `touch -t` is POSIX.
touch -t 202001011200.00 "$CASE4"
BEFORE_SHA=$(shasum "$CASE4" 2>/dev/null | awk '{print $1}')
BEFORE_MTIME=$(ls -la "$CASE4" | awk '{print $6, $7, $8}')

if sh "$SCRIPT" "$CASE4" "$BLOCK"; then
    note_ok "synthesis returns 0"
else
    note_fail "synthesis returned non-zero"
fi

AFTER_SHA=$(shasum "$CASE4" 2>/dev/null | awk '{print $1}')
AFTER_MTIME=$(ls -la "$CASE4" | awk '{print $6, $7, $8}')

if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then
    note_ok "byte-identical content after idempotent re-run"
else
    note_fail "content changed (before=$BEFORE_SHA after=$AFTER_SHA)"
fi

if [ "$BEFORE_MTIME" = "$AFTER_MTIME" ]; then
    note_ok "mtime unchanged after idempotent re-run"
else
    note_fail "mtime changed (before=$BEFORE_MTIME after=$AFTER_MTIME)"
fi

# Sanity check: there's still only ONE TUNEIN block — we didn't append
# a duplicate even though the splice path was a no-op.
n_tunein=$(grep -c '<sourceKey type="TUNEIN"' "$CASE4" || true)
if [ "$n_tunein" = "1" ]; then
    note_ok "exactly one TUNEIN block after re-run"
else
    note_fail "expected 1 TUNEIN block, found $n_tunein"
fi

# ---------------------------------------------------------------------
printf '\n--- Summary: %d ok, %d failed ---\n' "$ok" "$fail"
[ "$fail" -eq 0 ] || exit 1
