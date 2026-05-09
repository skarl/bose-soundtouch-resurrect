# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.1.0] - 2026-05-09

### Added
- Initial public release.
- On-speaker static-file resolver (`resolver/`), including:
  - `build.py` — fetch fresh stream URLs from TuneIn's public API and
    emit Bose-shaped JSON.
  - Static templates for the registry and source-provider responses.
  - `shepherd-resolver.xml` — daemon config so busybox `httpd` auto-starts
    at boot.
- Documentation (`docs/`) covering compatibility, opening up the speaker,
  installation, preset customisation, troubleshooting, architecture,
  the speaker's local API, and TuneIn's OPML API as used by `build.py`.
- Helper scripts (`scripts/`) for USB-stick prep, deployment,
  post-install verification, stream refresh, preset assignment,
  uninstall, and SSH wrapper.
- Design plan for a browser-based admin UI (`admin/PLAN.md`).
- CI: GitHub Actions workflow running shellcheck on `scripts/` and a
  Python compile + error-path check on `resolver/build.py`.

[v0.1.0]: https://github.com/skarl/bose-soundtouch-resurrect/releases/tag/v0.1.0
