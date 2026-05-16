# Shepherd override directory replaces, not merges — deploy must link stock configs

- **Status**: accepted
- **Date**: 2026-05-16
- **Supersedes**: —
- **Related**: `scripts/deploy.sh`, `scripts/uninstall.sh`,
  `resolver/shepherd-resolver.xml`, `CONTEXT.md` § Shepherdd / Shepherd
  config / Shepherd override directory / Variant / Stock daemon

## Context

The speaker firmware runs **Shepherdd** as its process supervisor.
Shepherdd loads **Shepherd config** files at boot and supervises every
declared daemon — `BoseApp`, `WebServer`, `APServer`, `Bluetooth`, the
per-**variant** daemon (`Rhino` on ST 10, `Spotty` on ST 20, `Mojo` on
ST 30), and any third-party config layered on top, like our
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
ports 8090/8080 live. On an external contributor's ST 20, the same
documented path produced a speaker stuck at ~90% boot, with ports
8090/8080 dead. SSH to the maintainer's speaker revealed that its
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

## Consequences

- **The documented install path becomes reproducible.** Any fresh
  speaker — any model — that follows `scripts/deploy.sh` produces the
  same override-directory shape the maintainer's speaker has had
  since May 2026. The manual sysadmin step is captured in code.

- **Uninstall must reverse the operation cleanly.** A subsequent fresh
  install starting from "speaker that has been uninstalled" must
  produce the same state as "speaker that never had us deployed." The
  uninstall script enumerates and removes every symlink it created,
  removes `Shepherd-resolver.xml`, and `rmdir`s the empty override
  directory — returning shepherdd to its default load path under
  `/opt/Bose/etc/`.

- **One implementation, all variants.** The previous mental model
  ("we tested on ST 10, hope ST 20 works") is replaced with: any model
  whose firmware exposes the standard Shepherd config layout under
  `/opt/Bose/etc/` is handled by the same loop, with no variant
  branching in deploy.sh. The compat matrix collapses one row.

- **A regression-test gate is now possible.** Until 0.8 the deploy
  path couldn't be validated against a known-clean override-directory
  state without losing the maintainer's working state. With the
  symlink step in code, the override directory is reproducible: wipe
  it (`rm -rf /mnt/nv/shepherd /mnt/nv/resolver /mnt/nv/OverrideSdkPrivateCfg.xml*`),
  run `scripts/deploy.sh`, verify. A deeper full-factory-reset gate
  that also exercises the SSH-enable procedure remains a future fold.

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
