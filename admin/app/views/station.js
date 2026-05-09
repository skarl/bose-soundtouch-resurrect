// station — station detail view (#/station/sNNN), slice 4.
//
// On entry:
//   1. Render skeleton immediately (back arrow, name placeholder,
//      "loading metadata...", disabled assign buttons).
//   2. Fetch Describe.ashx via tuneinStation(sid) → fill name,
//      slogan, location/language/format meta. Adds the station to
//      state.caches.recentlyViewed (search.js's empty state reads it).
//   3. Fetch Tune.ashx via tuneinProbe(sid) → classify() the response.
//      Probe results are cached in state.caches.probe for 10 minutes
//      keyed by sid; re-entry within TTL skips the network fetch.
//   4. Render the verdict:
//      - playable: "N streams . best: K kbps CODEC" + assign buttons
//        kept disabled (slice 5 wires the click handlers).
//      - gated/dark: replace assign buttons with a friendly message +
//        a "More like this" link to #/browse.
//
// See admin/PLAN.md § View specs / station detail.

import { html, mount } from '../dom.js';
import { tuneinStation, tuneinProbe } from '../api.js';
import { addRecentlyViewed } from '../state.js';
import { classify } from '../reshape.js';

const PROBE_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const ASSIGN_SLOTS = 6;

// Pull the friendliest single image URL from a Describe.ashx body[0].
// TuneIn's Describe sometimes provides `logo` (square preferred), and
// Browse responses use `image`. Either may be HTTP or HTTPS.
function pickArt(stationBody) {
  if (!stationBody || typeof stationBody !== 'object') return '';
  const url = stationBody.logo || stationBody.image || '';
  return typeof url === 'string' ? url : '';
}

// Build the metadata strip text from a Describe body. Filters empty
// fields so we don't render lonely separators.
function buildMetaText(stationBody) {
  if (!stationBody || typeof stationBody !== 'object') return '';
  const parts = [];
  if (stationBody.location) parts.push(stationBody.location);
  if (stationBody.language) parts.push(stationBody.language);
  if (stationBody.genre_name) parts.push(stationBody.genre_name);
  if (stationBody.frequency && stationBody.band) {
    parts.push(`${stationBody.frequency} ${stationBody.band}`);
  } else if (stationBody.frequency) {
    parts.push(String(stationBody.frequency));
  }
  return parts.join(' . ');
}

// Pick the "best" stream for the verdict pill: highest bitrate.
// Defensive — bitrate may be a string or missing on real TuneIn data.
function bestStream(streams) {
  if (!Array.isArray(streams) || streams.length === 0) return null;
  const score = (s) => {
    const b = Number(s && s.bitrate);
    return Number.isFinite(b) ? b : -1;
  };
  let best = streams[0];
  for (const s of streams) if (score(s) > score(best)) best = s;
  return best;
}

function fmtCodec(stream) {
  if (!stream) return '';
  const codec = stream.media_type || stream.formats || '';
  return typeof codec === 'string' ? codec.toUpperCase() : '';
}

function buildAssignRow() {
  const wrap = document.createElement('div');
  wrap.className = 'station-assign-row';
  for (let n = 1; n <= ASSIGN_SLOTS; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-assign-btn';
    btn.dataset.slot = String(n);
    btn.textContent = String(n);
    btn.disabled = true;        // wired in slice 5
    wrap.appendChild(btn);
  }
  return wrap;
}

function renderSkeleton(root, sid) {
  // Refs collected for later mutation. The mount helper from dom.js
  // text-interpolates only, so we attach class names + IDs we can
  // re-query from `root` after mount.
  const verdictBox = document.createElement('div');
  verdictBox.className = 'station-verdict';
  verdictBox.textContent = 'Probing stream...';

  const assignBox = document.createElement('div');
  assignBox.className = 'station-assign';
  const heading = document.createElement('p');
  heading.className = 'station-assign__label';
  heading.textContent = 'Set as preset:';
  assignBox.appendChild(heading);
  assignBox.appendChild(buildAssignRow());

  mount(root, html`
    <section class="station-detail" data-view="station" data-sid="${sid}">
      <p class="breadcrumb"><a href="#/browse">&larr; Browse</a></p>
      <header class="station-header">
        <div class="station-art" hidden></div>
        <div class="station-header__body">
          <h1 class="station-name">${sid}</h1>
          <p class="station-slogan"></p>
          <p class="station-meta">Loading metadata...</p>
        </div>
      </header>
      ${verdictBox}
      ${assignBox}
    </section>
  `);
}

function applyMetadata(root, stationBody, fallbackName) {
  const nameEl   = root.querySelector('.station-name');
  const sloganEl = root.querySelector('.station-slogan');
  const metaEl   = root.querySelector('.station-meta');
  const artBox   = root.querySelector('.station-art');

  const name = (stationBody && stationBody.name) || fallbackName || '';
  if (nameEl && name) nameEl.textContent = name;

  if (sloganEl) {
    const slogan = (stationBody && stationBody.slogan) || '';
    if (slogan) {
      sloganEl.textContent = slogan;
    } else {
      sloganEl.remove();
    }
  }

  if (metaEl) {
    const text = buildMetaText(stationBody);
    metaEl.textContent = text || '';
    if (!text) metaEl.remove();
  }

  if (artBox) {
    const art = pickArt(stationBody);
    if (art) {
      const img = document.createElement('img');
      img.src = art;
      img.alt = name;
      img.loading = 'lazy';
      artBox.replaceChildren(img);
      artBox.removeAttribute('hidden');
    }
  }
}

