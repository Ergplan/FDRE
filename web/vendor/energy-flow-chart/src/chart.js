// Stacked-area time-series chart for power flows (supply stack + demand overlay).
// Zero dependencies; renders SVG. Linked to other components through a store.

import { createStore } from './store.js';
import { getTheme, resolveMode, resolveSeriesColors, applyThemeVars } from './themes.js';
import { indexSpan, nearestIndex, aggregator, parseClock, time } from './data.js';
import { renderTod, todColumnAt, computeTod, DEFAULT_TOD_ZONES } from './tod.js';
import { fmtPeriod, fmtPrice, fmtMoney, fmtEnergy, fmtNumber, fmtBlockTime, fmtDay, fmtDayLong, fmtRange, fmtWeekday, niceTicks, timeTicks, isoDay } from './format.js';
import { injectStyles } from './styles.js';
import { toCSV, download, svgToPNG } from './export.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const { MIN, DAY } = time;

function s(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}
function h(tag, attrs = {}, parent) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') el.textContent = v;
    else if (v != null) el.setAttribute(k, v);
  }
  if (parent) parent.appendChild(el);
  return el;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const DEFAULTS = {
  theme: 'energy',
  mode: 'auto',
  height: 420,
  navigator: true,
  navigatorHeight: 52,
  legend: true,
  unit: 'kW',
  yLabel: 'Power (kW)',
  yMin: 0,
  yMax: null,
  yLock: false, // true → y axis fixed to the highest value in the whole loaded range (trend view)
  yLockButton: true, // show the "Lock Y" toggle in the chart
  curve: 'linear', // 'linear' | 'step'
  initialRange: null, // [t0, t1] to override the range mode's default window
  rangeMode: 'day', // 'day': one whole calendar day, zoom/pan locked (overview snaps to days)
  //                   'week': last `weekDays` days, free zoom + pan
  weekDays: 7,
  // built-in toolbar; true / false, or pick controls: { range, stepper, view, todScale, lock, export }
  toolbar: true,
  stickyHover: true, // crosshair / zone stays where the pointer left it (pin); Esc or × clears
  exportBand: true, // PNG export includes the readout band above the plot
  minSpanMinutes: 60,
  live: false, // { series: 'demand' }
  bands: [], // [{ start: '18:00', end: '22:00', label: 'Peak' }]
  view: 'timeline', // 'timeline' | 'tod'
  todZones: DEFAULT_TOD_ZONES,
  todScale: 'absolute', // 'absolute' (area = kWh) | 'share' (100% columns)
  dayMarkers: true,
  tooltip: {},
  locale: 'en-IN',
  margin: { top: 30, right: 18, bottom: 30, left: 58 },
};

