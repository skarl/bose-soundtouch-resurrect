// CGI error envelope → user-facing toast text.
//
// The /play, /preview, /presets CGIs all return one of these shapes on
// failure (the new, 0.4.2-onwards shape):
//   { ok: false, error: { code: "OFF_AIR", message: "..." } }
//
// During the 0.4.2 rollout window, the SPA may also encounter the
// pre-0.4.2 flat envelope from a stale /play CGI on the speaker:
//   { ok: false, error: "off-air" }
//
// cgiErrorMessage() absorbs both shapes so callers don't have to fork
// on the envelope version. Pass the entire envelope (the `result`
// object playGuideId / previewStream resolves with) — the function
// pulls `error.code` (object form) or `error` (string form), folds
// the legacy lowercase-kebab codes to their SHOUTY equivalents, and
// looks the result up in the message table.
//
// Returns a short, user-facing English string suitable for showToast.
// Falls back to a generic "couldn't play / save" message on unknown
// codes; the structured `error.message` is intentionally NOT surfaced
// to avoid leaking internal HTTP status text into the UI.

// Lowercase-kebab → SHOUTY_SNAKE_CASE alias map. The pre-0.4.2 /play
// CGI emitted the left-hand keys; the new envelope uses the right-hand
// values for every code across all three CGIs.
const LEGACY_CODE_ALIASES = {
  'off-air':         'OFF_AIR',
  'not-available':   'NOT_AVAILABLE',
  'invalid-id':      'INVALID_ID',
  'no-stream':       'NO_STREAM',
  'tune-failed':     'TUNE_FAILED',
  'select-failed':   'SELECT_FAILED',
  'select-rejected': 'SELECT_REJECTED',
  'method-not-allowed': 'METHOD_NOT_ALLOWED',
  'csrf-blocked':    'CSRF_BLOCKED',
  'write-failed':    'WRITE_FAILED',
  'rename-failed':   'RENAME_FAILED',
};

// SHOUTY code → toast text. The phrasing is the original
// PLAY_ERROR_MESSAGES table from components.js / show-hero.js,
// preserved verbatim so the existing test_browse.js assertions
// (which expect "Off-air right now" etc.) keep passing.
const TOAST_MESSAGES = {
  OFF_AIR:              'Off-air right now',
  NOT_AVAILABLE:        'Not available in your region',
  INVALID_ID:           'Cannot play this row',
  NO_STREAM:            'No stream available',
  TUNE_FAILED:          'TuneIn lookup failed',
  SELECT_FAILED:        'Speaker rejected the stream',
  SELECT_REJECTED:      'Speaker rejected the stream',
  STOREPRESET_REJECTED: 'Speaker rejected the preset',
  METHOD_NOT_ALLOWED:   'Method not allowed',
  CSRF_BLOCKED:         'Cross-origin request blocked',
  UPSTREAM_UNREACHABLE: 'Speaker did not respond',
  WRITE_FAILED:         'Could not save resolver entry',
  RENAME_FAILED:        'Could not save resolver entry',
  INVALID_NAME:         'Missing station name',
  INVALID_JSON:         'Malformed stream payload',
  INVALID_SLOT:         'Invalid preset slot',
  INVALID_KIND:         'Unsupported preset kind',
  SLOT_MISMATCH:        'Preset slot mismatch',
  NO_PATH:              'Missing endpoint',
};

const FALLBACK_MESSAGE = 'Could not play this row';

// Pull the SHOUTY code from a CGI envelope. Tolerates:
//   - { error: { code: 'OFF_AIR' } }     → 'OFF_AIR'
//   - { error: 'off-air' }               → 'OFF_AIR' (legacy /play)
//   - { error: 'OFF_AIR' }               → 'OFF_AIR' (defensive)
//   - missing / nullish envelope         → null
// Anything else (number, array, ...) → null.
export function codeFor(envelope) {
  if (!envelope) return null;
  const err = envelope.error;
  if (err == null) return null;
  if (typeof err === 'string') {
    return LEGACY_CODE_ALIASES[err] || err;
  }
  if (typeof err === 'object' && typeof err.code === 'string') {
    return LEGACY_CODE_ALIASES[err.code] || err.code;
  }
  return null;
}

// Map a CGI error envelope to a short user-facing string.
//
//   cgiErrorMessage({ ok: false, error: 'off-air' })           // → 'Off-air right now'
//   cgiErrorMessage({ ok: false, error: { code: 'OFF_AIR' } }) // → 'Off-air right now'
//   cgiErrorMessage({ ok: false, error: { code: 'BOOM' } })    // → fallback
//   cgiErrorMessage(null)                                       // → fallback
export function cgiErrorMessage(envelope) {
  const code = codeFor(envelope);
  if (code && TOAST_MESSAGES[code]) return TOAST_MESSAGES[code];
  return FALLBACK_MESSAGE;
}
