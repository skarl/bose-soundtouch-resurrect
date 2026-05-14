// show-landing — c=pbrowse show-drill landing surface.
//
// The upstream `Browse.ashx?c=pbrowse&id=p<N>` endpoint is regionally
// gated and returns `head.status="400"` with `body:[]` from Bo's
// egress (issue #84). Curl evidence captured against Bo on 2026-05-13:
//
//   /tunein/browse?c=pbrowse&id=p17 →
//     {"head":{"status":"400","fault":"Invalid root category"},"body":[]}
//   /tunein/browse?id=p17 →
//     {"head":{"title":"Fresh Air","status":"200"},"body":[
//       {"text":"Genres","key":"genres","children":[...]},
//       {"text":"Networks","key":"affiliates","children":[...]}]}
//   /tunein/describe?id=p17 →
//     {"head":{"status":"200"},"body":[{"element":"show",
//       "title":"Fresh Air","hosts":"Terry Gross",
//       "description":"...","logo":"...","location":"Philadelphia, PA",
//       "genre_id":"g168","genre_name":"Interviews",...}]}
//
// renderShowLanding composes the two working routes: Describe drives
// a "show landing" card at the top (title, hosts, description, genre
// chip, logo, +Play CTA on the p-prefix guide_id), and Browse(bare
// id) renders any related sections (Genres / Networks). The combined
// surface stays semantically a show drill — the user can play the
// show via the inline Play icon, follow its genre chip, or jump to
// the related affiliate network.
//
// renderLiveShowCard / renderTopicsCard are the c=pbrowse section
// renderers — outline-render's renderSection dispatch routes liveShow
// / topics entries through them. They live here (not in outline-
// render) because the topic-row layout and liveShow hero pattern are
// part of the show-drill flow.

import { tuneinDescribe, tuneinBrowse } from '../../api.js';
import { stationRow } from '../../components.js';
import { showHero } from '../../show-hero.js';
import { cache, TTL_LABEL } from '../../tunein-cache.js';
import { normaliseRow } from '../../tunein-outline.js';
import { store as appStore } from '../../state.js';
import {
  renderSection,
  emptyNode,
  pluralize,
  skeleton,
  errorNode,
  primeTuneinSkipCaches,
  primeLabelForEntry,
} from './outline-render.js';

// Drive the two-fetch composite. Describe is the load-bearing call (it
// drives the show card); Browse-by-bare-id is best-effort — its
// failure does not block the show card from rendering. Both fetches
// fire in parallel; we wait on Describe synchronously and treat
// Browse's failure as "no related sections".
export function loadShowLanding(body, showId, headerCount, head) {
  body.replaceChildren();
  body.appendChild(skeleton());
  if (headerCount) headerCount.textContent = '';

  const describePromise = tuneinDescribe({ id: showId });
  // Browse(bare id) is best-effort — we swallow its rejection so the
  // describe-driven card still renders even if Browse 4xxs.
  const browsePromise = tuneinBrowse(showId).catch(() => null);

  Promise.all([describePromise, browsePromise])
    .then(([describeJson, browseJson]) => {
      renderShowLandingBody(body, describeJson, browseJson, headerCount, head);
    })
    .catch((err) => {
      body.replaceChildren();
      body.appendChild(errorNode(err));
    });
}

// Synchronous body-rendering core. Takes the resolved Describe and
// Browse payloads and walks them into the body. Exported (as the
// test-only `_renderShowLandingForTest`) so tests can drive the path
// without faking fetch.
export function _renderShowLandingForTest(body, describeJson, browseJson, headerCount, head) {
  return renderShowLandingBody(body, describeJson, browseJson, headerCount, head);
}