export class EnergyFlowChart {
  /**
   * @param {HTMLElement} el
   * @param {object} options  see DEFAULTS and types/index.d.ts
   */
  constructor(el, options) {
    if (!el) throw new Error('EnergyFlowChart: container element is required');
    injectStyles(el.ownerDocument);
    this.el = el;
    this.opts = { ...DEFAULTS, ...options, margin: { ...DEFAULTS.margin, ...(options.margin || {}) }, tooltip: { ...(options.tooltip || {}) } };
    this.store = options.store || createStore();
    this.data = options.data;
    this.series = options.series.map((x) => ({ type: 'area', stack: 'supply', ...x }));
    this._uid = Math.random().toString(36).slice(2, 8);
    this._buildDom();
    this.setTheme(this.opts.theme, this.opts.mode, false);

    const st = this.store.get();
    if (!st.range) this.store.set({ range: this._initialRange() });

    this._unsub = this.store.subscribe((state, changed) => {
      if (changed.includes('range') && state.hover != null) {
        // drop a hover that fell outside the new window so linked cards never show off-range readings
        const [a, b] = indexSpan(this.data.t, state.range[0], state.range[1]);
        if (state.hover < a || state.hover > b) this.store.set({ hover: null });
      }
      if (changed.includes('range') && state.hoverZone) this.store.set({ hoverZone: null });
      if (changed.includes('hidden')) this._applyHighlight(); // toggle state updates immediately; geometry next frame
      if (changed.includes('range') || changed.includes('hidden')) this._scheduleRender();
      else if (changed.includes('highlight')) this._applyHighlight();
      if (changed.includes('hover') || changed.includes('hoverZone')) this._drawHover();
      if (changed.includes('range') && this.opts.onRangeChange) this.opts.onRangeChange(state.range);
    });

    this._ro = new ResizeObserver(() => this._scheduleRender());
    this._ro.observe(this.plotEl);

    if (typeof matchMedia !== 'undefined') {
      this._mq = matchMedia('(prefers-color-scheme: dark)');
      this._mqFn = () => this.opts.mode === 'auto' && this.setTheme(this.opts.theme, 'auto');
      this._mq.addEventListener?.('change', this._mqFn);
      this._mo = new MutationObserver(this._mqFn);
      this._mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    this.render();
  }

  // ------------------------------------------------------------------ public API

  /** Replace the dataset (e.g. on a live update). Keeps the window pinned to the end if it was. */
  setData(data, { keepRange = true } = {}) {
    const old = this.data;
    const [t0, t1] = this.store.get().range || [];
    const wasAtEnd = old && old.t.length && t1 >= old.t[old.t.length - 1];
    this.data = data;
    if (!!old?.prices !== !!data.prices) this._buildLegend();
    if (!keepRange || !t0) this.store.set({ range: this._initialRange() });
    else if (this.opts.rangeMode === 'day') {
      const oldLast = Math.floor((old.t[old.t.length - 1] - 1) / DAY);
      const newLast = Math.floor((data.t[data.t.length - 1] - 1) / DAY);
      if (wasAtEnd && newLast > oldLast) this.showDay(newLast * DAY); // follow into the new day
    } else if (wasAtEnd && data.t.length) {
      const end = data.t[data.t.length - 1];
      const shift = end - old.t[old.t.length - 1];
      this.store.set({ range: [t0 + shift, t1 + shift] });
    }
    this.render();
    this.store.set({ dataRev: (this.store.get().dataRev || 0) + 1 });
  }

  setSeries(series) {
    this.series = series.map((x) => ({ type: 'area', stack: 'supply', ...x }));
    this._resolveColors();
    this._buildLegend();
    this.render();
  }

  setTheme(theme, mode = this.opts.mode, rerender = true) {
    this.opts.theme = theme;
    this.opts.mode = mode;
    this.theme = getTheme(theme);
    this.modeResolved = resolveMode(mode);
    this.t = this.theme[this.modeResolved];
    applyThemeVars(this.el, this.theme, this.modeResolved);
    this._resolveColors();
    this._buildLegend();
    if (rerender) this.render();
    this.store.set({ themeRev: (this.store.get().themeRev || 0) + 1 });
    this.opts.onThemeChange?.(this.theme, this.modeResolved);
  }

  /** 'day' (locked to one calendar day) or 'week' (last N days, free zoom/pan). */
  setRangeMode(mode) {
    if (mode !== 'day' && mode !== 'week') throw new Error(`setRangeMode: 'day' | 'week', got ${mode}`);
    const prev = this.opts.rangeMode;
    this.opts.rangeMode = mode;
    if (mode === 'day') {
      // keep context: the day of the pinned block, else the last day in view
      const st = this.store.get();
      const t = st.hover != null ? this.data.t[st.hover] - 1 : st.range[1] - 1;
      this.showDay(Math.min(t, this._extent()[1] - 1));
    } else if (prev !== mode) this.store.set({ range: this._initialRange() });
    this.render();
    this.opts.onRangeModeChange?.(mode);
  }
  get rangeMode() { return this.opts.rangeMode; }
  /** Step the window by whole days (day mode) or by its own length (week mode). */
  step(n) {
    const [t0, t1] = this.store.get().range;
    const d = this.opts.rangeMode === 'day' ? DAY : t1 - t0;
    this.setRange(t0 + n * d, t1 + n * d);
  }
  /** Clear a pinned crosshair / zone. */
  clearPin() { this.store.set({ hover: null, hoverZone: null }); }

  /** Lock the y axis to the highest value across the whole loaded range (trend view). */
  setYLock(on) {
    this.opts.yLock = !!on;
    this.render();
    this.opts.onYLockChange?.(this.opts.yLock);
  }

  /**
   * Highest value the chart can draw anywhere in the loaded data, for the current view
   * and visible series. Timeline: stack total / line per sample. ToD: per-day zone means
   * (each day aggregated on its own, so a single day's column can reach the lock).
   */
  _lockedMax() {
    const hidden = this.store.get().hidden;
    const key = `${this.opts.view}|${[...hidden].sort()}|${this.data.t.length}|${this.data.t[this.data.t.length - 1]}|${this.opts.todScale}`;
    if (this._lockCache?.key === key && this._lockCache.data === this.data) return this._lockCache.value;
    const vis = this.series.filter((x) => !hidden.has(x.key));
    const stacks = new Map();
    for (const x of vis.filter((q) => q.type === 'area')) {
      const k = x.stack === false ? `__solo_${x.key}` : x.stack;
      if (!stacks.has(k)) stacks.set(k, []);
      stacks.get(k).push(x);
    }
    const lines = vis.filter((q) => q.type === 'line');
    let max = 0;
    if (this.opts.view === 'tod') {
      const areas = vis.filter((q) => q.type === 'area' && q.stack !== false);
      const keys = vis.map((q) => q.key);
      for (const d of this.days()) {
        const [a, b] = indexSpan(this.data.t, d, d + DAY);
        if (b < a || this.data.t[a] > d + DAY) continue;
        for (const c of computeTod(this.data, this.opts.todZones, a, b, keys)) {
          max = Math.max(max, areas.reduce((acc, q) => acc + c.mean[q.key], 0));
          for (const l of lines) max = Math.max(max, c.mean[l.key]);
        }
      }
    } else {
      const n = this.data.t.length;
      for (let i = 0; i < n; i++) {
        for (const members of stacks.values()) {
          let tot = 0;
          for (const q of members) tot += Math.max(0, this.data.values[q.key]?.[i] || 0);
          if (tot > max) max = tot;
        }
        for (const l of lines) { const v = this.data.values[l.key]?.[i] || 0; if (v > max) max = v; }
      }
    }
    this._lockCache = { key, data: this.data, value: max };
    return max;
  }

  /** 'timeline' (15-min stacked area) or 'tod' (one column per tariff zone, width = hours). */
  setView(view) {
    if (view === this.opts.view) return;
    this.opts.view = view;
    this.store.set({ hover: null, hoverZone: null });
    this.el.dataset.efcView = view;
    this.render();
    this.opts.onViewChange?.(view);
  }
  get view() { return this.opts.view; }

  setOptions(patch) {
    Object.assign(this.opts, patch);
    this.render();
  }

  /** Visible window in epoch-ms. */
  setRange(t0, t1) {
    const [a, b] = this._clampRange(t0, t1);
    this.store.set({ range: [a, b] });
  }
  /** Show one calendar day (date string 'YYYY-MM-DD' or epoch-ms inside the day). */
  showDay(day) {
    const d0 = typeof day === 'number' ? Math.floor(day / DAY) * DAY : Date.parse(`${day}T00:00:00Z`);
    this.setRange(d0, d0 + DAY);
  }
  showLast(hours) {
    if (hours > 24 && this.opts.rangeMode === 'day') this.opts.rangeMode = 'week';
    const end = this._extent()[1];
    this.setRange(end - hours * 3_600_000, end);
  }
  /** Whole loaded range (switches to week mode, since a day can't show it). */
  showAll() {
    if (this.opts.rangeMode === 'day') { this.opts.rangeMode = 'week'; this.opts.onRangeModeChange?.('week'); }
    this.setRange(...this._extent());
  }
  /** Distinct days present in the data (UTC-midnight epochs). */
  days() {
    const set = new Set(this.data.t.map((t) => Math.floor((t - 1) / DAY) * DAY));
    return [...set].sort((a, b) => a - b);
  }
  colors() { return { ...this.colorMap }; }
  getVisibleSpan() { const [t0, t1] = this.store.get().range; return indexSpan(this.data.t, t0, t1); }
  aggregate() { const [i0, i1] = this.getVisibleSpan(); return aggregator(this.data, i0, i1); }

  setTableVisible(on) {
    this.tableEl.hidden = !on;
    if (on) this._renderTable();
  }

  exportCSV(filename) {
    const [i0, i1] = this.getVisibleSpan();
    const csv = toCSV(this.data, this.series, i0, i1, this.opts.unit);
    download(new Blob([csv], { type: 'text/csv' }), filename || `energy-flow-${isoDay(this.store.get().range[0] + 1)}.csv`);
  }
  /**
   * PNG of what the viewer sees: the readout band (values at the pinned block / zone)
   * above the plot, crosshair included. Named after the pinned timestamp when there is one.
   */
  async exportPNG(filename, scale = 2) {
    this.flush();
    const blob = await svgToPNG(this.exportSVG(), this.t.surface, scale);
    download(blob, filename || this._exportName('png'));
    return blob;
  }

  /** Composed SVG (band + plot) used by exportPNG; handy for custom sharing flows. */
  exportSVG() {
    this.flush();
    const W = this.dim.W;
    const out = s('svg', { xmlns: SVGNS, 'font-family': 'system-ui, -apple-system, Segoe UI, sans-serif' });
    let y = 0;
    if (this.opts.exportBand && this.bandEl) {
      const band = this._bandSVG(W);
      out.appendChild(band.g);
      y = band.height + 8;
    }
    const plot = this.svg.cloneNode(true);
    const g = s('g', { transform: `translate(0 ${y})` }, out);
    for (const child of [...plot.childNodes]) g.appendChild(child);
    const H = y + this.dim.H;
    out.setAttribute('width', W);
    out.setAttribute('height', H);
    out.setAttribute('viewBox', `0 0 ${W} ${H}`);
    return out;
  }

  _exportName(ext) {
    const st = this.store.get();
    const [t0, t1] = st.range;
    if (this.opts.view === 'tod') {
      const z = st.hoverZone ? this.todCols?.[st.hoverZone.index] : null;
      const period = `${isoDay(t0 + 1)}${t1 - t0 > DAY ? `_to_${isoDay(t1 - 1)}` : ''}`;
      return `energy-tod-${period}${z ? `-${z.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${z.range.replace(/[^0-9]+/g, '')}` : ''}.${ext}`;
    }
    if (st.hover != null) { const t = this.data.t[st.hover]; return `energy-flow-${isoDay(t - 1)}-${fmtBlockTime(t).replace(':', '')}.${ext}`; }
    return `energy-flow-${isoDay(t0 + 1)}${t1 - t0 > DAY ? `_to_${isoDay(t1 - 1)}` : ''}.${ext}`;
  }

  /** Draw the readout band as SVG (same text as on screen) for export. */
  _bandSVG(W) {
    const ctx = (this._measure ||= document.createElement('canvas').getContext('2d'));
    const font = (wgt, px) => `${wgt} ${px}px system-ui, -apple-system, Segoe UI, sans-serif`;
    const width = (txt, wgt, px) => { ctx.font = font(wgt, px); return ctx.measureText(txt).width; };
    const t = this.t;
    const g = s('g', {});
    const pad = 12;
    const text = (x, yy, txt, { size = 12, weight = 400, fill = t.ink } = {}) => {
      s('text', { x, y: yy, 'font-size': size, 'font-weight': weight, fill, style: 'font-variant-numeric: tabular-nums' }, g).textContent = txt;
    };
    // header: when + sub
    const whenMain = this.bandWhen.querySelector('b')?.textContent || '';
    const whenSub = this.bandWhen.querySelector('span')?.textContent || '';
    let y = pad + 13;
    text(pad, y, whenMain, { size: 13.5, weight: 700 });
    if (whenSub) text(pad + width(whenMain, 700, 13.5) + 10, y, whenSub, { size: 12, fill: t.muted });
    // chips (visible series only), flowing with wrap
    const hidden = this.store.get().hidden;
    const priced = !!this.data?.prices;
    const chipH = priced ? 46 : 32;
    let x = pad;
    y += 10;
    for (const [k, c] of Object.entries(this.chips || {})) {
      if (hidden.has(k)) continue;
      const label = c.b.querySelector('.efc-chip-label').textContent;
      const val = c.val.textContent;
      const price = c.price?.textContent?.trim() || '';
      const w = 20 + Math.max(width(label, 400, 11.5), width(val, 700, 13), price ? width(price, 400, 11) : 0) + 16;
      if (x + w > W - pad) { x = pad; y += chipH + 4; }
      const ser = this.series.find((q) => q.key === k);
      if (ser?.type === 'line') s('line', { x1: x, x2: x + 12, y1: y + 12, y2: y + 12, stroke: this.colorMap[k], 'stroke-width': 2, 'stroke-dasharray': ser.dash ? '3 2' : null }, g);
      else s('rect', { x, y: y + 6, width: 12, height: 12, rx: 3, fill: ser?.pattern === 'hatch' ? `url(#efc-hatch-${this._uid}-${k})` : this.colorMap[k] }, g);
      text(x + 18, y + 16, label, { size: 11.5, fill: t.ink2 });
      text(x + 18, y + 31, val, { size: 13, weight: 700 });
      if (price) text(x + 18, y + 44, price, { size: 11, fill: t.muted });
      x += w;
    }
    y += chipH + 10;
    // summary line
    x = pad;
    for (const row of this.bandSum.children) {
      const label = row.firstChild?.textContent || '';
      const val = row.lastChild?.textContent || '';
      const w = width(label, 400, 11.5) + 6 + width(val, 700, 13) + 22;
      if (x + w > W - pad) { x = pad; y += 20; }
      text(x, y + 4, label, { size: 11.5, fill: t.muted });
      const tone = row.classList.contains('pos') ? '#0a8a0a' : row.classList.contains('neg') ? '#d03b3b' : t.ink;
      text(x + width(label, 400, 11.5) + 6, y + 4, val, { size: 13, weight: 700, fill: tone });
      x += w;
    }
    const height = y + pad;
    g.insertBefore(s('rect', { x: 0.5, y: 0.5, width: W - 1, height: height - 1, rx: 10, fill: t.surface, stroke: t.axis }, g), g.firstChild);
    return { g, height };
  }

  destroy() {
    this._unsub?.();
    this._ro?.disconnect();
    this._mo?.disconnect();
    this._mq?.removeEventListener?.('change', this._mqFn);
    this.el.replaceChildren();
    this.el.classList.remove('efc');
  }

  // ------------------------------------------------------------------ internals

  _extent() {
    const t = this.data.t;
    if (!t.length) return [0, DAY];
    return [t[0] - this.data.stepMinutes * MIN, t[t.length - 1]];
  }

  _initialRange() {
    const r = this.opts.initialRange;
    const [, b] = this._extent();
    if (Array.isArray(r)) return this._clampRange(r[0], r[1]);
    if (r === 'all') return this._clampRange(...this._extent()); // legacy value
    const lastDay = Math.floor((b - 1) / DAY) * DAY; // the calendar day holding the latest sample
    if (this.opts.rangeMode === 'week') return this._clampRange(lastDay + DAY - this.opts.weekDays * DAY, lastDay + DAY);
    return this._clampRange(lastDay, lastDay + DAY);
  }

  _clampRange(t0, t1) {
    const [a, b] = this._extent();
    // Allow the right edge to extend to the end of the current day, so "today"
    // shows the remaining blocks as empty space rather than stretching.
    const bMax = Math.max(b, Math.ceil(b / DAY) * DAY);
    if (this.opts.rangeMode === 'day') {
      // day mode: always exactly one whole calendar day, the one under the window's centre
      const first = Math.floor(a / DAY) * DAY + (a % DAY > DAY - this.data.stepMinutes * MIN ? DAY : 0);
      const lastDay = bMax - DAY;
      const d = clamp(Math.floor((t0 + t1) / 2 / DAY) * DAY, first, lastDay);
      return [d, d + DAY];
    }
    // week mode: snap to whole blocks, so periods read 12:15–16:45 and totals cover whole blocks
    const stepMs = this.data.stepMinutes * MIN;
    const minSpan = Math.ceil((this.opts.minSpanMinutes * MIN) / stepMs) * stepMs;
    let span = Math.max(minSpan, Math.round((t1 - t0) / stepMs) * stepMs);
    t0 = Math.round(t0 / stepMs) * stepMs;
    span = Math.min(span, bMax - a);
    let s0 = clamp(t0, a, bMax - span);
    return [s0, s0 + span];
  }

  _resolveColors() { this.colorMap = resolveSeriesColors(this.series, this.theme, this.modeResolved); }

  _buildDom() {
    const el = this.el;
    el.classList.add('efc');
    el.replaceChildren();


    // Toolbar: [1 day | 7 days] ‹ period ›  ·  [Timeline | ToD] [kWh | %]  (●) Lock Y axis  Reset zoom  Export PNG
    const tb = this.opts.toolbar;
    const want = (k) => tb === true || (tb && tb[k] !== false && (tb[k] || tb[k] === undefined));
    this.toolbarEl = h('div', { class: 'efc-toolbar', role: 'toolbar', 'aria-label': 'Chart controls' }, el);
    if (!tb) this.toolbarEl.hidden = true;
    const seg = (items, onPick, label) => {
      const wrap = h('div', { class: 'efc-seg', role: 'group', 'aria-label': label }, this.toolbarEl);
      const btns = items.map(([val, txt]) => {
        const b = h('button', { type: 'button', 'data-v': val, 'aria-pressed': 'false', text: txt }, wrap);
        b.addEventListener('click', () => onPick(val));
        return b;
      });
      return { wrap, set: (v) => btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v))) };
    };
    this.tbRange = seg([['day', '1 day'], ['week', `${this.opts.weekDays} days`]], (v) => this.setRangeMode(v), 'Range');
    if (!want('range')) this.tbRange.wrap.hidden = true;
    this.topEl = h('div', { class: 'efc-range' }, this.toolbarEl);
    this.prevBtn = h('button', { class: 'efc-step', type: 'button', 'aria-label': 'Previous', text: '‹' }, this.topEl);
    this.rangeLabel = h('span', { class: 'efc-period', 'aria-live': 'polite' }, this.topEl);
    this.nextBtn = h('button', { class: 'efc-step', type: 'button', 'aria-label': 'Next', text: '›' }, this.topEl);
    this.prevBtn.addEventListener('click', () => this.step(-1));
    this.nextBtn.addEventListener('click', () => this.step(1));
    if (!want('stepper')) { this.prevBtn.hidden = true; this.nextBtn.hidden = true; }
    h('span', { class: 'efc-tb-spacer' }, this.toolbarEl);
    this.tbView = seg([['timeline', 'Timeline'], ['tod', 'ToD']], (v) => this.setView(v), 'View');
    if (!want('view')) this.tbView.wrap.hidden = true;
    this.tbScale = seg([['absolute', 'kWh'], ['share', 'Share %']], (v) => this.setOptions({ todScale: v }), 'ToD scale');
    this._wantScale = want('todScale');
    // small switch: [ ●— ] Lock Y axis
    this.lockBtn = h('button', { class: 'efc-lock', type: 'button', role: 'switch', 'aria-checked': 'false', title: 'Fix the y axis to the highest value in the loaded date range, so days and zooms compare on one scale' }, this.toolbarEl);
    h('span', { class: 'efc-switch', 'aria-hidden': 'true' }, this.lockBtn);
    h('span', { text: 'Lock Y axis' }, this.lockBtn);
    this.lockBtn.addEventListener('click', () => this.setYLock(!this.opts.yLock));
    this._wantLock = want('lock');
    this.resetBtn = h('button', { class: 'efc-reset', type: 'button', text: 'Reset zoom', hidden: '' }, this.toolbarEl);
    this.resetBtn.addEventListener('click', () => this.store.set({ range: this._initialRange() }));
    this.exportBtn = h('button', { class: 'efc-export', type: 'button', title: 'Download a PNG of the chart with the readout band (pin a time first by hovering it)' }, this.toolbarEl);
    this.exportBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg><span>Export PNG</span>'; // static markup
    this.exportBtn.addEventListener('click', () => this.exportPNG());
    if (!want('export')) this.exportBtn.hidden = true;

