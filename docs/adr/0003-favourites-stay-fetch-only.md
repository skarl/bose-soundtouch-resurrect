# Favourites stay a fetch-only Field

- **Status**: accepted
- **Date**: 2026-05-15
- **Supersedes**: —
- **Related**: `admin/app/speaker-state.js`, `admin/app/favorites.js`,
  `admin/cgi-bin/api/v1/favorites`, `CONTEXT.md` § Favourite / Field

## Context

The **Favourite** list is an admin-owned record persisted at
`/mnt/nv/resolver/admin-data/favorites.json`. It is disjoint from the
firmware-owned **Preset** slots: the speaker firmware never reads, writes,
or emits events about favourites. The list is modelled as a **Field** in
the `FIELDS` registry in `admin/app/speaker-state.js`, the same way every
other speaker-state row is modelled.

A Field carries a `fetcher`, optional `path` / `tag` / `parseEl` for the
REST decode path, and an optional `eventTag` that hooks the row into the
firmware's WebSocket dispatch. **Presets** declare `eventTag:
'presetsUpdated'` and get cross-tab convergence for free — when one client
mutates, every other client sees a hint event and refetches. **Favourites**
declare no `eventTag`, because the firmware has no event to emit: it does
not know the list exists.

Reconcile for favourites runs on two triggers today:

1. Boot, via `reconcile(store)` at SPA start.
2. `visibilitychange → 'visible'`, via a listener mounted by the
   favourites view (mirrored on the now-playing card so the
   3×3 preview also refreshes when the tab regains focus).

This means two simultaneously open SPA clients converge on the next
visibility transition — typically the next tab switch — rather than in
real time.

Every architecture review of the favourites slice surfaces the same
question: should favourites get a push channel from the resolver back to
the SPA, so multi-tab clients see each other's edits without waiting for a
visibility transition?

## Decision

**Favourites remain a fetch-only Field. No resolver-to-SPA push channel.**

The reconcile contract for favourites is:

- Initial load via `fetcher` on boot.
- Refetch via `fetcher` on `visibilitychange → 'visible'`.
- After every local mutation, the SPA owns the optimistic state directly;
  no server round-trip is needed to learn what the local client just
  wrote.

## Consequences

- The **FIELDS registry** stays a single seam. Every speaker-state row
  reconciles through the same `fetcher` (+ optional WS hint) shape.
  Inventing a second transport just for favourites would fracture that
  invariant: future maintainers would have to ask, per field, "is this
  one push, pull, or both?" instead of reading one registry row.

- The reconcile delay for a second tab is bounded by user tab-switch
  latency, which on a single-user single-speaker home appliance is the
  same order of magnitude as any push-driven UI we could build. No bug
  has been filed that requires sub-second multi-tab convergence; the
  cost of building a push channel for hypothetical demand would
  outweigh the leverage.

- A resolver-pushed event channel would have to be invented from
  scratch. The firmware's gabbo subprotocol is not extensible from the
  resolver side — it is owned by the speaker's WebSocket server. A
  second transport (a second WS endpoint on the resolver, SSE from the
  CGI, or long-poll) would serve exactly one field today, with no
  other Field currently asking for the same machinery. The module
  would be shallow by construction: a large transport implementation
  behind an interface used by one caller.

- The decision is reversible. If a future Field also needs
  resolver-originated push — for example, a cross-device pairing flow
  that the firmware does not surface as a gabbo event — then push
  becomes a generally useful transport rather than a favourites-only
  workaround, and this ADR should be re-opened to define the seam
  before two callers diverge on transport details.

- Future architecture reviews should not re-propose a favourites push
  channel without identifying at least one additional Field that would
  share the transport, or a concrete user-visible bug that the
  visibility-driven reconcile cannot solve. The `// see also` comment
  on the favourites Field row in `speaker-state.js` points here so the
  judgement stays local rather than tribal.
