// tunein-drill — one-shot TuneIn drill resolver.
//
// Owns the fetch policy for a single Browse.ashx drill: transport,
// structured-error envelopes, empty / tombstone classification, and the
// head.status discrimination that turns "TuneIn rejected the drill but
// the CGI still returned 200" (e.g. c=pbrowse on Bo's egress, see
// issue #84) into the empty state. Before this seam those branches were
// scattered across browse.js renderDrill, show-landing.js, and
// renderOutline's body-emptiness check; the seam concentrates them so
// the renderer sees a tagged DrillResult rather than a raw JSON envelope
// that could be a payload, an empty state, or a structured error.
//
// Contract:
//
//   resolveBrowseDrill(parts, opts?) -> Promise<DrillResult>
//
//   DrillResult =
//     | { kind: 'ok',    json }
//     | { kind: 'empty', message }
//     | { kind: 'error', error: { code, message } }
//
// Classification (matches the table in issue #122):
//
//   - `fetch` throws (timeout / CGI 5xx / network)
//       → { kind: 'error', error: { code, message } }
//   - body is `{ ok: false, error: { code, message } }`
//       → { kind: 'error', error: { code, message } }  (pass-through)
//   - body is raw `{ error: "..." }` (wget upstream-fetch failure)
//       → { kind: 'error', error: { code: 'UPSTREAM_FETCH_FAILED', message } }
//   - `head.status` is non-200 AND `body:[]` (TuneIn rejected drill,
//     e.g. c=pbrowse on Bo's egress)
//       → { kind: 'empty', message }
//   - `body:[]` with head.status 200
//       → { kind: 'empty', message: 'Nothing here.' }
//   - single-entry body whose only row classifies as tombstone AND
//     carries no children
//       → { kind: 'empty', message: entry.text || 'Nothing here.' }
//   - otherwise
//       → { kind: 'ok', json }
//
// Caching of drill bodies is intentionally out of scope (see #122 body).
// The label cache continues to be primed downstream by the renderer's
// row pipeline.

import { tuneinBrowse } from './api.js';
import { classifyOutline } from './tunein-outline.js';

const FALLBACK_EMPTY_MESSAGE = 'Nothing here.';

// The error code the CGI's raw `{"error":"..."}` body maps to. The
// busybox-shell tunein CGI emits this exact body when its `wget` call
// against opml.radiotime.com fails (network down, DNS, etc.) — see
// admin/cgi-bin/api/v1/tunein. The shape pre-dates the structured
// envelope and only the tunein route still emits it, so we recognise
// it here rather than promote it to the CGI-shared envelope schema.
const UPSTREAM_FETCH_FAILED = 'UPSTREAM_FETCH_FAILED';

// Pull a usable head.status string out of the response head. Empty
// when missing / non-string. Numeric statuses are coerced to string so
// the comparison against '200' is reliable regardless of upstream
// shape drift.
function headStatus(json) {
  const head = json && typeof json === 'object' ? json.head : null;
  if (!head || typeof head !== 'object') return '';
  const s = head.status;
  if (typeof s === 'string') return s;
  if (typeof s === 'number' && Number.isFinite(s)) return String(s);
  return '';
}

// Pull a usable head.title / head.fault string for the empty-state
// message when TuneIn rejects the drill. Prefer `fault` (the rejection
// reason, e.g. "Invalid root category") over `title` (often "Music" or
// the request's category label, which carries no signal about why the
// drill came back empty). Final fallback is FALLBACK_EMPTY_MESSAGE so
// the user always sees something readable.
function headFaultMessage(json) {
  const head = json && typeof json === 'object' ? json.head : null;
  if (head && typeof head === 'object') {
    if (typeof head.fault === 'string' && head.fault !== '') return head.fault;
  }
  return FALLBACK_EMPTY_MESSAGE;
}

// Recognise the CGI's structured `{ok:false, error:{code, message}}`
// envelope. Returns the normalised `{code, message}` pair when the
// envelope matches, null otherwise.
function pickStructuredError(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.ok !== false) return null;
  const err = json.error;
  if (!err || typeof err !== 'object') return null;
  const code = typeof err.code === 'string' && err.code !== ''
    ? err.code
    : 'ERROR';
  const message = typeof err.message === 'string' && err.message !== ''
    ? err.message
    : code;
  return { code, message };
}

