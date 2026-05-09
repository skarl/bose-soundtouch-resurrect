# Security policy

## Reporting a vulnerability

If you find a security issue in this project (the resolver scripts, the
admin UI, or anything we ship for installation on the speaker), please
open a private security advisory on the project's GitHub repository
rather than a public issue.

## Threat model and what to expect

This project deliberately makes a Bose SoundTouch speaker more
"open":

- It enables SSH on the speaker (factory-disabled by default).
- It runs an HTTP server (`busybox httpd`) on the speaker bound to the
  LAN IP if the admin UI is installed.
- It writes static-file responses to `/mnt/nv/resolver/` that the
  speaker's firmware then trusts as if they came from the original
  cloud.

By design, anyone on the same LAN can therefore:

- Reach the speaker's local API on TCP 8090 (this is true with or
  without this project — Bose firmware exposes it unconditionally).
- Reach the resolver and the admin UI on TCP 8181 (only if you install
  the admin UI; the resolver alone listens on `127.0.0.1` and is not
  reachable from the LAN).
- Modify the resolver's responses (and therefore which stream URL plays
  for a given preset) via the admin UI's CGI endpoints.

This is acceptable for a trusted home LAN. **Do not expose port 8090 or
8181 to the public internet.**

## What we cannot patch

- Vulnerabilities in the speaker's firmware itself. The firmware is
  frozen; Bose stopped issuing updates with the 2026-05-06 cloud
  shutdown. If a defect surfaces in the speaker's TLS stack, kernel,
  or application code, this project has no way to ship a fix.
- Any new vulnerability that the on-speaker resolver doesn't introduce
  but that's exposed by enabling SSH on the speaker.

If you discover a critical issue in the speaker firmware itself,
treat it as a third-party disclosure and follow Bose's security
contact channels.
