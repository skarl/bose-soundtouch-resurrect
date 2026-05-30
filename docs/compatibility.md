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
wrong.** Issue [#160](https://github.com/skarl/bose-soundtouch-resurrect/issues/160)
is a real SoundTouch 20 (`spotty`) that boot-loops after
`scripts/deploy.sh` on the same release the loop was supposed to fix.
The override-replacement mechanism is sound on the ST 10, but the
generalisation to every model is not established — the stock Shepherd
config inventory is itself model-dependent (see
[adr/0004-shepherd-override-replaces-not-merges.md](adr/0004-shepherd-override-replaces-not-merges.md)).
So an Inferred row may brick your speaker; only **Tested** carries a
real safety guarantee.

## Model rows

| Model               | Variant  | Firmware              | State    |
| ------------------- | -------- | --------------------- | -------- |
| SoundTouch 10       | `rhino`  | 27.0.6.46330.5043500  | Tested   |
| SoundTouch 20       | `spotty` | 27.0.6.46330.5043500  | **Broken** (#160) |
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

### SoundTouch 20 — `spotty` — Broken (#160)

**Do not run `scripts/deploy.sh` against a SoundTouch 20 yet.** In
[#160](https://github.com/skarl/bose-soundtouch-resurrect/issues/160) an
external contributor reported a real ST 20 (`spotty`, moduleType `sm2`,
firmware 27.0.6.46330.5043500) that **boot-loops after deploy** — no
SSH, no telnet, hard reset required — and it recurs on every redeploy.
This is the same boot-brick class as
[#143](https://github.com/skarl/bose-soundtouch-resurrect/issues/143).

This was supposed to be fixed: 0.8 (#144) made `scripts/deploy.sh` link
every stock `Shepherd-*.xml` into `/mnt/nv/shepherd/`, on the theory
that the same loop handles every model. But that fix was only ever
validated on the maintainer's ST 10, and #160 is direct evidence it
does **not** hold on a real ST 20. The investigation is open — we need
a full `/opt/Bose/etc/` listing from a working ST 20 to know whether
its stock-config layout defeats the `Shepherd-*.xml` glob. Until then,
the ST 20 is fenced off.

### SoundTouch 30 — `mojo` — Inferred (unverified)

No ST 30 has ever been reported to this project — no `/info`, no
install, nothing. Even the `mojo` = ST 30 variant mapping is an
inference, not a confirmed fact. Given the ST 20 (#160) bricked on the
same "variant-agnostic" deploy path, treat the ST 30 as equally
unproven: it may work, it may brick. If you have one, capture its
`/info` and `/opt/Bose/etc/` listing with `scripts/capture-state.sh`
and file a report **before** deploying.

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
