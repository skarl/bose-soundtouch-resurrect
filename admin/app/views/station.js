// station — station detail view (#/station/sNNN).
//
// On entry:
//   1. Render skeleton immediately (back arrow, name placeholder,
//      "loading metadata...", disabled assign buttons).
//   2. Fetch Describe.ashx via tuneinStation(sid) → fill name,
//      slogan, location/language/format meta. Adds the station to
//      state.ui.visitedStations (search.js's empty state reads it).
//   3. Fetch Tune.ashx via probe(sid) → cache-aware orchestrator in
//      app/probe.js. Re-entry within the 10-minute TTL skips the fetch.
//      The Probe result carries tuneinJson so assign + audition can
//      call buildBosePayload() without refetching.
//   4. Render the verdict:
//      - playable: "N streams . best: K kbps CODEC" + assign buttons
//        enabled, click handler POSTs to /presets/:slot.
//      - gated/dark: replace assign buttons with a friendly message +
//        a "More like this" link to #/browse.
//
// See admin/PLAN.md § View specs / station detail.

import { html, mount, defineView } from '../dom.js';
import { tuneinStation, presetsList } from '../api.js';
import { store, addVisitedStation } from '../state.js';
import { showToast } from '../toast.js';
import { setArt } from '../art.js';
import { stationGradient } from '../tint.js';
import { pill } from '../components.js';
import { probe, assignToPreset, buildBosePayload } from '../probe.js';
import { previewStream } from '../actions/index.js';
import { cgiErrorMessage } from '../error-messages.js';
import { pickArt, bestStream, buildMetaText, fmtCodec, fmtReliability } from '../station-verdict.js';

const ASSIGN_SLOTS = 6;

function buildAssignGrid() {
  const wrap = document.createElement('div');
  wrap.className = 'station-presets-grid';
  for (let n = 1; n <= ASSIGN_SLOTS; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-preset-cell station-assign-btn';
    btn.dataset.slot = String(n);
    btn.disabled = true;

    const slotLabel = document.createElement('span');
    slotLabel.className = 'station-preset-cell__slot';
    slotLabel.textContent = String(n);

    const occupant = document.createElement('span');
    occupant.className = 'station-preset-cell__occupant';
    occupant.textContent = 'Empty';

    const tag = document.createElement('span');
    tag.className = 'station-preset-cell__tag';

    btn.appendChild(slotLabel);
    btn.appendChild(occupant);
    btn.appendChild(tag);
    wrap.appendChild(btn);
  }
  return wrap;
}

// Update one cell from a preset slot. Falls back to "Empty" + no tag
// for unset slots; long names truncate via CSS ellipsis. The active
// inset accent (slot already holds this station) is keyed off
// .is-current — applied here when the slot's location matches sid.
function paintPresetCell(btn, slotIndex, preset, sid) {
  const occupant = btn.querySelector('.station-preset-cell__occupant');
  const tagWrap  = btn.querySelector('.station-preset-cell__tag');
  if (!occupant || !tagWrap) return;

  const empty = !preset || preset.empty === true;
  const name  = empty ? '' : (preset.itemName || `Preset ${slotIndex + 1}`);
  const genre = empty ? '' : presetGenreLabel(preset);
  const isCurrent = !empty && typeof preset.location === 'string'
    && preset.location === sid;

  occupant.textContent = empty ? 'Empty' : name;
  btn.classList.toggle('station-preset-cell--empty', empty);
  btn.classList.toggle('is-current', isCurrent);
  btn.setAttribute('aria-label', empty
    ? `Assign to preset ${slotIndex + 1}, currently empty`
    : `Assign to preset ${slotIndex + 1}, currently ${name}`);

  tagWrap.replaceChildren();
  if (genre) tagWrap.appendChild(pill({ tone: 'ok', text: genre }));
}

// Pick a short tag for the preset cell. Probed Bose JSON doesn't carry
// genre on /presets, so we surface the source/account or location code
// — anything short and stable that helps disambiguate identically-named
// stations across slots.
function presetGenreLabel(preset) {
  if (!preset || typeof preset !== 'object') return '';
  const src = typeof preset.source === 'string' ? preset.source : '';
  if (src && src !== 'INTERNET_RADIO') return src.toLowerCase();
  if (typeof preset.location === 'string' && preset.location) {
    return preset.location.length > 8
      ? preset.location.slice(0, 8) + '…'
      : preset.location;
  }
  return src ? src.toLowerCase() : '';
}

