// station — station detail view (#/station/sNNN).
//
// On entry:
//   1. Render skeleton immediately (back arrow, name placeholder,
//      "loading metadata...", disabled assign buttons).
//   2. Fetch Describe.ashx via tuneinStation(sid) → fill name,
//      slogan, location/language/format meta. Adds the station to
//      state.caches.recentlyViewed (search.js's empty state reads it).
//   3. Fetch Tune.ashx via tuneinProbe(sid) → classify() the response.
//      Probe results are cached in state.caches.probe for 10 minutes
//      keyed by sid; re-entry within TTL skips the network fetch. The
//      raw tuneinJson is cached alongside the verdict so the
//      assign-button handlers can call reshape() without refetching.
//   4. Render the verdict:
//      - playable: "N streams . best: K kbps CODEC" + assign buttons
//        enabled, click handler POSTs to /presets/:slot.
//      - gated/dark: replace assign buttons with a friendly message +
//        a "More like this" link to #/browse.
//
// See admin/PLAN.md § View specs / station detail.

import { html, mount } from '../dom.js';
import { tuneinStation, tuneinProbe, presetsAssign, presetsList, previewStream } from '../api.js';
import { store, addRecentlyViewed } from '../state.js';
import { classify, reshape } from '../reshape.js';
import { showToast } from '../toast.js';
import { setArt } from '../art.js';

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

// --- stream chooser + audition --------------------------------------
//
// Audition plays on the speaker, not in the browser. Clicking ▶ on a
// row writes that stream's URL into the resolver entry for the station
// (atomically) and POSTs /select to the speaker, so Bo plays the
// user's chosen stream right now. Bo stays tuned until the user picks
// something else (another row, another preset, or a hardware action)
// — no auto-stop on toggle-click or on navigation away from the view.

let chosenStreamUrl = '';
let auditionRow     = null;
let auditionCtx     = null;   // {sid, getName, getBose} captured at row render

function markRowPlaying(rowEl) {
  if (auditionRow && auditionRow !== rowEl) {
    auditionRow.classList.remove('is-playing');
  }
  auditionRow = rowEl;
  if (auditionRow) auditionRow.classList.add('is-playing');
}

async function auditionStream(url, rowEl, ctx) {
  if (!ctx || !ctx.getBose || !ctx.getName) return;
  // Read the live name at click time. Describe.ashx races Tune.ashx,
  // and the chooser renders on Tune's response, so capturing the name
  // at render time can stamp the resolver JSON with `sid` (e.g.
  // "s17490") instead of the friendly name. Evaluating here also
  // means a re-click after Describe lands picks up the real name.
  const liveName = ctx.getName();
  const bose = ctx.getBose(url);
  if (!bose) {
    showToast('No playable streams to audition');
    return;
  }
  bose.name = liveName;
  markRowPlaying(rowEl);
  try {
    const env = await previewStream({ id: ctx.sid, name: liveName, json: bose });
    if (!env || env.ok !== true) {
      const code = env && env.error && env.error.code;
      showToast(`Audition failed${code ? ': ' + code : ''}`);
      markRowPlaying(null);
      return;
    }
    showToast(`Playing on Bo: ${liveName}`);
  } catch (err) {
    showToast(`Audition failed: ${err.message || 'transport error'}`);
    markRowPlaying(null);
  }
}

function selectStream(url, listEl) {
  chosenStreamUrl = url;
  if (!listEl) return;
  for (const row of listEl.querySelectorAll('.station-stream')) {
    const isMe = row.dataset.url === url;
    row.classList.toggle('is-selected', isMe);
    const radio = row.querySelector('input[type="radio"]');
    if (radio) radio.checked = isMe;
  }
}

function fmtReliability(stream) {
  const r = Number(stream && stream.reliability);
  return Number.isFinite(r) && r > 0 ? `${r}%` : '';
}

