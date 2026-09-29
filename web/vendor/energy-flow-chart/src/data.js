// Data adapters. The chart consumes one normalised shape:
//
//   { t: number[], stepMinutes: number, values: { [seriesKey]: number[] }, block?: number[] }
//
// `t` is epoch-ms of *wall-clock* time encoded as UTC (so an IST 14:15 reading is
// Date.UTC(y, m, d, 14, 15)). All formatting uses UTC getters, which keeps
// timestamps stable regardless of the viewer's browser timezone.

const MIN = 60_000;
const DAY = 86_400_000;

/** Parse 'YYYY-MM-DD' (or a Date / Excel serial) into a UTC-midnight epoch. */
export function parseDay(v) {
  if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'number') return Math.round((v - 25569) * DAY); // Excel serial date
  const m = String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) throw new Error(`Unrecognised date: ${v}`);
  return m[1].length === 4 ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.UTC(+m[3], +m[1] - 1, +m[2]);
}

/** Parse 'HH:MM' into minutes after midnight. '24:00' is allowed. */
export function parseClock(v) {
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : NaN;
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Build a dataset from interval "block" rows (e.g. 96 × 15-min blocks per day, as
 * exported by SLDC/IEX style meters).
 *
 * Timestamps are placed at the END of each block (block 1 → 00:15), matching the
 * way Indian scheduling data labels intervals.
 *
 * Day inference: when the date column changes, that date is used. When the date is
 * constant but the block number resets (a multi-day export stamped with the export
 * date), days are counted back so the LAST run of blocks lands on that date.
 *
 * @param {object[]} rows       records (objects keyed by column name)
 * @param {object}   opts
 * @param {Record<string,string>} opts.columns   seriesKey → column name
 * @param {string}  [opts.dateKey='Date']
 * @param {string}  [opts.blockKey='Block']
 * @param {string}  [opts.timeKey]              optional 'HH:MM' column used when no block column
 * @param {number}  [opts.blockMinutes=15]
 * @param {'end'|'start'} [opts.stamp='end']
 */
export function fromBlockRows(rows, opts) {
  const { columns, dateKey = 'Date', blockKey = 'Block', timeKey, blockMinutes = 15, stamp = 'end' } = opts;
  if (!rows.length) return { t: [], stepMinutes: blockMinutes, values: Object.fromEntries(Object.keys(columns).map((k) => [k, []])), block: [] };

  const blockOf = (r) => {
    if (blockKey && r[blockKey] != null && r[blockKey] !== '') return num(r[blockKey]);
    const mins = parseClock(r[timeKey]);
    return Math.round(mins / blockMinutes) || Math.round(1440 / blockMinutes);
  };

  // First pass: split into day runs.
  const runs = []; // { dateKey, start, end }
  let prevBlock = Infinity;
  let prevDate = null;
  rows.forEach((r, i) => {
    const b = blockOf(r);
    const d = r[dateKey];
    if (b <= prevBlock || d !== prevDate) runs.push({ date: d, start: i });
    prevBlock = b;
    prevDate = d;
  });

  const distinctDates = new Set(runs.map((r) => String(r.date)));
  const constantDate = distinctDates.size === 1 && runs.length > 1;
  const lastDay = parseDay(runs[runs.length - 1].date);

  const t = new Array(rows.length);
  const block = new Array(rows.length);
  runs.forEach((run, ri) => {
    const day = constantDate ? lastDay - (runs.length - 1 - ri) * DAY : parseDay(run.date);
    const end = ri + 1 < runs.length ? runs[ri + 1].start : rows.length;
    for (let i = run.start; i < end; i++) {
      const b = blockOf(rows[i]);
      block[i] = b;
      t[i] = day + (stamp === 'end' ? b : b - 1) * blockMinutes * MIN;
    }
  });

  const values = {};
  for (const [key, col] of Object.entries(columns)) values[key] = rows.map((r) => num(r[col]));
  return { t, stepMinutes: blockMinutes, values, block, inferredDays: constantDate };
}

/**
 * Build a dataset from records with a timestamp column.
 * @param {object[]} rows
 * @param {object} opts
 * @param {string|((row:object)=>number|string|Date)} opts.time  column name or accessor
 * @param {Record<string,string|((row:object)=>number)>} opts.columns
 * @param {number} [opts.stepMinutes]  inferred from the median gap when omitted
 */
export function fromRecords(rows, { time, columns, stepMinutes }) {
  const get = typeof time === 'function' ? time : (r) => r[time];
  const toMs = (v) => {
    if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes());
    if (typeof v === 'number') return v;
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return Date.parse(v);
  };
  const order = rows.map((r, i) => [toMs(get(r)), i]).sort((a, b) => a[0] - b[0]);
  const t = order.map((o) => o[0]);
  const values = {};
  for (const [key, col] of Object.entries(columns)) {
    const acc = typeof col === 'function' ? col : (r) => r[col];
    values[key] = order.map(([, i]) => num(acc(rows[i])));
  }
  if (!stepMinutes) {
    const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
    stepMinutes = gaps.length ? gaps[gaps.length >> 1] / MIN : 15;
  }
  return { t, stepMinutes, values };
}

