// station-verdict — pure derivations for the station detail view.
//
// Extracted from views/station.js so the view shrinks to fetch
// sequencing + DOM mutation, and the derivations stay fixture-testable
// in isolation. Byte-identical behaviour to the inline originals.

// Pull the friendliest single image URL from a Describe.ashx body[0].
// TuneIn's Describe sometimes provides `logo` (square preferred), and
// Browse responses use `image`. Either may be HTTP or HTTPS.
export function pickArt(stationBody) {
  if (!stationBody || typeof stationBody !== 'object') return '';
  const url = stationBody.logo || stationBody.image || '';
  return typeof url === 'string' ? url : '';
}

// Build the metadata strip text from a Describe body. Filters empty
// fields so we don't render lonely separators.
export function buildMetaText(stationBody) {
  if (!stationBody || typeof stationBody !== 'object') return '';
  const parts = [];
  if (stationBody.location) parts.push(stationBody.location);
  if (stationBody.language) parts.push(stationBody.language);
  if (stationBody.genre_name) parts.push(stationBody.genre_name);
  if (stationBody.frequency && stationBody.band) {
    parts.push(`${stationBody.frequency} ${stationBody.band}`);
  } else if (stationBody.frequency) {
    parts.push(String(stationBody.frequency));
  }
  return parts.join(' . ');
}

// Pick the "best" stream for the verdict pill: highest bitrate.
// Defensive — bitrate may be a string or missing on real TuneIn data.
export function bestStream(streams) {
  if (!Array.isArray(streams) || streams.length === 0) return null;
  const score = (s) => {
    const b = Number(s && s.bitrate);
    return Number.isFinite(b) ? b : -1;
  };
  let best = streams[0];
  for (const s of streams) if (score(s) > score(best)) best = s;
  return best;
}

export function fmtCodec(stream) {
  if (!stream) return '';
  const codec = stream.media_type || stream.formats || '';
  return typeof codec === 'string' ? codec.toUpperCase() : '';
}

export function fmtReliability(stream) {
  const r = Number(stream && stream.reliability);
  return Number.isFinite(r) && r > 0 ? `${r}%` : '';
}
