// setArt(imgEl, url, name) — point an <img> at the given URL with a
// graceful fallback. Whatever happens (no URL, broken URL, no network)
// the image renders something: an SVG initial-letter avatar derived
// from `name`. So the strip / cards / detail header never have a
// visually broken slot.
//
// The fallback is an inline data: URI; no extra request, scales to
// any size, rerenderable per-name.

import { applyTint, hashHue } from './tint.js';

export function setArt(imgEl, url, name) {
  if (!imgEl) return;
  imgEl.alt = name || '';
  imgEl.removeAttribute('hidden');
  imgEl.onerror = () => {
    // Belt-and-braces: detach the handler before swapping src so a
    // failing fallback (impossible — it's a data URI — but still)
    // can't loop.
    imgEl.onerror = null;
    imgEl.src = fallbackDataUri(name);
    applyTint(imgEl);
  };
  imgEl.src = url || fallbackDataUri(name);
  applyTint(imgEl);
}

// Single-color placeholder. Hue is derived from the name so the same
// station always gets the same color across reloads / polls; only
// nameless slots roll the dice afresh on each render.
function fallbackDataUri(name) {
  const trimmed = (name || '').trim();
  const hue = trimmed ? hashHue(trimmed) : Math.floor(Math.random() * 360);
  const fill = `hsl(${hue}, 55%, 70%)`;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      `<rect fill="${fill}" width="100" height="100"/>` +
    '</svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