    // Readout band: doubles as the legend. Shows values at the hovered block / zone.
    this.bandEl = h('div', { class: 'efc-band' }, el);
    this.bandWhen = h('div', { class: 'efc-band-when' }, this.bandEl);
    this.legendEl = h('div', { class: 'efc-legend efc-band-items', role: 'group', 'aria-label': 'Series (click to toggle)' }, this.bandEl);
    this.bandSum = h('div', { class: 'efc-band-sum' }, this.bandEl);

    this.plotEl = h('div', { class: 'efc-plot' }, el);
    this.svg = s('svg', { role: 'img', 'font-family': 'system-ui, -apple-system, Segoe UI, sans-serif' }, this.plotEl);
    this.srEl = h('div', { class: 'efc-sr', 'aria-live': 'polite' }, this.plotEl);

    const g = (cls, parent = this.svg) => s('g', { class: cls }, parent);
    this.defs = s('defs', {}, this.svg);
    this.gBands = g('efc-bands');
    this.gGrid = g('efc-grid');
    this.gDays = g('efc-days');
    this.gAreas = g('efc-areas');
    this.gEdges = g('efc-edges');
    this.gLines = g('efc-lines');
    this.gAxes = g('efc-axes');
    this.gNow = g('efc-now');
    this.gBrush = g('efc-brush');
    this.gCross = g('efc-cross');
    this.hit = s('rect', { class: 'efc-hit', fill: 'transparent', tabindex: '0', 'aria-label': 'Chart plot. Use arrow keys to move between intervals, + and − to zoom.' }, this.svg);
    this.focusRing = s('rect', { class: 'efc-focusring', fill: 'none', rx: 4, 'stroke-width': 2, 'pointer-events': 'none' }, this.svg);

