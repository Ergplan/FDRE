// KPI cards linked to a chart through the shared store.
//
//  • values aggregate over the chart's visible range (zoom/pan the chart → cards update)
//  • hovering the chart shows each card's instantaneous reading at the crosshair
//  • each card names the period it covers ("Sat 26 Sep", "20–26 Sep", "24 Sep 06:00–16:00")
//  • hovering a card highlights its series in the chart; cards are NOT clickable unless
//    `clickable: true` (then a click toggles the series)
//  • each card carries a sparkline of its series with the crosshair position marked

import { createStore } from './store.js';
import { getTheme, resolveMode, resolveSeriesColors, applyThemeVars } from './themes.js';
import { aggregator, indexSpan } from './data.js';
import { fmtEnergy, fmtPower, fmtPercent, fmtNumber, fmtBlockTime, fmtDay, fmtPrice, fmtMoney, fmtPeriod } from './format.js';
import { injectStyles } from './styles.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export const icons = {
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M10 9l-2 3h4l-2 3"/>',
  grid: '<path d="M12 2 7 22M12 2l5 20M5 8h14M4 14h16M8.5 2h7"/>',
  market: '<path d="M3 17l5-5 4 4 8-8"/><path d="M14 8h6v6"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 16-10-1 12-5 16-10 16"/><path d="M4 21c3-6 7-9 11-11"/>',
  peak: '<path d="M3 20h18M6 16l4-8 3 5 2-3 3 6"/>',
  rupee: '<path d="M6 3h12M6 8h12M6 13l8 8M6 13h3a5 5 0 0 0 0-10"/>',
  surplus: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
};

const FORMATS = {
  energy: (v) => fmtEnergy(v),
  power: (v, m) => fmtPower(v, { unit: m.unit || 'kW' }),
  percent: (v) => fmtPercent(v, 0),
  number: (v) => fmtNumber(v, 2),
  price: (v) => fmtPrice(v),
  money: (v) => fmtMoney(v),
};

/** Split "43.48 MWh" into value + unit so the unit can be styled smaller. */
function splitUnit(str) {
  const m = String(str).match(/^(.*?)(?:\s+([^\d\s][^\s]*))?$/);
  return m && m[2] ? [m[1], m[2]] : [str, ''];
}

export class EnergyCards {
  /**
   * @param {HTMLElement} el
   * @param {object} opts
   * @param {import('./chart.js').EnergyFlowChart} [opts.chart]  link to a chart (store, data, colours come from it)
   * @param {object[]} opts.metrics
   */
  constructor(el, opts) {
    injectStyles(el.ownerDocument);
    this.el = el;
    this.opts = opts;
    this.chart = opts.chart || null;
    this.store = this.chart ? this.chart.store : opts.store || createStore();
    this.metrics = opts.metrics;
    el.classList.add('efc-cards');
    if (opts.minWidth) el.style.setProperty('--efc-card-min', `${opts.minWidth}px`);
    this._build();
    this._unsub = this.store.subscribe((state, changed) => {
      if (changed.some((k) => k === 'range' || k === 'hidden' || k === 'themeRev' || k === 'dataRev')) this.update();
      else if (changed.includes('hover') || changed.includes('hoverZone')) this._updateHover();
      if (changed.includes('highlight')) this._updateHighlight();
    });
    this.update();
  }

  get data() { return this.chart ? this.chart.data : this.opts.data; }

  get colors() {
    if (this.chart) return this.chart.colorMap;
    const theme = getTheme(this.opts.theme);
    const mode = resolveMode(this.opts.mode || 'auto');
    applyThemeVars(this.el, theme, mode);
    return resolveSeriesColors(this.opts.series || [], theme, mode);
  }

  setMetrics(metrics) { this.metrics = metrics; this._build(); this.update(); }

  destroy() { this._unsub?.(); this.el.replaceChildren(); this.el.classList.remove('efc-cards'); }

  _keys(m) { return m.series == null ? [] : Array.isArray(m.series) ? m.series : [m.series]; }

