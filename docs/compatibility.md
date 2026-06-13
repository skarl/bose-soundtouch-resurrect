# Compatibility

Which Bose SoundTouch speakers and firmware versions are known to work
with this project, on what evidence, and how to add a new report.

## The rubric

Coverage across the SoundTouch line is uneven, and pretending otherwise
has been a source of trouble. **Everything in this project is validated
on exactly one speaker — the maintainer's SoundTouch 10 (`rhino`).**
Treat any claim about another model as a hypothesis until a report
confirms it. Every model row below carries one of four states, ordered
from strongest evidence to weakest:

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
- **Inferred** — No install has been confirmed on this model. We have
  no evidence either way; the row is a guess based on shared
  architecture. **Inferred is not a safety claim** — see the warning
  below.
- **Broken** — An external contributor has reported a reproducible
  failure (e.g. a boot loop) following the documented install path on
  this model. Do **not** run `scripts/deploy.sh` against this model
  until the row says otherwise.

We used to claim the 0.8 deploy path was "variant-agnostic by
construction" — that every model was handled by the same
`Shepherd-*.xml` linking loop regardless of hardware. **That claim was
wrong**, and [#160](https://github.com/skarl/bose-soundtouch-resurrect/issues/160)
(a real SoundTouch 20, `spotty`) proved it by boot-looping after
`scripts/deploy.sh`. 0.8.4 found the cause: the ST 20's firmware image
carries Shepherd configs for **seven products**, and the old loop linked
all of them, whereas the firmware loads only a variant-specific subset.
`scripts/deploy.sh` now reproduces the firmware's own selection (see
[adr/0004-shepherd-override-replaces-not-merges.md](adr/0004-shepherd-override-replaces-not-merges.md)).
That fix is verified on the ST 10 and unit-tested against the ST 20's
captured inventory, **but has not yet been run on a live ST 20** — so
the ST 20 stays Broken below until the #160 reporter confirms it. An
Inferred row may still brick your speaker; only **Tested** carries a
real safety guarantee.

## Model rows

| Model               | Variant  | Firmware              | State    |
| ------------------- | -------- | --------------------- | -------- |
| SoundTouch 10       | `rhino`  | 27.0.6.46330.5043500  | Tested   |
| SoundTouch 20       | `spotty` | 27.0.6.46330.5043500  | **Broken** (#160 — fix in 0.8.4, awaiting live validation) |
| SoundTouch 30       | `mojo`   | —                     | Inferred (unverified) |
| SoundTouch Portable | `taigan` | 27.0.6.46330.5043500  | Partial (#159) |

The `mojo` = SoundTouch 30 mapping is itself unverified — no `/info`
from an ST 30 has ever been seen by this project; it is an educated
guess, not a confirmed variant. `taigan` = SoundTouch Portable is a
real, observed variant (discussion #159) that the project originally
didn't know existed.

### SoundTouch 10 — `rhino` — Tested

Firmware 27.0.6.46330.5043500. This is the maintainer's reference
speaker; the project has been running on it for over a year. The 0.8
release re-validates `scripts/deploy.sh` end-to-end against a
known-clean override-directory state — i.e. with
`/mnt/nv/shepherd/`, `/mnt/nv/resolver/`, and
`/mnt/nv/OverrideSdkPrivateCfg.xml*` wiped — so the "Tested" claim
rests on the documented install path, not on accumulated manual state.

### SoundTouch 20 — `spotty` — Broken (#160, fix in 0.8.4 awaiting validation)

**Do not run `scripts/deploy.sh` against a SoundTouch 20 until this row
says Tested.** In
[#160](https://github.com/skarl/bose-soundtouch-resurrect/issues/160) an
external contributor reported a real ST 20 (`spotty`, moduleType `sm2`,
firmware 27.0.6.46330.5043500) that **boot-loops after deploy** — no
SSH, no telnet, hard reset required — and it recurs on every redeploy.
This is the same boot-brick class as
[#143](https://github.com/skarl/bose-soundtouch-resurrect/issues/143).

**Root cause (0.8.4).** A full capture from a working, hard-reset ST 20
showed its `/opt/Bose/etc/` is a **multi-product firmware image** — 10
`Shepherd-*.xml` configs for seven different Bose products. The
firmware's own init script (`/etc/init.d/SoundTouch`) loads only a
variant-specific subset (`{core,noncore,product,spotty,hsp}` of those
that exist → in practice just `spotty` + `noncore`), but the 0.8 deploy
linked **all 10** into the override directory. shepherdd then supervised
eight foreign products' `recovery="reboot"` daemons at once → boot loop.
It worked on the ST 10 only because that model's image is single-product,
so linking everything happened to equal the selected subset.

**Fix (0.8.4).** `scripts/deploy.sh` now reproduces the firmware's
selection via `scripts/select-shepherd-configs.sh`, linking only the
variant subset (with a brick guard). Verified byte-identical to the
working state on the live ST 10 and unit-tested against the captured
ST 20 inventory. **Still fenced off** here because no live ST 20 has
completed a deploy-and-recover — that validation runs through the #160
reporter (the project owns no ST 20). The state flips to Tested once
they confirm a clean boot.

### SoundTouch 30 — `mojo` — Inferred (unverified)

No ST 30 has ever been reported to this project — no `/info`, no
install, nothing. Even the `mojo` = ST 30 variant mapping is an
inference, not a confirmed fact. 0.8.4 makes the deploy reproduce the
firmware's own variant selection (so the #160 over-link can't recur) and
adds a brick guard that aborts before touching the override directory if
the speaker's variant config is unrecognised — which lowers the risk on
an unknown model but does **not** make it Tested. Treat the ST 30 as
unproven: capture its `/info` and `/opt/Bose/etc/` listing with
`scripts/capture-state.sh` and file a report **before** deploying.

### SoundTouch Portable — `taigan` — Partial (#159)

The Portable boots and installs the resolver fine, but in
[#159](https://github.com/skarl/bose-soundtouch-resurrect/discussions/159)
the admin SPA on port 8181 turned out to be **unreachable from the
LAN** on this unit, even though `busybox httpd` binds `0.0.0.0:8181`
correctly and loopback works. The maintainer reproduced LAN
reachability on an ST 10 at the identical firmware, so this is specific
to the Portable's hardware, not a resolver bug — the mechanism is not
yet understood. The working access path is an SSH tunnel forwarding
**both** 8181 (admin) and 8080 (the WebSocket); see
[troubleshooting.md](troubleshooting.md) § "Admin loads over an SSH
tunnel but the speaker reboots". Note this unit was mislabelled as an
"ST 20" through much of #121/#159 before its `/info` revealed `taigan`.

### Other models

Untested. The SoundTouch-equipped Wave variants and any other speaker
that shares the internal Linux + `shepherdd` + busybox architecture
are plausible candidates, but no install has been attempted as part
of this project. File a report (see below) if you try one.

## Filing a compatibility report

If you've run this on a model not yet in the table, or on a firmware
version different from the one listed for your model, please open an
issue or PR with the output of `scripts/capture-state.sh` attached.
That script collects the speaker-side detail we need to evaluate a
report — variant, firmware version, the full `/opt/Bose/etc/` listing,
override-directory contents, supervised-daemon list — and anonymises
MACs / IPs / serials by default, so it's safe to paste into a public
issue (pass `--raw` only for your own bench).

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
endpoints (102 on the maintainer's SoundTouch 10 — the count varies by
model and firmware), you're in good shape. If the first
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
