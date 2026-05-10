// Pure-function a11y helpers — formatters and key handlers without DOM
// dependencies, so they're trivially testable under node --test.

// "Volume 32 of 100" / "Volume 32 of 100, muted". Speakers also use this
// shape for bass/balance, where the level is signed and the suffix is
// dropped. Used by the now-playing slider + audio settings sliders so
// screen readers announce the same wording everywhere.
export function formatVolumeValueText(level, max, muted) {
  return `Volume ${level} of ${max}${muted ? ', muted' : ''}`;
}

export function formatBassValueText(level, min, max) {
  return `Bass ${level} (range ${min} to ${max})`;
}

export function formatBalanceValueText(level, min, max) {
  if (level === 0) return 'Balance centred';
  if (level < 0)  return `Balance left ${-level} of ${-min}`;
  return `Balance right ${level} of ${max}`;
}

// Roving-tabindex advance — given the current index and the keyboard
// event key, return the new index. Wraps at the ends; Home/End jump.
// Returns the input index when the key isn't a navigation key (so the
// caller can detect "no-op").
export function rovingFocus(length, currentIndex, key) {
  if (length <= 0) return -1;
  const i = Math.max(0, Math.min(length - 1, currentIndex));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':  return (i + 1) % length;
    case 'ArrowLeft':
    case 'ArrowUp':    return (i - 1 + length) % length;
    case 'Home':       return 0;
    case 'End':        return length - 1;
    default:           return i;
  }
}
