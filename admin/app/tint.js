// Sample a dominant colour from album art and expose it as --np-tint
// on the now-playing root, so the hero gradient can pick up a tint
// from what's playing.
//
// Pure-function core: dominantColor(imageData) → {r, g, b}
// Browser shim: applyTint(imgElement) — draws to an offscreen canvas
// and writes the CSS custom property.

const BINS_PER_AXIS = 8;
const BIN_SIZE = 256 / BINS_PER_AXIS;
const SAMPLE_SIZE = 32;

export function dominantColor(imageData) {
  const data = imageData && imageData.data;
  if (!data || data.length < 4) return { r: 0, g: 0, b: 0 };

  const counts = new Uint32Array(BINS_PER_AXIS * BINS_PER_AXIS * BINS_PER_AXIS);
  const sumR = new Uint32Array(counts.length);
  const sumG = new Uint32Array(counts.length);
  const sumB = new Uint32Array(counts.length);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a === 0) continue;
    const br = (r / BIN_SIZE) | 0;
    const bg = (g / BIN_SIZE) | 0;
    const bb = (b / BIN_SIZE) | 0;
    const idx = (br * BINS_PER_AXIS + bg) * BINS_PER_AXIS + bb;
    counts[idx]++;
    sumR[idx] += r;
    sumG[idx] += g;
    sumB[idx] += b;
  }

  let bestIdx = 0;
  let bestCount = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > bestCount) {
      bestCount = counts[i];
      bestIdx = i;
    }
  }

  if (bestCount === 0) return { r: 0, g: 0, b: 0 };

  return {
    r: Math.round(sumR[bestIdx] / bestCount),
    g: Math.round(sumG[bestIdx] / bestCount),
    b: Math.round(sumB[bestIdx] / bestCount),
  };
}

// djb2-ish hash → hue in [0,360). Cheap, plenty of spread for our
// inputs (a few dozen station names). Shared by art.js (initial-letter
// avatar fallback) and views/station.js (per-station gradient CTAs).
export function hashHue(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

// CSS linear-gradient string keyed off hashHue(name). Used by the
// station-detail Test play CTA so each station's gradient is stable
// across reloads. Two stops, fixed saturation/lightness — anything
// fancier should land in tint.js so it stays themeable from one place.
export function stationGradient(name) {
  const hue = hashHue(name);
  const a = `hsl(${hue}, 70%, 48%)`;
  const b = `hsl(${(hue + 35) % 360}, 70%, 38%)`;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function applyTint(imgElement) {
  if (!imgElement || typeof document === 'undefined') return;
  const root = document.querySelector('.np-view');
  if (!root) return;

  const draw = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE_SIZE;
      canvas.height = SAMPLE_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(imgElement, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      // getImageData throws SecurityError on a CORS-tainted canvas — the
      // speaker's /art URL may not include Access-Control-Allow-Origin.
      // Bail silently and leave the existing neutral hero in place.
      const imageData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const { r, g, b } = dominantColor(imageData);
      root.style.setProperty('--np-tint', `rgb(${r}, ${g}, ${b})`);
    } catch (_) {
      /* CORS taint or canvas unavailable — keep neutral hero. */
    }
  };

  if (imgElement.complete && imgElement.naturalWidth > 0) {
    draw();
  } else {
    imgElement.addEventListener('load', draw, { once: true });
  }
}
