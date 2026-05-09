#!/bin/sh
#
# Convenience wrapper for SSH'ing into the speaker with the right flags.
# The speaker uses an old RSA host key that modern OpenSSH refuses
# without the explicit algorithm allow.
#
# Usage:
#   ./scripts/ssh-speaker.sh <speaker-ip>
#       (interactive shell)
#
#   ./scripts/ssh-speaker.sh <speaker-ip> 'command'
#       (one-shot command)

set -eu

SPEAKER="${1:?usage: $0 <speaker-ip> [command]}"
shift

exec ssh \
    -oHostKeyAlgorithms=+ssh-rsa \
    -oUserKnownHostsFile=/dev/null \
    -oStrictHostKeyChecking=no \
    -oConnectTimeout=10 \
    root@"$SPEAKER" "$@"
