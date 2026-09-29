// Time-of-Day (ToD) view: one column per tariff zone across a 0–24 h axis.
//
// Column WIDTH = zone duration (hours). Column HEIGHT = mean power over the zone
// (kW). So column AREA = energy (kWh): a 9-hour normal zone at 1,500 kW reads as
// visibly more energy than a 3-hour peak at 2,000 kW, which a plain bar chart hides.
// Segments stack each supply source; the dashed marker is mean demand.
//
// 'share' scale fills every column to 100% instead, showing each source's share of supply.

import { parseClock, time } from './data.js';
import { fmtNumber, fmtEnergy } from './format.js';

const { MIN, DAY } = time;
const SVGNS = 'http://www.w3.org/2000/svg';

/** Zones in the demo export's convention (blocks 1-12 peak, 13-20 normal, ...). */
export const DEFAULT_TOD_ZONES = [
  { name: 'Peak', start: '00:00', end: '03:00', kind: 'peak' },
  { name: 'Normal', start: '03:00', end: '05:00', kind: 'normal' },
  { name: 'Off-peak', start: '05:00', end: '10:00', kind: 'offpeak' },
  { name: 'Normal', start: '10:00', end: '19:00', kind: 'normal' },
  { name: 'Peak', start: '19:00', end: '24:00', kind: 'peak' },
];