  _build() {
    this.el.replaceChildren();
    if (this.chart) {
      // inherit chrome tokens from the chart so cards match in both modes
      for (const k of ['surface', 'page', 'ink', 'ink2', 'muted', 'grid', 'axis', 'border', 'tooltip', 'band', 'accent']) {
        this.el.style.setProperty(`--efc-${k}`, `var(--efc-${k}-from-chart)`);
      }
    }
    this.cards = this.metrics.map((m) => {
      const keys = this._keys(m);
      const toggles = !!this.opts.clickable && m.toggle !== false && keys.length > 0;
      const card = document.createElement(toggles ? 'button' : 'div');
      card.className = `efc-card${toggles ? '' : ' is-static'}`;
      if (toggles) { card.type = 'button'; card.setAttribute('aria-pressed', 'true'); }
      this.el.appendChild(card);
      const top = el('div', 'efc-card-top', card);
      const label = el('div', 'efc-card-label', top);
      label.textContent = m.label;
      // period this card's number covers: always visible, so a zoomed / scrolled chart never leaves it ambiguous
      const period = this.opts.showPeriod === false ? null : el('div', 'efc-card-period', card); // own line under the label
      if (this.opts.icons && m.icon !== false) {
        const ic = el('div', 'efc-card-icon', top);
        const svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.innerHTML = icons[m.icon] || icons.bolt; // icon markup is library-owned, never user data
        ic.appendChild(svg);
      }
      const value = el('div', 'efc-card-value', card);
      const sub = el('div', 'efc-card-sub', card);
      let spark = null;
      if (m.sparkline !== false && keys.length) {
        spark = document.createElementNS(SVGNS, 'svg');
        spark.setAttribute('class', 'efc-card-spark');
        spark.setAttribute('preserveAspectRatio', 'none');
        spark.setAttribute('aria-hidden', 'true');
        card.appendChild(spark);
      }
      if (keys.length) {
        card.addEventListener('mouseenter', () => this.store.setHighlight(keys));
        card.addEventListener('mouseleave', () => this.store.setHighlight(null));
        card.addEventListener('focus', () => this.store.setHighlight(keys));
        card.addEventListener('blur', () => this.store.setHighlight(null));
      }
      if (toggles) {
        card.addEventListener('click', () => {
          const hidden = new Set(this.store.get().hidden);
          const allHidden = keys.every((k) => hidden.has(k));
          keys.forEach((k) => (allHidden ? hidden.delete(k) : hidden.add(k)));
          this.store.set({ hidden });
        });
      }
      m.onClick && card.addEventListener('click', (e) => m.onClick(e, m));
      return { m, card, value, sub, spark, keys, period };
    });
  }

  _span() {
    const d = this.data;
    const r = this.store.get().range;
    if (!d || !d.t.length) return [0, -1];
    return r ? indexSpan(d.t, r[0], r[1]) : [0, d.t.length - 1];
  }

  /** Recompute every card for the current range. */
  update() {
    const d = this.data;
    if (!d) return;
    if (this.chart) {
      for (const k of ['surface', 'page', 'ink', 'ink2', 'muted', 'grid', 'axis', 'border', 'tooltip', 'band', 'accent']) {
        this.el.style.setProperty(`--efc-${k}-from-chart`, this.chart.t[k]);
      }
      this.el.style.colorScheme = this.chart.modeResolved;
    }
    const [i0, i1] = this._span();
    const agg = aggregator(d, i0, i1);
    const colors = this.colors;
    const hidden = this.store.get().hidden;
    this.spanAgg = agg;
    for (const c of this.cards) {
      const { m, card, keys } = c;
      const color = m.color || colors[keys[0]] || 'var(--efc-accent)';
      card.style.setProperty('--card-color', color);
      if (c.period) {
        const r = this.store.get().range;
        c.period.textContent = r ? fmtPeriod(r[0], r[1]) : '';
        c.period.title = r ? `Figures for ${fmtPeriod(r[0], r[1], { long: true })}` : '';
      }
      if (card.tagName === 'BUTTON') card.setAttribute('aria-pressed', String(!keys.every((k) => hidden.has(k))));
      const v = this._compute(m, agg, keys);
      c.current = v;
      this._setValue(c, v);
      c.baseSub = this._baseSub(m, agg, keys, v);
      this._drawSpark(c, i0, i1, color);
    }
    this._updateHover();
    this._updateHighlight();
  }

