# Shepherd override directory replaces, not merges — deploy must link stock configs

- **Status**: accepted (core decision); **contested** (the "all
  variants" generalisation — see the Update below)
- **Date**: 2026-05-16
- **Updated**: 2026-05-30 (0.8.3)
- **Supersedes**: —
- **Related**: `scripts/deploy.sh`, `scripts/uninstall.sh`,
  `resolver/shepherd-resolver.xml`, `CONTEXT.md` § Shepherdd / Shepherd
  config / Shepherd override directory / Variant / Stock daemon

> ## Update (0.8.3) — the "all variants" claim is contested
>
> The core decision below — link every stock `Shepherd-*.xml` into the
> override directory because the directory *replaces* rather than
> *merges* — is correct and stands, verified on the ST 10. **But the
> Consequences section over-reached.** It claimed the same loop handles
> "all variants" with the compat matrix collapsing to one row. That is
> falsified: issue
> [#160](https://github.com/skarl/bose-soundtouch-resurrect/issues/160)
> is a real SoundTouch 20 (`spotty`) that **boot-loops after
> `scripts/deploy.sh`** on the very release this ADR shipped in — the
> same boot-brick class as #143.
>
> Two reasons the generalisation didn't hold:
> 1. **The stock config inventory is model-dependent.** The ST 10
>    (`rhino`) ships `{core, hsp, noncore, product, rhino}`; the
>    SoundTouch Portable (`taigan`, discussion #159) ships
>    `{mojo, noncore, spotty, taigan}` — only `noncore` in common.
>    There is no single "standard layout."
> 2. **The `Shepherd-*.xml` glob has a blind spot.** Both
>    `scripts/deploy.sh` and `scripts/capture-state.sh` only match
>    `Shepherd-*.xml`; a boot-critical config named differently (e.g. a
>    dash-less `Shepherd.xml`) would be silently missed, leaving a
>    `recovery="reboot"` daemon unsupervised → a boot *loop*. We don't
>    yet have a full `/opt/Bose/etc/` listing from a working ST 20 to
>    confirm whether this is #160's cause.
>
> Also: the "external contributor's ST 20" cited as motivating evidence
> below is **not** an ST 20 — David's `/info` (discussion #159) reports
> a SoundTouch **Portable** (`taigan`). So no real ST 20 ever validated
> this path; the first one (#160) failed. Treat the Consequences below
> as ST-10-validated only until a non-ST-10 model passes the
> regression gate.

## Context

The speaker firmware runs **Shepherdd** as its process supervisor.
Shepherdd loads **Shepherd config** files at boot and supervises every
declared daemon — `BoseApp`, `WebServer`, `APServer`, `Bluetooth`, the
per-**variant** daemon (`rhino` on ST 10, `spotty` on ST 20, `taigan`
on the SoundTouch Portable; `mojo` = ST 30 is inferred, unverified),
and any third-party config layered on top, like our
`Shepherd-resolver.xml`.

Shepherdd has two possible load locations:

- `/opt/Bose/etc/Shepherd-*.xml` — the read-only stock configs that
  ship with the firmware. Default.
- `/mnt/nv/shepherd/Shepherd-*.xml` — the **Shepherd override directory**
  on writable NV flash. Used when the directory exists.

The behaviour is **replacement, not merging**: when the override
directory exists, shepherdd ignores `/opt/Bose/etc/` entirely. Any
stock config not also present in the override directory is *not loaded*.

Our project needs to drop `Shepherd-resolver.xml` somewhere shepherdd
will read. We cannot write under `/opt/Bose/etc/` (squashfs,
read-only). The override directory is therefore the only place this
file can live — and creating it switches shepherdd's load source for
*every* Shepherd config.

Until 0.8, our `deploy.sh` created `/mnt/nv/shepherd/` and dropped only
our own `Shepherd-resolver.xml` into it. On the maintainer's ST 10
this somehow worked — verified install, all stock daemons supervised,
ports 8090/8080 live. On an external contributor's speaker (discussion
#121 — at the time assumed to be an ST 20, later identified from its
`/info` as a SoundTouch **Portable** / `taigan`), the same documented
path produced a speaker stuck at ~90% boot, with ports 8090/8080 dead.
SSH to the maintainer's speaker revealed that its
override directory contained five **manually-created symlinks** to
the stock configs:

```
Shepherd-core.xml      -> /opt/Bose/etc/Shepherd-core.xml
Shepherd-hsp.xml       -> /opt/Bose/etc/Shepherd-hsp.xml
Shepherd-noncore.xml   -> /opt/Bose/etc/Shepherd-noncore.xml
Shepherd-product.xml   -> /opt/Bose/etc/Shepherd-product.xml
Shepherd-rhino.xml     -> /opt/Bose/etc/Shepherd-rhino.xml
Shepherd-resolver.xml  (our file)
```

These were set up in early development, never committed to git, and
silently kept the maintainer's speaker working while the documented
install path was broken for every fresh install on any model. The
bug was invisible to the maintainer because the speaker's flash
retains the manual state across reboots and across project iterations.

## Decision

**The deploy script populates `/mnt/nv/shepherd/` with symlinks to
every `/opt/Bose/etc/Shepherd-*.xml` stock config in addition to
dropping `Shepherd-resolver.xml`.** The uninstall script reverses the
operation: removes every symlink we created, removes
`Shepherd-resolver.xml`, and `rmdir`s the directory if (and only if)
it ends up empty.

Concretely the relevant deploy step becomes:

```sh
mkdir -p /mnt/nv/shepherd
for stock in /opt/Bose/etc/Shepherd-*.xml; do
  ln -sf "$stock" "/mnt/nv/shepherd/$(basename "$stock")"
done
# our own resolver config is then scp'd in alongside
```

### Symlinks, not copies

We use symlinks rather than copies because:

- The maintainer's verified-working state uses symlinks. Copies are unverified.
- Symlinks survive any (now theoretical) future firmware Shepherd-config
  change. Bose's update servers are dead, but if a community-archived
  firmware ever lands, no stale-snapshot risk.
- Less NV flash usage; less drift surface.
- The shell idiom is `ln -sf` — idempotent, safe to re-run.

### Why no per-variant detection

The loop links *every* `Shepherd-*.xml` under `/opt/Bose/etc/`,
including the per-variant one. We don't need to know whether we're on
an ST 10 or ST 20: whichever model the speaker is, its variant config
is present at `/opt/Bose/etc/Shepherd-<variant>.xml` and gets linked
the same way as the rest.

> **Caveat (0.8.3):** this assumes every boot-critical config is named
> `Shepherd-<something>.xml`. If a model ships a config the glob doesn't
> match (a dash-less `Shepherd.xml`, or one in another location), it is
> silently not linked — the failure mode suspected in #160. The glob is
> not known to be sufficient beyond the ST 10.

## Consequences

- **The documented install path becomes reproducible.** On the ST 10,
  a fresh speaker that follows `scripts/deploy.sh` produces the same
  override-directory shape the maintainer's speaker has had since May
  2026 — the manual sysadmin step is captured in code. (Originally
  stated as "any fresh speaker — any model"; see the Update at the top
  — that has not held on the ST 20.)

- **Uninstall must reverse the operation cleanly.** A subsequent fresh
  install starting from "speaker that has been uninstalled" must
  produce the same state as "speaker that never had us deployed." The
  uninstall script enumerates and removes every symlink it created,
  removes `Shepherd-resolver.xml`, and `rmdir`s the empty override
  directory — returning shepherdd to its default load path under
  `/opt/Bose/etc/`.

- **One implementation, all variants. _[CONTESTED — see the Update at
  the top.]_** This consequence claimed the previous mental model
  ("we tested on ST 10, hope ST 20 works") was *replaced* by a loop
  that handles any model, collapsing the compat matrix to one row. It
  was not — #160 shows a real ST 20 still bricks on this path. The
  honest statement is: there is no variant branching in `deploy.sh`,
  the loop is validated on the ST 10 only, and "all variants" is a
  hypothesis that the first ST 20 report disproved.

- **A regression-test gate is now possible — but it is single-model.**
  With the symlink step in code, the override directory is reproducible:
  wipe it (`rm -rf /mnt/nv/shepherd /mnt/nv/resolver /mnt/nv/OverrideSdkPrivateCfg.xml*`),
  run `scripts/deploy.sh`, verify. The catch: the procedure
  (MAINTAINING.md) runs only on the maintainer's ST 10, so passing it
  does **not** establish that other models work — exactly the gap #160
  fell through. Any future "all variants" claim must be gated on at
  least one independent non-ST-10 pass. A deeper full-factory-reset
  gate that also exercises the SSH-enable procedure remains a future
  fold.

- **Never leave the override directory present-but-empty.** Removing
  only the *contents* of `/mnt/nv/shepherd/` (`rm -rf /mnt/nv/shepherd/*`)
  produces an empty-but-existing directory — and shepherdd reads from
  it exclusively, finds zero Shepherd-*.xml files, supervises zero
  daemons. BoseApp / WebServer never start, ports 8090 / 8080 stay
  dead, LED flickers forever, no SSH recovery (NetManager isn't
  supervised either). Only escape is USB-stick firmware re-flash
  (`Update.stu`). Both `scripts/uninstall.sh` and the validation
  procedure remove the directory itself for exactly this reason. Any
  future tool that touches the override dir must follow the same
  rule.

- **A persistent class of bug is closed.** Any feature that requires
  state in `/mnt/nv/shepherd/` or `/mnt/nv/` more broadly must now
  ship that state-creation step in code. Future ADRs that touch
  shepherdd should note this constraint inline.

- **The decision is reversible at low cost.** If symlinks ever cause
  trouble — for example, if a future Bose-released firmware patch
  rewrites `/opt/Bose/etc/Shepherd-*.xml` in a way we want to ignore —
  switching the `ln -sf` to `cp` is a one-line change. We chose
  symlinks for fidelity to the maintainer's verified state and the
  smaller long-term drift surface, but no part of the rest of the
  system depends on the symlink shape.
