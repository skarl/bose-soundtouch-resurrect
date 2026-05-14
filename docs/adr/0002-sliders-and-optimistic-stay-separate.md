# Sliders and optimistic stay separate

- **Status**: accepted
- **Date**: 2026-05-13
- **Supersedes**: —
- **Related**: `admin/app/sliders.js`, `admin/app/optimistic.js`

## Context

`admin/app/sliders.js` and `admin/app/optimistic.js` both encode the pattern
"local-first then reconcile with the speaker," and the surface similarity is
strong enough that every architecture review re-suggests collapsing them into
one module.

The shapes differ where it matters:

- **`sliders.js`** coalesces *value-with-target* drags. The user holds a thumb
  while a stream of intermediate frames flows past; the module needs a queue
  with coalescence so only the latest target is in-flight, and a way to keep
  the thumb pinned to the user's gesture while the speaker catches up.
- **`optimistic.js`** does *fire-and-rollback* for discrete actions (preset
  tap, source pick, mute toggle). One action goes out, one of two outcomes
  comes back, and on rejection the UI snaps to the pre-action state.

The two are adapters of two different concepts, not one concept with two
adapters.

## Decision

Keep them as separate modules. Do not merge them under a shared "local-first
reconciler" interface.

## Consequences

- A unified module would need both shapes behind one interface, widening the
  surface without giving callers more leverage. Callers always know which
  shape they want; forcing them through a polymorphic layer just adds a
  branch at each call site.
- Future architecture reviews should not re-propose the merge. To make that
  judgement local rather than tribal, both files carry a one-line
  `// see also` comment at their top cross-referencing the other.
- If a third "local-first" shape appears (e.g. long-poll with optimistic
  preview), prefer adding a third sibling over generalising. Re-open this
  ADR only if two of the three shapes turn out to be the same.
