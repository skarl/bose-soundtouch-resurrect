// Tests for app/tunein-drill.js — the one-shot drill resolver.
//
// One fixture per row of the classification table in issue #122. Each
// test injects a scripted fetcher via `opts.fetch` so the resolver
// never reaches `globalThis.fetch`; the tests assert kind + payload
// against the documented contract.
//
// Run: node --test admin/test

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { resolveBrowseDrill } = await import('../app/tunein-drill.js');

// Build a one-shot fetcher that resolves with the supplied value and
// records every call. Tests assert the recorded args to make sure the
// resolver passes `parts` through verbatim.
function scriptedResolve(value) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return value;
  };
  fn.calls = calls;
  return fn;
}

// Build a one-shot fetcher that rejects with the supplied error.
function scriptedReject(err) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    throw err;
  };
  fn.calls = calls;
  return fn;
}

// --- transport throws -----------------------------------------------

test('resolveBrowseDrill returns kind:error when the fetcher throws a TimeoutError', async () => {
  const timeout = Object.assign(new Error('drill timed out after 15000ms'), {
    name: 'TimeoutError',
  });
  const fetch = scriptedReject(timeout);
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'error');
  assert.equal(r.error.code, 'TIMEOUT');
  assert.match(r.error.message, /timed out/i);
});

test('resolveBrowseDrill returns kind:error when the fetcher throws a network error', async () => {
  const fetch = scriptedReject(new Error('failed to fetch'));
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'error');
  assert.equal(r.error.code, 'ERROR');
  assert.equal(r.error.message, 'failed to fetch');
});

test('resolveBrowseDrill returns kind:error when the fetcher throws an HTTP-5xx-mapped Error', async () => {
  // getJson maps non-2xx to `throw new Error(`${path} failed: HTTP ${res.status}`)`.
  const fetch = scriptedReject(new Error('/tunein/browse failed: HTTP 502'));
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'error');
  assert.equal(r.error.code, 'ERROR');
  assert.match(r.error.message, /HTTP 502/);
});

test('resolveBrowseDrill returns kind:error when the fetcher throws a non-Error value', async () => {
  // Defence: a malformed throw shouldn't crash the resolver.
  const fetch = async () => { throw 'boom'; };
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'error');
  assert.equal(r.error.code, 'ERROR');
});

// --- structured envelope `{ok:false, error:{code, message}}` --------

test('resolveBrowseDrill maps the CGI structured envelope to kind:error verbatim', async () => {
  const fetch = scriptedResolve({
    ok: false,
    error: { code: 'UPSTREAM_UNREACHABLE', message: 'speaker unreachable' },
  });
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'error');
  assert.equal(r.error.code, 'UPSTREAM_UNREACHABLE');
  assert.equal(r.error.message, 'speaker unreachable');
});

test('resolveBrowseDrill backfills missing fields on a partial structured envelope', async () => {
  const fetch = scriptedResolve({ ok: false, error: { code: '', message: '' } });
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'error');
  assert.equal(r.error.code, 'ERROR');
  assert.equal(r.error.message, 'ERROR');
});

// --- raw upstream-fetch-failure body `{error:"..."}` ----------------

test('resolveBrowseDrill maps the raw `{error:"..."}` body to UPSTREAM_FETCH_FAILED', async () => {
  // The busybox-shell CGI emits this exact body when its `wget` call
  // against opml.radiotime.com fails. No `ok` key — only `error` as a
  // bare string.
  const fetch = scriptedResolve({ error: 'upstream fetch failed' });
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'error');
  assert.equal(r.error.code, 'UPSTREAM_FETCH_FAILED');
  assert.equal(r.error.message, 'upstream fetch failed');
});

// --- head.status non-200 + body:[] (TuneIn-rejected drill) ----------