/** Minimal RFC-4180 CSV parser → array of records keyed by header. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

/** Convert a header row + array-of-arrays (compact JSON) into records. */
export function fromTable(header, table) {
  return table.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------------------------------------------------------------------------
// Range maths shared by chart + cards

/** Index of the first t >= x (binary search). */
export function bisect(t, x) {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Nearest index to time x. */
export function nearestIndex(t, x) {
  const i = bisect(t, x);
  if (i <= 0) return 0;
  if (i >= t.length) return t.length - 1;
  return x - t[i - 1] <= t[i] - x ? i - 1 : i;
}

/**
 * Index span [i0, i1] of points whose time lies in (t0, t1]. Samples are stamped at
 * the END of their interval, so the 00:00 sample belongs to the previous day.
 */
export function indexSpan(t, t0, t1) {
  // An empty window (no samples inside) is returned honestly as i1 < i0; callers
  // treat that as "no data in view" instead of borrowing a neighbouring sample.
  return [bisect(t, t0 + 1), bisect(t, t1 + 1) - 1];
}

/**
 * Aggregation helpers over an index span. Power readings (kW) integrate to energy
 * (kWh) by multiplying each sample by the interval length in hours.
 */
export function aggregator(dataset, i0, i1) {
  const h = dataset.stepMinutes / 60;
  const arr = (k) => dataset.values[k] || [];
  const reduce = (k, fn, init) => { const a = arr(k); let acc = init; for (let i = i0; i <= i1; i++) acc = fn(acc, a[i] ?? 0, i); return acc; };
  const api = {
    i0,
    i1,
    count: i1 - i0 + 1,
    dataset,
    values: (k) => arr(k).slice(i0, i1 + 1),
    sum: (k) => reduce(k, (a, v) => a + v, 0),
    energy: (k) => api.sum(k) * h,
    avg: (k) => (api.count > 0 ? api.sum(k) / api.count : 0),
    max: (k) => reduce(k, (a, v) => Math.max(a, v), -Infinity),
    min: (k) => reduce(k, (a, v) => Math.min(a, v), Infinity),
    last: (k) => arr(k)[i1] ?? 0,
    first: (k) => arr(k)[i0] ?? 0,
    /** purchase cost over the span: Σ kW × h × price (0 where no price) */
    cost: (k) => { const p = dataset.prices?.[k]; if (!p) return NaN; const a = arr(k); let c = 0; for (let i = i0; i <= i1; i++) { const pr = p[i]; if (Number.isFinite(pr)) c += (a[i] ?? 0) * h * pr; } return c; },
    /** volume-weighted average price; NaN when unpriced or no volume */
    avgPrice: (k) => { const e = api.energy(k); return e > 0 ? api.cost(k) / e : NaN; },
    hasPrice: (k) => !!dataset.prices?.[k],
    /** index where series k peaks inside the span */
    argmax: (k) => reduce(k, (a, v, i) => (v > (arr(k)[a] ?? -Infinity) ? i : a), i0),
  };
  return api;
}

/**
 * Attach purchase prices (₹/kWh, or any currency per kWh) to a dataset, one value per
 * sample, so the chart and cards can show cost and volume-weighted average price.
 *
 * spec[seriesKey] may be:
 *   number                                   flat rate, e.g. PPA ₹4.20
 *   number[]                                 per-sample series, e.g. IEX MCP per block
 *   { tod: [{ start, end, price }], base? }  time-of-day tariff (zone by interval start)
 *   (t, i, dataset) => number                anything else
 * Series without a spec (e.g. surplus exported) carry no price.
 */
export function withPrices(dataset, spec) {
  const prices = { ...(dataset.prices || {}) };
  const stepMs = dataset.stepMinutes * MIN;
  for (const [key, p] of Object.entries(spec)) {
    if (p == null) continue;
    let fn;
    if (typeof p === 'number') fn = () => p;
    else if (Array.isArray(p)) fn = (t, i) => p[i] ?? NaN;
    else if (typeof p === 'function') fn = p;
    else if (p.tod) {
      const zones = p.tod.map((z) => {
        const a = parseClock(z.start);
        let b = parseClock(z.end);
        if (b === 0) b = 1440;
        return { a, b, price: z.price };
      });
      fn = (t) => {
        const m = Math.floor((((t - stepMs) % DAY) + DAY) % DAY / MIN);
        const z = zones.find((q) => (q.b > q.a ? m >= q.a && m < q.b : m >= q.a || m < q.b));
        return z ? z.price : p.base ?? NaN;
      };
    } else throw new Error(`withPrices: unsupported spec for ${key}`);
    prices[key] = dataset.t.map((t, i) => fn(t, i, dataset));
  }
  return { ...dataset, prices };
}

export const time = { MIN, DAY };