  _compute(m, agg, keys) {
    if (typeof m.agg === 'function') return m.agg(agg, this.data);
    const kind = m.agg || 'energy';
    if (kind === 'avgPrice' || kind === 'cost') {
      // volume-weighted across the metric's series (only those with prices)
      let cost = 0;
      let vol = 0;
      for (const k of keys) { if (!agg.hasPrice(k)) continue; cost += agg.cost(k); vol += agg.energy(k); }
      return kind === 'cost' ? cost : vol > 0 ? cost / vol : NaN;
    }
    return keys.reduce((a, k) => {
      const v = agg[kind](k);
      return kind === 'max' ? Math.max(a, v) : kind === 'min' ? Math.min(a, v) : a + v;
    }, kind === 'max' ? -Infinity : kind === 'min' ? Infinity : 0);
  }

  _format(m, v) {
    if (typeof m.format === 'function') return m.format(v);
    const f = FORMATS[m.format || (m.agg === 'avgPrice' ? 'price' : m.agg === 'cost' ? 'money' : m.agg === 'max' || m.agg === 'min' || m.agg === 'avg' || m.agg === 'last' ? 'power' : 'energy')];
    return f(v, m);
  }

  _setValue(c, v) {
    if (!Number.isFinite(v) && (this.spanAgg?.count ?? 1) <= 0) v = 0; // empty window reads as zero, not "-∞"
    const [num, unit] = splitUnit(this._format(c.m, v));
    c.value.replaceChildren(document.createTextNode(num));
    if (unit) { const u = document.createElement('small'); u.textContent = unit; c.value.appendChild(u); }
  }

  _baseSub(m, agg, keys, v) {
    if (typeof m.description === 'function') return m.description(agg, v, this.data);
    if (agg.count <= 0) return 'No data in view';
    if (m.description) return m.description;
    if (m.agg === 'max' && keys.length === 1) {
      const i = agg.argmax(keys[0]);
      return `at ${fmtBlockTime(this.data.t[i])} on ${fmtDay(this.data.t[i] - 1)}`;
    }
    return '';
  }

  _updateHover() {
    const i = this.store.get().hover;
    const zone = this.store.get().hoverZone;
    const h = this.data.stepMinutes / 60;
    for (const c of this.cards) {
      const { m, sub, keys } = c;
      sub.replaceChildren();
      let live = null;
      const priceKind = m.agg === 'avgPrice' || m.agg === 'cost';
      if (priceKind && m.instant !== false && (zone || i != null)) {
        const idx = zone ? zone.indices : [i];
        let cost = 0;
        let vol = 0;
        for (const ix of idx) for (const k of keys) {
          const p = this.data.prices?.[k]?.[ix];
          const v = this.data.values[k]?.[ix] ?? 0;
          if (Number.isFinite(p)) { cost += v * h * p; vol += v * h; }
        }
        const v = m.agg === 'cost' ? cost : vol > 0 ? cost / vol : NaN;
        live = [zone ? zone.label : fmtBlockTime(this.data.t[i]), this._format(m, v)];
        live.zone = !!zone;
      } else if (zone && m.instant !== false && keys.length) {
        // ToD column hovered: the card shows that zone's share of its metric
        if (m.agg === 'max') live = [zone.label, fmtPower(Math.max(0, ...zone.indices.map((ix) => keys.reduce((a, k) => a + (this.data.values[k]?.[ix] ?? 0), 0))), { unit: m.unit || 'kW' })];
        else live = [zone.label, fmtEnergy(zone.indices.reduce((a, ix) => a + keys.reduce((b, k) => b + (this.data.values[k]?.[ix] ?? 0), 0), 0) * h, { digits: 1 })];
        live.zone = true;
      } else if (i != null && m.instant !== false) {
        if (typeof m.instant === 'function') live = m.instant(i, this.data);
        else if (keys.length) {
          const kw = keys.reduce((a, k) => a + (this.data.values[k]?.[i] ?? 0), 0);
          live = [`${fmtBlockTime(this.data.t[i])}`, fmtPower(kw, { unit: m.unit || 'kW' })];
        }
      }
      if (live) {
        sub.classList.add('is-live');
        if (Array.isArray(live)) {
          sub.append(document.createTextNode(live.zone ? `${live[0]} ` : `@ ${live[0]} · `));
          const b = document.createElement('b');
          b.textContent = live[1];
          sub.append(b);
        } else sub.textContent = live;
      } else {
        sub.classList.remove('is-live');
        sub.textContent = c.baseSub || ' ';
      }
      this._sparkDot(c, zone ? null : i, zone);
    }
  }