test('resolveBrowseDrill maps head.status!="200" + body:[] to kind:empty with the head.fault message', async () => {
  // The c=pbrowse-on-Bo-egress shape — issue #84. The CGI is 200 but
  // TuneIn rejected the drill; head carries the fault.
  const fetch = scriptedResolve({
    head: { status: '400', fault: 'Invalid root category' },
    body: [],
  });
  const r = await resolveBrowseDrill({ c: 'pbrowse', id: 'p17' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'Invalid root category');
});

test('resolveBrowseDrill tolerates numeric head.status when discriminating non-200', async () => {
  const fetch = scriptedResolve({
    head: { status: 400, fault: 'Bad something' },
    body: [],
  });
  const r = await resolveBrowseDrill({ id: 'whatever' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'Bad something');
});

test('resolveBrowseDrill maps head.status!="200" + body:[] with no fault to the fallback message', async () => {
  const fetch = scriptedResolve({ head: { status: '500' }, body: [] });
  const r = await resolveBrowseDrill({ id: 'x' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'Nothing here.');
});

// --- body:[] with head.status 200 -----------------------------------

test('resolveBrowseDrill maps body:[] with head.status 200 to kind:empty with the fallback message', async () => {
  const fetch = scriptedResolve({
    head: { title: 'Music', status: '200' },
    body: [],
  });
  const r = await resolveBrowseDrill({ c: 'music' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'Nothing here.');
});

test('resolveBrowseDrill maps body:[] with absent head.status to the fallback message', async () => {
  // Defence: a body-empty response with no head at all should still
  // produce the empty state, not crash.
  const fetch = scriptedResolve({ body: [] });
  const r = await resolveBrowseDrill({ id: 'x' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'Nothing here.');
});

test('resolveBrowseDrill treats a response with no body array as empty', async () => {
  // A malformed payload (e.g. `null` or `{head:…}` with no body)
  // should land on empty rather than ok, otherwise renderOutline would
  // run against a missing `.body` array.
  const fetch = scriptedResolve({ head: { status: '200' } });
  const r = await resolveBrowseDrill({ id: 'x' }, { fetch });
  assert.equal(r.kind, 'empty');
});

// --- single-entry tombstone body ------------------------------------

test('resolveBrowseDrill maps a single-entry tombstone body to kind:empty with the tombstone text', async () => {
  // The c=lang/l117 (Welsh) response shape — exists at fixtures/api/
  // c424724-l117-tombstone.tunein.json.
  const fetch = scriptedResolve({
    head: { title: 'Music', status: '200' },
    body: [
      { element: 'outline', type: 'text', text: 'No stations or shows available' },
    ],
  });
  const r = await resolveBrowseDrill({ c: 'music', filter: 'l117' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'No stations or shows available');
});

test('resolveBrowseDrill falls back to "Nothing here." when the tombstone has no text', async () => {
  const fetch = scriptedResolve({
    head: { status: '200' },
    body: [{ type: 'text' }],
  });
  const r = await resolveBrowseDrill({ id: 'x' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'Nothing here.');
});

test('resolveBrowseDrill does NOT treat a section wrapper with children as a tombstone', async () => {
  // A typeless+keyless wrapper with children classifies as tombstone
  // under the fallback rule, but it carries real rows below it. The
  // resolver must hand the wrapper through on the ok path so renderOutline
  // can mount the section.
  const fetch = scriptedResolve({
    head: { title: 'X', status: '200' },
    body: [
      {
        text: 'Stations',
        key: 'stations',
        children: [
          { type: 'audio', guide_id: 's1', text: 'One' },
        ],
      },
    ],
  });
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'ok');
  assert.ok(r.json && Array.isArray(r.json.body) && r.json.body.length === 1);
});

// --- ok path --------------------------------------------------------

test('resolveBrowseDrill maps a populated multi-section body to kind:ok with the raw json', async () => {
  const json = {
    head: { title: 'Folk', status: '200' },
    body: [
      {
        text: 'Stations', key: 'stations',
        children: [{ type: 'audio', guide_id: 's1', text: 'One' }],
      },
      {
        text: 'Shows', key: 'shows',
        children: [{ type: 'link', item: 'show', guide_id: 'p1', text: 'A Show' }],
      },
    ],
  };
  const fetch = scriptedResolve(json);
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'ok');
  assert.equal(r.json, json, 'ok path returns the raw json by reference');
});

test('resolveBrowseDrill maps a flat-row populated body to kind:ok', async () => {
  const json = {
    head: { title: 'Stations only', status: '200' },
    body: [
      { type: 'audio', guide_id: 's1', text: 'One' },
      { type: 'audio', guide_id: 's2', text: 'Two' },
    ],
  };
  const fetch = scriptedResolve(json);
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'ok');
  assert.equal(r.json, json);
});

test('resolveBrowseDrill maps a body containing a tombstone alongside real rows to kind:ok', async () => {
  // The single-tombstone rule requires length===1 — a tombstone mixed
  // with real rows is just one row; the renderer handles it.
  const json = {
    head: { status: '200' },
    body: [
      { type: 'text', text: 'No stations or shows available' },
      { type: 'audio', guide_id: 's1', text: 'A real row' },
    ],
  };
  const fetch = scriptedResolve(json);
  const r = await resolveBrowseDrill({ id: 'g79' }, { fetch });
  assert.equal(r.kind, 'ok');
});

// --- parts pass-through ---------------------------------------------

test('resolveBrowseDrill forwards parts to the fetcher verbatim', async () => {
  const json = {
    head: { status: '200' },
    body: [{ type: 'audio', guide_id: 's1', text: 'One' }],
  };
  const fetch = scriptedResolve(json);
  const parts = { c: 'music', filter: 'l109' };
  await resolveBrowseDrill(parts, { fetch });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0][0], parts, 'first arg passed by reference');
});

// --- fixture-driven: tombstone payload via captured fixture ---------
//
// One end-to-end fixture wire — the captured c=music/filter=l117 (Welsh)
// response. This was previously asserted by renderOutline's tombstone
// test; the classification has moved upstream of renderOutline so the
// fixture parity assertion moves here.

test('resolveBrowseDrill on the captured Welsh tombstone fixture → kind:empty', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve('admin/test/fixtures/api/c424724-l117-tombstone.tunein.json'),
      'utf8',
    ),
  );
  const fetch = scriptedResolve(fixture);
  const r = await resolveBrowseDrill({ c: 'music', filter: 'l117' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'No stations or shows available');
});

test('resolveBrowseDrill on the captured p17-pbrowse-invalid fixture → kind:empty with head.fault', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve('admin/test/fixtures/api/p17-pbrowse-invalid.tunein.json'),
      'utf8',
    ),
  );
  const fetch = scriptedResolve(fixture);
  const r = await resolveBrowseDrill({ c: 'pbrowse', id: 'p17' }, { fetch });
  assert.equal(r.kind, 'empty');
  assert.equal(r.message, 'Invalid root category');
});
