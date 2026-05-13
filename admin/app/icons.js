// Inline SVG icon module — Lucide/Feather-flavoured 24x24 glyphs.
// Children are built with createElementNS so the module works in both
// the browser and a minimal xmldom test harness; stroke is currentColor
// so every icon picks up the surrounding text colour and rides the
// theme cycle automatically.

const NS = 'http://www.w3.org/2000/svg';
const SIZE = 24;

const SHAPES = {
  play: [['polygon', { points: '6 4 20 12 6 20 6 4' }]],
  pause: [
    ['rect', { x: '6', y: '5', width: '4', height: '14' }],
    ['rect', { x: '14', y: '5', width: '4', height: '14' }],
  ],
  next: [
    ['polygon', { points: '5 4 15 12 5 20 5 4' }],
    ['line', { x1: '19', y1: '5', x2: '19', y2: '19' }],
  ],
  prev: [
    ['polygon', { points: '19 20 9 12 19 4 19 20' }],
    ['line', { x1: '5', y1: '19', x2: '5', y2: '5' }],
  ],
  vol: [
    ['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }],
    ['path', { d: 'M15.54 8.46a5 5 0 0 1 0 7.07' }],
    ['path', { d: 'M19.07 4.93a10 10 0 0 1 0 14.14' }],
  ],
  mute: [
    ['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }],
    ['line', { x1: '22', y1: '9', x2: '16', y2: '15' }],
    ['line', { x1: '16', y1: '9', x2: '22', y2: '15' }],
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }],
  ],
  list: [
    ['line', { x1: '8', y1: '6', x2: '21', y2: '6' }],
    ['line', { x1: '8', y1: '12', x2: '21', y2: '12' }],
    ['line', { x1: '8', y1: '18', x2: '21', y2: '18' }],
    ['circle', { cx: '4', cy: '6', r: '1' }],
    ['circle', { cx: '4', cy: '12', r: '1' }],
    ['circle', { cx: '4', cy: '18', r: '1' }],
  ],
  settings: [
    ['circle', { cx: '12', cy: '12', r: '3' }],
    ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }],
  ],
  speaker: [
    ['rect', { x: '5', y: '2', width: '14', height: '20', rx: '2', ry: '2' }],
    ['circle', { cx: '12', cy: '14', r: '4' }],
    ['line', { x1: '12', y1: '6', x2: '12.01', y2: '6' }],
  ],
  // "Two speakers in sync" — narrower side-by-side cabinets so the glyph
  // reads as multiple speakers rather than a wider single one. Used for
  // the Settings → Multi-room section header.
  multiroom: [
    ['rect', { x: '3', y: '4', width: '8', height: '16', rx: '1.5', ry: '1.5' }],
    ['circle', { cx: '7', cy: '14', r: '2.5' }],
    ['line', { x1: '7', y1: '7', x2: '7.01', y2: '7' }],
    ['rect', { x: '13', y: '4', width: '8', height: '16', rx: '1.5', ry: '1.5' }],
    ['circle', { cx: '17', cy: '14', r: '2.5' }],
    ['line', { x1: '17', y1: '7', x2: '17.01', y2: '7' }],
  ],
  bt: [
    ['polyline', { points: '6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5' }],
  ],
  wifi: [
    ['path', { d: 'M5 12.55a11 11 0 0 1 14.08 0' }],
    ['path', { d: 'M1.42 9a16 16 0 0 1 21.16 0' }],
    ['path', { d: 'M8.53 16.11a6 6 0 0 1 6.95 0' }],
    ['line', { x1: '12', y1: '20', x2: '12.01', y2: '20' }],
  ],
  cpu: [
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2', ry: '2' }],
    ['rect', { x: '9', y: '9', width: '6', height: '6' }],
    ['line', { x1: '9', y1: '1', x2: '9', y2: '4' }],
    ['line', { x1: '15', y1: '1', x2: '15', y2: '4' }],
    ['line', { x1: '9', y1: '20', x2: '9', y2: '23' }],
    ['line', { x1: '15', y1: '20', x2: '15', y2: '23' }],
    ['line', { x1: '20', y1: '9', x2: '23', y2: '9' }],
    ['line', { x1: '20', y1: '14', x2: '23', y2: '14' }],
    ['line', { x1: '1', y1: '9', x2: '4', y2: '9' }],
    ['line', { x1: '1', y1: '14', x2: '4', y2: '14' }],
  ],
  bell: [
    ['path', { d: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9' }],
    ['path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }],
  ],
  music: [
    ['path', { d: 'M9 18V5l12-2v13' }],
    ['circle', { cx: '6', cy: '18', r: '3' }],
    ['circle', { cx: '18', cy: '16', r: '3' }],
  ],
  refresh: [
    ['polyline', { points: '23 4 23 10 17 10' }],
    ['polyline', { points: '1 20 1 14 7 14' }],
    ['path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10' }],
    ['path', { d: 'M20.49 15a9 9 0 0 1-14.85 3.36L1 14' }],
  ],
  warning: [
    ['path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }],
    ['line', { x1: '12', y1: '9', x2: '12', y2: '13' }],
    ['line', { x1: '12', y1: '17', x2: '12.01', y2: '17' }],
  ],
  trash: [
    ['polyline', { points: '3 6 5 6 21 6' }],
    ['path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }],
    ['path', { d: 'M10 11v6' }],
    ['path', { d: 'M14 11v6' }],
    ['path', { d: 'M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2' }],
  ],
  arrow: [
    ['line', { x1: '5', y1: '12', x2: '19', y2: '12' }],
    ['polyline', { points: '12 5 19 12 12 19' }],
  ],
  clock: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['polyline', { points: '12 6 12 12 16 14' }],
  ],
  zap: [
    ['polygon', { points: '13 2 4 14 11 14 9 22 20 10 13 10 13 2' }],
  ],
  power: [
    ['path', { d: 'M18.36 6.64a9 9 0 1 1-12.73 0' }],
    ['line', { x1: '12', y1: '2', x2: '12', y2: '12' }],
  ],
  x: [
    ['line', { x1: '18', y1: '6', x2: '6', y2: '18' }],
    ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }],
  ],
  back: [
    ['line', { x1: '19', y1: '12', x2: '5', y2: '12' }],
    ['polyline', { points: '12 19 5 12 12 5' }],
  ],
  // Chevron-left — just the angle bracket (no horizontal shaft). Used
  // for the drill pill-bar's circular Back affordance, where the glyph
  // sits alone inside the pill and any extra shaft would crowd the
  // 24x24 frame.
  'chevron-left': [
    ['polyline', { points: '15 18 9 12 15 6' }],
  ],
  // Buffering — three horizontal dots. Used on the play/pause control
  // while the speaker is in BUFFERING_STATE (or any non-PLAY non-
  // STANDBY state with a selected item) so the visual is distinct
  // from both Play (triangle) and Pause (two bars). The CSS pulse on
  // .np-btn--play[data-phase="buffering"] carries the "in flight"
  // signal; this is the glyph the pulse is wrapped around. See #88.
  buffer: [
    ['circle', { cx: '5',  cy: '12', r: '1.5' }],
    ['circle', { cx: '12', cy: '12', r: '1.5' }],
    ['circle', { cx: '19', cy: '12', r: '1.5' }],
  ],
};

export function icon(name, size = 16) {
  if (name === 'equalizer') return equalizer();
  const shape = SHAPES[name];
  if (!shape) throw new Error(`unknown icon: ${name}`);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shape) {
    const child = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    svg.appendChild(child);
  }
  return svg;
}

function equalizer() {
  const span = document.createElement('span');
  span.setAttribute('class', 'eq');
  span.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) span.appendChild(document.createElement('i'));
  return span;
}

export const ICON_NAMES = Object.freeze([...Object.keys(SHAPES), 'equalizer']);