    if (this.opts.navigator) {
      const wrap = h('div', { class: 'efc-nav-wrap' }, el);
      this.nav = s('svg', { class: 'efc-nav', 'aria-hidden': 'true' }, wrap);
    }
    this.tableEl = h('div', { class: 'efc-table', hidden: '' }, el);
    this._bindPlot();
    if (this.nav) this._bindNav();
  }

  _buildLegend() {
    if (!this.legendEl) return;
    this.legendEl.replaceChildren();
    if (!this.opts.legend) return;
    const hidden = this.store.get().hidden;
    this.chips = {};
    // Lines (demand) first, then the stack top-down, matching the chart.
    const ordered = [...this.series.filter((x) => x.type === 'line'), ...this.series.filter((x) => x.type === 'area').reverse()];
    for (const ser of ordered) {
      if (ser.legend === false) continue;
      const b = h('button', { type: 'button', class: 'efc-chip', 'aria-pressed': String(!hidden.has(ser.key)), title: 'Click to toggle, hover to highlight' }, this.legendEl);
      const key = h('span', { class: `efc-key${ser.type === 'line' ? ' is-line' : ''}${ser.type === 'line' && !ser.dash ? ' is-solid' : ''}${ser.pattern === 'hatch' ? ' is-hatch' : ''}` }, b);
      if (ser.type === 'line') key.style.borderTopColor = this.colorMap[ser.key];
      else key.style.background = this.colorMap[ser.key];
      h('span', { class: 'efc-chip-label', text: ser.label || ser.key }, b);
      const val = h('b', { class: 'efc-chip-val' }, b);
      // price line only when the dataset carries prices (reserved even when idle → no layout jump)
      const price = this.data?.prices ? h('span', { class: 'efc-chip-price' }, b) : null;
      this.chips[ser.key] = { b, val, price };
      b.addEventListener('click', () => this.store.toggle(ser.key));
      b.addEventListener('mouseenter', () => this.store.setHighlight([ser.key]));
      b.addEventListener('mouseleave', () => this.store.setHighlight(null));
      b.addEventListener('focus', () => this.store.setHighlight([ser.key]));
      b.addEventListener('blur', () => this.store.setHighlight(null));
    }
  }

  _scheduleRender() {
    if (this._raf) return;
    // Coalesce into one frame. Hidden tabs pause rAF, so fall back to a timer there:
    // live updates and toggles made while hidden must still land in the DOM.
    const run = () => { if (!this._raf) return; this._raf = null; this.render(); };
    this._raf = document.hidden ? setTimeout(run, 16) : requestAnimationFrame(run);
  }

  /** Apply any pending redraw now (e.g. right before exportPNG, or in tests). */
  flush() {
    if (!this._raf) return;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._raf);
    this._raf = null;
    this.render();
  }

  /** Full redraw. Cheap enough (~700 pts × 7 series) to run on every range change. */
  render() {
    if (!this.data || !this.plotEl.isConnected) return;
    const { height } = this.opts;
    // ToD view needs a second axis line for zone names
    const m = this.opts.view === 'tod' ? { ...this.opts.margin, bottom: this.opts.margin.bottom + 18 } : this.opts.margin;
    const W = Math.max(280, this.plotEl.clientWidth || this.el.clientWidth || 800);
    const H = height;
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    this.dim = { W, H, pw, ph, m };
    this.svg.setAttribute('width', W);
    this.svg.setAttribute('height', H);
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const state = this.store.get();
    const [t0, t1] = state.range;
    const tArr = this.data.t;
    let [i0, i1] = indexSpan(tArr, t0, t1);
    // include one point either side so the area reaches the plot edges
    const j0 = Math.max(0, i0 - 1);
    const j1 = Math.min(tArr.length - 1, i1 + 1);
    this.span = [i0, i1];

    const x = (t) => m.left + ((t - t0) / (t1 - t0)) * pw;
    this.x = x;
    this.xInv = (px) => t0 + ((px - m.left) / pw) * (t1 - t0);

    if (this.opts.view === 'tod') {
      this.layers = [];
      this.lineSeries = [];
      this.j0 = j0;
      this._renderDefs();
      renderTod(this);
      // a zone hovered against stale columns (before this frame) → re-point it at the fresh ones
      const hz = this.store.get().hoverZone;
      const fresh = hz && this.todCols[hz.index];
      if (fresh && fresh.indices !== hz.indices) this.store.set({ hoverZone: { ...hz, indices: fresh.indices } });
      this._renderNav();
      this._finishRender(t0, t1);
      return;
    }

    // ---- stacks
    const visible = this.series.filter((x) => !state.hidden.has(x.key));
    const stacks = new Map();
    for (const ser of visible.filter((x) => x.type === 'area')) {
      const k = ser.stack === false ? `__solo_${ser.key}` : ser.stack;
      if (!stacks.has(k)) stacks.set(k, []);
      stacks.get(k).push(ser);
    }
    this.layers = []; // { ser, lo:number[], hi:number[] }  (indexed j0..j1)
    let yMaxData = 0;
    for (const members of stacks.values()) {
      const base = new Array(j1 - j0 + 1).fill(0);
      for (const ser of members) {
        const v = this.data.values[ser.key] || [];
        const lo = base.slice();
        const hi = base.map((b, k) => b + Math.max(0, v[j0 + k] || 0));
        for (let k = 0; k < base.length; k++) base[k] = hi[k];
        this.layers.push({ ser, lo, hi });
      }
      for (let k = i0 - j0; k <= i1 - j0; k++) yMaxData = Math.max(yMaxData, base[k] || 0);
    }
    this.lineSeries = visible.filter((x) => x.type === 'line');
    for (const ser of this.lineSeries) {
      const v = this.data.values[ser.key] || [];
      for (let i = i0; i <= i1; i++) yMaxData = Math.max(yMaxData, v[i] || 0);
    }
    if (this.opts.yLock && this.opts.yMax == null) yMaxData = this._lockedMax();
    const yt = niceTicks(this.opts.yMin, this.opts.yMax ?? (yMaxData * 1.06 || 1), Math.max(3, Math.round(ph / 70)));
    const yMin = yt.min;
    const yMax = this.opts.yMax ?? yt.max;
    const y = (v) => m.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
    this.y = y;
    this.j0 = j0;

    this._renderDefs();
    this._renderBands(t0, t1);
    this._renderGrid(yt.ticks.filter((v) => v <= yMax));
    this._renderDays(t0, t1);
    this._renderSeries(j0, j1);
    this._renderAxes(t0, t1);
    this._renderNow(t0, t1);
    this._renderNav();

    this._finishRender(t0, t1);
  }

  _finishRender(t0, t1) {
    const { m, pw, ph } = this.dim;
    this.hit.setAttribute('x', m.left);
    this.hit.setAttribute('y', m.top);
    this.hit.setAttribute('width', pw);
    this.hit.setAttribute('height', ph);
    this.hit.style.cursor = this.opts.view === 'tod' ? 'pointer' : '';
    const lockable = this._wantLock && this.opts.yLockButton && !(this.opts.view === 'tod' && this.opts.todScale === 'share');
    this.lockBtn.hidden = !lockable;
    this.lockBtn.setAttribute('aria-checked', String(!!this.opts.yLock));
    this.tbRange.set(this.opts.rangeMode);
    this.tbView.set(this.opts.view);
    this.tbScale.set(this.opts.todScale);
    this.tbScale.wrap.hidden = !(this._wantScale && this.opts.view === 'tod');
    const [ea, eb] = this._extent();
    this.prevBtn.disabled = t0 <= ea + this.data.stepMinutes * MIN;
    this.nextBtn.disabled = t1 >= eb;
    this.el.dataset.efcRange = this.opts.rangeMode;
    Object.entries({ x: m.left - 2, y: m.top - 2, width: pw + 4, height: ph + 4, stroke: this.t.accent }).forEach(([k, v]) => this.focusRing.setAttribute(k, v));

    const init = this._initialRange();
    const zoomed = this.opts.rangeMode === 'week' && (Math.abs(t1 - t0 - (init[1] - init[0])) > MIN || Math.abs(t0 - init[0]) > MIN);
    this.resetBtn.hidden = !zoomed;
    this.rangeLabel.textContent = this.opts.rangeLabel === false ? '' : fmtPeriod(t0, t1, { long: true });
    this.svg.setAttribute('aria-label', (this.opts.view === 'tod' ? 'Time-of-day columns. ' : '') + this._summary());

    this._applyHighlight();
    this._drawHover();
    if (!this.tableEl.hidden) this._renderTable();
  }

  _summary() {
    const agg = this.aggregate();
    const parts = this.series.map((ser) => `${ser.label || ser.key} ${fmtNumber(agg.energy(ser.key) / 1000, 1)} MWh`);
    return `Stacked area chart, ${fmtRange(...this.store.get().range)}. ${parts.join(', ')}.`;
  }

  _renderDefs() {
    this.defs.replaceChildren();
    const { m, pw, ph } = this.dim;
    const clip = s('clipPath', { id: `efc-clip-${this._uid}` }, this.defs);
    s('rect', { x: m.left, y: m.top - 1, width: pw, height: ph + 1 }, clip);
    for (const ser of this.series) {
      if (ser.pattern !== 'hatch') continue;
      const c = this.colorMap[ser.key];
      const p = s('pattern', { id: `efc-hatch-${this._uid}-${ser.key}`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, this.defs);
      s('rect', { width: 6, height: 6, fill: c, 'fill-opacity': 0.22 }, p);
      s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: c, 'stroke-width': 2.2 }, p);
    }
  }

  _renderBands(t0, t1) {
    this.gBands.replaceChildren();
    const bands = this.opts.bands || [];
    if (!bands.length) return;
    const { m, ph } = this.dim;
    for (let d = Math.floor(t0 / DAY) * DAY; d < t1; d += DAY) {
      for (const b of bands) {
        const a = d + parseClock(b.start) * MIN;
        let e = d + parseClock(b.end) * MIN;
        if (e <= a) e += DAY;
        if (e < t0 || a > t1) continue;
        const xa = Math.max(m.left, this.x(a));
        const xb = Math.min(m.left + this.dim.pw, this.x(e));
        if (xb - xa < 1) continue;
        s('rect', { x: xa, y: m.top, width: xb - xa, height: ph, fill: b.color || this.t.band }, this.gBands);
        if (b.label && xb - xa > 34) {
          s('text', { x: xa + 5, y: m.top + ph - 6, 'font-size': 10.5, fill: this.t.muted, 'font-weight': 600, 'letter-spacing': '0.04em' }, this.gBands).textContent = b.label.toUpperCase();
        }
      }
    }
  }

  _renderGrid(ticks) {
    this.gGrid.replaceChildren();
    const { m, pw } = this.dim;
    for (const v of ticks) {
      const yy = Math.round(this.y(v)) + 0.5;
      s('line', { x1: m.left, x2: m.left + pw, y1: yy, y2: yy, stroke: v === ticks[0] ? this.t.axis : this.t.grid, 'stroke-width': 1 }, this.gGrid);
      s('text', { x: m.left - 8, y: yy + 3.5, 'text-anchor': 'end', 'font-size': 11, fill: this.t.muted, style: 'font-variant-numeric: tabular-nums' }, this.gGrid).textContent = fmtNumber(v, 0, this.opts.locale);
    }
    s('text', { x: m.left - 8, y: m.top - 14, 'text-anchor': 'end', 'font-size': 11, 'font-weight': 600, fill: this.t.muted }, this.gGrid).textContent = this.opts.unit;
  }

  _renderDays(t0, t1) {
    this.gDays.replaceChildren();
    if (!this.opts.dayMarkers) return;
    const { m, pw, ph } = this.dim;
    const pxPerDay = (DAY / (t1 - t0)) * pw;
    const reserve = 0;
    const first = Math.floor(t0 / DAY) * DAY;
    for (let d = first; d < t1; d += DAY) {
      const xd = this.x(d);
      if (d > t0) {
        s('line', { x1: Math.round(xd) + 0.5, x2: Math.round(xd) + 0.5, y1: m.top - 18, y2: m.top + ph, stroke: this.t.axis, 'stroke-dasharray': '2 3' }, this.gDays);
      }
      const lx = Math.max(m.left, xd) + 6;
      const room = Math.min(m.left + pw - reserve, this.x(d + DAY)) - lx;
      if (room < 46) continue;
      const label = pxPerDay > 150 ? fmtDayLong(d + 1) : pxPerDay > 70 ? `${fmtWeekday(d + 1)} ${fmtDay(d + 1)}` : fmtDay(d + 1);
      s('text', { x: lx, y: m.top - 10, 'font-size': 11.5, 'font-weight': 600, fill: this.t.ink2 }, this.gDays).textContent = label;
    }
  }

  _pathPoints(arr, j0) {
    // Returns [x, y][] for arr (indexed from j0), expanded for step curves.
    const pts = [];
    const tArr = this.data.t;
    const stepMs = this.data.stepMinutes * MIN;
    for (let k = 0; k < arr.length; k++) {
      const t = tArr[j0 + k];
      const yy = this.y(arr[k]);
      if (this.opts.curve === 'step') {
        pts.push([this.x(t - stepMs), yy], [this.x(t), yy]);
      } else pts.push([this.x(t), yy]);
    }
    return pts;
  }

  _renderSeries(j0, j1) {
    this.gAreas.replaceChildren();
    this.gEdges.replaceChildren();
    this.gLines.replaceChildren();
    const clip = `url(#efc-clip-${this._uid})`;
    this.gAreas.setAttribute('clip-path', clip);
    this.gEdges.setAttribute('clip-path', clip);
    this.gLines.setAttribute('clip-path', clip);
    const f = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    this.areaEls = {};
    this.lineEls = {};

    for (const L of this.layers) {
      const up = this._pathPoints(L.hi, j0);
      const dn = this._pathPoints(L.lo, j0).reverse();
      if (!up.length) continue;
      const d = `M${up.map(f).join('L')}L${dn.map(f).join('L')}Z`;
      const fill = L.ser.pattern === 'hatch' ? `url(#efc-hatch-${this._uid}-${L.ser.key})` : this.colorMap[L.ser.key];
      const el = s('path', { d, fill, 'fill-opacity': L.ser.opacity ?? (L.ser.stack === false ? 0.28 : 0.92), class: 'efc-area', 'data-key': L.ser.key }, this.gAreas);
      this.areaEls[L.ser.key] = el;
      // 1.5px surface-coloured edge keeps neighbouring fills visually separate.
      const edge = s('path', { d: `M${up.map(f).join('L')}`, fill: 'none', stroke: L.ser.stack === false ? this.colorMap[L.ser.key] : this.t.surface, 'stroke-width': L.ser.stack === false ? 2 : 1.5, 'stroke-linejoin': 'round', class: 'efc-area', 'data-key': L.ser.key }, this.gEdges);
      this.areaEls[L.ser.key + '__edge'] = edge;
    }
    for (const ser of this.lineSeries) {
      const v = (this.data.values[ser.key] || []).slice(j0, j1 + 1);
      const pts = this._pathPoints(v, j0);
      if (!pts.length) continue;
      const d = `M${pts.map(f).join('L')}`;
      // surface halo under the line so it reads over any fill
      s('path', { d, fill: 'none', stroke: this.t.surface, 'stroke-width': (ser.width || 2) + 3, 'stroke-opacity': 0.7, 'stroke-linejoin': 'round', class: 'efc-line', 'data-key': ser.key }, this.gLines);
      const el = s('path', { d, fill: 'none', stroke: this.colorMap[ser.key], 'stroke-width': ser.width || 2, 'stroke-dasharray': ser.dash || null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'efc-line', 'data-key': ser.key }, this.gLines);
      this.lineEls[ser.key] = el;
    }
  }

  _renderAxes(t0, t1) {
    this.gAxes.replaceChildren();
    const { m, pw, ph } = this.dim;
    const { ticks, step } = timeTicks(t0, t1, pw, 62);
    for (const t of ticks) {
      const xx = Math.round(this.x(t)) + 0.5;
      if (xx < m.left - 1 || xx > m.left + pw + 1) continue;
      s('line', { x1: xx, x2: xx, y1: m.top + ph, y2: m.top + ph + 4, stroke: this.t.axis }, this.gAxes);
      const isMidnight = t % DAY === 0;
      const label = step >= DAY ? fmtDay(t) : isMidnight ? fmtDay(t) : fmtBlockTime(t);
      s('text', { x: xx, y: m.top + ph + 18, 'text-anchor': 'middle', 'font-size': 11, fill: isMidnight ? this.t.ink2 : this.t.muted, 'font-weight': isMidnight ? 600 : 400, style: 'font-variant-numeric: tabular-nums' }, this.gAxes).textContent = label;
    }
  }

  _renderNow(t0, t1) {
    this.gNow.replaceChildren();
    const live = this.opts.live;
    if (!live) return;
    const key = live.series || this.lineSeries[0]?.key;
    const n = this.data.t.length - 1;
    const t = this.data.t[n];
    if (n < 0 || t < t0 || t > t1 || this.store.get().hidden.has(key)) return;
    const v = this._topValue(key, n);
    const xx = this.x(t);
    const yy = this.y(v);
    const c = live.color || '#e5484d';
    s('circle', { cx: xx, cy: yy, r: 5, fill: c, class: 'pulse' }, this.gNow);
    s('circle', { cx: xx, cy: yy, r: 5, fill: c, stroke: this.t.surface, 'stroke-width': 2 }, this.gNow);
  }

  /** y-value at index i where series `key` is drawn (stack top for areas). */
  _topValue(key, i) {
    const L = this.layers.find((l) => l.ser.key === key);
    if (!L) return this.data.values[key]?.[i] ?? 0;
    const cached = L.hi[i - this.j0];
    if (cached != null) return cached;
    // index outside the last rendered span (hover set before the next frame): sum the stack directly
    let top = 0;
    for (const l of this.layers) {
      if (l.ser.stack !== L.ser.stack) continue;
      top += Math.max(0, this.data.values[l.ser.key]?.[i] || 0);
      if (l === L) break;
    }
    return top;
  }

  _applyHighlight() {
    const hl = this.store.get().highlight;
    const all = [...this.gAreas.children, ...this.gEdges.children, ...this.gLines.children];
    for (const el of all) {
      const k = el.getAttribute('data-key');
      const isLine = el.classList.contains('efc-line');
      el.classList.toggle(isLine ? 'efc-dimline' : 'efc-dim', !!hl && !hl.has(k));
    }
    const hidden = this.store.get().hidden;
    for (const [k, c] of Object.entries(this.chips || {})) {
      c.b.setAttribute('aria-pressed', String(!hidden.has(k)));
      c.b.classList.toggle('is-hl', !!hl && hl.has(k));
    }
  }

  // ------------------------------------------------------------------ hover

  _drawHover() {
    this.gCross.replaceChildren();
    if (!this.dim || !this.data.t.length) return;
    if (this.opts.view === 'tod') {
      const hz = this.store.get().hoverZone?.index;
      [...this.gAreas.querySelectorAll('.efc-todcol')].forEach((g, ci) => g.setAttribute('opacity', hz != null && hz !== ci ? 0.4 : 1));
      this._fillBand();
      return;
    }
    const i = this.store.get().hover;
    const t = i == null ? null : this.data.t[i];
    const [t0, t1] = this.store.get().range;
    if (i != null && t >= t0 && t <= t1) {
      const { m, ph } = this.dim;
      const xx = Math.round(this.x(t)) + 0.5;
      s('line', { x1: xx, x2: xx, y1: m.top, y2: m.top + ph, stroke: this.t.ink2, 'stroke-width': 1, 'stroke-opacity': 0.55 }, this.gCross);
      // time pill at the foot of the crosshair, over the axis labels
      const label = fmtBlockTime(t);
      const pw2 = 42;
      const px = clamp(xx - pw2 / 2, m.left, m.left + this.dim.pw - pw2);
      s('rect', { x: px, y: m.top + ph + 5, width: pw2, height: 18, rx: 5, fill: this.t.ink }, this.gCross);
      s('text', { x: px + pw2 / 2, y: m.top + ph + 18, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: this.t.surface, style: 'font-variant-numeric: tabular-nums' }, this.gCross).textContent = label;
      // dots on every visible series (≥8px with a 2px surface ring)
      for (const L of this.layers) {
        const v = this.data.values[L.ser.key]?.[i] || 0;
        if (v <= 0) continue;
        s('circle', { cx: xx, cy: this.y(this._topValue(L.ser.key, i)), r: 4, fill: this.colorMap[L.ser.key], stroke: this.t.surface, 'stroke-width': 2 }, this.gCross);
      }
      for (const ser of this.lineSeries) {
        const v = this.data.values[ser.key]?.[i] ?? 0;
        s('circle', { cx: xx, cy: this.y(v), r: 4.5, fill: this.t.surface, stroke: this.colorMap[ser.key], 'stroke-width': 2.5 }, this.gCross);
      }
    }
    this._fillBand();
    this._highlightTableRow(i);
  }

  /**
   * Fill the readout band. Timeline: kW at the hovered block (idle → latest block in view).
   * ToD: kWh in the hovered zone (idle → all zones in view).
   */
  _fillBand() {
    const st = this.store.get();
    const u = this.opts.unit;
    const loc = this.opts.locale;
    let val; // (key) => number
    let fmt; // (number) => string
    let priceOf = () => NaN; // (key) => currency/kWh
    let whenMain;
    let whenSub;
    let live = false;
    if (this.opts.view === 'tod') {
      const cols = this.todCols || [];
      const z = st.hoverZone ? cols[st.hoverZone.index] : null;
      const h = this.data.stepMinutes / 60;
      const [i0, i1] = this.span;
      const agg = aggregator(this.data, i0, i1);
      val = z ? (k) => z.energy[k] : (k) => agg.energy(k);
      priceOf = z ? (k) => z.price[k] : (k) => agg.avgPrice(k);
      fmt = (v) => fmtEnergy(v, { digits: 1 });
      whenMain = z ? `${z.name} · ${z.range}` : 'All ToD zones';
      whenSub = z ? `${fmtNumber(z.hours, z.hours % 1 ? 1 : 0)} h · ${z.count} blocks` : `${this.data.stepMinutes}-min blocks · energy`;
      live = !!z;
      void h;
    } else {
      const [i0, i1] = this.span;
      const hov = st.hover != null && st.hover >= i0 && st.hover <= i1;
      const i = hov ? st.hover : i1;
      fmt = (v) => (Number.isFinite(v) ? `${fmtNumber(v, 0, loc)} ${u}` : '–');
      if (i1 < i0) {
        val = () => NaN;
        whenMain = 'No data in view';
        whenSub = 'pick another range';
      } else {
        val = (k) => this.data.values[k]?.[i] ?? 0;
        priceOf = (k) => this.data.prices?.[k]?.[i] ?? NaN;
        whenMain = `${fmtDay(this.data.t[i] - 1)} · ${fmtBlockTime(this.data.t[i])}`;
        whenSub = hov ? (this.data.block ? `Block ${this.data.block[i]}` : '') : 'Latest in view';
      }
      live = hov;
    }
    this.bandEl.classList.toggle('is-live', live);
    const pinned = live && this.opts.stickyHover && !this._pointerInside;
    this.bandEl.classList.toggle('is-pinned', pinned);
    this.bandWhen.replaceChildren();
    h('b', { text: whenMain }, this.bandWhen);
    h('span', { text: pinned ? `${whenSub ? `${whenSub} · ` : ''}pinned` : whenSub }, this.bandWhen);
    if (live && this.opts.stickyHover) {
      const x = h('button', { class: 'efc-unpin', type: 'button', 'aria-label': 'Clear pinned time', title: 'Clear (Esc)', text: '×' }, this.bandWhen);
      x.addEventListener('click', () => this.clearPin());
    }

    const hidden = st.hidden;
    for (const [k, c] of Object.entries(this.chips || {})) {
      const v = hidden.has(k) ? null : val(k);
      c.val.textContent = v == null ? 'off' : fmt(v);
      c.b.classList.toggle('is-zero', v === 0);
      if (c.price) {
        const pr = v ? priceOf(k) : NaN;
        const ser = this.series.find((x) => x.key === k);
        // demand and exported surplus aren't purchases: leave the line blank (height is kept)
        c.price.textContent = Number.isFinite(pr) ? `@ ${fmtPrice(pr, this.opts.priceFormat)}` : this.data.prices?.[k] ? '@ –' : ser?.type === 'line' ? '\u00a0' : 'not purchased';
      }
    }

    this.bandSum.replaceChildren();
    if (this.opts.tooltip.summary === false) return;
    for (const r of this._balance(val, fmt, priceOf)) {
      const d = h('div', { class: r.tone || '' }, this.bandSum);
      h('span', { text: r.label }, d);
      h('b', { text: r.value }, d);
    }
  }

  _balance(val, fmt, priceOf = () => NaN) {
    const hidden = this.store.get().hidden;
    const stackKey = this.opts.tooltip.stack || 'supply';
    const areas = this.series.filter((x) => x.type === 'area' && x.stack === stackKey && !hidden.has(x.key) && x.countInTotal !== false);
    const demand = this.series.find((x) => x.type === 'line' && (x.role === 'demand' || x.key === this.opts.tooltip.demand));
    if (!areas.length) return [];
    const supply = areas.reduce((a, ser) => a + val(ser.key), 0);
    const out = [{ label: 'Supply', value: fmt(supply) }];
    // blended purchase price across priced sources, weighted by volume
    const priced = areas.filter((x) => this.data.prices?.[x.key]);
    if (priced.length) {
      let cost = 0;
      let vol = 0;
      for (const x of priced) { const v = val(x.key); const p = priceOf(x.key); if (v > 0 && Number.isFinite(p)) { cost += v * p; vol += v; } }
      out.push({ label: 'Avg price', value: vol > 0 ? fmtPrice(cost / vol, this.opts.priceFormat) : '–' });
      // cost only makes sense for energy (ToD); a kW snapshot has no cost
      if (this.opts.view === 'tod') out.push({ label: 'Cost', value: fmtMoney(cost, this.opts.priceFormat) });
    }
    if (demand && !hidden.has(demand.key)) {
      const dv = val(demand.key);
      const net = supply - dv;
      const eps = Math.max(1, Math.abs(dv) * 0.001);
      if (Math.abs(net) < eps) out.push({ label: 'Balance', value: 'Balanced' });
      else out.push({ label: net > 0 ? 'Surplus' : 'Shortfall', value: `${net > 0 ? '+' : '−'}${fmt(Math.abs(net))}`, tone: net > 0 ? 'pos' : 'neg' });
      if (this.series.some((x) => x.role === 'renewable')) {
        const re = this.series.filter((x) => x.role === 'renewable' && !hidden.has(x.key)).reduce((a, ser) => a + val(ser.key), 0);
        out.push({ label: 'RE share', value: dv > 0 ? `${fmtNumber(Math.min(1, re / dv) * 100, 0)}%` : '–' });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ interaction

  _bindPlot() {
    const hit = this.hit;
    let drag = null;
    const pos = (e) => {
      const r = this.svg.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const hoverAt = (px) => {
      const idx = nearestIndex(this.data.t, this.xInv(px));
      const [i0, i1] = this.span;
      this.store.set({ hover: i1 < i0 ? null : clamp(idx, i0, i1) });
      this.opts.onHover?.(idx);
    };

    const zoneAt = (px) => {
      const zi = todColumnAt(this, px);
      const c = zi == null ? null : this.todCols[zi];
      this.store.set({ hoverZone: c ? { index: zi, label: c.name, range: c.range, indices: c.indices } : null });
    };
    hit.addEventListener('pointerenter', () => { this._pointerInside = true; });
    hit.addEventListener('pointermove', (e) => {
      this._pointerInside = true;
      const [px] = pos(e);
      if (this.opts.view === 'tod') { zoneAt(px); return; }
      hoverAt(px);
      if (drag) {
        drag.x1 = clamp(px, this.dim.m.left, this.dim.m.left + this.dim.pw);
        if (Math.abs(drag.x1 - drag.x0) > 4) this._drawBrush(drag.x0, drag.x1);
      }
    });
    hit.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || this.opts.view === 'tod' || this.opts.rangeMode === 'day') return; // day: no zoom
      const [px] = pos(e);
      drag = { x0: px, x1: px };
      try { hit.setPointerCapture(e.pointerId); } catch { /* pen/synthetic pointers may refuse capture */ }
    });
    const end = (e) => {
      if (!drag) return;
      const { x0, x1 } = drag;
      drag = null;
      this.gBrush.replaceChildren();
      try { hit.releasePointerCapture(e.pointerId); } catch {}
      if (Math.abs(x1 - x0) > 8) {
        const a = this.xInv(Math.min(x0, x1));
        const b = this.xInv(Math.max(x0, x1));
        this.setRange(a, b);
      }
    };
    hit.addEventListener('pointerup', end);
    hit.addEventListener('pointercancel', end);
    hit.addEventListener('pointerleave', () => {
      this._pointerInside = false;
      if (drag) return;
      if (this.opts.stickyHover) this._fillBand(); // keep the crosshair where it is (pinned) → export / share it
      else this.clearPin();
    });
    hit.addEventListener('dblclick', () => { if (this.opts.view !== 'tod' && this.opts.rangeMode === 'week') this.showAll(); });

    hit.addEventListener('wheel', (e) => {
      if (this.opts.rangeMode === 'day') return; // locked: let the page scroll
      const [t0, t1] = this.store.get().range;
      const span = t1 - t0;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const [px] = pos(e);
        const at = this.xInv(px);
        const k = Math.exp(clamp(e.deltaY, -60, 60) * 0.01);
        const ns = span * k;
        const f = (at - t0) / span;
        this.setRange(at - f * ns, at - f * ns + ns);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        // ranges snap to whole blocks, so bank sub-block movement until it adds up
        this._panAcc = (this._panAcc || 0) + ((e.shiftKey ? e.deltaY : e.deltaX) / this.dim.pw) * span;
        const stepMs = this.data.stepMinutes * MIN;
        const d = Math.trunc(this._panAcc / stepMs) * stepMs;
        if (d) { this._panAcc -= d; this.setRange(t0 + d, t1 + d); }
      }
    }, { passive: false });

    hit.addEventListener('keydown', (e) => {
      const st = this.store.get();
      if (this.opts.view === 'tod') {
        const n = (this.todCols || []).length;
        const cur = st.hoverZone?.index ?? -1;
        const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (move && n) {
          e.preventDefault();
          const zi = clamp(cur + move, 0, n - 1);
          const c = this.todCols[zi];
          this.store.set({ hoverZone: { index: zi, label: c.name, range: c.range, indices: c.indices } });
          this.srEl.textContent = `${c.name} ${c.range}: ${this.series.map((x) => `${x.label || x.key} ${fmtEnergy(c.energy[x.key])}`).join(', ')}`;
        } else if (e.key === 'Escape') this.store.set({ hoverZone: null });
        return;
      }
      const [i0, i1] = this.span;
      if (i1 < i0 && !['+', '=', '-', 'PageUp', 'PageDown'].includes(e.key)) return;
      let i = st.hover ?? i1;
      const [t0, t1] = st.range;
      const span = t1 - t0;
      const keys = {
        ArrowRight: () => this.store.set({ hover: clamp(i + (e.shiftKey ? 4 : 1), i0, i1) }),
        ArrowLeft: () => this.store.set({ hover: clamp(i - (e.shiftKey ? 4 : 1), i0, i1) }),
        Home: () => this.store.set({ hover: i0 }),
        End: () => this.store.set({ hover: i1 }),
        '+': () => this.opts.rangeMode === 'week' && this.setRange(t0 + span / 4, t1 - span / 4),
        '=': () => this.opts.rangeMode === 'week' && this.setRange(t0 + span / 4, t1 - span / 4),
        '-': () => this.opts.rangeMode === 'week' && this.setRange(t0 - span / 2, t1 + span / 2),
        Escape: () => this.clearPin(),
        PageUp: () => this.step(-1),
        PageDown: () => this.step(1),
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
        const hv = this.store.get().hover;
        if (hv != null) this.srEl.textContent = this._describeIndex(hv);
      }
    });
    hit.addEventListener('focus', () => { if (this.opts.view !== 'tod' && this.store.get().hover == null && this.span[1] >= this.span[0]) this.store.set({ hover: this.span[1] }); });
    hit.addEventListener('blur', () => { if (!this.opts.stickyHover) this.clearPin(); });
  }

  _describeIndex(i) {
    const t = this.data.t[i];
    const parts = this.series.filter((x) => !this.store.get().hidden.has(x.key)).map((ser) => `${ser.label || ser.key} ${fmtNumber(this.data.values[ser.key]?.[i] ?? 0)} ${this.opts.unit}`);
    return `${fmtDay(t - 1)} ${fmtBlockTime(t)}: ${parts.join(', ')}`;
  }

  _drawBrush(x0, x1) {
    this.gBrush.replaceChildren();
    const { m, ph } = this.dim;
    s('rect', { x: Math.min(x0, x1), y: m.top, width: Math.abs(x1 - x0), height: ph, fill: this.t.accent, 'fill-opacity': 0.12, stroke: this.t.accent, 'stroke-opacity': 0.6 }, this.gBrush);
  }

  // ------------------------------------------------------------------ navigator

  _renderNav() {
    if (!this.nav) return;
    const nav = this.nav;
    nav.replaceChildren();
    const { m, W } = this.dim;
    const NH = this.opts.navigatorHeight;
    const pw = this.dim.pw;
    nav.setAttribute('width', W);
    nav.setAttribute('height', NH);
    const [a, b0] = this._extent();
    const b = Math.max(b0, Math.ceil(b0 / DAY) * DAY);
    const nx = (t) => m.left + ((t - a) / (b - a)) * pw;
    this.nx = nx;
    this.nxInv = (px) => a + ((px - m.left) / pw) * (b - a);

    s('rect', { x: m.left, y: 0.5, width: pw, height: NH - 1, rx: 6, fill: this.t.band, stroke: this.t.border }, nav);

    // mini stack: draw each area total (hidden series excluded), bucketed to ~1 pt per 2px
    const tArr = this.data.t;
    const n = tArr.length;
    if (n) {
      const hidden = this.store.get().hidden;
      const areas = this.series.filter((x) => x.type === 'area' && x.stack !== false && !hidden.has(x.key));
      let maxV = 1;
      const tops = [];
      let acc = new Array(n).fill(0);
      for (const ser of areas) {
        const v = this.data.values[ser.key] || [];
        acc = acc.map((p, i) => p + Math.max(0, v[i] || 0));
        tops.push({ ser, arr: acc.slice() });
      }
      for (const v of acc) maxV = Math.max(maxV, v);
      for (const ser of this.series.filter((x) => x.type === 'line' && !hidden.has(x.key))) for (const v of this.data.values[ser.key] || []) maxV = Math.max(maxV, v);
      const ny = (v) => NH - 4 - (v / maxV) * (NH - 10);
      const f = (i, arr) => `${nx(tArr[i]).toFixed(1)},${ny(arr[i]).toFixed(1)}`;
      for (let k = tops.length - 1; k >= 0; k--) {
        const { ser, arr } = tops[k];
        let d = `M${nx(tArr[0]).toFixed(1)},${ny(0)}`;
        for (let i = 0; i < n; i++) d += `L${f(i, arr)}`;
        d += `L${nx(tArr[n - 1]).toFixed(1)},${ny(0)}Z`;
        s('path', { d, fill: this.colorMap[ser.key], 'fill-opacity': 0.55 }, nav);
      }
      for (let d = Math.ceil(a / DAY) * DAY; d < b; d += DAY) {
        const xx = Math.round(nx(d)) + 0.5;
        s('line', { x1: xx, x2: xx, y1: 4, y2: NH - 4, stroke: this.t.axis }, nav);
        if (nx(d + DAY) - xx > 40) s('text', { x: xx + 4, y: 13, 'font-size': 10, fill: this.t.muted, 'font-weight': 600 }, nav).textContent = fmtDay(d + 1);
      }
    }

    // window
    const [t0, t1] = this.store.get().range;
    const x0 = nx(t0);
    const x1 = nx(t1);
    s('rect', { x: m.left, y: 0, width: Math.max(0, x0 - m.left), height: NH, fill: this.t.surface, 'fill-opacity': 0.65 }, nav);
    s('rect', { x: x1, y: 0, width: Math.max(0, m.left + pw - x1), height: NH, fill: this.t.surface, 'fill-opacity': 0.65 }, nav);
    this.navWin = s('rect', { class: 'win', x: x0, y: 1, width: Math.max(2, x1 - x0), height: NH - 2, rx: 4, fill: this.t.accent, 'fill-opacity': 0.08, stroke: this.t.accent, 'stroke-width': 1.5 }, nav);
    for (const [xx, side] of this.opts.rangeMode === 'day' ? [] : [[x0, 'l'], [x1, 'r']]) { // day: width locked
      const g = s('g', { class: 'handle', 'data-side': side }, nav);
      s('rect', { x: xx - 7, y: 0, width: 14, height: NH, fill: 'transparent' }, g);
      s('rect', { x: xx - 3, y: NH / 2 - 11, width: 6, height: 22, rx: 3, fill: this.t.surface, stroke: this.t.accent, 'stroke-width': 1.5 }, g);
    }
  }

  _bindNav() {
    const nav = this.nav;
    let drag = null;
    const px = (e) => e.clientX - nav.getBoundingClientRect().left;
    nav.addEventListener('pointerdown', (e) => {
      const [t0, t1] = this.store.get().range;
      const handle = e.target.closest('.handle');
      const x = px(e);
      if (handle) drag = { mode: handle.dataset.side, t0, t1 };
      else if (e.target.classList.contains('win')) drag = { mode: 'move', t0, t1, start: this.nxInv(x) };
      else {
        const c = this.nxInv(x);
        const span = t1 - t0;
        this.setRange(c - span / 2, c + span / 2);
        const [n0, n1] = this.store.get().range;
        drag = { mode: 'move', t0: n0, t1: n1, start: c };
      }
      try { nav.setPointerCapture(e.pointerId); } catch { /* see above */ }
      e.preventDefault();
    });
    nav.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const t = this.nxInv(px(e));
      if (drag.mode === 'move') { const d = t - drag.start; this.setRange(drag.t0 + d, drag.t1 + d); }
      else if (drag.mode === 'l') this.setRange(Math.min(t, drag.t1 - this.opts.minSpanMinutes * MIN), drag.t1);
      else this.setRange(drag.t0, Math.max(t, drag.t0 + this.opts.minSpanMinutes * MIN));
    });
    const end = () => { drag = null; };
    nav.addEventListener('pointerup', end);
    nav.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------------ table view

  _renderTable() {
    if (this.opts.view === 'tod') return this._renderTodTable();
    const [i0, i1] = this.getVisibleSpan();
    const cols = this.series;
    const table = h('table');
    const thead = h('thead', {}, table);
    const hr = h('tr', {}, thead);
    h('th', { text: 'Time' }, hr);
    if (this.data.block) h('th', { text: 'Block' }, hr);
    for (const c of cols) h('th', { text: `${c.label || c.key} (${this.opts.unit})` }, hr);
    const tb = h('tbody', {}, table);
    this._rows = {};
    for (let i = i0; i <= i1; i++) {
      const tr = h('tr', {}, tb);
      h('td', { text: `${fmtDay(this.data.t[i] - 1)} ${fmtBlockTime(this.data.t[i])}` }, tr);
      if (this.data.block) h('td', { text: String(this.data.block[i]) }, tr);
      for (const c of cols) h('td', { text: fmtNumber(this.data.values[c.key]?.[i] ?? 0, 1, this.opts.locale) }, tr);
      this._rows[i] = tr;
    }
    this.tableEl.replaceChildren(table);
  }

  _renderTodTable() {
    const table = h('table');
    const hr = h('tr', {}, h('thead', {}, table));
    const priced = this.series.filter((x) => this.data.prices?.[x.key]);
    for (const c of ['Zone', 'Hours', ...this.series.map((x) => `${x.label || x.key} (kWh)`), ...priced.map((x) => `${x.label || x.key} (₹/kWh)`)]) h('th', { text: c }, hr);
    const tb = h('tbody', {}, table);
    for (const c of this.todCols || []) {
      const tr = h('tr', {}, tb);
      h('td', { text: `${c.name} ${c.range}` }, tr);
      h('td', { text: fmtNumber(c.hours, 1) }, tr);
      for (const x of this.series) h('td', { text: fmtNumber(c.energy[x.key], 1, this.opts.locale) }, tr);
      for (const x of priced) h('td', { text: Number.isFinite(c.price[x.key]) ? fmtNumber(c.price[x.key], 2) : '–' }, tr);
    }
    this._rows = null;
    this.tableEl.replaceChildren(table);
  }

  _highlightTableRow(i) {
    if (this.tableEl.hidden || !this._rows) return;
    this._hoverRow?.classList.remove('is-hover');
    this._hoverRow = i == null ? null : this._rows[i];
    this._hoverRow?.classList.add('is-hover');
  }
}

export function createChart(el, options) {
  return new EnergyFlowChart(el, options);
}