/** Normalise zones to minute ranges on [0, 1440); wrapping zones (22:00–06:00) split in two. */
export function normaliseZones(zones) {
  const out = [];
  zones.forEach((z, zi) => {
    const a = parseClock(z.start);
    let b = parseClock(z.end);
    if (b === 0) b = 1440;
    if (b > a) out.push({ ...z, zi, a, b });
    else { out.push({ ...z, zi, a, b: 1440 }); if (b > 0) out.push({ ...z, zi, a: 0, b }); }
  });
  return out.sort((x, y) => x.a - y.a);
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Aggregate samples [i0, i1] into ToD columns.
 * A sample belongs to the zone containing the START of its interval.
 */
export function computeTod(data, zones, i0, i1, keys) {
  const cols = normaliseZones(zones).map((z) => ({
    ...z,
    hours: (z.b - z.a) / 60,
    range: `${hhmm(z.a)}–${hhmm(z.b)}`,
    indices: [],
    sum: Object.fromEntries(keys.map((k) => [k, 0])),
    costSum: Object.fromEntries(keys.map((k) => [k, 0])),
  }));
  const stepMs = data.stepMinutes * MIN;
  const h = data.stepMinutes / 60;
  for (let i = i0; i <= i1; i++) {
    const m = Math.floor((((data.t[i] - stepMs) % DAY) + DAY) % DAY / MIN);
    const c = cols.find((z) => m >= z.a && m < z.b);
    if (!c) continue;
    c.indices.push(i);
    for (const k of keys) {
      const v = data.values[k]?.[i] || 0;
      c.sum[k] += v;
      const pr = data.prices?.[k]?.[i];
      if (Number.isFinite(pr)) c.costSum[k] += v * pr;
    }
  }
  for (const c of cols) {
    c.count = c.indices.length;
    c.energy = Object.fromEntries(keys.map((k) => [k, c.sum[k] * h]));
    c.mean = Object.fromEntries(keys.map((k) => [k, c.count ? c.sum[k] / c.count : 0]));
    // cost (currency) and volume-weighted average purchase price (currency/kWh); NaN when unpriced
    c.cost = Object.fromEntries(keys.map((k) => [k, data.prices?.[k] ? c.costSum[k] * h : NaN]));
    c.price = Object.fromEntries(keys.map((k) => [k, c.energy[k] > 0 && data.prices?.[k] ? c.cost[k] / c.energy[k] : NaN]));
    c.days = c.count ? c.count / ((c.b - c.a) / data.stepMinutes) : 0;
  }
  return cols;
}

function s(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  parent.appendChild(el);
  return el;
}

/** Draw the ToD view into a chart instance's SVG layers. */
export function renderTod(chart) {
  const { m, pw, ph } = chart.dim;
  const t = chart.t;
  const state = chart.store.get();
  const [i0, i1] = chart.span;
  const share = chart.opts.todScale === 'share';

  for (const g of [chart.gBands, chart.gGrid, chart.gDays, chart.gAreas, chart.gEdges, chart.gLines, chart.gAxes, chart.gNow]) {
    g.replaceChildren();
    g.removeAttribute('clip-path');
  }

  const areas = chart.series.filter((x) => x.type === 'area' && x.stack !== false && !state.hidden.has(x.key));
  const totalKeys = areas.filter((x) => x.countInTotal !== false).map((x) => x.key);
  const demand = chart.series.find((x) => x.type === 'line' && !state.hidden.has(x.key));
  const keys = chart.series.map((x) => x.key);
  const cols = computeTod(chart.data, chart.opts.todZones, i0, i1, keys);
  chart.todCols = cols;

  // y domain
  let yMax = share ? 100 : 0;
  if (!share && chart.opts.yLock) yMax = chart._lockedMax(); // trend view: same scale for every day
  else if (!share) {
    for (const c of cols) {
      yMax = Math.max(yMax, areas.reduce((a, x) => a + c.mean[x.key], 0));
      if (demand) yMax = Math.max(yMax, c.mean[demand.key]);
    }
  }
  const ticks = [];
  let top = yMax;
  if (share) { for (let v = 0; v <= 100; v += 25) ticks.push(v); top = 110; } // headroom for the kWh totals
  else {
    const raw = (yMax * 1.1 || 1) / Math.max(3, Math.round(ph / 70));
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw);
    top = Math.ceil((yMax * 1.1 || 1) / step) * step;
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  }
  const y = (v) => m.top + ph - (v / top) * ph;
  const x = (min) => m.left + (min / 1440) * pw;
  chart.y = y;

  // grid + y labels
  for (const v of ticks) {
    const yy = Math.round(y(v)) + 0.5;
    s('line', { x1: m.left, x2: m.left + pw, y1: yy, y2: yy, stroke: v === 0 ? t.axis : t.grid }, chart.gGrid);
    s('text', { x: m.left - 8, y: yy + 3.5, 'text-anchor': 'end', 'font-size': 11, fill: t.muted, style: 'font-variant-numeric: tabular-nums' }, chart.gGrid).textContent = share ? `${v}%` : fmtNumber(v, 0, chart.opts.locale);
  }
  s('text', { x: m.left - 8, y: m.top - 14, 'text-anchor': 'end', 'font-size': 11, 'font-weight': 600, fill: t.muted }, chart.gGrid).textContent = share ? 'share' : `avg ${chart.opts.unit}`;

  const hz = state.hoverZone?.index;
  const GAP = 2;
  cols.forEach((c, ci) => {
    const xa = x(c.a) + GAP;
    const xb = x(c.b) - GAP;
    const w = Math.max(1, xb - xa);
    const dim = hz != null && hz !== ci;
    const g = s('g', { class: 'efc-todcol', opacity: dim ? 0.4 : 1 }, chart.gAreas);

    if (c.kind === 'peak') s('rect', { x: xa - GAP, y: m.top, width: w + 2 * GAP, height: ph, fill: t.band }, chart.gBands);

    if (!c.count) {
      s('rect', { x: xa, y: m.top, width: w, height: ph, fill: 'none', stroke: t.axis, 'stroke-dasharray': '3 4', rx: 4 }, g);
      s('text', { x: xa + w / 2, y: m.top + ph / 2, 'text-anchor': 'middle', 'font-size': 11.5, fill: t.muted }, g).textContent = 'No data yet';
    } else {
      const totalE = totalKeys.reduce((a, k) => a + c.energy[k], 0);
      let base = 0;
      const segs = [];
      for (const ser of areas) {
        const v = share ? (totalE > 0 ? (c.energy[ser.key] / totalE) * 100 : 0) : c.mean[ser.key];
        if (share && ser.countInTotal === false) continue; // share of supply excludes surplus
        if (v <= 0) continue;
        segs.push({ ser, lo: base, hi: base + v });
        base += v;
      }
      segs.forEach((sg, si) => {
        const y1 = y(sg.hi);
        const y0 = y(sg.lo);
        const fill = sg.ser.pattern === 'hatch' ? `url(#efc-hatch-${chart._uid}-${sg.ser.key})` : chart.colorMap[sg.ser.key];
        const isTop = si === segs.length - 1;
        // 4px rounded top on the uppermost segment only; square elsewhere
        const r = isTop ? Math.min(4, (y0 - y1) / 2, w / 2) : 0;
        const d = `M${xa},${y0}V${y1 + r}${r ? `Q${xa},${y1} ${xa + r},${y1}` : ''}H${xb - r}${r ? `Q${xb},${y1} ${xb},${y1 + r}` : ''}V${y0}Z`;
        s('path', { d, fill, 'fill-opacity': 0.92, class: 'efc-area', 'data-key': sg.ser.key }, g);
        if (si > 0) s('line', { x1: xa, x2: xb, y1: y0, y2: y0, stroke: t.surface, 'stroke-width': 1.5, class: 'efc-area', 'data-key': sg.ser.key }, chart.gEdges);
        // in-segment value label when there is room
        if (y0 - y1 > 30 && w > 64) {
          const txt = share ? `${fmtNumber(sg.hi - sg.lo, 0)}%` : fmtEnergy(c.energy[sg.ser.key], { digits: 1 });
          s('text', { x: xa + 8, y: y0 - 8, 'font-size': 11.5, 'font-weight': 650, fill: '#ffffff', 'fill-opacity': 0.95, 'pointer-events': 'none', style: 'paint-order: stroke; font-variant-numeric: tabular-nums', stroke: 'rgba(0,0,0,.18)', 'stroke-width': 2 }, g).textContent = txt;
        }
      });

      // mean demand marker
      if (demand) {
        const dv = share ? (totalE > 0 ? Math.min(100, (c.energy[demand.key] / totalE) * 100) : 0) : c.mean[demand.key];
        const yy = y(dv);
        s('line', { x1: xa - 4, x2: xb + 4, y1: yy, y2: yy, stroke: t.surface, 'stroke-width': 5, 'stroke-opacity': 0.75, class: 'efc-line', 'data-key': demand.key }, chart.gLines);
        s('line', { x1: xa - 4, x2: xb + 4, y1: yy, y2: yy, stroke: chart.colorMap[demand.key], 'stroke-width': 2, 'stroke-dasharray': demand.dash || null, class: 'efc-line', 'data-key': demand.key }, chart.gLines);
      }

      // total energy above the column
      const topY = y(base);
      if (w > 44) {
        s('text', { x: xa + w / 2, y: Math.max(m.top + 12, topY - 8), 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: t.ink, style: 'font-variant-numeric: tabular-nums' }, chart.gAxes).textContent = fmtEnergy(totalE, { digits: 1 });
      }
    }

    // zone name under the time axis, centred on its column
    if (w > 40) {
      s('text', { x: xa + w / 2, y: m.top + ph + 36, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 600, fill: c.kind === 'peak' ? t.ink : t.ink2 }, chart.gDays).textContent = w > 110 ? `${c.name} · ${fmtNumber(c.hours, c.hours % 1 ? 1 : 0)} h` : c.name;
    }
    c.x0 = xa - GAP;
    c.x1 = xb + GAP;
  });

  // x axis: zone boundaries
  const bounds = [...new Set(cols.flatMap((c) => [c.a, c.b]))];
  let lastX = -Infinity;
  for (const b of bounds) {
    const xx = Math.round(x(b)) + 0.5;
    s('line', { x1: xx, x2: xx, y1: m.top + ph, y2: m.top + ph + 4, stroke: t.axis }, chart.gAxes);
    if (xx - lastX < 38 && b !== 1440) continue; // skip colliding labels (always keep 24:00)
    lastX = xx;
    s('text', { x: xx, y: m.top + ph + 18, 'text-anchor': 'middle', 'font-size': 11, fill: t.muted, style: 'font-variant-numeric: tabular-nums' }, chart.gAxes).textContent = hhmm(b);
  }

  chart.gCross.replaceChildren();
}

/** Column index under an x pixel, or null. */
export function todColumnAt(chart, px) {
  const cols = chart.todCols || [];
  const i = cols.findIndex((c) => px >= c.x0 && px < c.x1);
  return i < 0 ? null : i;
}
