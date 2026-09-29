// The simplest way in: one call, any website.
//
//   const board = await EnergyFlow.mount('#chart', { url: '/energy.json', cards: '#cards' });
//
// Accepts data as a URL (JSON or CSV), CSV text, compact { header, rows } JSON,
// an array of records, or an already-built Dataset. Missing options come from the
// 'energy-supply' preset, which matches the standard export columns.

import { EnergyFlowChart } from './chart.js';
import { EnergyCards } from './cards.js';
import { fromBlockRows, fromRecords, fromTable, parseCSV, withPrices } from './data.js';
import { presets } from './presets.js';

const resolveEl = (x) => (typeof x === 'string' ? document.querySelector(x) : x);

async function fetchRows(url, fetchOptions) {
  const res = await fetch(url, fetchOptions);
  if (!res.ok) throw new Error(`EnergyFlow: ${url} → HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('json') || /\.json(\?|$)/.test(url)) return res.json();
  return res.text();
}

/** Turn whatever the caller has into a Dataset. */
export function toDataset(input, cfg) {
  if (input && Array.isArray(input.t) && input.values) return input; // already a Dataset
  let rows = input;
  if (typeof rows === 'string') rows = parseCSV(rows);
  else if (rows && Array.isArray(rows.header) && Array.isArray(rows.rows)) rows = fromTable(rows.header, rows.rows);
  if (!Array.isArray(rows)) throw new Error('EnergyFlow: data must be a URL, CSV text, {header, rows}, records[] or a Dataset');
  if (cfg.time) return fromRecords(rows, { time: cfg.time, columns: cfg.columns, stepMinutes: cfg.blockMinutes });
  return fromBlockRows(rows, { columns: cfg.columns, dateKey: cfg.dateKey, blockKey: cfg.blockKey, timeKey: cfg.timeKey, blockMinutes: cfg.blockMinutes });
}

/**
 * Cards to show. `metrics` may mix preset card ids ('demand', 'grid', 'avgPrice', ...) with
 * full Metric objects; omitted → the preset's short default list (+ price card when priced).
 */
export function resolveMetrics(requested, preset, priced) {
  const library = [...(preset.metrics || []), ...(preset.priceMetrics || [])];
  const byId = (id) => {
    const m = library.find((x) => x.id === id);
    if (!m) console.warn(`EnergyFlow: unknown card id "${id}". Available: ${library.map((x) => x.id).join(', ')}`);
    return m;
  };
  if (typeof requested === 'string') requested = requested.split(',').map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(requested)) return requested.map((m) => (typeof m === 'string' ? byId(m) : m)).filter(Boolean);
  const ids = [...(preset.defaultCards || library.map((x) => x.id)), ...(priced ? preset.defaultPriceCards || [] : [])];
  return ids.map(byId).filter(Boolean);
}

/**
 * Mount a chart (and optional cards) with sensible defaults.
 * @returns {Promise<{ chart, cards, store, load(input): Promise<void>, destroy(): void }>}
 */
export async function mount(target, options = {}) {
  const el = resolveEl(target);
  if (!el) throw new Error(`EnergyFlow.mount: element not found: ${target}`);
  const preset = options.preset === false ? {} : presets[options.preset || 'energy-supply'] || {};
  // undefined options (e.g. absent data-* attributes) must not mask defaults
  const cfg = { ...preset, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };

  const build = async (input) => {
    let src = input;
    if (typeof src === 'string' && !src.includes('\n') && !src.includes(',')) src = await fetchRows(src, cfg.fetchOptions);
    let ds = toDataset(src, cfg);
    if (cfg.prices) ds = withPrices(ds, typeof cfg.prices === 'function' ? cfg.prices(ds) : cfg.prices);
    return cfg.transform ? cfg.transform(ds) : ds;
  };

  const data = await build(cfg.data ?? cfg.url ?? cfg.rows ?? cfg.csv);
  const { cards: cardsTarget, metrics, priceMetrics, cardsClickable, cardIcons, cardPeriod, url, rows, csv, preset: _p, prices: _pr, columns, dateKey, blockKey, timeKey, blockMinutes, time, transform, fetchOptions, refreshSeconds, ...chartOptions } = cfg;
  const chart = new EnergyFlowChart(el, { ...chartOptions, data });

  let cards = null;
  const cardsEl = resolveEl(cardsTarget);
  if (cardsEl) {
    const all = resolveMetrics(options.metrics, preset, !!data.prices);
    if (all.length) cards = new EnergyCards(cardsEl, { chart, metrics: all, minWidth: cfg.cardMinWidth, clickable: cfg.cardsClickable, icons: cfg.cardIcons, showPeriod: cfg.cardPeriod });
  }

  let timer = null;
  const handle = {
    chart,
    cards,
    store: chart.store,
    /** Replace the data (URL / CSV / rows / Dataset). The view stays pinned to "now". */
    async load(input) { chart.setData(await build(input)); },
    destroy() { clearInterval(timer); cards?.destroy(); chart.destroy(); },
  };
  if (url && refreshSeconds) timer = setInterval(() => handle.load(url).catch((e) => console.warn(e)), refreshSeconds * 1000);
  return handle;
}

/**
 * Zero-JS setup: mount every element carrying data-energy-flow.
 *   <div data-energy-flow data-src="/energy.json" data-cards="#cards" data-theme="energy" data-view="tod"></div>
 */
export function autoMount(root = document) {
  return Promise.all([...root.querySelectorAll('[data-energy-flow]:not([data-efc-mounted])')].map((el) => {
    el.setAttribute('data-efc-mounted', '');
    const d = el.dataset;
    return mount(el, {
      url: d.src,
      cards: d.cards,
      metrics: d.cardsShow, // data-cards-show="demand,grid,market,avgPrice"

      theme: d.theme,
      mode: d.mode,
      view: d.view,
      height: d.height ? +d.height : undefined,
      yLock: d.yLock != null ? d.yLock !== 'false' : undefined, // data-y-lock
      rangeMode: d.range, // data-range="day" | "week"
      toolbar: d.toolbar === 'false' ? false : undefined,
      refreshSeconds: d.refresh ? +d.refresh : undefined,
    }).catch((e) => { console.error(e); el.textContent = 'Chart failed to load.'; });
  }));
}
