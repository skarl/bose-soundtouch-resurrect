// Optimistic action helper. Applies a local state mutation eagerly,
// fires the POST, and on rejection rolls back the mutation and surfaces
// an error toast. Modelled after the slider controller in sliders.js:
// the slider gives the user instant feedback while a POST is in flight,
// and reconciles via WS. Source-picker taps and preset taps want the
// same shape — they POST blind and rely on a follow-up WS event to
// confirm. Without rollback, a failed POST leaves a stale UI: the pill
// or preset row shows as active even though the speaker never moved.
//
// Reconciliation on success is implicit: the speaker emits its matching
// <nowPlayingUpdated> / <sourcesUpdated> event, which the existing
// dispatch pipeline applies to state, overwriting whatever we wrote
// optimistically. The only path that needs explicit help is the
// rejection path — that's what this helper exists for.

import { store } from './state.js';
import { showToast } from './toast.js';

// runOptimistic({ snapshot, apply, post, rollback, errorMessage })
//   - snapshot()  — return a value capturing the state we will mutate,
//                   so we can restore it on POST rejection.
//   - apply()     — mutate state synchronously; helper will touch
//                   'speaker' so subscribers re-render.
//   - post()      — return a Promise for the wire POST.
//   - rollback(prev) — restore state from the snapshot; helper will
//                      touch 'speaker' again so subscribers re-render
//                      back to the original.
//   - errorMessage — string surfaced via showToast on POST rejection.
//
// The helper rethrows the rejection so callers that want to surface it
// elsewhere (logging, additional UI) can still observe the failure. The
// existing view click handlers already swallow the throw — they get the
// rollback + toast for free without needing further changes.
export async function runOptimistic({ snapshot, apply, post, rollback, errorMessage }) {
  const prev = snapshot();
  apply();
  store.touch('speaker');
  try {
    await post();
  } catch (err) {
    rollback(prev);
    store.touch('speaker');
    showToast(errorMessage || 'Action failed');
    throw err;
  }
}
