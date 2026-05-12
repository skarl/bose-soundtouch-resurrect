// tunein-outline — single home for TuneIn outline element semantics.
//
// Browse / Search / Describe responses are trees of `outline`
// elements (`docs/tunein-api.md` § 2). The render pipeline needs to
// know what each element is for: a station leaf, a drill node, a
// pagination cursor, a sideways "pivot" shortcut, an empty-result
// tombstone, etc. The wire format mixes the signal across three
// fields — `type` (link / text / audio / object / search), `key`
// (`stations`, `nextStations`, `pivotGenre`, …), and `item`
// (`station`, `show`, `topic`) — and clients are expected to fuse
// them. This module is the executable form of that fusion.
//
// Four pure functions:
//
//   classifyOutline(entry) → one of:
//       "station" | "show" | "topic" | "drill" | "cursor" |
//       "pivot" | "nav" | "tombstone"
//
//     - "station"   — a playable audio leaf (`type:"audio"`)
//     - "show"      — a `type:"link"` row with `item:"show"`
//     - "topic"     — a `type:"link"` row with `item:"topic"`
//     - "drill"     — any other `type:"link"` row that drills into a
//                     child Browse response (genre `g`, category `c`,
//                     region `r`, artist/song `m`, affiliate `a`)
//     - "cursor"    — pagination cursor (`key.startsWith("next")`)
//     - "pivot"     — cross-cut shortcut (`key.startsWith("pivot")`).
//                     `pivot` outranks `drill` so a pivotLocation row
//                     ends up classified as `pivot`, not `drill`.
//     - "nav"       — `key:"popular"` and similar fixed-axis link rows
//                     that are not pivots but live in the related
//                     section. Renders as a chip alongside pivots.
//     - "tombstone" — a `type:"text"` row signalling an empty result
//                     ("No stations or shows available"). § 6.2.
//
//   normaliseRow(entry, opts) → { id, type, primary, secondary,
//                                 image, badges }
//     The basic shape every renderer can lean on. Slice #79 will
//     extend it with reliability / bitrate / now-playing dedup. For
//     this slice:
//       - id        = guide_id
//       - type      = classifyOutline(entry)
//       - primary   = entry.text
//       - secondary = playing || subtext   (prefer `playing` if both)
//       - image     = entry.image, suffixed to the 145px logo
//                     (§ 10 — `…q.jpg`)
//       - badges    = []   (Slice #79 fills this)
//
//   extractCursor(section) → { url, key } | null
//     Returns the first child of a section whose `key` starts
//     `next`. The cursor URL is the API-emitted form — callers are
//     expected to push it through `canonicaliseBrowseUrl` before
//     fetching.
//
//   extractPivots(section) → [{ url, label, axis }]
//     Returns every child of a section whose `key` starts `pivot`.
//     `axis` is the suffix after `pivot` lowercased (so `pivotName`
//     → `"name"`, `pivotGenre` → `"genre"`, `pivotLocation` →
//     `"location"`).

const TOMBSTONE_TEXT = 'No stations or shows available';

// classifyOutline — the central dispatch. Order matters: cursor and
// pivot detection by `key` prefix wins over the bare `type`, because
// a `type:"link"` row with `key:"nextStations"` is a cursor first and
// a drill second. Tombstones win over the bare `type:"text"`
// fallback.
export function classifyOutline(entry) {
  if (!entry || typeof entry !== 'object') return 'tombstone';
  const key = typeof entry.key === 'string' ? entry.key : '';
  if (key.startsWith('next'))  return 'cursor';
  if (key.startsWith('pivot')) return 'pivot';

  const type = typeof entry.type === 'string' ? entry.type : '';
  if (type === 'text') {
    if ((entry.text || '') === TOMBSTONE_TEXT) return 'tombstone';
    return 'tombstone';
  }
  if (type === 'audio') return 'station';
  if (type === 'link' || type === '') {
    // Containers (section headers) and most drill-into-child rows
    // are `type:"link"`; some hand-rolled or legacy entries omit
    // `type` entirely. Both shapes resolve via `item` / `key` /
    // presence-of-URL.
    const item = typeof entry.item === 'string' ? entry.item : '';
    if (item === 'station') return 'station';
    if (item === 'show')    return 'show';
    if (item === 'topic')   return 'topic';
    // "nav"-shaped link rows in the `related` section carry a known
    // fixed key (e.g. `popular`, `localCountry`). They're not pivots
    // and they're not drill nodes either — they jump into a curated
    // sibling list. Render as a chip alongside pivots.
    if (key === 'popular' || key === 'localCountry') return 'nav';
    // Typeless + URL-less + guide_id-less = no rendering signal at
    // all. Treat as tombstone so callers render a disabled label.
    const hasUrl = typeof entry.URL === 'string' && entry.URL !== '';
    const hasGid = typeof entry.guide_id === 'string' && entry.guide_id !== '';
    if (type === '' && !hasUrl && !hasGid) return 'tombstone';
    return 'drill';
  }
  // `object` (Describe-only) and `search` (head-only) don't appear
  // in the browse render path. Treat them as tombstones so they
  // surface in tests if they ever leak through.
  return 'tombstone';
}

