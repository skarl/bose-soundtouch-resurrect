# admin/e2e/fixtures

MITM response payloads used by specs that need to observe or simulate
upstream API responses.

| File | Used by | What it simulates |
|------|---------|-------------------|
| `play-placeholder-url.json` | `tests/play.spec.js` | A `/cgi-bin/play` response indicating TuneIn handed back a non-streamable placeholder URL — exercises the error-toast path without needing the speaker to actually receive a broken stream. |

Add new fixtures here when a spec needs a deterministic response that
the live speaker / upstream cannot reliably produce.