function applyMetadataError(root, err) {
  const metaEl = root.querySelector('.station-meta');
  if (metaEl) metaEl.textContent = `Couldn't load metadata: ${err.message}`;
}

// Replace the verdict box and assign block based on classify() output.
function applyVerdict(root, sid, verdict) {
  const verdictEl = root.querySelector('.station-verdict');
  const assignEl  = root.querySelector('.station-assign');
  if (!verdictEl || !assignEl) return;

  if (verdict.kind === 'playable') {
    const streams = verdict.streams || [];
    const best = bestStream(streams);
    const bitrate = best && Number(best.bitrate) > 0 ? `${best.bitrate} kbps` : '';
    const codec = fmtCodec(best);
    const detail = [
      `${streams.length} stream${streams.length === 1 ? '' : 's'}`,
      [bitrate, codec].filter(Boolean).join(' '),
    ].filter(Boolean).join(' . ');
    verdictEl.classList.remove('is-gated', 'is-dark');
    verdictEl.classList.add('is-playable');
    verdictEl.textContent = detail || 'Playable';
    return;
  }

  // gated or dark — replace assign block with friendly message + link.
  const message = verdict.kind === 'gated'
    ? "This station isn't available from this client right now."
    : 'This station is currently off-air.';
  verdictEl.classList.remove('is-playable');
  verdictEl.classList.add(verdict.kind === 'gated' ? 'is-gated' : 'is-dark');
  verdictEl.textContent = message;

  // Hide the assign buttons; offer "More like this" instead. We don't
  // have a related-id yet (Tune.ashx doesn't return one); link to the
  // browse root so the user can pick something else.
  const more = document.createElement('a');
  more.className = 'station-more-like-this';
  more.href = '#/browse';
  more.textContent = 'More like this →';
  assignEl.replaceChildren(more);
}

function applyProbeError(root, err) {
  const verdictEl = root.querySelector('.station-verdict');
  if (verdictEl) {
    verdictEl.classList.add('is-error');
    verdictEl.textContent = `Couldn't probe stream: ${err.message}`;
  }
}

// Read state.caches.probe for a non-expired entry. Returns null if
// missing or stale; on stale, evicts the entry as a courtesy.
function readCachedProbe(store, sid) {
  const cache = store.state.caches.probe;
  if (!cache || typeof cache.get !== 'function') return null;
  const hit = cache.get(sid);
  if (!hit) return null;
  if (typeof hit.expires !== 'number' || hit.expires <= Date.now()) {
    cache.delete(sid);
    return null;
  }
  return hit;
}

function writeCachedProbe(store, sid, verdict) {
  const cache = store.state.caches.probe;
  if (!cache || typeof cache.set !== 'function') return;
  cache.set(sid, { ...verdict, expires: Date.now() + PROBE_TTL_MS });
}

export default {
  init(root, store, ctx) {
    const sid = (ctx && ctx.params && ctx.params.id) || '';
    if (!sid) {
      mount(root, html`
        <section class="placeholder" data-view="station">
          <h1>Station</h1>
          <p>Missing station id in route.</p>
        </section>
      `);
      return;
    }

    renderSkeleton(root, sid);

    // Describe.ashx → metadata. Errors fall back to showing just the
    // sid; the probe still runs, so the user gets a useful page.
    tuneinStation(sid)
      .then((res) => {
        const body = (res && Array.isArray(res.body) && res.body[0]) || null;
        applyMetadata(root, body, sid);
        // Add to recently-viewed AFTER Describe so we have a real name
        // (and an art URL when available). Slice 3's search empty state
        // reads this list.
        const name = (body && body.name) || sid;
        addRecentlyViewed({ sid, name, art: pickArt(body) });
      })
      .catch((err) => {
        applyMetadataError(root, err);
        // Still record the visit, even without a friendly name. Slice 3
        // can render the sid as a fallback label via stationCard().
        addRecentlyViewed({ sid, name: sid });
      });

    // Tune.ashx → verdict. Cache hit short-circuits the network fetch.
    const cached = readCachedProbe(store, sid);
    if (cached) {
      applyVerdict(root, sid, cached);
      return;
    }
    tuneinProbe(sid)
      .then((res) => {
        const verdict = classify(res);
        writeCachedProbe(store, sid, verdict);
        applyVerdict(root, sid, verdict);
      })
      .catch((err) => {
        applyProbeError(root, err);
      });
  },

  update(/* state, changedKey */) {
    // Static view — no store subscription declared in main.js, so this
    // is a no-op. Each visit triggers a fresh init() via the router.
  },
};