// Suffix-rewrite for TuneIn art URLs. The service emits a base URL
// that resolves to the original; appending `q.jpg` before the
// extension yields the 145×145 variant used everywhere in the
// admin. See § 10 of docs/tunein-api.md.
//
// Idempotent — if the URL already ends in a size suffix, leave it
// alone.
function logoUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  const qIdx = raw.indexOf('?');
  const head = qIdx < 0 ? raw : raw.slice(0, qIdx);
  const tail = qIdx < 0 ? '' : raw.slice(qIdx);
  // Already has a recognised size suffix (`t`/`q`/`d`/`g`)? Leave
  // alone — the service emits all four shapes in different contexts
  // (§ 10 of docs/tunein-api.md).
  if (/[tqdg]\.(?:jpg|png|webp)$/i.test(head)) return raw;
  const dot = head.lastIndexOf('.');
  if (dot < 0) return raw;
  return `${head.slice(0, dot)}q.jpg${tail}`;
}

// Pick the better of {playing, subtext} for the secondary line. The
// spec is explicit (§ 2.4): if `playing` is present, prefer it;
// otherwise fall back to `subtext`. Empty strings count as absent.
function secondaryLineFor(entry) {
  const playing = entry && typeof entry.playing === 'string' && entry.playing !== '' ? entry.playing : '';
  if (playing) return playing;
  const subtext = entry && typeof entry.subtext === 'string' && entry.subtext !== '' ? entry.subtext : '';
  return subtext;
}

// normaliseRow — fold an outline into the shape the renderer wants.
// `opts` is reserved for the polish-slice (#79); accepted-but-unused
// today so the call sites can be locked in now.
export function normaliseRow(entry, _opts) {
  const id = entry && typeof entry.guide_id === 'string' ? entry.guide_id : '';
  const type = classifyOutline(entry);
  const primary = entry && typeof entry.text === 'string' ? entry.text : '';
  const secondary = secondaryLineFor(entry);
  const image = entry && typeof entry.image === 'string' ? logoUrl(entry.image) : '';
  return { id, type, primary, secondary, image, badges: [] };
}

// extractCursor — find the `next*` child within a section. Returns
// the first match (sections only carry one cursor in practice).
export function extractCursor(section) {
  const kids = section && Array.isArray(section.children) ? section.children : [];
  for (const c of kids) {
    const k = c && typeof c.key === 'string' ? c.key : '';
    if (k.startsWith('next')) {
      const url = typeof c.URL === 'string' ? c.URL : '';
      return { url, key: k };
    }
  }
  return null;
}

// extractPivots — collect every `pivot*` child of a section. The
// `related` section is where these live; other sections rarely
// carry them but we don't filter by section name.
export function extractPivots(section) {
  const kids = section && Array.isArray(section.children) ? section.children : [];
  const out = [];
  for (const c of kids) {
    const k = c && typeof c.key === 'string' ? c.key : '';
    if (!k.startsWith('pivot')) continue;
    const axis = k.slice('pivot'.length).toLowerCase();
    out.push({
      url:   typeof c.URL === 'string' ? c.URL : '',
      label: typeof c.text === 'string' ? c.text : '',
      axis,
    });
  }
  return out;
}