function renderSkeleton(root, sid) {
  const verdictBox = document.createElement('div');
  verdictBox.className = 'station-verdict';
  verdictBox.textContent = 'Probing stream...';

  const assignBox = document.createElement('div');
  assignBox.className = 'station-assign';
  const heading = document.createElement('p');
  heading.className = 'station-assign__label';
  heading.textContent = 'Set as preset:';
  assignBox.appendChild(heading);
  assignBox.appendChild(buildAssignGrid());

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

// Full-width gradient CTA shown above the assign grid on playable
// stations. Click streams the chosen stream to the speaker without
// touching the persistent preset slots. Subtitle is muted secondary
// text; the gradient is keyed off the station name so the same station
// always renders the same hue across reloads.
function buildTestPlayButton(name) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'station-test-play';
  btn.dataset.testPlay = '1';
  btn.style.backgroundImage = stationGradient(name);

  const label = document.createElement('span');
  label.className = 'station-test-play__label';
  label.textContent = 'Play';

  const sub = document.createElement('span');
  sub.className = 'station-test-play__sub';
  sub.textContent = 'Stream a test sample without saving';

  btn.appendChild(label);
  btn.appendChild(sub);
  return btn;
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

function applyProbeError(root, err) {
  const verdictEl = root.querySelector('.station-verdict');
  if (verdictEl) {
    verdictEl.classList.add('is-error');
    verdictEl.textContent = `Couldn't probe stream: ${err.message}`;
  }
}

export default defineView({
  mount(root, _store, ctx, env) {
    const sid = (ctx && ctx.params && ctx.params.id) || '';
    if (!sid) {
      mount(root, html`
        <section class="placeholder" data-view="station">
          <h1>Station</h1>
          <p>Missing station id in route.</p>
        </section>
      `);
      return {};
    }

    renderSkeleton(root, sid);
    repaintPresetCells();

    // Play + assign closure state. The Play CTA streams to the speaker,
    // not in the browser. Bo stays tuned until the user picks
    // something else — no auto-stop on toggle-click or navigation.
    let chosenStreamUrl = '';
    let testPlayCtx     = null;
    let testPlayBusy    = false;

    let stationName = sid;
    let stationArt = '';
    const getName = () => stationName;
    const getArt  = () => stationArt;

    async function auditionStream(url, actx) {
      if (!actx || !actx.getProbe || !actx.getName) return;
      // Read the live name at click time — Describe.ashx may still be
      // racing the probe when the stream list mounts.
      const liveName = actx.getName();
      const bose = buildBosePayload(actx.getProbe(), liveName, url);
      if (!bose) {
        showToast('No playable streams to audition');
        return;
      }
      try {
        const envelope = await previewStream({ id: actx.sid, name: liveName, json: bose });
        if (!envelope || envelope.ok !== true) {
          showToast(`Playback failed: ${cgiErrorMessage(envelope)}`);
          return;
        }
        showToast(`Playing on Bo: ${liveName}`);
      } catch (err) {
        showToast(`Playback failed: ${err.message || 'transport error'}`);
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

    function renderStreamList(streams, actx) {
      const list = document.createElement('div');
      list.className = 'station-streams';
      list.setAttribute('aria-label', 'Stream chooser');

      testPlayCtx = actx || null;
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

        const meta = document.createElement('span');
        meta.className = 'station-stream-meta';
        const bits = Number(s.bitrate) > 0 ? `${s.bitrate} kbps` : '';
        const parts = [bits, fmtCodec(s), fmtReliability(s)].filter(Boolean);
        meta.textContent = parts.join(' . ') || url;

        row.appendChild(radio);
        row.appendChild(meta);

        row.addEventListener('click', () => selectStream(url, list));

        list.appendChild(row);
      }
      return list;
    }

    function applyVerdict(verdict, actx) {
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

        const oldList = root.querySelector('.station-streams');
        if (oldList) oldList.remove();
        const oldCta = root.querySelector('.station-test-play');
        if (oldCta) oldCta.remove();

        let anchor = verdictEl;
        if (streams.length > 0) {
          const list = renderStreamList(streams, {
            sid,
            getName: () => (actx && actx.getName ? actx.getName() : sid),
            getProbe: () => (actx && actx.probe ? actx.probe : null),
          });
          anchor.insertAdjacentElement('afterend', list);
          anchor = list;
        }

        // Play CTA goes between the stream chooser and the assign
        // grid. Reuses chosenStreamUrl from the chooser; preserves the
        // existing previewStream callsite (auditionStream → previewStream).
        const cta = buildTestPlayButton(actx && actx.getName ? actx.getName() : sid);
        cta.addEventListener('click', () => onTestPlayClick(cta));
        anchor.insertAdjacentElement('afterend', cta);

        enableAssignButtons(actx);
        repaintPresetCells();
        return;
      }

      // Non-playable verdicts: drop any prior stream list + CTA. We
      // deliberately don't tell the speaker to stop — Bo keeps playing
      // whatever it's playing until the user picks something else.
      const oldList = root.querySelector('.station-streams');
      if (oldList) oldList.remove();
      const oldCta = root.querySelector('.station-test-play');
      if (oldCta) oldCta.remove();

      const message = verdict.kind === 'gated'
        ? "This station isn't available from this client right now."
        : 'This station is currently off-air.';
      verdictEl.classList.remove('is-playable');
      verdictEl.classList.add(verdict.kind === 'gated' ? 'is-gated' : 'is-dark');
      verdictEl.textContent = message;

      const more = document.createElement('a');
      more.className = 'station-more-like-this';
      more.href = '#/browse';
      more.textContent = 'More like this →';
      assignEl.replaceChildren(more);
    }

    async function onTestPlayClick(cta) {
      if (testPlayBusy) return;
      if (!testPlayCtx || !chosenStreamUrl) {
        showToast('No playable streams to test');
        return;
      }
      testPlayBusy = true;
      cta.classList.add('is-busy');
      cta.disabled = true;
      try {
        await auditionStream(chosenStreamUrl, testPlayCtx);
      } finally {
        testPlayBusy = false;
        cta.classList.remove('is-busy');
        cta.disabled = false;
      }
    }

    function repaintPresetCells() {
      const presets = (store.state.speaker && store.state.speaker.presets) || [];
      const cells = root.querySelectorAll('.station-preset-cell');
      cells.forEach((cell, idx) => {
        paintPresetCell(cell, idx, presets[idx] || null, sid);
      });
    }

    function enableAssignButtons(actx) {
      if (!actx || !actx.probe) return;
      const btns = root.querySelectorAll('.station-assign-btn');
      for (const btn of btns) {
        btn.disabled = false;
        btn.addEventListener('click', () => {
          const slot = Number(btn.dataset.slot);
          if (!Number.isInteger(slot) || slot < 1 || slot > 6) return;
          handleAssignClick(slot, actx);
        });
      }
    }

    async function handleAssignClick(slot, actx) {
      const btn = root.querySelector(`.station-assign-btn[data-slot="${slot}"]`);
      if (!btn || btn.dataset.busy === '1') return;

      const name = actx.getName ? actx.getName() : sid;
      const art  = actx.getArt  ? actx.getArt()  : '';

      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.classList.add('is-busy');

      let envelope;
      try {
        envelope = await assignToPreset(actx.probe, slot, { name, art, chosenStreamUrl });
      } catch (err) {
        showToast(`Save failed: ${err.message || 'transport error'}`);
        btn.disabled = false;
        btn.dataset.busy = '';
        btn.classList.remove('is-busy');
        presetsList().then((envv) => {
          if (envv && envv.ok && Array.isArray(envv.data)) store.update('speaker', (s) => { s.speaker.presets = envv.data; });
        }).catch(() => { /* surfaced via the original toast already */ });
        return;
      }

      btn.disabled = false;
      btn.dataset.busy = '';
      btn.classList.remove('is-busy');

      if (envelope && envelope.ok) {
        showToast(`Saved to preset ${slot}`);
        return;
      }

      showToast(`Save failed: ${cgiErrorMessage(envelope)}`);
      presetsList().then((envv) => {
        if (envv && envv.ok && Array.isArray(envv.data)) store.update('speaker', (s) => { s.speaker.presets = envv.data; });
      }).catch(() => { /* keep the toast as the user-facing signal */ });
    }

    // The assign-button handler reads the live name + art at click
    // time, so the Describe fetch races the probe but doesn't block
    // it. Both fetches honour env.signal so leaving the view aborts
    // any in-flight network work.
    tuneinStation(sid, { signal: env.signal })
      .then((res) => {
        if (env.signal.aborted) return;
        const body = (res && Array.isArray(res.body) && res.body[0]) || null;
        applyMetadata(root, body, sid);
        const name = (body && body.name) || sid;
        stationName = name;
        stationArt  = pickArt(body);
        addVisitedStation({ sid, name, art: stationArt });
      })
      .catch((err) => {
        if (env.signal.aborted) return;
        applyMetadataError(root, err);
        addVisitedStation({ sid, name: sid });
      });

    // probe() is cache-aware — re-entry within the 10-minute TTL skips
    // the network fetch.
    probe(sid, { signal: env.signal })
      .then((p) => {
        if (env.signal.aborted) return;
        applyVerdict(p.verdict, { probe: p, getName, getArt });
      })
      .catch((err) => {
        if (env.signal.aborted) return;
        applyProbeError(root, err);
      });

    return {
      speaker() { repaintPresetCells(); },
    };
  },
});
