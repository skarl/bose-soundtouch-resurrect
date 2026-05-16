# Maintaining this project

For project maintainers. Outside contributors don't need this file —
[CONTRIBUTING.md](CONTRIBUTING.md) is the right starting point for
them.

## Who can merge

Only people listed in `.github/CODEOWNERS` can approve and merge PRs.
Outside contributors **fork** the repo and submit PRs against `main`;
direct push to `main` is reserved for maintainers.

## One-time GitHub setup (after creating the repo on GitHub)

These can't live in the repo itself — they're per-repository settings
on GitHub.com. Apply them once after you've created the repository on
GitHub and run `git push -u origin main` for the first time.

### 1. Branch protection on `main`

**Settings → Branches → Add branch protection rule** (target `main`):

- ☑ Require a pull request before merging
  - ☑ Require approvals (set to **1** for a small project, **2** later)
  - ☑ Dismiss stale pull request approvals when new commits are pushed
  - ☑ Require review from Code Owners
- ☑ Require status checks to pass before merging
  - (Add the names of any CI checks once you have them.)
- ☑ Require conversation resolution before merging
- ☑ Do not allow bypassing the above settings (apply to admins too)
- ☐ Allow force pushes — leave **off**.
- ☐ Allow deletions — leave **off**.

### 2. Restrict who can push to `main`

Same panel, **Restrict who can push to matching branches**:

- Add yourself / your maintainers list. Everyone else has to PR.

This is the rule that turns "open source" into "open source where only
maintainers ship code." Outside contributors can still fork freely.

### 3. Issue / PR settings

**Settings → General**:

- Issues: ☑ enabled
- Discussions: ☑ enabled (optional, useful for design questions that
  shouldn't churn the issue tracker).
- Pull requests:
  - ☑ Allow merge commits — yes, default
  - ☐ Allow squash merging — your call; some projects disallow because
    it loses commit history. Squash is fine for small PRs.
  - ☐ Allow rebase merging — your call.
  - ☑ Always suggest updating pull request branches.
  - ☑ Automatically delete head branches after merge.

### 4. Issue templates

Already in `.github/ISSUE_TEMPLATE/`:

- `bug_report.md` — collects speaker model, firmware, resolver state.
- `feature_request.md` — gates against out-of-scope requests.

If you want a "Compatibility report" template too (so people can
contribute "works on my ST 20") add a third template to that
directory.

## Adding a new maintainer

1. Add them to your repo's collaborator list (Settings → Collaborators).
   Give "Maintain" or "Admin" role depending on trust level — Maintain
   is enough to merge PRs.
2. Add their handle to `.github/CODEOWNERS`. PR + merge.
3. Add them to the "Restrict who can push" list under branch
   protection.

## Pre-release validation: shepherd-state-only reset

Before any release that touches `scripts/deploy.sh`,
`scripts/uninstall.sh`, `resolver/`, or anything else that writes to
the speaker's `/mnt/nv/`, run this procedure on the test speaker to
validate the documented install path against a known-clean
override-directory state.

This catches the bug class that motivated 0.8: invisible manual state
on the maintainer's NV flash making the documented path
non-reproducible for fresh users. See
[`docs/adr/0004-shepherd-override-replaces-not-merges.md`](docs/adr/0004-shepherd-override-replaces-not-merges.md)
for the full background.

**Scope: shallow.** This procedure resets only the state our deploy
and uninstall scripts manage — the resolver tree, the Shepherd
override directory, the Override XML. It does NOT factory-reset the
speaker, re-enable SSH via USB stick, or re-onboard via the
SoundTouch app. The deeper full-factory-reset gate that exercises
those paths is a future fold.

### Procedure

1. **Capture user data.** Back up the speaker's presets before tearing
   anything down:
   ```sh
   ./scripts/backup-presets.sh <speaker-ip>
   ```

2. **Wipe the project-managed state on the speaker:**
   ```sh
   ./scripts/ssh-speaker.sh <speaker-ip> '
     rm -rf /mnt/nv/shepherd/* /mnt/nv/resolver/* \
            /mnt/nv/OverrideSdkPrivateCfg.xml*
     sync; reboot
   '
   ```
   Wait ~60s for the reboot to complete.

3. **Confirm clean factory-app boot.** Verify the speaker comes up
   normally without our resolver — this is the control:
   ```sh
   ./scripts/ssh-speaker.sh <speaker-ip> 'curl -s http://localhost:8090/info | head -1'
   ```
   Should return parseable XML with the speaker's model and variant.

4. **Deploy from the release branch:**
   ```sh
   ./scripts/deploy.sh <speaker-ip>
   ```

5. **Verify** — every probe must pass. Capture the output for the
   release PR body:
   ```sh
   ./scripts/verify.sh <speaker-ip>
   ```

6. **Smoke a preset.** Press a hardware preset on the speaker;
   confirm playback starts.

7. **Uninstall.** Confirm the override directory is removed (or
   empty) after the speaker reboots:
   ```sh
   ./scripts/uninstall.sh <speaker-ip>
   ./scripts/ssh-speaker.sh <speaker-ip> 'ls -la /mnt/nv/shepherd/ 2>&1 | head'
   ```

8. **Re-confirm clean boot post-uninstall.** Same probe as step 3.

9. **Re-deploy** to leave the test speaker in a working state for
   normal use:
   ```sh
   ./scripts/deploy.sh <speaker-ip>
   ```

### What to capture

- `scripts/verify.sh` output from step 5 — paste into the release
  PR body.
- Anomalies surfaced by any step — file as follow-up issues and
  decide whether each gates the release.

### What to do if any step fails

The plan is wrong, not just the step. Re-grill the milestone before
shipping. The release does not ship until step 5 passes cleanly.

## Releasing

There's no formal release machinery yet — this project ships small
enough changes that PRs land on `main` and users follow `main`. If
the project grows enough to need versioned releases:

1. Bump `[Unreleased]` to a new section header `[v0.x.y] - YYYY-MM-DD`
   in `CHANGELOG.md`. Open a PR for it.
2. After merge, tag locally: `git tag v0.x.y && git push --tags`.
3. Create a GitHub release tied to that tag (UI: Releases → Draft a
   new release → choose the tag → paste the CHANGELOG section into
   the body).

## Security disclosure

[SECURITY.md](SECURITY.md) tells reporters to use GitHub Security
Advisories rather than public issues. As a maintainer you'll see those
in **Security → Advisories** in the repo.

When acting on a private advisory:

- Discuss the fix in the advisory's private fork (GitHub provides
  one).
- Land the fix on `main` only when ready to disclose; don't sit on
  a fixed `main` for long.
- Add a `[Security]` line under the next CHANGELOG entry once
  disclosed.

## Out-of-scope handling

The project's scope is narrow on purpose (see `CONTRIBUTING.md`
§ "Scope"). When closing an out-of-scope issue, link them back to the
scope statement and offer fork-friendly redirects: "this project
intentionally doesn't cover X; if you want X, the simplest path is to
fork and add it on top — happy to link to your fork from the README."

The point is to keep this project small and reliable, not to be all
things to all SoundTouch owners. The cost of saying yes to every nice
idea is that the maintenance burden creeps up to where the project
stops being maintainable. Saying no is part of the job.
