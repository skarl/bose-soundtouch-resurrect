// reshape — TuneIn JSON classifier + Bose-shape generator.
//
// Two exports, both pure functions:
//
//   classify(tuneinJson) → { kind, streams?, reason? }
//     'playable' — at least one usable stream URL
//     'gated'    — placeholder URL contains 'notcompatible' (client gated)
//     'dark'     — placeholder URL contains 'nostream' (off-air)
//
//   reshape(tuneinJson, sid, name) → object | null
//     The per-station Bose JSON the speaker firmware expects under
//     /bmx/tunein/v1/playback/station/<sid>. Returns null when no
//     compatible streams remain — mirrors resolver/build.py:make_bose.
//
// This module is the JS twin of resolver/build.py:make_bose. The two
// implementations MUST agree; admin/test/test_reshape.js and
// resolver/test_build.py assert that against shared fixtures and CI
// fails if drift is introduced.
//

const NOT_COMPATIBLE = 'notcompatible';
const NO_STREAM = 'nostream';

// Filter a TuneIn body[] down to entries the *UI* considers playable.
// More aggressive than make_bose's filter — also drops `nostream`
// placeholders so the verdict pill doesn't claim a dark station has 1
// stream. reshape() below stays byte-identical to make_bose; this
// helper is only used by classify().
function filterPlayable(body) {
  if (!Array.isArray(body)) return [];
  return body.filter((entry) => {
    const url = (entry && typeof entry.url === 'string') ? entry.url : '';
    return url && !url.includes(NOT_COMPATIBLE) && !url.includes(NO_STREAM);
  });
}

export function classify(tuneinJson) {
  const body = (tuneinJson && Array.isArray(tuneinJson.body)) ? tuneinJson.body : [];
  const firstUrl = (body[0] && typeof body[0].url === 'string') ? body[0].url : '';
  const streams = filterPlayable(body);

  // Any usable stream → playable, even if the first slot is a
  // notcompatible placeholder ahead of a real fallback URL. This
  // matches resolver/build.py:make_bose, which keeps non-notcompatible
  // entries regardless of position.
  if (streams.length > 0) {
    return { kind: 'playable', streams };
  }

  // No usable stream. Inspect the first placeholder URL to distinguish
  // gated (client-side block) from dark (station off-air).
  if (firstUrl.includes(NOT_COMPATIBLE)) {
    return { kind: 'gated', reason: firstUrl };
  }
  if (firstUrl.includes(NO_STREAM)) {
    return { kind: 'dark', reason: firstUrl };
  }
  // Empty / unrecognised body. Treat as dark so the view's render
  // branch stays total — gives the user a non-cryptic message.
  return { kind: 'dark', reason: firstUrl };
}

// Build the Bose-shaped JSON object the speaker reads from
// /bmx/tunein/v1/playback/station/<sid>. Byte-equivalent to
// resolver/build.py:make_bose for any (tunein, sid, name) input.
//
// Returns null when there are no compatible streams (matching
// make_bose's `return None` path).
export function reshape(tuneinJson, sid, name) {
  const body = (tuneinJson && Array.isArray(tuneinJson.body)) ? tuneinJson.body : [];

  const streams = [];
  for (const entry of body) {
    const url = (entry && typeof entry.url === 'string') ? entry.url : '';
    if (!url || url.includes(NOT_COMPATIBLE)) continue;
    streams.push({
      bufferingTimeout: 20,
      connectingTimeout: 10,
      hasPlaylist: true,
      isRealtime: true,
      streamUrl: url,
      maxTimeout: 60,
    });
  }
  if (streams.length === 0) return null;

  return {
    _links: {
      bmx_reporting: {
        href: `/v1/report?stream_id=e0&guide_id=${sid}&listen_id=0&stream_type=liveRadio`,
      },
      bmx_favorite: { href: `/v1/favorite/${sid}` },
      bmx_nowplaying: {
        href: `/v1/now-playing/station/${sid}`,
        useInternalClient: 'ALWAYS',
      },
    },
    audio: {
      hasPlaylist: true,
      isRealtime: true,
      maxTimeout: 60,
      streamUrl: streams[0].streamUrl,
      streams,
    },
    imageUrl: '',
    isFavorite: false,
    name,
    streamType: 'liveRadio',
  };
}
