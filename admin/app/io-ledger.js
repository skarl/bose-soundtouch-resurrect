// Outgoing-call ledger. Records the timestamp of every outgoing API
// call so that incoming state-change events can be attributed either to
// hardware-button presses ("pressed on speaker") or to the admin's own
// calls (suppress toast — we already know).
//
// recordOutgoing(kind, detail?) — stamp now for (kind, detail).
// wasRecentOutgoing(kind, detail?, withinMs?) → boolean — true if a
//   stamp exists within the window. The default window is 2000 ms.
//
// kind is one of: 'preset' | 'volume' | 'transport' | 'source'.
// detail is an optional discriminator (e.g. preset slot number).

const ledger = new Map();   // key → timestamp

function makeKey(kind, detail) {
  return detail != null ? `${kind}:${detail}` : kind;
}

export function recordOutgoing(kind, detail) {
  ledger.set(makeKey(kind, detail), Date.now());
}

export function wasRecentOutgoing(kind, detail, withinMs = 2000) {
  const ts = ledger.get(makeKey(kind, detail));
  if (ts == null) return false;
  return Date.now() - ts < withinMs;
}
