# Compatibility

Which Bose SoundTouch speakers and firmware versions are known to work
with this project, on what evidence, and how to add a new report.

## The rubric

Coverage across the SoundTouch line is uneven, and pretending otherwise
has been a source of trouble. Every model row below carries one of
three states, ordered from strongest evidence to weakest:

- **Tested** — The maintainer has run `scripts/deploy.sh` and
  `scripts/verify.sh` end-to-end on this model from a known-clean
  Shepherd-override-directory state, on the listed firmware. Confirms
  our deploy path works for this hardware against the regression-test
  gate documented in
  [adr/0004-shepherd-override-replaces-not-merges.md](adr/0004-shepherd-override-replaces-not-merges.md).
- **Confirmed** — An external contributor has reported a successful
  end-to-end install on this model and firmware, with `<variant>` and
  `<softwareVersion>` from `/info` matching the row. Less rigorous than
  Tested but still empirical.
- **Inferred** — Community evidence suggests the model should work
  (same hardware family, same firmware family, no model-specific
  blockers known), but no install has been independently confirmed
  against this release.

**Inferred is not broken.** It means we don't have evidence either
way. The 0.8 deploy path is variant-agnostic by construction — the
shepherd-override fix in #144 links every stock `Shepherd-*.xml` under
`/opt/Bose/etc/` regardless of model, so a row stays in Inferred only
until someone runs it.

## Model rows

| Model         | Variant  | Firmware              | State    |
| ------------- | -------- | --------------------- | -------- |
| SoundTouch 10 | `rhino`  | 27.0.6.46330.5043500  | Tested   |
| SoundTouch 20 | `spotty` | 27.0.6 family         | Inferred |
| SoundTouch 30 | `mojo`   | 27.0.6 family         | Inferred |

### SoundTouch 10 — `rhino` — Tested

Firmware 27.0.6.46330.5043500. This is the maintainer's reference
speaker; the project has been running on it for over a year. The 0.8
release re-validates `scripts/deploy.sh` end-to-end against a
known-clean override-directory state — i.e. with
`/mnt/nv/shepherd/`, `/mnt/nv/resolver/`, and
`/mnt/nv/OverrideSdkPrivateCfg.xml*` wiped — so the "Tested" claim
rests on the documented install path, not on accumulated manual state.

### SoundTouch 20 — `spotty` — Inferred

Same firmware family (27.0.6), same SDK build (User-Agent reports
`Bose_Lisa/27.0.6` — `Lisa` is the shared SDK build-tree name across
the line, not a variant). The shepherd-override directory bug that
made the documented install path fail on this model has been closed by
#144 and
[adr/0004-shepherd-override-replaces-not-merges.md](adr/0004-shepherd-override-replaces-not-merges.md):
`scripts/deploy.sh` now links every stock `Shepherd-*.xml` —
including `Shepherd-spotty.xml` — into `/mnt/nv/shepherd/`, which is
what kept the per-variant daemon supervised on the maintainer's
ST 10 all along.

Pending confirmation from the reporter in discussion #121. Promotes to
Confirmed once a successful install on a `spotty` speaker is filed.

### SoundTouch 30 — `mojo` — Inferred

Same firmware family, same SDK build. No reports either way. The same
variant-agnostic deploy reasoning applies: the loop in
`scripts/deploy.sh` links `Shepherd-mojo.xml` along with the rest, so
there is no model-specific code path that would single out the ST 30.

### Other models

Untested. The SoundTouch-equipped Wave variants and any other speaker
that shares the internal Linux + `shepherdd` + busybox architecture
are plausible candidates, but no install has been attempted as part
of this project. File a report (see below) if you try one.

## Filing a compatibility report

If you've run this on a model not yet in the table, or on a firmware
version different from the one listed for your model, please open an
issue or PR with the output of `scripts/capture-state.sh` (landing in
#147) attached. That script collects the speaker-side detail we need
to evaluate a report — variant, firmware version, override-directory
contents, supervised-daemon list — without manual copy-paste.

A successful install on a new model + firmware combination promotes
its row from Inferred to Confirmed; a row gets to Tested only by
running the maintainer's clean-slate validation procedure on the
maintainer's bench.

## Likely to NOT work

- The newer **Bose Home Speaker** line (Home Speaker 300/450/500).
  Those run a different firmware stack and don't expose the
  SoundTouch port-8090 API in the same way.
- The **Bose Wireless Link Adapter** without an attached SoundTouch —
  it's a different product internally.
- Any speaker whose firmware predates the SoundTouch app era (you'd
  notice — those don't have preset buttons backed by cloud lookups in
  the first place).

## How to check whether your speaker is a candidate

Before going any further, run from a laptop on the same LAN as the
speaker:

```bash
curl http://<speaker-ip>:8090/info
curl http://<speaker-ip>:8090/supportedURLs
```

If both return XML with a recognisable model name and a long list of
endpoints (102 on a SoundTouch 10), you're in good shape. If the first
is silent or the second 404s, the speaker is on a different firmware
generation and this project won't help directly.

The SSH-enable USB-OTG trick described in
[opening-up-your-speaker.md](opening-up-your-speaker.md) is also
firmware-specific. It's known to work on firmware 27.x. Earlier
firmwares had a different trick (telnet to port 17000 and run
`remote_services on`); if your firmware predates 27.x you might be
able to use that older path instead, but it's outside the scope of
this project.

## Speakers vs. mobile app vs. accounts

This project works on the **speaker hardware**: onboarding a speaker
to your WiFi, local control over the LAN, presets, favourites, TuneIn
drill, AUX, Bluetooth, Spotify Connect — all the things that don't
need to round-trip through Bose's servers — still work.

What's gone is the **cloud-routed** half of the SoundTouch ecosystem:
cross-device favourites sync, remote control over the internet, and
anything the **SoundTouch mobile app** routed through Bose's account
servers. Local control through the mobile app stopped working when
those servers went away; this project doesn't bring the app back, but
it doesn't need to — the **Admin SPA** (the browser interface at
`http://<speaker-ip>:8181/`) is the supported everyday interface
post-cloud-shutdown.
