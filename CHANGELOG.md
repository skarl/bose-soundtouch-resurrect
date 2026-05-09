# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release.
- On-speaker static-file resolver (`resolver/`), including:
  - `build.py` — fetch fresh stream URLs from TuneIn's public API and
    emit Bose-shaped JSON.
  - Static templates for the registry and source-provider responses.
  - `shepherd-resolver.xml` — daemon config so busybox `httpd` auto-starts
    at boot.
- Documentation (`docs/`) covering compatibility, opening up the speaker,
  installation, preset customisation, troubleshooting, architecture, and
  the speaker's local API.
- Helper scripts (`scripts/`) for USB-stick prep, deployment, and
  post-install verification.
- Design plan for a browser-based admin UI (`admin/PLAN.md`).