function renderShowLandingBody(body, describeJson, browseJson, headerCount, head) {
  // Clear any prior children (skeleton). Use replaceChildren when the
  // host DOM supports it; fall back to a manual removeChild loop for
  // the xmldom test shim which lacks replaceChildren.
  if (typeof body.replaceChildren === 'function') {
    body.replaceChildren();
  } else {
    while (body.firstChild) body.removeChild(body.firstChild);
  }
  const show = pickShowFromDescribe(describeJson);
  if (!show) {
    // Describe came back without a usable show element — render an
    // empty-state so the user sees something other than a stuck
    // skeleton. The text stays plain so the user understands the gap
    // rather than a phantom failure.
    body.appendChild(emptyNode('Show details aren’t available right now.'));
    return;
  }

  body.appendChild(renderShowLandingCard(show));

  const headTitle = pickShowTitle(describeJson, browseJson);
  if (head && head.titleEl && headTitle) head.titleEl.textContent = headTitle;
  if (head && head.crumbToken && headTitle) {
    cache.set(`tunein.label.${head.crumbToken}`, headTitle, TTL_LABEL);
  }
  // Issue #105: prime the show's bare-sid label too. The crumb token
  // captured at frame-mount time can be filter-bearing (`p<NN>:l109`),
  // in which case writing only the combined token leaves a back-and-
  // return visit to the bare `p<NN>` drill flashing the raw token. The
  // show.guide_id is authoritative and unambiguous — stash the title
  // there too so any future drill that lands on this show paints
  // instantly.
  const showSid = typeof show.guide_id === 'string' ? show.guide_id : '';
  if (showSid && headTitle) {
    cache.set(`tunein.label.${showSid}`, headTitle, TTL_LABEL);
  }

  // Browse(bare id) is best-effort. When it returns a body, render
  // any sections it carries; flat or empty bodies (e.g. p4727070
  // returns 200 with body:[]) emit nothing extra.
  let relatedCount = 0;
  if (browseJson && Array.isArray(browseJson.body) && browseJson.body.length > 0) {
    for (const entry of browseJson.body) {
      if (Array.isArray(entry.children) && entry.children.length > 0) {
        const rendered = renderSection(entry);
        if (rendered) {
          relatedCount += rendered.visibleCount;
          body.appendChild(rendered.element);
        }
      }
    }
  }

  if (headerCount) {
    // The header count reflects related entries only — the show card
    // itself isn't a "row" in the same sense.
    headerCount.textContent = relatedCount > 0
      ? `${relatedCount.toLocaleString()} ${pluralize(relatedCount)}`
      : '';
  }
}

// Pick the `element:"show"` entry from a Describe response. Returns
// null when the response is malformed or carries no show element.
function pickShowFromDescribe(json) {
  if (!json || !Array.isArray(json.body)) return null;
  for (const entry of json.body) {
    if (entry && entry.element === 'show') return entry;
  }
  return null;
}

// Prefer Describe's title (richer, e.g. "Fresh Air") over Browse's
// head.title (often identical). Fall back to Browse's head.title when
// Describe lacks one.
function pickShowTitle(describeJson, browseJson) {
  const show = pickShowFromDescribe(describeJson);
  if (show && typeof show.title === 'string' && show.title !== '') return show.title;
  if (browseJson && browseJson.head && typeof browseJson.head.title === 'string' &&
      browseJson.head.title !== '') {
    return browseJson.head.title;
  }
  return '';
}

// Render the show landing card. The card is the *page subject* — a
// hero block, not a listing row — so it's composed via showHero (a
// non-anchor <div> with the same visual treatment as stationRow). Genre
// folds into the chips slot; description renders below as its own
// block. The p-prefix guide_id lights up the inline Play icon via
// isPlayableSid; tapping the body itself does nothing (no self-link).
function renderShowLandingCard(show) {
  const wrap = document.createElement('section');
  wrap.className = 'browse-section browse-section--show-landing';
  wrap.setAttribute('data-section', 'showLanding');

  const card = document.createElement('div');
  card.className = 'browse-card';

  const sid = typeof show.guide_id === 'string' ? show.guide_id : '';
  const title = typeof show.title === 'string' ? show.title : sid;
  const hosts = typeof show.hosts === 'string' && show.hosts !== ''
    ? show.hosts : '';
  const location = typeof show.location === 'string' ? show.location : '';
  const description = typeof show.description === 'string' ? show.description : '';
  const logo = typeof show.logo === 'string' ? show.logo : '';
  const genreId = typeof show.genre_id === 'string' ? show.genre_id : '';

  // Compose the chips array so the chip pipeline surfaces the genre as
  // a tappable pill (drills to #/browse?id=<gNN>).
  const chips = genreId ? [{ kind: 'genre', id: genreId }] : [];

  // Hosts are the most useful secondary line (e.g. "Terry Gross").
  // When hosts are absent, fall back to location ("Kent, OH").
  const secondary = hosts || location;

  const row = showHero({
    sid,
    name: title,
    art:  logo,
    location: secondary,
    chips,
    // Show-landing capture rule per #126: {id: pid, name: show.name,
    // art: show.art, note: ''} from the Describe-resolved show entry.
    favorite: {
      store: appStore,
      getEntry: () => ({
        id:   sid,
        name: title,
        art:  logo,
        note: '',
      }),
    },
  });
  // Mark the hero so tests / CSS can target it specifically.
  row.setAttribute('data-show-landing', '1');
  row.classList.add('is-last');
  card.appendChild(row);

  wrap.appendChild(card);

  // Description lives below the row as a paragraph block. TuneIn ships
  // multi-paragraph descriptions separated by \r\n; preserve paragraph
  // breaks by emitting one <p> per non-empty chunk.
  if (description !== '') {
    const desc = document.createElement('div');
    desc.className = 'browse-show-description';
    const chunks = description.split(/\r?\n\r?\n|\r\r/).map((c) => c.trim()).filter(Boolean);
    if (chunks.length === 0) {
      const p = document.createElement('p');
      p.textContent = description;
      desc.appendChild(p);
    } else {
      for (const chunk of chunks) {
        const p = document.createElement('p');
        p.textContent = chunk;
        desc.appendChild(p);
      }
    }
    wrap.appendChild(desc);
  }

  return wrap;
}