function renderStreamList(streams, ctx) {
  const list = document.createElement('div');
  list.className = 'station-streams';
  list.setAttribute('aria-label', 'Stream chooser');

  auditionCtx = ctx || null;
  const initial = bestStream(streams) || streams[0];
  chosenStreamUrl = initial ? initial.streamUrl || initial.url : '';

  for (const s of streams) {
    const url = s.streamUrl || s.url;
    if (!url) continue;

    const row = document.createElement('div');
    row.className = 'station-stream';
    row.dataset.url = url;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'stream-choice';
    radio.checked = url === chosenStreamUrl;
    if (radio.checked) row.classList.add('is-selected');

    const audition = document.createElement('button');
    audition.type = 'button';
    audition.className = 'station-stream-audition';
    audition.setAttribute('aria-label', 'Audition this stream');
    audition.textContent = '▶'; // ▶ — toggles to ⏸ via .is-playing CSS

    const meta = document.createElement('span');
    meta.className = 'station-stream-meta';
    const bits = Number(s.bitrate) > 0 ? `${s.bitrate} kbps` : '';
    const parts = [bits, fmtCodec(s), fmtReliability(s)].filter(Boolean);
    meta.textContent = parts.join(' . ') || url;

    row.appendChild(radio);
    row.appendChild(audition);
    row.appendChild(meta);

    // Clicking anywhere on the row selects it. Audition button also
    // selects, so the auditioned stream is what gets assigned.
    row.addEventListener('click', (ev) => {
      if (ev.target === audition) return;     // handled below
      selectStream(url, list);
    });
    audition.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectStream(url, list);
      auditionStream(url, row, auditionCtx);
    });

    list.appendChild(row);
  }
  return list;
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
    // Initial state: disabled. Enabled by enableAssignButtons() once a
    // playable verdict + tuneinJson are in hand.
    btn.disabled = true;
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
    const img = document.createElement('img');
    img.loading = 'lazy';
    artBox.replaceChildren(img);
    artBox.removeAttribute('hidden');
    setArt(img, pickArt(stationBody) || '', name);
  }
}

function applyMetadataError(root, err) {
  const metaEl = root.querySelector('.station-meta');
  if (metaEl) metaEl.textContent = `Couldn't load metadata: ${err.message}`;
}

// Replace the verdict box and assign block based on classify() output.
// On playable, enable assign buttons + attach the slot handler. On
// gated/dark, swap the assign block for a "More like this" link.
function applyVerdict(root, sid, verdict, ctx) {
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

    // Render the stream chooser (radios + audition buttons) under
    // the verdict, between it and the assign row. The chooser needs
    // a way to build a Bose JSON for the URL the user clicked, so
    // that previewStream() can stage it on the resolver and /select
    // on the speaker. We pass a getBose(chosenUrl) closure that calls
    // reshape() once and patches in the chosen streamUrl — same
    // override the assign path uses.
    const auditionGetBose = (chosenUrl) => {
      if (!ctx || !ctx.tuneinJson) return null;
      const previewName = ctx.getName ? ctx.getName() : sid;
      const j = reshape(ctx.tuneinJson, sid, previewName);
      if (!j) return null;
      if (chosenUrl && j.audio && Array.isArray(j.audio.streams)) {
        const match = j.audio.streams.find((s) => s.streamUrl === chosenUrl);
        if (match) j.audio.streamUrl = match.streamUrl;
      }
      return j;
    };
    const existing = root.querySelector('.station-streams');
    if (existing) existing.remove();
    if (streams.length > 0) {
      verdictEl.insertAdjacentElement('afterend', renderStreamList(streams, {
        sid,
        // Evaluated at click time, not at render — Describe may still
        // be racing the probe when this list mounts.
        getName: () => (ctx && ctx.getName ? ctx.getName() : sid),
        getBose: auditionGetBose,
      }));
    }

    enableAssignButtons(root, sid, ctx);
    return;
  }

  // Non-playable verdicts: drop any prior stream list. We deliberately
  // don't tell the speaker to stop — Bo keeps playing whatever it's
  // playing until the user picks something else.
  const oldList = root.querySelector('.station-streams');
  if (oldList) oldList.remove();
  markRowPlaying(null);

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

// Enable each assign button and wire its click handler. ctx carries
// {tuneinJson, getName} — getName() is read at click time so the
// metadata-fetch latency doesn't matter as long as it lands before the
// user clicks. Buttons stay disabled if tuneinJson is missing (e.g.
// the cache entry was rebuilt without it).
function enableAssignButtons(root, sid, ctx) {
  if (!ctx || !ctx.tuneinJson) return;
  const btns = root.querySelectorAll('.station-assign-btn');
  for (const btn of btns) {
    btn.disabled = false;
    btn.addEventListener('click', () => {
      const slot = Number(btn.dataset.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > 6) return;
      handleAssignClick(root, sid, slot, ctx);
    });
  }
}

