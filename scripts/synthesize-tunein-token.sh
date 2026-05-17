#!/bin/sh
#
# synthesize-tunein-token — idempotently ensure a TUNEIN <source> block
# exists in a SoundTouch Speaker's BoseApp Sources.xml.
#
# Background:
#   Bose's cloud was the only thing that ever issued the anonymous-account
#   TuneIn token persisted at /mnt/nv/BoseApp-Persistence/1/Sources.xml.
#   Without that token block, BoseApp refuses to register TUNEIN as a known
#   source and /select source="TUNEIN" returns HTTP 500 UNKNOWN_SOURCE_ERROR.
#   Since the 2026-05-06 shutdown a factory reset wipes the token and
#   nothing re-issues it; we synthesise one. BoseApp does not validate it
#   against anything external. See issue #157 / context #156.
#
# Usage:
#   synthesize-tunein-token.sh <sources-xml-path> <block-file>
#
# Behaviour:
#   - If <sources-xml-path> already contains a `<sourceKey type="TUNEIN"`
#     line, exits 0 with no changes. mtime is preserved.
#   - If the file exists but lacks the TUNEIN block, splices the contents
#     of <block-file> in immediately before the closing </sources> tag,
#     atomically (tmp file + mv). All other <source> blocks survive
#     byte-for-byte.
#   - If the file does not exist, writes a minimal valid Sources.xml
#     containing the XML declaration, <sources> wrapper, and the block.
#     Parent directories are created.
#
# Speaker-side constraints (also tested on the laptop, so the constraints
# bind here too): busybox sh — no bashisms, no GNU sed -i, no awk -v, no
# python3. Only sh / sed / grep / cat / mv / mkdir / printf / dirname.

set -eu

SRC="${1:?usage: $0 <sources-xml-path> <block-file>}"
BLOCK_FILE="${2:?usage: $0 <sources-xml-path> <block-file>}"

[ -f "$BLOCK_FILE" ] || { printf 'error: block file missing: %s\n' "$BLOCK_FILE" >&2; exit 1; }

# Case 1: file already has a TUNEIN block — leave it strictly alone.
# Detection mirrors the issue spec exactly so the no-op branch is
# byte-for-byte conservative.
if [ -f "$SRC" ] && grep -q '<sourceKey type="TUNEIN"' "$SRC"; then
    exit 0
fi

# Case 2: file is absent — write a minimal Sources.xml containing just
# the TUNEIN block. Parent dirs are created on demand because the
# Speaker may have a fresh /mnt/nv with no BoseApp-Persistence tree yet.
if [ ! -f "$SRC" ]; then
    mkdir -p "$(dirname "$SRC")"
    TMP="$SRC.new"
    {
        printf '<?xml version="1.0" encoding="UTF-8" ?>\n'
        printf '<sources>\n'
        cat "$BLOCK_FILE"
        printf '</sources>\n'
    } > "$TMP"
    mv "$TMP" "$SRC"
    exit 0
fi

# Case 3: file exists but lacks TUNEIN — splice the block in immediately
# before the closing </sources> tag, leaving every other <source> block
# byte-for-byte intact. Read-loop idiom is busybox-safe and obviously
# correct on inspection; busybox sed insert semantics for multi-line
# blocks are easy to get subtly wrong.
TMP="$SRC.new"
: > "$TMP"
spliced=0
while IFS= read -r line; do
    case "$line" in
        *"</sources>"*)
            if [ "$spliced" -eq 0 ]; then
                cat "$BLOCK_FILE" >> "$TMP"
                spliced=1
            fi
            ;;
    esac
    printf '%s\n' "$line" >> "$TMP"
done < "$SRC"

# Defensive: if the input had no </sources> tag at all, append the block
# plus a closing tag so we produce something BoseApp can parse rather
# than silently corrupting the file. (Real Sources.xml always has the
# closing tag; this guards the pathological case.)
if [ "$spliced" -eq 0 ]; then
    cat "$BLOCK_FILE" >> "$TMP"
    printf '</sources>\n' >> "$TMP"
fi

mv "$TMP" "$SRC"
