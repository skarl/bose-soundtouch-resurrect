// Transport key sender. Issues a press/release pair to the speaker's
// /key endpoint. PRESS is sent first, RELEASE follows only after PRESS
// resolves so the firmware registers a clean keydown/keyup sequence.
//
// Throws on non-2xx. Callers let the exception bubble.

import { speakerKey } from './api.js';
import { recordOutgoing } from './io-ledger.js';

// Map key names to io-ledger kinds so wasRecentOutgoing() can attribute
// incoming state changes to the correct outgoing category.
function kindForKey(key) {
  if (/^PRESET_\d+$/.test(key)) return 'preset';
  if (key === 'PLAY' || key === 'PAUSE' || key === 'PREV_TRACK' || key === 'NEXT_TRACK') return 'transport';
  return 'transport';
}

export async function postKey(key) {
  recordOutgoing(kindForKey(key));
  await speakerKey(key, 'press');
  await speakerKey(key, 'release');
}
