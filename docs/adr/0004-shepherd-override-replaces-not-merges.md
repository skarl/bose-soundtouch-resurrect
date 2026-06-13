# Shepherd override directory replaces, not merges — deploy must link stock configs

- **Status**: accepted. (The 0.8.3 "contested" mark is **resolved** as of
  0.8.4 — see the Update below; the "link every config" implementation
  was wrong and is replaced by the firmware's own variant selection.)
- **Date**: 2026-05-16
- **Updated**: 2026-06-13 (0.8.4 — root cause found, selection rule
  reproduced in code); 2026-05-30 (0.8.3 — generalisation contested)
- **Supersedes**: —
- **Related**: `scripts/deploy.sh`, `scripts/select-shepherd-configs.sh`,
  `scripts/uninstall.sh`, `resolver/shepherd-resolver.xml`, `CONTEXT.md`
  § Shepherdd / Shepherd config / Shepherd override directory / Variant /
  Stock daemon

> ## Update (0.8.4) — resolved: the override dir must reproduce the
> firmware's *variant selection*, not link every config
>
> The replace-not-merge core decision stands. The **implementation** in
> the Decision section below — "link every stock `Shepherd-*.xml`" — was
> wrong, and is the cause of
> [#160](https://github.com/skarl/bose-soundtouch-resurrect/issues/160).
> A full capture from a working, hard-reset ST 20 (`spotty`) plus the
> firmware's own init script settled it:
>
> 1. **The firmware does not load every `Shepherd-*.xml`.**
>    `/etc/init.d/SoundTouch` assembles its run directory from a
>    **variant-specific subset**:
>    ```sh
>    read variant </proc/variant            # e.g. rhino, spotty
>    for i in core noncore product $variant hsp; do
>        cfg=/opt/Bose/etc/Shepherd-$i.xml
>        [ -e "$cfg" ] && ln -s "$cfg" "$rundir"
>    done
>    # + a Bardeen-Linus bonded substitution gated on a persistence marker
>    ```
>    This loop runs **only when `/mnt/nv/shepherd` does not exist**
>    (`override=false`). Creating the override directory is exactly what
>    makes the firmware skip selection and use our directory verbatim —
>    so we must reproduce the selection ourselves.
> 2. **The image inventory is model-dependent.** The ST 10 (`rhino`)
>    ships a single-product `/opt/Bose/etc` = `{core, hsp, noncore,
>    product, rhino}`; the ST 20 (`spotty`) ships a **multi-product**
>    image = `{bardeen, bardeen_linus, binky, burns, ginger, mojo,
>    noncore, noncore_linus, rhino, spotty}` (10 configs, 7 products).
>    On the ST 10 "link everything" accidentally equalled the selected
>    subset, so it worked. On the ST 20 it linked eight foreign-product
>    configs — each declaring its own `recovery="reboot"`
>    BoseApp/APServer/WebServer/NetManager — and shepherdd boot-looped.
>    Confirmed against the working ST 20's `ps` (stock supervises only
>    the `spotty` + `noncore` daemon set) and the init script above.
>
> The 0.8.3 "dash-less `Shepherd.xml` glob blind spot" hypothesis was
> **wrong**: the ST 20 ships no such file, and the real fault is
> over-linking, not under-matching.
>
> Fixed in 0.8.4: `scripts/deploy.sh` delegates to
> `scripts/select-shepherd-configs.sh`, which reproduces the loop above
> (with a brick guard), unit-tested against both inventories in
> `scripts/test/test_select_shepherd_configs.sh`. Verified on the live
> ST 10 (identical to its working state); the live-ST-20 reboot pass
> runs through the #160 reporter.
>
> Also: the "external contributor's ST 20" cited as motivating evidence
> below is **not** an ST 20 — David's `/info` (discussion #159) reports
> a SoundTouch **Portable** (`taigan`). The first real ST 20 was #160.

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
exactly the stock configs the firmware's own init script would select
for this product** — the variant-specific subset `Shepherd-{core,
noncore, product, <variant>, hsp}.xml` (whichever exist) — in addition
to dropping `Shepherd-resolver.xml`. It does **not** link every
`Shepherd-*.xml` (see the 0.8.4 Update; that over-links on multi-product
images and boot-loops the speaker). The uninstall script removes the
entire override directory so shepherdd falls back to its stock load path.

Concretely the selection (factored into
`scripts/select-shepherd-configs.sh`, run on the speaker) is:

```sh
# variant from /proc/variant (or "eddie" on /opt/Bose/bin products),
# mirroring /etc/init.d/SoundTouch
for i in core noncore product "$variant" hsp; do
  cfg=/opt/Bose/etc/Shepherd-$i.xml
  [ -e "$cfg" ] && ln -sf "$cfg" "/mnt/nv/shepherd/Shepherd-$i.xml"
done
# our own resolver config is then scp'd in alongside
```

The firmware additionally applies a Bardeen-Linus *bonded* substitution
(swap the bardeen configs for their `_linus` variants when a persistence
marker exists). We **deliberately do not reproduce it**: it isn't
variant-gated, so on a non-bardeen speaker that happened to carry the
marker it would link a foreign-product config — re-creating the #160
boot-loop class — and this project supports no bardeen-family device to
validate it against. If such a report ever lands, add it then, gated on
the variant and validated against that device's capture.

A **brick guard** precedes this: if `Shepherd-$variant.xml` is absent
from `/opt/Bose/etc` the product is unrecognised, so the script refuses
to create the override directory at all and the deploy aborts before the
reboot — far better than assembling a guessed (possibly brick-class)
override dir.

### Symlinks, not copies

We use symlinks rather than copies because:

- The maintainer's verified-working state uses symlinks. Copies are unverified.
- Symlinks survive any (now theoretical) future firmware Shepherd-config
  change. Bose's update servers are dead, but if a community-archived
  firmware ever lands, no stale-snapshot risk.
- Less NV flash usage; less drift surface.
- The shell idiom is `ln -sf` — idempotent, safe to re-run.

### Why variant selection, matching the firmware (0.8.4)

We must select the *same* subset the firmware would, because the
override directory replaces — not merges with — the stock load path.
The firmware (`/etc/init.d/SoundTouch`) selects by variant; a
multi-product image (the ST 20) carries other products' configs that
must **not** be loaded together (each declares its own
`recovery="reboot"` BoseApp/APServer/WebServer, and running several at
once boot-loops the speaker — #160). So `select-shepherd-configs.sh`
reads the variant (`/proc/variant`) and links only
`Shepherd-{core,noncore,product,<variant>,hsp}.xml` that exist —
byte-identical to the firmware's own selection on the models we support
(the bonded substitution is the one firmware step we don't reproduce;
see the Decision above for why).

> **Earlier reasoning, now retracted (was "Why no per-variant
> detection"):** 0.8 claimed we could link every `Shepherd-*.xml` and
> ignore the model, since the variant config "gets linked the same way
> as the rest." That held only because the ST 10 image is single-product.
> It is false on multi-product images and is the direct cause of #160.
> The 0.8.3 "dash-less `Shepherd.xml` glob blind spot" caveat was also
> wrong: the fault is over-linking, not under-matching.

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
  uninstall script removes the **entire** override directory
  (`rm -rf /mnt/nv/shepherd`, symlinks + our `Shepherd-resolver.xml`
  together) — returning shepherdd to its default load path under
  `/opt/Bose/etc/`. It deliberately removes the directory itself, not
  just its contents: an empty-but-present override dir is its own brick
  (see the "never leave the override directory present-but-empty"
  consequence below).

- **One implementation, all variants — by reproducing the firmware's
  selection, not by ignoring the variant. _[RESOLVED in 0.8.4 — see the
  Update at the top.]_** The 0.8 claim ("link everything, it works on
  any model") was disproved by #160: it bricks multi-product images.
  The implementation that *does* generalise is the opposite — read the
  variant and link the same subset the firmware would. That logic is
  verified on the live ST 10 (byte-identical to its working state) and
  unit-tested against the captured ST 10 and ST 20 inventories. It is
  still **not** validated by a live ST 20 reboot (the project has no
  ST 20); per the honesty doctrine, the ST 20 stays Broken in
  `docs/compatibility.md` until the #160 reporter confirms a clean
  deploy-and-recover.

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
