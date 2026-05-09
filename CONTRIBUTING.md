# Contributing

Thanks for considering a contribution. This project is small and the bar
is low — bug reports, doc fixes, and confirmations of "works on my
speaker model + firmware" are all valuable.

## Project model

This is an open-source project, but **only project maintainers can push
directly to this repository**. Outside contributors:

- **Open issues** to report bugs, request features, or ask questions.
- **Fork the repository** to make code or doc changes, then **open a
  pull request** from your fork against `main`. A maintainer will
  review and merge.
- **Fork freely** if you want to maintain a divergent variant — the
  MIT licence allows it.

The current set of maintainers is encoded in `.github/CODEOWNERS`.
Maintainer responsibilities are documented in
[MAINTAINING.md](MAINTAINING.md).

## Reporting bugs / asking questions

Open an issue. If it's a bug, include:

- Speaker model and firmware version (`curl http://<speaker-ip>:8090/info`).
- A description of what you did, what happened, and what you expected.
- Any relevant log output (e.g. `dmesg | tail`, `cat /mnt/nv/shepherd/pids`).

## Pull requests

How to submit:

1. Fork the repo on GitHub.
2. Clone your fork and create a topic branch: `git checkout -b fix/something`.
3. Make your change. Test it on a real speaker if it touches the
   resolver or scripts. Run the relevant verifier (`./scripts/verify.sh`).
4. Push to your fork.
5. Open a PR against this repo's `main` branch.

Quality bar:

- Keep the diff focused. One change per PR.
- Update relevant docs in `docs/` when behaviour or setup steps change.
- Don't include personal data — IPs, MAC addresses, real station IDs
  used as your own presets, router brand names, etc. Use placeholders
  like `<speaker-ip>`, `<your-mac>`, `s12345`.

A PR template at `.github/PULL_REQUEST_TEMPLATE.md` will populate the
PR body with the right sections automatically.

## Planning and design — use issues, not in-tree files

We track design discussions, work-in-progress plans, and rough notes
**in GitHub issues**, not as committed `.md` files in the tree. The
repo's tree is for things that ship. Plans / drafts / TODO lists live
on the issue tracker so they're easy to comment on, close, and move
around without churn in the codebase.

Rule of thumb:

- **Spec it shipping?** PR with code + docs.
- **Discussing it?** Issue.

Common gitignored locations for purely-local working files:
`planning/`, `notes/`, `scratch/`, `*.draft.md`, `*.scratch.md`,
`*.local.md`, `TODO.md`. See `.gitignore` for the full list. None of
these get committed.

## Compatibility reports

If you've successfully run this on a speaker model or firmware not yet
listed in `docs/compatibility.md`, please open a PR adding it. Include:

- Model name (e.g. SoundTouch 20).
- Firmware version (`curl http://<speaker-ip>:8090/info`).
- Whether all six steps in `docs/installation.md` worked unchanged.
- Anything you had to adjust.

## Scope

In scope:

- Keeping legacy SoundTouch speakers usable post-cloud-shutdown.
- Improving the on-speaker resolver, the admin UI, and the docs.
- Supporting more speaker models that share the underlying Linux/firmware
  architecture.

Out of scope:

- Modifying or repackaging Bose-copyrighted firmware components.
- Replicating Bose-account-coupled cloud features (favourites sync,
  cross-device history) — those are gone with the cloud.
- Streaming services other than TuneIn for v1; can be revisited later.

## License

By contributing, you agree that your contributions will be licensed
under the project's [MIT License](LICENSE).
