// tunein-sid — single source of truth for TuneIn guide_id prefix routing.
//
// The s/p/t/c/g/r/m/a/l/n prefix is the most-used piece of domain
// knowledge in the 0.4.2 surface — it decides whether a row gets a
// Play icon, where its href points, and which view a `/station/<sid>`
// URL redirects to. Until #92 it lived in three places (components.js,
// main.js, search.js) with slightly different validation in each.
//
// `parseSid` is the canonical entry point — pass a sid, get back the
// prefix, the human-ish kind name, whether it plays, and the two href
// variants (drill = browse with bare id; detail = the canonical view
// for the prefix). `isValidSid` and `isPlayableSid` are thin shims
// around the same parser for callers that only need a yes/no.
//
// Adding a new prefix means adding one entry to KINDS (and to PLAYABLE
// if the prefix resolves to a stream). Every surface picks it up.

const KINDS = {
  s: 'station',
  p: 'show',
  t: 'topic',
  c: 'category',
  g: 'genre',
  r: 'region',
  m: 'misc',
  a: 'audio',
  l: 'language',
  n: 'network',
};

const PLAYABLE = new Set(['s', 'p', 't']);

function digitTail(sid) {
  for (let i = 1; i < sid.length; i++) {
    const c = sid.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

export function isValidSid(sid) {
  if (typeof sid !== 'string' || sid.length < 2) return false;
  if (!KINDS[sid.charAt(0)]) return false;
  return digitTail(sid);
}

export function isPlayableSid(sid) {
  if (!isValidSid(sid)) return false;
  return PLAYABLE.has(sid.charAt(0));
}

// `parseSid` always returns the same shape so callers can destructure
// without null-guarding. For invalid input every field is null/false
// — a defensive default that collapses to "#" or "no-op" in the UI
// rather than emitting a route that would 404.
export function parseSid(sid) {
  if (!isValidSid(sid)) {
    return { prefix: null, kind: null, isPlayable: false, drillHref: null, detailHref: null };
  }
  const prefix = sid.charAt(0);
  const enc = encodeURIComponent(sid);
  const drillHref = `#/browse?id=${enc}`;
  let detailHref;
  switch (prefix) {
    case 's':
      detailHref = `#/station/${enc}`;
      break;
    case 'p':
      // c=pbrowse so the browse view's show-landing dispatch (#84)
      // mounts the Describe-driven hero. Without it the bare-id path
      // falls into the generic drill and the show metadata vanishes.
      detailHref = `#/browse?c=pbrowse&id=${enc}`;
      break;
    case 't':
      detailHref = drillHref;
      break;
    default:
      // Non-playable prefixes (g / c / r / m / a / l / n) are drill-
      // only — they aren't valid targets for a row's detail anchor.
      // Callers that need a navigable href for them use drillHref;
      // detail callers (stationRow, redirectHashForStation) collapse
      // to the no-op anchor.
      detailHref = null;
      break;
  }
  return {
    prefix,
    kind: KINDS[prefix],
    isPlayable: PLAYABLE.has(prefix),
    drillHref,
    detailHref,
  };
}
