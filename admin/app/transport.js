// Transport key sender. Issues a press/release pair to the speaker's
// /key endpoint. PRESS is sent first, RELEASE follows only after PRESS
// resolves so the firmware registers a clean keydown/keyup sequence.
//
// Throws on non-2xx. Callers let the exception bubble (no toast in
// slice 4; slice 8 wires the toast layer).

import { speakerKey } from './api.js';

export async function postKey(key) {
  await speakerKey(key, 'press');
  await speakerKey(key, 'release');
}

// Throttled-coalesce volume sender.
//
// makeVolumeSender(postFn) returns { setVolume, confirm }.
//
// setVolume(level) — at most one postFn(level) in flight at a time.
//   While a POST is in flight, any subsequent calls queue only the
//   *latest* target. After the POST resolves, if a newer level is
//   queued, exactly one more POST fires (trailing-coalesce). Intermediate
//   values between the in-flight and the trailing call are dropped.
//
// confirm(actualVolume) — called by the WS volumeUpdated handler when
//   the speaker reports its actual volume. Suppresses the next setVolume()
//   call if the requested level equals the confirmed actual, preventing
//   a redundant round-trip POST after a WS reconcile.
//
// postFn is injected so callers (and tests) can substitute a fake.
export function makeVolumeSender(postFn) {
  let inFlight    = false;   // true while a POST is awaiting response
  let queued      = null;    // last level received during in-flight; null = none
  let confirmed   = null;    // last actualVolume reported via confirm()

  async function flush(level) {
    inFlight = true;
    try {
      await postFn(level);
    } finally {
      inFlight = false;
      // If a newer target arrived while we were posting, send it now.
      if (queued !== null) {
        const next = queued;
        queued = null;
        await flush(next);
      }
    }
  }

  function setVolume(level) {
    // Suppress if the speaker already confirmed this exact level.
    if (confirmed !== null && level === confirmed) return;
    if (inFlight) {
      queued = level;   // coalesce: only the latest queued value matters
      return;
    }
    flush(level);
  }

  function confirm(actualVolume) {
    confirmed = actualVolume;
  }

  return { setVolume, confirm };
}