// Optimistic POST + reconcile. On {ok:true,data} reconcile speaker
// presets from the response. On {ok:false,error} surface the code in a
// toast and refetch /presets so the UI shows actual speaker state.
async function handleAssignClick(root, sid, slot, ctx) {
  const btn = root.querySelector(`.station-assign-btn[data-slot="${slot}"]`);
  if (!btn || btn.dataset.busy === '1') return;

  const name = ctx.getName ? ctx.getName() : sid;
  const art  = ctx.getArt  ? ctx.getArt()  : '';
  const bose = reshape(ctx.tuneinJson, sid, name);
  if (!bose) {
    showToast(`Cannot save: no playable streams for ${sid}`);
    return;
  }
  // Override the auto-picked top-level streamUrl with the user's
  // selection from the chooser (if they made one). Keep the full
  // streams[] list intact as fallbacks for the speaker. We don't
  // touch reshape() itself — the reshape contract test fixtures
  // still pin the auto-pick path against resolver/build.py.
  if (chosenStreamUrl && bose.audio && Array.isArray(bose.audio.streams)) {
    const match = bose.audio.streams.find((s) => s.streamUrl === chosenStreamUrl);
    if (match) bose.audio.streamUrl = match.streamUrl;
  }

  btn.dataset.busy = '1';
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '...';

  let envelope;
  try {
    envelope = await presetsAssign(slot, {
      id: sid,
      slot,
      name,
      art,
      kind: 'playable',
      json: bose,
    });
  } catch (err) {
    showToast(`Save failed: ${err.message || 'transport error'}`);
    btn.textContent = originalLabel;
    btn.disabled = false;
    btn.dataset.busy = '';
    // Best-effort refetch so the user sees the actual speaker state.
    presetsList().then((env) => {
      if (env && env.ok && Array.isArray(env.data)) store.update('speaker', (s) => { s.speaker.presets = env.data; });
    }).catch(() => { /* surfaced via the original toast already */ });
    return;
  }

  btn.textContent = originalLabel;
  btn.disabled = false;
  btn.dataset.busy = '';

  if (envelope && envelope.ok && Array.isArray(envelope.data)) {
    store.update('speaker', (s) => { s.speaker.presets = envelope.data; });
    showToast(`Saved to preset ${slot}`);
    return;
  }

  // Structured error — refetch to show what's actually on the speaker.
  const err = (envelope && envelope.error) || { code: 'UNKNOWN' };
  const detail = err.message ? `${err.code}: ${err.message}` : err.code;
  showToast(`Save failed (${detail})`);
  presetsList().then((env) => {
    if (env && env.ok && Array.isArray(env.data)) store.update('speaker', (s) => { s.speaker.presets = env.data; });
  }).catch(() => { /* keep the toast as the user-facing signal */ });
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
// Returned shape: {kind, streams?, reason?, tuneinJson?, expires}.
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

// Cache the verdict + the original tuneinJson together. The assign
// handler needs the raw probe to reshape() into Bose JSON; keeping it
// here means a re-entry within the 10-minute TTL skips both the
// network probe and the reshape input fetch.
function writeCachedProbe(store, sid, verdict, tuneinJson) {
  const cache = store.state.caches.probe;
  if (!cache || typeof cache.set !== 'function') return;
  cache.set(sid, {
    ...verdict,
    tuneinJson,
    expires: Date.now() + PROBE_TTL_MS,
  });
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

    // The assign-button handler reads the live name + art at click
    // time, so the Describe fetch races the probe but doesn't block
    // it. We stash both in closure-local vars and pass getters in
    // ctx.
    let stationName = sid;
    let stationArt = '';
    const getName = () => stationName;
    const getArt  = () => stationArt;

    // Describe.ashx → metadata. Errors fall back to showing just the
    // sid; the probe still runs, so the user gets a useful page.
    tuneinStation(sid)
      .then((res) => {
        const body = (res && Array.isArray(res.body) && res.body[0]) || null;
        applyMetadata(root, body, sid);
        // Add to recently-viewed AFTER Describe so we have a real name
        // (and an art URL when available). The search empty state
        // reads this list.
        const name = (body && body.name) || sid;
        stationName = name;
        stationArt  = pickArt(body);
        addRecentlyViewed({ sid, name, art: stationArt });
      })
      .catch((err) => {
        applyMetadataError(root, err);
        // Still record the visit, even without a friendly name. Search
        // can render the sid as a fallback label via stationCard().
        addRecentlyViewed({ sid, name: sid });
      });

    // Tune.ashx → verdict. Cache hit short-circuits the network fetch.
    const cached = readCachedProbe(store, sid);
    if (cached) {
      applyVerdict(root, sid, cached, {
        tuneinJson: cached.tuneinJson || null,
        getName,
        getArt,
      });
      return;
    }
    tuneinProbe(sid)
      .then((res) => {
        const verdict = classify(res);
        writeCachedProbe(store, sid, verdict, res);
        applyVerdict(root, sid, verdict, { tuneinJson: res, getName, getArt });
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
