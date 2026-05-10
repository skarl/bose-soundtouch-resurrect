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
