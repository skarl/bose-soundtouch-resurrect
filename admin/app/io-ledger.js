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
  // When called without a detail, also match prefix-keyed entries like
  // `preset:3` — watchSpeakerButtons calls wasRecentOutgoing('preset') but
  // recordOutgoing('preset', slot) writes per-slot keys.
  if (detail == null) {
    const exact = ledger.get(kind);
    const prefix = `${kind}:`;
    let ts = exact;
    for (const [key, keyTs] of ledger) {
      if (key === kind || key.startsWith(prefix)) {
        if (ts == null || keyTs > ts) ts = keyTs;
      }
    }
    if (ts == null) return false;
    return Date.now() - ts < withinMs;
  }
  const ts = ledger.get(makeKey(kind, detail));
  if (ts == null) return false;
  return Date.now() - ts < withinMs;
}
