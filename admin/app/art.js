// setArt(imgEl, url, name) — point an <img> at the given URL with a
// graceful fallback. Whatever happens (no URL, broken URL, no network)
// the image renders something: an SVG initial-letter avatar derived
// from `name`. So the strip / cards / detail header never have a
// visually broken slot.
//
// The fallback is an inline data: URI; no extra request, scales to
// any size, rerenderable per-name.

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
  };
  imgEl.src = url || fallbackDataUri(name);
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

// djb2-ish hash → hue in [0,360). Cheap, plenty of spread for our
// inputs (a few dozen station names).
function hashHue(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}