// ---- c=pbrowse section renderers (liveShow / topics) ---------------
//
// renderLiveShowCard — the `liveShow` section's single p-prefix child
// is the currently-airing show. Default renderEntry classifies a
// p-prefix link as 'show' and routes through showRow (no Play). For
// the show drill we want a play-on-tap row, so route the child through
// stationRow directly — its auto-attach Play icon (#78) lights up on
// p/s/t guide_ids.
//
// The section's `text` ("Now Airing") is the card label; the row body
// carries the show's name + optional subtext (host / description).
export function renderLiveShowCard(entries) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Issue #105: liveShow row carries the airing show's title — stash
    // it under `tunein.label.<p-sid>` so a future drill into the show
    // paints instantly. The liveShow card is a hero (no drill anchor of
    // its own), but the same p-prefix surfaces elsewhere as a row /
    // chip and benefits from the cache hit.
    primeLabelForEntry(entry);
    const row = renderLiveShowRow(entry);
    if (i === entries.length - 1) row.classList.add('is-last');
    row._outline = entry;
    card.appendChild(row);
  }
  return card;
}

function renderLiveShowRow(entry) {
  const id = (entry && typeof entry.guide_id === 'string') ? entry.guide_id : '';
  const norm = normaliseRow(entry);
  // The live-show card is a hero (the airing show you're already looking
  // at), not a drill row — its primary affordance is the inline Play
  // icon, not navigation. showHero produces a non-anchor body and
  // auto-mounts the Play icon for p/s/t prefixes via isPlayableSid.
  return showHero({
    sid:      id,
    name:     norm.primary || id,
    art:      norm.image,
    location: norm.secondary,
    favorite: {
      store: appStore,
      getEntry: () => ({
        id,
        name: norm.primary || id || '',
        art:  norm.image || '',
        note: '',
      }),
    },
  });
}

// renderTopicsCard — episode list. Each `t`-prefix child is rendered
// via stationRow (which auto-attaches the Play icon for t-prefix
// guide_ids). topic_duration, when present, is formatted as MM:SS or
// H:MM:SS and threaded into the meta line via stationRow's `location`
// slot — the only stationRow field that surfaces non-numeric text on
// the secondary line without requiring a components.js change.
export function renderTopicsCard(entries) {
  const card = document.createElement('div');
  card.className = 'browse-card';

  // Issue #88: prime the parent-show + topics-list caches as the user
  // walks past this drill. The parent key (per-topic) lets the now-
  // playing Prev/Next classifier answer "what show is this topic
  // from?" without re-fetching; the topics-list key gives it the
  // ordered neighbours for the skip path. Both writes are cheap and
  // run once per render — TTL keeps them from going stale.
  primeTuneinSkipCaches(entries);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Issue #105: prime `tunein.label.<t-sid>` from the topic row's
    // text so the next drill into this topic paints the breadcrumb
    // current-segment immediately. (primeTuneinSkipCaches above already
    // writes the topic NAME under the separate `tunein.topicname.*`
    // key for the now-playing skip path — different cache, same idea.)
    primeLabelForEntry(entry);
    const row = renderTopicRow(entry);
    if (i === entries.length - 1) row.classList.add('is-last');
    row._outline = entry;
    card.appendChild(row);
  }
  return card;
}

export function renderTopicRow(entry) {
  const id = (entry && typeof entry.guide_id === 'string') ? entry.guide_id : '';
  const norm = normaliseRow(entry);
  // Surface topic_duration in the meta slot when present. The location
  // chunk is the only one stationRow renders for a row with no
  // bitrate/codec/reliability, so we thread duration there. When
  // duration is missing we fall back to the description (subtext) via
  // normaliseRow's secondary line.
  const duration = formatTopicDuration(entry && entry.topic_duration);
  // Tertiary line gets the description when we used duration as the
  // primary meta. Otherwise the description rides on the secondary
  // slot via norm.secondary.
  const tertiary = duration ? norm.secondary : '';
  return stationRow({
    sid:      id,
    name:     norm.primary || id,
    art:      norm.image,
    location: duration || norm.secondary,
    tertiary,
  });
}

// formatTopicDuration — TuneIn's `topic_duration` is a seconds value
// (numeric or numeric string). Returns "M:SS" for sub-hour episodes
// and "H:MM:SS" for longer ones. Returns '' on unparseable input.
function formatTopicDuration(raw) {
  let seconds;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    seconds = Math.max(0, Math.floor(raw));
  } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    seconds = Math.max(0, parseInt(raw, 10));
  } else {
    return '';
  }
  if (seconds === 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) {
    const mm = String(m).padStart(2, '0');
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}
