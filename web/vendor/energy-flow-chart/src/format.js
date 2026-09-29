// Number and time formatting. Times are wall-clock encoded as UTC (see data.js).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n) => String(n).padStart(2, '0');

export function fmtNumber(v, digits = 0, locale = 'en-IN') {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** kW → "2,431 kW" or "2.43 MW" when auto-scaling. */
export function fmtPower(kw, { unit = 'kW', auto = false, digits } = {}) {
  if (auto && Math.abs(kw) >= 1000) return `${fmtNumber(kw / 1000, digits ?? 2)} MW`;
  return `${fmtNumber(kw, digits ?? 0)} ${unit}`;
}

/** kWh → "43.48 MWh" (auto-scales kWh → MWh → GWh). */
export function fmtEnergy(kwh, { digits = 2 } = {}) {
  const a = Math.abs(kwh);
  if (a >= 1e6) return `${fmtNumber(kwh / 1e6, digits)} GWh`;
  if (a >= 1e3) return `${fmtNumber(kwh / 1e3, digits)} MWh`;
  return `${fmtNumber(kwh, a < 10 ? digits : 0)} kWh`;
}

/** 7.624 → "₹7.62/kWh" (compact: "₹7.62") */
export function fmtPrice(v, { currency = '₹', unit = '/kWh', digits = 2, compact = false } = {}) {
  if (!Number.isFinite(v)) return '–';
  return `${currency}${fmtNumber(v, digits)}${compact ? '' : unit}`;
}

/** Indian money: ₹12,345 · ₹4.56 L · ₹1.23 Cr */
export function fmtMoney(v, { currency = '₹' } = {}) {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e7) return `${currency}${fmtNumber(v / 1e7, 2)} Cr`;
  if (a >= 1e5) return `${currency}${fmtNumber(v / 1e5, 2)} L`;
  return `${currency}${fmtNumber(v, 0)}`;
}

export function fmtPercent(v, digits = 0) {
  return Number.isFinite(v) ? `${fmtNumber(v * 100, digits)}%` : '–';
}

export const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
export const fmtDay = (t) => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export const fmtWeekday = (t) => DAYS[new Date(t).getUTCDay()];
export const fmtDayLong = (t) => { const d = new Date(t); return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export const fmtDateTime = (t) => `${fmtDay(t)} · ${fmtTime(t)}`;
export const isoDay = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

/** A block labelled 00:00 at END means 24:00 of the previous day. */
export function fmtBlockTime(t) {
  const s = fmtTime(t);
  return s === '00:00' ? '24:00' : s;
}

/** Human description of a range: "Wed, 23 Sep 2026" or "Sep 20 – Sep 26". */
export function fmtRange(t0, t1) {
  const d0 = Math.floor(t0 / 86_400_000);
  const d1 = Math.floor((t1 - 1) / 86_400_000);
  if (d0 === d1) return `${fmtDayLong(t0)} · ${fmtTime(t0)}–${fmtBlockTime(t1)}`;
  return `${fmtDay(t0)} ${fmtTime(t0)} – ${fmtDay(t1 - 1)} ${fmtBlockTime(t1)}`;
}

/**
 * Compact period label for cards and the toolbar.
 *   whole day        → "Sat 26 Sep"            (long: "Sat, 26 Sep 2026")
 *   whole days       → "20–26 Sep"             (long: "20–26 Sep 2026") · across months "28 Sep – 4 Oct"
 *   partial window   → "24 Sep 06:00–16:00"    · across days "23 Sep 18:00 – 24 Sep 06:00"
 */
export function fmtPeriod(t0, t1, { long = false } = {}) {
  const D = 86_400_000;
  const d = (t) => new Date(t);
  const dm = (t) => `${d(t).getUTCDate()} ${MONTHS[d(t).getUTCMonth()]}`;
  const yr = (t) => (long ? ` ${d(t).getUTCFullYear()}` : '');
  const whole = t0 % D === 0 && t1 % D === 0;
  const last = t1 - 1;
  if (whole && t1 - t0 === D) return long ? `${fmtDayLong(t0)}` : `${DAYS[d(t0).getUTCDay()]} ${dm(t0)}`;
  if (whole) {
    return d(t0).getUTCMonth() === d(last).getUTCMonth()
      ? `${d(t0).getUTCDate()}–${dm(last)}${yr(last)}`
      : `${dm(t0)} – ${dm(last)}${yr(last)}`;
  }
  if (Math.floor(t0 / D) === Math.floor(last / D)) return `${dm(t0)} ${fmtTime(t0)}–${fmtBlockTime(t1)}${yr(t0)}`;
  return `${dm(t0)} ${fmtTime(t0)} – ${dm(last)} ${fmtBlockTime(t1)}`;
}

/** "Nice" axis ticks (1-2-5 steps). */
export function niceTicks(min, max, count = 5) {
  if (max <= min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { ticks, step, min: start, max: end };
}

/** Time ticks for the visible span: picks a step so labels never collide. */
export function timeTicks(t0, t1, widthPx, minGapPx = 64) {
  const H = 3_600_000;
  const steps = [15 * 60_000, 30 * 60_000, H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H, 48 * H, 7 * 24 * H];
  const span = t1 - t0;
  const step = steps.find((s) => (s / span) * widthPx >= minGapPx) || steps[steps.length - 1];
  const out = [];
  for (let v = Math.ceil(t0 / step) * step; v <= t1; v += step) out.push(v);
  return { ticks: out, step };
}