  _updateHighlight() {
    const hl = this.store.get().highlight;
    for (const c of this.cards) c.card.classList.toggle('is-hl', !!hl && c.keys.length > 0 && c.keys.every((k) => hl.has(k)));
  }

  _drawSpark(c, i0, i1, color) {
    const svg = c.spark;
    if (!svg) return;
    svg.replaceChildren();
    const n = i1 - i0 + 1;
    if (n < 2) return;
    const W = 200;
    const H = 30;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const vals = new Array(n);
    let max = 0;
    for (let k = 0; k < n; k++) {
      vals[k] = c.keys.reduce((a, key) => a + (this.data.values[key]?.[i0 + k] ?? 0), 0);
      max = Math.max(max, vals[k]);
    }
    const x = (k) => (k / (n - 1)) * W;
    const y = (v) => H - 2 - (max > 0 ? (v / max) * (H - 4) : 0);
    let line = '';
    for (let k = 0; k < n; k++) line += `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(vals[k]).toFixed(1)}`;
    const area = document.createElementNS(SVGNS, 'path');
    area.setAttribute('d', `${line}L${W},${H}L0,${H}Z`);
    area.setAttribute('fill', color);
    area.setAttribute('fill-opacity', '0.18');
    const stroke = document.createElementNS(SVGNS, 'path');
    stroke.setAttribute('d', line);
    stroke.setAttribute('fill', 'none');
    stroke.setAttribute('stroke', color);
    stroke.setAttribute('stroke-width', '1.5');
    stroke.setAttribute('vector-effect', 'non-scaling-stroke');
    const cursor = document.createElementNS(SVGNS, 'line');
    cursor.setAttribute('y1', '0');
    cursor.setAttribute('y2', String(H));
    cursor.setAttribute('stroke', 'currentColor');
    cursor.setAttribute('stroke-opacity', '0.45');
    cursor.setAttribute('vector-effect', 'non-scaling-stroke');
    cursor.style.display = 'none';
    const zoneG = document.createElementNS(SVGNS, 'g');
    svg.append(zoneG, area, stroke, cursor);
    c.sparkMeta = { i0, i1, x, cursor, zoneG };
  }

  _sparkDot(c, i, zone) {
    const meta = c.sparkMeta;
    if (!meta) return;
    // shade the hovered ToD zone's blocks on the sparkline
    meta.zoneG.replaceChildren();
    if (zone) {
      const w = meta.x(1) - meta.x(0);
      for (const ix of zone.indices) {
        if (ix < meta.i0 || ix > meta.i1) continue;
        const r = document.createElementNS(SVGNS, 'rect');
        r.setAttribute('x', (meta.x(ix - meta.i0) - w / 2).toFixed(1));
        r.setAttribute('width', (w + 0.5).toFixed(1));
        r.setAttribute('y', '0');
        r.setAttribute('height', '30');
        r.setAttribute('fill', 'currentColor');
        r.setAttribute('fill-opacity', '0.12');
        meta.zoneG.appendChild(r);
      }
    }
    if (i == null || i < meta.i0 || i > meta.i1) { meta.cursor.style.display = 'none'; return; }
    const xx = meta.x(i - meta.i0).toFixed(1);
    meta.cursor.setAttribute('x1', xx);
    meta.cursor.setAttribute('x2', xx);
    meta.cursor.style.display = '';
  }
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

export function createCards(el, opts) {
  return new EnergyCards(el, opts);
}
