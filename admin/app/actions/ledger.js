// Outgoing-call ledger. Stamps the timestamp of every mutating call so
// incoming WS state-change events can be attributed either to a hardware
// button on the speaker or to the admin's own request (suppress toast).
//
// kind ∈ 'preset' | 'volume' | 'transport' | 'source'.
// detail is optional (e.g. preset slot number).

const ledger = new Map();

function makeKey(kind, detail) {
  return detail != null ? `${kind}:${detail}` : kind;
}

export function recordOutgoing(kind, detail) {
  ledger.set(makeKey(kind, detail), Date.now());
}

export function wasRecent(kind, detail, withinMs = 2000) {
  // Called without a detail, also match prefix-keyed entries like `preset:3`
  // — watchSpeakerButtons calls wasRecent('preset') but recordOutgoing('preset', slot)
  // writes per-slot keys.
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