// Recognise the raw `{ "error": "<text>" }` body the busybox CGI emits
// on upstream wget failure. Returns the normalised error pair (with a
// stable code) when matched, null otherwise. Defensive against the
// structured-error envelope above — only triggers when `error` is a
// bare string AND `ok` is absent.
function pickRawError(json) {
  if (!json || typeof json !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(json, 'ok')) return null;
  const e = json.error;
  if (typeof e !== 'string' || e === '') return null;
  return { code: UPSTREAM_FETCH_FAILED, message: e };
}

// Normalise an error thrown by the fetcher (timeout, CGI 5xx, network).
// fetchWithTimeout decorates timeouts with `name === 'TimeoutError'`;
// every other throw lands here as a bare Error. Returns the
// `{code, message}` pair the DrillResult contract expects.
function normaliseThrownError(err) {
  if (!err) {
    return { code: 'ERROR', message: 'Unknown error' };
  }
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'TimeoutError') {
    return {
      code: 'TIMEOUT',
      message: typeof err.message === 'string' && err.message
        ? err.message
        : 'Drill fetch timed out',
    };
  }
  const message = typeof err.message === 'string' && err.message
    ? err.message
    : String(err);
  return { code: 'ERROR', message };
}

// True when this is the canonical "single tombstone" body shape: one
// top-level entry that classifies as tombstone AND carries no children.
// A section header with children (e.g. an empty `local` wrapper) can
// also classify as tombstone via the typeless fallback, so we guard on
// children-absence to keep section-bearing payloads on the `ok` path
// (per-section emptiness is renderOutline's job).
function isSingleTombstone(items) {
  if (!Array.isArray(items) || items.length !== 1) return false;
  const only = items[0];
  if (classifyOutline(only) !== 'tombstone') return false;
  if (only && Array.isArray(only.children) && only.children.length > 0) {
    return false;
  }
  return true;
}

// resolveBrowseDrill — fetch + classify a single Browse.ashx drill.
//
// `parts` is the same shape browse.js renderDrill already constructs:
// either `{ id: '<guide_id>' }` for bare-id drills, or `{ c: 'music',
// filter: 'l109' }` for the c-style top-level (URLSearchParams handles
// both). `tuneinBrowse(parts)` is the existing fetcher; it returns the
// raw TuneIn JSON body and throws on transport / non-2xx.
//
// `opts.fetch` lets tests dependency-inject a scripted fetcher so the
// classification table is exercised without going through `globalThis
// .fetch`. Default is the production tuneinBrowse.
export async function resolveBrowseDrill(parts, opts) {
  const fetchDrill = (opts && typeof opts.fetch === 'function')
    ? opts.fetch
    : tuneinBrowse;

  let json;
  try {
    json = await fetchDrill(parts);
  } catch (err) {
    return { kind: 'error', error: normaliseThrownError(err) };
  }

  // Structured envelope — pass code / message through verbatim. Order
  // matters: the structured envelope sets `ok:false`, so this must run
  // before the raw `{error:'...'}` check which only triggers when `ok`
  // is absent.
  const structured = pickStructuredError(json);
  if (structured) return { kind: 'error', error: structured };

  // Raw wget-failure envelope from the busybox CGI.
  const raw = pickRawError(json);
  if (raw) return { kind: 'error', error: raw };

  const body = json && Array.isArray(json.body) ? json.body : [];

  // head.status non-200 with body:[] — TuneIn rejected the drill but
  // the CGI still surfaced a 200. The head.fault carries the reason
  // (e.g. "Invalid root category" for c=pbrowse on Bo's egress).
  if (body.length === 0) {
    const status = headStatus(json);
    if (status !== '' && status !== '200') {
      return { kind: 'empty', message: headFaultMessage(json) };
    }
    return { kind: 'empty', message: FALLBACK_EMPTY_MESSAGE };
  }

  // Single-entry tombstone — the canonical "No stations or shows
  // available" body shape (§ 6.2). A section wrapper with children is
  // not a tombstone even when classifyOutline tags it that way.
  if (isSingleTombstone(body)) {
    const text = (body[0] && typeof body[0].text === 'string' && body[0].text !== '')
      ? body[0].text
      : FALLBACK_EMPTY_MESSAGE;
    return { kind: 'empty', message: text };
  }

  return { kind: 'ok', json };
}
