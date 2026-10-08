// Round-the-clock (RTC) hybrid supply engine.
//
// Pure ES module with no DOM access, so it runs in the browser, in a Web Worker
// (optimizer) and in Node (tools/check_rtc_engine.mjs). Units:
//   power MW, energy MWh, money Rs crore (cr), tariffs Rs/kWh.
//   1 MWh x 1 Rs/kWh = Rs 1,000 = 1e-4 cr.

export const HOURS = 8760;
/** Capacity factors may exceed 1 when a plant's output exceeds its stated AC capacity (PVsyst). */
export const MAX_CF = 1.3;
/** Wind plants below this plant load factor are kept out of the profile library. */
export const MIN_WIND_PLF = 0.25;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const RS_CR_PER_MWH_AT_1RS = 1e-4;

export const MONTH_OF_HOUR = new Uint8Array(HOURS);
export const HOUR_OF_DAY = new Uint8Array(HOURS);
(() => {
  let t = 0;
  MONTH_DAYS.forEach((days, m) => {
    for (let d = 0; d < days; d += 1) {
      for (let h = 0; h < 24; h += 1) {
        MONTH_OF_HOUR[t] = m;
        HOUR_OF_DAY[t] = h;
        t += 1;
      }
    }
  });
})();

export const BEED_SITE = { name: "Beed, Maharashtra", lat: 18.99, lon: 75.76 };

export const DEFAULT_RTC_INPUTS = {
  site: BEED_SITE,
  annualEnergyMu: 2455, // million kWh = GWh
  plantCapacityMw: 285,
  dfrTarget: 0.85,
  dfrBasis: "annual", // 'annual' | 'monthly' (every month must meet the target)
  designCheck: "lifetime", // 'year1' | 'lifetime' (also meet the target in the most degraded year)
  demandGrowth: 0,
  lossPct: 0,
  solarCuf: 0.245,
  windCuf: 0.33,
  solarDcAc: 1.4,
};

export const DEFAULT_BESS = {
  rte: 0.87,
  minSoc: 0.05,
  maxSoc: 0.95,
  initSoc: 0.5,
  annualDegradation: 0.02,
  augmentation: "annual", // 'annual' | 'none' | 'oneTime'
  augmentationYear: 12,
  costDeclinePct: 0.03,
  durationH: 4, // discharge duration chosen by the user: 2 or 4 hours (MWh = MW x hours); null = free
  minDurationH: 1,
  maxDurationH: 8,
};

export const DEFAULT_COSTS = {
  solarCrPerMw: 3.5,
  windCrPerMw: 6.5,
  bessCrPerMwh: 1.2,
  bessPcsCrPerMw: 0,
  evacuationCr: 0,
  preopPct: 0.05,
};

export const DEFAULT_FINANCE = {
  years: 25,
  tariff: 4.5,
  tariffEscalation: 0,
  targetEquityIrr: 0.14,
  debtFraction: 0.7,
  interestRate: 0.09,
  tenorYears: 15,
  repayment: "equal", // 'equal' | 'annuity'
  taxRate: 0.2517,
  taxDepreciation: "wdv", // 'wdv' | 'slm'
  wdvRate: 0.4,
  bookLifeYears: 25,
  salvagePct: 0.1,
  solarOmLakhPerMw: 4.0,
  windOmLakhPerMw: 9.0,
  bessOmLakhPerMwh: 1.2,
  omEscalation: 0.05,
  insurancePct: 0.003,
  otherFixedCr: 0,
  receivableDays: 45,
  sellSurplus: false,
  surplusPrice: 2.5,
  extraExportMw: 0, // export capacity for surplus on top of the plant capacity (only used when selling)
  shortfallPenalty: 0,
  solarDegradation: 0.005,
  windDegradation: 0,
  discountRate: 0.1,
};

// ---------------------------------------------------------------- helpers

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i += 1) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

function scaleToCuf(raw, target, clip = 1) {
  const out = new Float64Array(raw.length);
  const cufFor = (k) => {
    let s = 0;
    for (let i = 0; i < raw.length; i += 1) s += Math.min(clip, raw[i] * k);
    return s / raw.length;
  };
  let lo = 0;
  let hi = 1;
  while (cufFor(hi) < target && hi < 1e6) hi *= 2;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (cufFor(mid) < target) lo = mid;
    else hi = mid;
  }
  for (let i = 0; i < raw.length; i += 1) out[i] = Math.min(clip, raw[i] * hi);
  return out;
}

export function monthlyMeans(series) {
  const sum = new Array(12).fill(0);
  const cnt = new Array(12).fill(0);
  for (let t = 0; t < HOURS; t += 1) {
    sum[MONTH_OF_HOUR[t]] += series[t];
    cnt[MONTH_OF_HOUR[t]] += 1;
  }
  return sum.map((s, m) => (cnt[m] ? s / cnt[m] : 0));
}

/** Average 24-hour shape for each month: rows[month][hour]. */
export function monthHourMatrix(series) {
  const sum = Array.from({ length: 12 }, () => new Array(24).fill(0));
  for (let t = 0; t < HOURS; t += 1) sum[MONTH_OF_HOUR[t]][HOUR_OF_DAY[t]] += series[t];
  return sum.map((row, m) => row.map((v) => v / MONTH_DAYS[m]));
}

// ---------------------------------------------------------------- resource profiles

const SOLAR_CLEARNESS = [0.95, 0.96, 0.95, 0.93, 0.9, 0.72, 0.58, 0.6, 0.7, 0.88, 0.93, 0.94];
const SOLAR_VARIABILITY = [0.05, 0.05, 0.06, 0.07, 0.1, 0.3, 0.38, 0.36, 0.3, 0.14, 0.06, 0.05];

/**
 * Synthetic hourly AC capacity factor for a fixed-tilt plant (per MWac), calibrated to
 * the annual AC CUF. Uses clear-sky geometry for the site plus a monsoon clearness pattern
 * typical of Marathwada (Beed). Replace with a PVsyst/SolarGIS 8760 via upload for bids.
 */
export function synthSolarCf({ lat = BEED_SITE.lat, lon = BEED_SITE.lon, targetCuf = 0.245, dcAc = 1.4, seed = 11 } = {}) {
  const rand = mulberry32(seed);
  const phi = (lat * Math.PI) / 180;
  const raw = new Float64Array(HOURS);
  let t = 0;
  for (let n = 1; n <= 365; n += 1) {
    const m = MONTH_OF_HOUR[t];
    const decl = ((23.45 * Math.PI) / 180) * Math.sin((2 * Math.PI * (284 + n)) / 365);
    const b = (2 * Math.PI * (n - 81)) / 364;
    const eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
    const dayCloud = Math.max(0.12, Math.min(1.05, SOLAR_CLEARNESS[m] * (1 + SOLAR_VARIABILITY[m] * (rand() * 2 - 1) * 1.6)));
    for (let h = 0; h < 24; h += 1) {
      const solarTime = h + 0.5 + (lon - 82.5) / 15 + eot / 60;
      const omega = ((solarTime - 12) * 15 * Math.PI) / 180;
      const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(omega);
      if (cosZ > 0.01) {
        const ghi = 1098 * cosZ * Math.exp(-0.057 / cosZ);
        // tilt = latitude, south facing: incidence depends on declination and hour angle
        const cosInc = Math.max(0, Math.cos(decl) * Math.cos(omega));
        const poa = ghi * (0.78 * (cosInc / Math.max(cosZ, 0.12)) * 0.93 + 0.22);
        const jitter = 1 + SOLAR_VARIABILITY[m] * 0.35 * (rand() * 2 - 1);
        raw[t] = Math.max(0, (poa / 1000) * dayCloud * jitter * dcAc * 0.82);
      }
      t += 1;
    }
  }
  return scaleToCuf(raw, targetCuf, 1);
}

// Beed / Marathwada wind: strong south-west monsoon (May-Aug), weak post-monsoon.
const WIND_MONTH_SPEED = [5.6, 5.7, 5.9, 6.3, 7.4, 9.0, 9.6, 9.0, 7.2, 5.2, 5.3, 5.6];
const WIND_DIURNAL = [1.06, 1.04, 1.02, 1.0, 0.97, 0.94, 0.9, 0.86, 0.83, 0.82, 0.84, 0.88, 0.93, 0.99, 1.05, 1.1, 1.14, 1.16, 1.16, 1.15, 1.13, 1.11, 1.09, 1.07];

function turbinePower(v) {
  if (v < 3 || v >= 25) return 0;
  if (v >= 11.5) return 1;
  return (v ** 3 - 27) / (11.5 ** 3 - 27);
}

/** Synthetic hourly wind capacity factor (per MW) calibrated to the annual CUF. */
export function synthWindCf({ targetCuf = 0.33, seed = 23 } = {}) {
  const rand = mulberry32(seed);
  const speed = new Float64Array(HOURS);
  const sigma = 0.24;
  const rho = 0.94;
  let x = 0;
  for (let t = 0; t < HOURS; t += 1) {
    x = rho * x + Math.sqrt(1 - rho * rho) * gaussian(rand) * sigma;
    speed[t] = WIND_MONTH_SPEED[MONTH_OF_HOUR[t]] * WIND_DIURNAL[HOUR_OF_DAY[t]] * Math.exp(x - (sigma * sigma) / 2);
  }
  const cufFor = (k) => {
    let s = 0;
    for (let t = 0; t < HOURS; t += 1) s += turbinePower(speed[t] * k);
    return (s / HOURS) * 0.94;
  };
  let lo = 0.2;
  let hi = 3;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    if (cufFor(mid) < targetCuf) lo = mid;
    else hi = mid;
  }
  const out = new Float64Array(HOURS);
  for (let t = 0; t < HOURS; t += 1) out[t] = turbinePower(speed[t] * hi) * 0.94;
  // exact calibration for capped profiles
  return scaleToCuf(out, targetCuf, 1);
}

/** Apply 12 monthly multipliers (user-drawn) to a capacity-factor profile, clipped to 1. */
export function applyMonthlyScale(cf, monthScale) {
  if (!monthScale || monthScale.every((v) => Math.abs(v - 1) < 1e-9)) return cf;
  const out = new Float64Array(HOURS);
  for (let t = 0; t < HOURS; t += 1) out[t] = Math.min(MAX_CF, cf[t] * monthScale[MONTH_OF_HOUR[t]]);
  return out;
}

// ---------------------------------------------------------------- demand

export const FLAT_HOUR_SHAPE = new Array(24).fill(1);
export const FLAT_MONTH_SHAPE = new Array(12).fill(1);

/**
 * Hourly demand (MW) for the year: either a custom 8760 shape or a 12x24 month-hour
 * shape, normalised so the year sums to annualEnergyMu (GWh).
 */
export function buildDemand({ annualEnergyMu, hourShape = FLAT_HOUR_SHAPE, monthShape = FLAT_MONTH_SHAPE, custom = null }) {
  const w = new Float64Array(HOURS);
  let sum = 0;
  for (let t = 0; t < HOURS; t += 1) {
    const v = custom ? Math.max(0, Number(custom[t]) || 0) : Math.max(0, hourShape[HOUR_OF_DAY[t]]) * Math.max(0, monthShape[MONTH_OF_HOUR[t]]);
    w[t] = v;
    sum += v;
  }
  const total = annualEnergyMu * 1000;
  for (let t = 0; t < HOURS; t += 1) w[t] = sum > 0 ? (w[t] / sum) * total : total / HOURS;
  return w;
}

// ---------------------------------------------------------------- uploads

/**
 * Parse an uploaded profile. Accepts one value per line or CSV with the value in the last
 * numeric column; 8760 / 8784 hourly or 35040 / 35136 quarter-hourly rows. Values above
 * 1.5 are treated as MW of a plant and normalised by `referenceMw` (or the maximum).
 */
export function parseProfileCsv(text, { kind = "cf", referenceMw = null } = {}) {
  const values = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      if (cells[i] !== "" && Number.isFinite(Number(cells[i]))) {
        values.push(Number(cells[i]));
        break;
      }
    }
  }
  let hourly = values;
  if (values.length === 35040 || values.length === 35136) {
    hourly = [];
    for (let i = 0; i + 3 < values.length; i += 4) hourly.push((values[i] + values[i + 1] + values[i + 2] + values[i + 3]) / 4);
  }
  if (hourly.length === 8784) hourly = [...hourly.slice(0, 59 * 24), ...hourly.slice(60 * 24)]; // drop 29 Feb
  if (hourly.length !== HOURS) {
    throw new Error(`Expected 8760 hourly (or 35040 15-minute) values, found ${values.length}.`);
  }
  const out = Float64Array.from(hourly, (v) => Math.max(0, v));
  if (kind === "demand") return { values: out, note: `${HOURS} hourly demand values (shape; scaled to the annual energy)` };
  const max = Math.max(...out);
  if (max > 1.5) {
    const ref = Number(referenceMw) > 0 ? Number(referenceMw) : max;
    for (let t = 0; t < HOURS; t += 1) out[t] = Math.min(MAX_CF, out[t] / ref);
    return { values: out, note: `MW values normalised by ${ref.toFixed(1)} MW → CUF ${(mean(out) * 100).toFixed(1)}%` };
  }
  for (let t = 0; t < HOURS; t += 1) out[t] = Math.min(MAX_CF, out[t]);
  return { values: out, note: `capacity factors, CUF ${(mean(out) * 100).toFixed(1)}%` };
}

// ---------------------------------------------------------------- dated time series (SCADA / meter exports)

const DAY_OFFSET = (() => {
  const out = [];
  let acc = 0;
  for (const d of MONTH_DAYS) { out.push(acc); acc += d; }
  return out;
})();

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";" || c === "\t") { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** "2025-09-29", "29-09-2025", "29/09/2025", "2025-09-29 00:15" → { m (0-11), d (1-31), hh, mm } */
function parseDateTime(dateStr, timeStr) {
  const s = String(dateStr || "").trim();
  let y; let m; let d; let rest = "";
  let hit = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(.*)$/);
  if (hit) { [, y, m, d, rest] = hit; } else {
    hit = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(.*)$/);
    if (!hit) return null;
    [, d, m, y, rest] = hit;
  }
  const t = String(timeStr || rest || "").match(/(\d{1,2}):(\d{2})/);
  return { y: Number(y), m: Number(m) - 1, d: Number(d), hh: t ? Number(t[1]) : 0, mm: t ? Number(t[2]) : 0 };
}

/**
 * Turn a dated generation export (e.g. SLDC/RLDC SCADA blockwise CSV: Date, Clock Time,
 * Actual Generation (MW), CUF (%)) into an 8760 hourly capacity-factor profile with a quality
 * report. Handles 15-minute or hourly data covering part of a year:
 *   - capacity from `referenceMw`, else implied by the CUF column, else the 99.5th percentile;
 *   - negative readings (auxiliary consumption) → 0; readings above 110% of capacity → invalid;
 *   - hours without data are filled with the same month × hour-of-day average (or the
 *     annual hour-of-day average when a whole month is missing).
 * Returns null when the file has no recognisable date column (caller falls back to 8760 lists).
 */
export function parseDatedProfile(text, { referenceMw = null } = {}) {
  let lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 48) return null;
  // PVsyst / EYA exports start with metadata lines (site, "AC,300,MW", "DC,450,MWp") before the header
  let headerAt = lines.slice(0, 40).findIndex((l) => /(^|,|")\s*(date|timestamp|datetime)\b/i.test(l));
  if (headerAt < 0) headerAt = 0;
  const metaLines = lines.slice(0, headerAt).map(splitCsvLine);
  let metaAc = null;
  let metaDc = null;
  for (const c of metaLines) {
    const k = String(c[0] || "").trim().toLowerCase();
    const v = Number(c[1]);
    if (k === "ac" && v > 0) metaAc = v;
    if (k === "dc" && v > 0) metaDc = v;
  }
  const metaTitle = metaLines.map((c) => c.find((x) => x && x.trim()) || "").filter((t) => t && !/^(ac|dc)$/i.test(t.trim())).join(" · ");
  lines = lines.slice(headerAt);
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const find = (re, not) => header.findIndex((h, i) => re.test(h) && i !== not);
  const dateCol = find(/date|day|timestamp|datetime/);
  if (dateCol < 0) return null;
  const timeCol = find(/clock|time|hour/, dateCol);
  // prefer measured output over schedules / forecasts
  const PRIORITY = [/actual.*\(mw\)/, /actual.*(mw|kw|power|generation)/, /(generation|output|power).*\((mw|kw)\)/, /^(mw|kw|power|output|generation)$/, /\((mw|kw)\)/];
  let valCol = -1;
  for (const re of PRIORITY) {
    valCol = header.findIndex((h, i) => re.test(h) && !/schedul|forecast|deviation|injection|settlement|mwh|kwh/.test(h) && i !== dateCol && i !== timeCol);
    if (valCol >= 0) break;
  }
  const cufCol = find(/cuf|capacity factor/);
  const nameCol = find(/entity name|plant|site|name/);
  if (valCol < 0) {
    const sample = splitCsvLine(lines[1]);
    for (let i = sample.length - 1; i >= 0; i -= 1) if (i !== dateCol && i !== timeCol && Number.isFinite(Number(sample[i]))) { valCol = i; break; }
  }
  if (valCol < 0) throw new Error("No generation (MW) column found.");
  const kw = /kw/.test(header[valCol]) && !/mw/.test(header[valCol]);

  const sum = new Float64Array(HOURS);
  const cnt = new Uint16Array(HOURS);
  const raw = [];
  const implied = [];
  let first = null;
  let last = null;
  let name = "";
  for (let i = 1; i < lines.length; i += 1) {
    const c = splitCsvLine(lines[i]);
    const dt = parseDateTime(c[dateCol], timeCol >= 0 ? c[timeCol] : "");
    if (!dt || dt.m < 0 || dt.m > 11 || (dt.m === 1 && dt.d === 29)) continue;
    let mw = Number(c[valCol]);
    if (!Number.isFinite(mw)) continue;
    if (kw) mw /= 1000;
    const h = (DAY_OFFSET[dt.m] + dt.d - 1) * 24 + Math.min(23, dt.hh);
    if (h < 0 || h >= HOURS) continue;
    raw.push([h, mw]);
    if (cufCol >= 0) {
      const cf = Number(c[cufCol]);
      if (cf > 0.5 && mw > 0) implied.push(mw / (cf / 100));
    }
    const key = `${dt.y}-${String(dt.m + 1).padStart(2, "0")}-${String(dt.d).padStart(2, "0")}`;
    if (!first || key < first) first = key;
    if (!last || key > last) last = key;
    if (!name && nameCol >= 0) name = c[nameCol];
  }
  if (raw.length < 48) throw new Error("Too few dated rows were recognised.");
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  let capacityMw = Number(referenceMw) > 0 ? Number(referenceMw) : null;
  let capacitySource = "given";
  if (!capacityMw && metaAc) { capacityMw = metaAc; capacitySource = `AC capacity stated in the file${metaDc ? ` (DC ${metaDc.toFixed(1)} MWp, DC/AC ${(metaDc / metaAc).toFixed(2)})` : ""}`; }
  // Measured data (a CUF column, or no stated AC capacity) gets the strict 110% rule; modelled
  // yield files that state their AC capacity in the header (PVsyst) may exceed nameplate.
  const scada = cufCol >= 0 || !metaAc;
  if (!capacityMw && implied.length > 20) { capacityMw = sorted(implied)[implied.length >> 1]; capacitySource = "implied by the CUF column"; }
  if (!capacityMw) { const v = sorted(raw.map((r) => r[1])); capacityMw = v[Math.floor(v.length * 0.995)] || 1; capacitySource = "99.5th percentile of output (no capacity given)"; }

  // Output above nameplate: SCADA readings > 110% of capacity are errors; modelled (PVsyst)
  // output may exceed the contracted AC figure when inverter capacity is higher, so it is
  // kept up to 130% and dropped only beyond that.
  const hardCap = scada ? 1.1 : 1.3;
  let negatives = 0;
  let negEnergy = 0;
  let posEnergy = 0;
  let invalid = 0;
  let aboveNameplate = 0;
  for (const [h, mw0] of raw) {
    let mw = mw0;
    if (mw < 0) { negatives += 1; negEnergy -= mw; mw = 0; } else posEnergy += mw;
    if (mw > capacityMw * hardCap) { invalid += 1; continue; }
    if (mw > capacityMw * 1.001) aboveNameplate += 1;
    sum[h] += mw;
    cnt[h] += 1;
  }
  const cf = new Float64Array(HOURS);
  const have = new Uint8Array(HOURS);
  const mhSum = Array.from({ length: 12 }, () => new Float64Array(24));
  const mhCnt = Array.from({ length: 12 }, () => new Uint32Array(24));
  const hSum = new Float64Array(24);
  const hCnt = new Uint32Array(24);
  let covered = 0;
  for (let t = 0; t < HOURS; t += 1) {
    if (!cnt[t]) continue;
    const v = Math.min(MAX_CF, sum[t] / cnt[t] / capacityMw);
    cf[t] = v;
    have[t] = 1;
    covered += 1;
    mhSum[MONTH_OF_HOUR[t]][HOUR_OF_DAY[t]] += v;
    mhCnt[MONTH_OF_HOUR[t]][HOUR_OF_DAY[t]] += 1;
    hSum[HOUR_OF_DAY[t]] += v;
    hCnt[HOUR_OF_DAY[t]] += 1;
  }
  const monthsMissing = [];
  for (let m = 0; m < 12; m += 1) if (!mhCnt[m].some((n) => n > 0)) monthsMissing.push(MONTHS[m]);
  for (let t = 0; t < HOURS; t += 1) {
    if (have[t]) continue;
    const m = MONTH_OF_HOUR[t];
    const hh = HOUR_OF_DAY[t];
    cf[t] = mhCnt[m][hh] ? mhSum[m][hh] / mhCnt[m][hh] : hCnt[hh] ? hSum[hh] / hCnt[hh] : 0;
  }
  const coverage = covered / HOURS;
  const invalidShare = invalid / raw.length;
  const negShare = negatives / raw.length;
  const cuf = mean(cf);
  const issues = [];
  let quality = "validated";
  if (invalidShare > 0.05) { quality = "rejected"; issues.push(`${(invalidShare * 100).toFixed(1)}% of readings exceed ${Math.round(hardCap * 100)}% of the ${capacityMw.toFixed(1)} MW capacity (wrong capacity, unit or capacity change)`); }
  // small negative night readings (auxiliary load) are normal; large negative energy is not
  const negEnergyShare = posEnergy > 0 ? negEnergy / posEnergy : 1;
  if (negEnergyShare > 0.05) { quality = "rejected"; issues.push(`negative readings amount to ${(negEnergyShare * 100).toFixed(0)}% of the generated energy (${(negShare * 100).toFixed(0)}% of readings)`); }
  if (quality !== "rejected") {
    if (coverage < 0.5) { quality = "suspect"; issues.push(`only ${(coverage * 100).toFixed(0)}% of the year has data`); }
    if (cuf < 0.12) { quality = "suspect"; issues.push(`very low CUF ${(cuf * 100).toFixed(1)}% (infirm / commissioning power or curtailment?)`); }
    if (monthsMissing.length >= 3) { quality = "suspect"; issues.push(`no data for ${monthsMissing.join(", ")} (filled with the average day)`); }
  }
  const notes = [];
  if (!scada && aboveNameplate > 0) {
    notes.push(`${aboveNameplate} readings are above the ${capacityMw.toFixed(0)} MW nameplate (inverter AC above the stated capacity); kept, so capacity factors reach ${(Math.max(...cf) * 100).toFixed(0)}%`);
  }
  if (negShare > 0) notes.push(`${(negShare * 100).toFixed(1)}% of readings were negative (night-time auxiliary consumption) and set to zero`);
  const monthly = monthlyMeans(cf);
  return {
    values: cf,
    name: name || metaTitle,
    notes,
    capacityMw,
    capacitySource,
    from: first,
    to: last,
    coverage,
    filledHours: HOURS - covered,
    invalidShare,
    negativeShare: negShare,
    monthsMissing,
    cuf,
    monthlyCuf: monthly,
    quality,
    issues,
    note: `${first} → ${last} · ${(coverage * 100).toFixed(0)}% of hours measured, rest filled · CUF ${(cuf * 100).toFixed(1)}% on ${capacityMw.toFixed(1)} MW`,
  };
}

/** Upload entry point: dated exports first, then plain 8760 / 35040 lists. */
export function parseAnyProfile(text, { kind = "cf", referenceMw = null } = {}) {
  if (kind !== "demand") {
    const dated = parseDatedProfile(text, { referenceMw });
    if (dated) return dated;
  }
  const plain = parseProfileCsv(text, { kind, referenceMw });
  const cuf = mean(plain.values);
  return { ...plain, cuf, monthlyCuf: monthlyMeans(plain.values), coverage: 1, quality: "validated", issues: [], filledHours: 0 };
}

export function profileTemplateCsv(kind) {
  const head = kind === "demand" ? "hour,month,hour_of_day,demand_mw" : `hour,month,hour_of_day,${kind}_cf_per_mw`;
  const rows = [head];
  for (let t = 0; t < HOURS; t += 1) rows.push(`${t + 1},${MONTH_OF_HOUR[t] + 1},${HOUR_OF_DAY[t]},${kind === "demand" ? 280 : 0}`);
  return rows.join("\n");
}

// ---------------------------------------------------------------- dispatch

/**
 * Hourly dispatch of solar + wind + BESS against demand, limited by plant (export) capacity.
 * Priority: RE direct to load → charge BESS from surplus → discharge BESS to deficit →
 * remaining surplus exported within spare plant capacity → rest curtailed. BESS charges only
 * from RE.
 */
export function simulate(ctx, sizes, opts = {}) {
  const { demand, solarCf, windCf, plantMw, bess } = ctx;
  const loss = 1 - (ctx.lossPct || 0);
  const sF = (opts.solarFactor ?? 1) * loss;
  const wF = (opts.windFactor ?? 1) * loss;
  const dF = opts.demandFactor ?? 1;
  const S = Math.max(0, sizes.solarMw || 0);
  const W = Math.max(0, sizes.windMw || 0);
  const B = Math.max(0, sizes.bessMw || 0);
  const E = Math.max(0, sizes.bessMwh || 0) * (opts.bessFactor ?? 1);
  const eta = Math.sqrt(Math.min(1, Math.max(0.5, bess.rte)));
  const socMin = E * bess.minSoc;
  const socMax = E * bess.maxSoc;
  let soc = Math.min(socMax, Math.max(socMin, E * bess.initSoc));
  const hourly = opts.hourly;
  const H = hourly
    ? {
        demand: new Float32Array(HOURS),
        solar: new Float32Array(HOURS),
        wind: new Float32Array(HOURS),
        discharge: new Float32Array(HOURS),
        charge: new Float32Array(HOURS),
        excess: new Float32Array(HOURS),
        curtail: new Float32Array(HOURS),
        unmet: new Float32Array(HOURS),
        soc: new Float32Array(HOURS),
      }
    : null;
  const mDemand = new Float64Array(12);
  const mDelivered = new Float64Array(12);
  let tDemand = 0;
  let tDelivered = 0;
  let tSolarGen = 0;
  let tWindGen = 0;
  let tSolarDirect = 0;
  let tWindDirect = 0;
  let tCharge = 0;
  let tDischarge = 0;
  let tExcess = 0;
  let tCurtail = 0;
  let sCharge = 0;
  let sExport = 0;
  let sCurtail = 0;
  let cuBatteryFull = 0;
  let cuBatteryPower = 0;
  let cuNoStorage = 0;
  const sell = Boolean(ctx.sellSurplus);
  const extraExport = Math.max(0, ctx.extraExportMw || 0);
  let tUnmet = 0;
  let aboveCap = 0;
  for (let t = 0; t < HOURS; t += 1) {
    const d = demand[t] * dF;
    const target = d < plantMw ? d : plantMw;
    if (d > plantMw) aboveCap += d - plantMw;
    const s = S * solarCf[t] * sF;
    const w = W * windCf[t] * wF;
    const g = s + w;
    const direct = g < target ? g : target;
    const surplus = g - direct;
    let ch = 0;
    if (surplus > 0 && E > 0) {
      ch = Math.min(surplus, B, (socMax - soc) / eta);
      if (ch < 0) ch = 0;
      soc += ch * eta;
    }
    let dis = 0;
    const deficit = target - direct;
    if (deficit > 0 && E > 0) {
      dis = Math.min(deficit, B, (soc - socMin) * eta);
      if (dis < 0) dis = 0;
      soc -= dis / eta;
    }
    const delivered = direct + dis;
    const rest = surplus - ch;
    // Surplus the customer and the battery cannot take is sold only if surplus sales are on,
    // through spare plant capacity plus any extra export capacity; the rest is curtailed.
    const room = sell ? Math.max(0, plantMw - delivered) + extraExport : 0;
    const ex = rest < room ? rest : room;
    const cu = rest - ex;
    if (cu > 1e-9) {
      if (E <= 0 || B <= 0) cuNoStorage += cu;
      else if (ch >= B - 1e-9) cuBatteryPower += cu;
      else cuBatteryFull += cu;
    }
    const m = MONTH_OF_HOUR[t];
    mDemand[m] += d;
    mDelivered[m] += delivered;
    tDemand += d;
    tDelivered += delivered;
    tSolarGen += s;
    tWindGen += w;
    const shareS = g > 0 ? s / g : 0;
    sCharge += ch * shareS;
    sExport += ex * shareS;
    sCurtail += cu * shareS;
    tSolarDirect += direct * shareS;
    tWindDirect += direct * (1 - shareS);
    tCharge += ch;
    tDischarge += dis;
    tExcess += ex;
    tCurtail += cu;
    tUnmet += d - delivered;
    if (H) {
      H.demand[t] = d;
      H.solar[t] = direct * shareS;
      H.wind[t] = direct * (1 - shareS);
      H.discharge[t] = dis;
      H.charge[t] = ch;
      H.excess[t] = ex;
      H.curtail[t] = cu;
      H.unmet[t] = d - delivered;
      H.soc[t] = E > 0 ? soc / E : 0;
    }
  }
  const monthlyDfr = Array.from(mDemand, (v, m) => (v > 0 ? mDelivered[m] / v : 1));
  const usable = E * (bess.maxSoc - bess.minSoc);
  return {
    demandMWh: tDemand,
    deliveredMWh: tDelivered,
    dfr: tDemand > 0 ? tDelivered / tDemand : 1,
    monthlyDfr,
    minMonthlyDfr: Math.min(...monthlyDfr),
    monthlyDemandMWh: Array.from(mDemand),
    monthlyDeliveredMWh: Array.from(mDelivered),
    solarGenMWh: tSolarGen,
    windGenMWh: tWindGen,
    solarDirectMWh: tSolarDirect,
    windDirectMWh: tWindDirect,
    chargeMWh: tCharge,
    dischargeMWh: tDischarge,
    excessMWh: tExcess,
    curtailMWh: tCurtail,
    curtailReasons: { batteryFull: cuBatteryFull, batteryPower: cuBatteryPower, noStorage: cuNoStorage },
    // where each technology's output went (surplus flows split by the hour's solar/wind share)
    byTech: {
      solar: { direct: tSolarDirect, charge: sCharge, export: sExport, curtail: sCurtail },
      wind: { direct: tWindDirect, charge: tCharge - sCharge, export: tExcess - sExport, curtail: tCurtail - sCurtail },
    },
    sellSurplus: sell,
    exportLimitMw: sell ? plantMw + extraExport : 0,
    unmetMWh: tUnmet,
    demandAboveCapMWh: aboveCap,
    cycles: usable > 0 ? tDischarge / usable : 0,
    hourly: H,
  };
}

// ---------------------------------------------------------------- degradation per year

export function yearFactors(year, fin, bess) {
  const solarFactor = (1 - (fin.solarDegradation || 0)) ** (year - 1);
  const windFactor = (1 - (fin.windDegradation || 0)) ** (year - 1);
  const demandFactor = (1 + (fin.demandGrowth || 0)) ** (year - 1);
  let bessFactor = 1;
  const deg = bess.annualDegradation || 0;
  if (bess.augmentation === "none") bessFactor = Math.max(0.4, 1 - deg * (year - 1));
  else if (bess.augmentation === "oneTime") {
    const since = year >= bess.augmentationYear ? year - bess.augmentationYear : year - 1;
    bessFactor = Math.max(0.4, 1 - deg * since);
  }
  return { solarFactor, windFactor, bessFactor, demandFactor };
}

/**
 * Conservative design envelope for lifetime DFR checks: the lowest solar, wind and BESS
 * factors and the highest demand factor seen in any PPA year, applied together.
 */
export function worstYearFactors(fin, bess) {
  const years = fin.years || 25;
  const env = { solarFactor: 1, windFactor: 1, bessFactor: 1, demandFactor: 1 };
  for (let y = 1; y <= years; y += 1) {
    const f = yearFactors(y, fin, bess);
    env.solarFactor = Math.min(env.solarFactor, f.solarFactor);
    env.windFactor = Math.min(env.windFactor, f.windFactor);
    env.bessFactor = Math.min(env.bessFactor, f.bessFactor);
    env.demandFactor = Math.max(env.demandFactor, f.demandFactor);
  }
  return env;
}

// ---------------------------------------------------------------- costs

/** Apply the chosen discharge duration (MWh = MW x hours) when one is set. */
export function withDuration(sizes, bess) {
  const dur = Number(bess?.durationH);
  return dur > 0 ? { ...sizes, bessMwh: sizes.bessMw * dur } : sizes;
}

export function capexCr(sizes, costs) {
  const hard = sizes.solarMw * costs.solarCrPerMw
    + sizes.windMw * costs.windCrPerMw
    + sizes.bessMwh * costs.bessCrPerMwh
    + sizes.bessMw * (costs.bessPcsCrPerMw || 0)
    + (sizes.biomassMw || 0) * (costs.biomassCrPerMw || 0) // Tender to Bid only; 0 for Round the clock
    // Tender to Bid dispatchable plants (hydro, thermal): capex per MW; none for Round the clock
    + (costs.plants || []).reduce((sum, pl) => sum + (sizes[`${pl.id}Mw`] || 0) * (pl.capexCrPerMw || 0), 0)
    + (costs.evacuationCr || 0);
  return { hard, preop: hard * (costs.preopPct || 0), total: hard * (1 + (costs.preopPct || 0)) };
}

function crf(rate, n) {
  if (rate <= 0) return 1 / n;
  const f = (1 + rate) ** n;
  return (rate * f) / (f - 1);
}

function augmentationScheduleCr(sizes, costs, bess, years) {
  const out = new Array(years + 1).fill(0);
  const deg = bess.annualDegradation || 0;
  const priceAt = (y) => costs.bessCrPerMwh * (1 - (bess.costDeclinePct || 0)) ** (y - 1);
  if (!sizes.bessMwh || !deg) return out;
  if (bess.augmentation === "annual") {
    for (let y = 2; y <= years; y += 1) out[y] = sizes.bessMwh * deg * priceAt(y);
  } else if (bess.augmentation === "oneTime" && bess.augmentationYear > 1 && bess.augmentationYear <= years) {
    const y = bess.augmentationYear;
    const lost = Math.min(0.6, deg * (y - 1));
    out[y] = sizes.bessMwh * lost * priceAt(y);
  }
  return out;
}

function omCr(sizes, fin) {
  return (sizes.solarMw * fin.solarOmLakhPerMw + sizes.windMw * fin.windOmLakhPerMw + sizes.bessMwh * fin.bessOmLakhPerMwh
    + (sizes.biomassMw || 0) * (fin.biomassOmLakhPerMw || 0)) / 100;
}

/**
 * Screening objective used by the optimizer: levelised cost of delivered energy
 * (Rs/kWh) = (capex·CRF + levelised O&M + levelised augmentation − surplus revenue) / energy.
 */
export function evaluateDesign(ctx, sizes, model) {
  const { costs, fin, bess, dfrTarget, dfrBasis, designCheck } = model;
  const y1 = simulate(ctx, sizes);
  let worst = null;
  if (designCheck === "lifetime") worst = simulate(ctx, sizes, model.worstFactors);
  const dfrY1 = dfrBasis === "monthly" ? y1.minMonthlyDfr : y1.dfr;
  const dfrWorst = worst ? (dfrBasis === "monthly" ? worst.minMonthlyDfr : worst.dfr) : dfrY1;
  const dfrCheck = Math.min(dfrY1, dfrWorst);
  const capex = capexCr(sizes, costs);
  const years = fin.years || 25;
  const r = fin.discountRate || 0.1;
  const f = crf(r, years);
  let omPv = 0;
  const om = omCr(sizes, fin) + capex.hard * (fin.insurancePct || 0) + (fin.otherFixedCr || 0);
  const aug = augmentationScheduleCr(sizes, costs, bess, years);
  for (let y = 1; y <= years; y += 1) omPv += (om * (1 + fin.omEscalation) ** (y - 1) + aug[y]) / (1 + r) ** y;
  const energy = worst ? (y1.deliveredMWh + worst.deliveredMWh) / 2 : y1.deliveredMWh;
  const excess = worst ? (y1.excessMWh + worst.excessMWh) / 2 : y1.excessMWh;
  const surplusRevenue = fin.sellSurplus ? excess * fin.surplusPrice * RS_CR_PER_MWH_AT_1RS : 0;
  const annualCost = capex.total * f + omPv * f - surplusRevenue;
  const lcoe = energy > 0 ? annualCost / (energy * RS_CR_PER_MWH_AT_1RS) : Infinity;
  const feasible = dfrCheck >= dfrTarget - 1e-6;
  return {
    sizes: { ...sizes },
    dfr: y1.dfr,
    minMonthlyDfr: y1.minMonthlyDfr,
    dfrWorst: worst ? worst.dfr : y1.dfr,
    dfrCheck,
    feasible,
    capexCr: capex.total,
    lcoe,
    deliveredMWh: y1.deliveredMWh,
    excessMWh: y1.excessMWh,
    curtailMWh: y1.curtailMWh,
    cycles: y1.cycles,
  };
}

function objectiveValue(ev, objective, dfrTarget) {
  const base = objective === "capex" ? ev.capexCr / 1000 : ev.lcoe; // "tariff" screens on LCOE
  if (ev.feasible) return base;
  return base + 10 + (dfrTarget - ev.dfrCheck) * 200;
}

// ---------------------------------------------------------------- optimizer

export const DEFAULT_VARS = {
  solarMw: { value: 450, min: 0, max: 1200, step: 5, locked: false },
  windMw: { value: 300, min: 0, max: 900, step: 5, locked: false },
  bessMw: { value: 150, min: 0, max: 500, step: 5, locked: false },
  bessMwh: { value: 600, min: 0, max: 3000, step: 10, locked: false },
};

const VAR_KEYS = ["solarMw", "windMw", "bessMw", "bessMwh"];

function snap(v, spec) {
  const s = spec.step || 1;
  return Math.min(spec.max, Math.max(spec.min, Math.round(v / s) * s));
}

function linspace(spec, n) {
  if (spec.locked) return [spec.value];
  if (spec.max <= spec.min) return [spec.min];
  const out = new Set();
  for (let i = 0; i < n; i += 1) out.add(snap(spec.min + ((spec.max - spec.min) * i) / (n - 1), spec));
  return [...out];
}

/**
 * Least-cost sizing. Stage 1: coarse grid over solar x wind x BESS power, bisecting BESS energy
 * for the smallest feasible MWh. Stage 2: compass (pattern) search from the best candidates
 * on the snapped lattice. Locked variables are held at their value.
 */
const fmtSizes = (z) => `solar ${Math.round(z.solarMw)} MW, wind ${Math.round(z.windMw)} MW, BESS ${Math.round(z.bessMw)} MW / ${Math.round(z.bessMwh)} MWh`;

export function* optimizeSteps(ctx, model, onProgress) {
  const started = Date.now();
  const clock = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();
  const t0 = clock();
  // Optimizer log: what was searched, every surface point, every accepted move, final checks.
  const log = [];
  const L = (stage, msg, extra = {}) => { if (log.length < 4000) log.push({ t: Math.round(clock() - t0), stage, msg, ...extra }); };
  let cacheHits = 0;
  let simMs = 0;
  const vars = {};
  for (const k of VAR_KEYS) {
    const v = model.vars[k];
    vars[k] = { ...v, value: v.locked ? v.value : snap(v.value, v), min: Math.min(v.min, v.max), max: Math.max(v.min, v.max) };
  }
  const cache = new Map();
  const cloud = [];
  let evals = 0;
  const minDur = model.bess.minDurationH || 0;
  const maxDur = model.bess.maxDurationH || 1e9;
  // fixed discharge duration: battery energy follows battery power, only MW is searched
  const fixedDur = Number(model.bess.durationH) > 0 ? Number(model.bess.durationH) : null;
  if (fixedDur) vars.bessMwh = { ...vars.bessMwh, locked: true, value: 0 };
  const evalAt = (input) => {
    const sizes = fixedDur ? { ...input, bessMwh: input.bessMw * fixedDur } : input;
    const key = VAR_KEYS.map((k) => sizes[k]).join("|");
    if (cache.has(key)) { cacheHits += 1; return cache.get(key); }
    const ts = clock();
    const ev = evaluateDesign(ctx, sizes, model);
    simMs += clock() - ts;
    // duration window only applies when a BESS exists
    if (fixedDur) {
      // duration is fixed by definition
    } else if (sizes.bessMwh > 0 && sizes.bessMw > 0) {
      const dur = sizes.bessMwh / sizes.bessMw;
      if (dur < minDur - 1e-9 || dur > maxDur + 1e-9) ev.durationViolation = true;
    } else if (sizes.bessMwh > 0 !== sizes.bessMw > 0) ev.durationViolation = true;
    // tiny tie-breaker: when PCS is free, prefer the smaller inverter for equal cost
    ev.score = objectiveValue(ev, model.objective, model.dfrTarget) + (ev.durationViolation ? 50 : 0) + sizes.bessMw * 1e-7;
    evals += 1;
    cache.set(key, ev);
    if (cloud.length < 4000) cloud.push({ ...ev.sizes, dfr: ev.dfrCheck, lcoe: ev.lcoe, capexCr: ev.capexCr, feasible: ev.feasible && !ev.durationViolation });
    return ev;
  };

  // full 25-year financial model of one design: yearly dispatch with degradation and
  // augmentation, debt, tax, working capital, and the tariff that gives the target equity IRR.
  // Feasible = DFR met in every PPA year (exact, not an envelope).
  const tariffMode = model.objective === "tariff";
  const tcache = new Map();
  let tariffEvals = 0;
  let tariffMs = 0;
  const tariffAt = (input) => {
    const sizes = fixedDur ? { ...input, bessMwh: input.bessMw * fixedDur } : input;
    const key = VAR_KEYS.map((k) => sizes[k]).join("|");
    if (tcache.has(key)) return tcache.get(key);
    const ts = clock();
    const fm = runFinancialModel(ctx, sizes, { costs: model.costs, fin: model.fin, bess: model.bess, dfrTarget: model.dfrTarget, tariffLocked: false });
    tariffMs += clock() - ts;
    tariffEvals += 1;
    const dfrOf = (r) => (model.dfrBasis === "monthly" ? r.minMonthlyDfr : r.dfr);
    const worstYear = fm.rows.reduce((w, r) => (dfrOf(r) < dfrOf(w) ? r : w), fm.rows[0]);
    const minDfr = dfrOf(worstYear);
    const feasible = minDfr >= model.dfrTarget - 1e-6;
    const rec = {
      sizes: { ...sizes },
      tariff: fm.tariff,
      lcoe: fm.lcoe,
      capexCr: fm.capex.total,
      minDfr,
      worstYear: worstYear.year,
      augCapexCr: fm.totals.augCapex,
      feasible,
      score: (feasible ? fm.tariff : fm.tariff + 10 + (model.dfrTarget - minDfr) * 200) + sizes.bessMw * 1e-7,
      deliveredMwh: fm.rows.map((r) => r.deliveredMu * 1000),
      exportMwh: fm.rows.map((r) => r.excessMu * 1000),
    };
    tcache.set(key, rec);
    return rec;
  };

  const gridN = model.gridPoints || 11;
  const solarGrid = linspace(vars.solarMw, gridN);
  const windGrid = linspace(vars.windMw, gridN);
  const bessGrid = linspace(vars.bessMw, fixedDur ? 9 : 6);
  const total = solarGrid.length * windGrid.length * bessGrid.length;
  let done = 0;
  const simsPerEval = model.designCheck === "lifetime" ? 2 : 1;
  L("setup", `Objective: ${model.objective === "capex" ? "least capital cost" : model.objective === "tariff" ? "least 25-year tariff (screened by levelised cost, then full 25-year financial model on a shortlist)" : "least levelised cost of delivered energy"}; DFR ≥ ${(model.dfrTarget * 100).toFixed(1)}% (${model.dfrBasis === "monthly" ? "every month" : "annual"}); check: ${model.designCheck === "lifetime" ? "year 1 and the most degraded year" : "year 1 only"}`);
  for (const k of VAR_KEYS) {
    const v = vars[k];
    if (k === "bessMwh" && fixedDur) L("setup", `bessMwh: follows battery power × ${fixedDur} h (fixed discharge duration)`);
    else L("setup", `${k}: ${v.locked ? `locked at ${v.value}` : `searched ${v.min}–${v.max} step ${v.step}`}`);
  }
  L("setup", `Plant capacity ${ctx.plantMw} MW; demand ${(ctx.demand.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} MU; surplus ${ctx.sellSurplus ? `sold (extra export ${ctx.extraExportMw || 0} MW)` : "curtailed"}`);
  L("setup", `Grid: ${solarGrid.length} solar × ${windGrid.length} wind × ${bessGrid.length} battery-power points${fixedDur ? "" : ", battery MWh by bisection to the smallest feasible size"}; each design = ${simsPerEval} full 8,760-hour dispatch${simsPerEval > 1 ? "es" : ""}`);
  let gridBest = null;
  const seeds = [];
  const cellBests = [];
  if (onProgress) onProgress({ stage: "axes", solarGrid, windGrid, total });
  solarGrid.forEach((solarMw, si) => {
    windGrid.forEach((windMw, wi) => {
      let cellBest = null;
      for (const bessMw of bessGrid) {
        done += 1;
        let best;
        if (vars.bessMwh.locked) {
          best = evalAt({ solarMw, windMw, bessMw, bessMwh: vars.bessMwh.value });
        } else {
          let lo = Math.max(vars.bessMwh.min, bessMw > 0 ? bessMw * minDur : 0);
          let hi = Math.min(vars.bessMwh.max, bessMw > 0 ? bessMw * maxDur : 0);
          if (bessMw === 0) { lo = 0; hi = 0; }
          lo = snap(lo, vars.bessMwh);
          hi = snap(hi, vars.bessMwh);
          const top = evalAt({ solarMw, windMw, bessMw, bessMwh: hi });
          if (!top.feasible || hi <= lo) best = top;
          else {
            const bottom = evalAt({ solarMw, windMw, bessMw, bessMwh: lo });
            if (bottom.feasible) best = bottom;
            else {
              let a = lo;
              let b = hi;
              while (b - a > vars.bessMwh.step) {
                const mid = snap((a + b) / 2, vars.bessMwh);
                if (mid <= a || mid >= b) break;
                if (evalAt({ solarMw, windMw, bessMw, bessMwh: mid }).feasible) b = mid;
                else a = mid;
              }
              best = evalAt({ solarMw, windMw, bessMw, bessMwh: b });
            }
          }
        }
        seeds.push(best);
        if (!cellBest || best.score < cellBest.score) cellBest = best;
        if (onProgress && done % 25 === 0) onProgress({ stage: "grid", done, total, evals });
      }
      // one point of the cost surface: best storage for this solar x wind pair
      const okCell = Boolean(cellBest.feasible && !cellBest.durationViolation);
      cellBests.push({ si, wi, ev: cellBest, ok: okCell });
      const isNewBest = okCell && (!gridBest || cellBest.score < gridBest.score);
      if (isNewBest) gridBest = cellBest;
      L("grid", `${fmtSizes(cellBest.sizes)} → ${okCell ? `LCOE ₹${cellBest.lcoe.toFixed(3)}/kWh` : "misses DFR"} · DFR ${(cellBest.dfrCheck * 100).toFixed(2)}% · capex ₹${Math.round(cellBest.capexCr)} cr${isNewBest ? "  ← best so far" : ""}`, { sizes: cellBest.sizes, lcoe: cellBest.lcoe, dfr: cellBest.dfrCheck, feasible: okCell, evals });
      if (onProgress) {
        onProgress({
          stage: "cell",
          si,
          wi,
          lcoe: cellBest.lcoe,
          capexCr: cellBest.capexCr,
          feasible: Boolean(cellBest.feasible && !cellBest.durationViolation),
          dfr: cellBest.dfrCheck,
          sizes: cellBest.sizes,
        });
      }
    });
  });
  seeds.sort((a, b) => a.score - b.score);
  const starts = [];
  for (const s of seeds) {
    if (starts.length >= (model.starts || 6)) break;
    if (!starts.some((x) => VAR_KEYS.every((k) => Math.abs(x.sizes[k] - s.sizes[k]) < 1e-9))) starts.push(s);
  }
  L("grid", `Grid done: ${evals} designs evaluated, ${seeds.filter((x) => x.feasible && !x.durationViolation).length} of ${seeds.length} grid designs meet the DFR`, { evals });
  // hand the screening optimum to the caller: it starts the HiGHS LP now, in parallel
  let highsSeed = null;
  if (tariffMode && gridBest) {
    const r = tariffAt(gridBest.sizes);
    highsSeed = { sizes: r.sizes, tariff: r.tariff, deliveredMwh: r.deliveredMwh, exportMwh: r.exportMwh };
  }
  yield { stage: "screened", seed: highsSeed };

  // tariff map: the 25-year tariff of the cheapest design at every solar × wind point
  let tariffMap = null;
  if (tariffMode) {
    L("tariff", `Tariff map: full 25-year financial model for the best design at each of ${cellBests.length} solar × wind points (DFR required in every year)`);
    tariffMap = { solarGrid, windGrid, cells: [] };
    cellBests.forEach(({ si, wi, ev, ok }, i) => {
      const r = ok || ev.dfrCheck >= model.dfrTarget - 0.02 ? tariffAt(ev.sizes) : null;
      const cell = { si, wi, sizes: ev.sizes, tariff: r ? r.tariff : null, minDfr: r ? r.minDfr : ev.dfrCheck, worstYear: r ? r.worstYear : null, feasible: Boolean(r?.feasible) };
      tariffMap.cells.push(cell);
      if (r) L("tariff", `${fmtSizes(ev.sizes)} → ₹${r.tariff.toFixed(4)}/kWh · lowest yearly DFR ${(r.minDfr * 100).toFixed(2)}% (year ${r.worstYear})${r.feasible ? "" : " ✗ misses DFR"}`, { sizes: ev.sizes, tariff: r.tariff, dfr: r.minDfr, feasible: r.feasible });
      if (onProgress) onProgress({ stage: "tcell", ...cell, z: cell.tariff });
      if (onProgress && i % 8 === 0) onProgress({ stage: "tariffmap", done: i + 1, total: cellBests.length, evals });
    });
  }

  starts.forEach((st, i) => L("refine", `Start ${i + 1}: ${fmtSizes(st.sizes)} (LCOE ₹${st.lcoe.toFixed(3)}, DFR ${(st.dfrCheck * 100).toFixed(2)}%)`));
  const results = [];
  starts.forEach((start, si) => {
    let cur = start;
    const steps = {};
    for (const k of VAR_KEYS) {
      const spec = vars[k];
      steps[k] = spec.locked ? 0 : Math.max(spec.step, snap((spec.max - spec.min) / (gridN - 1) / 2, { ...spec, min: 0 }));
    }
    let guard = 0;
    while (guard < 400) {
      guard += 1;
      let improved = false;
      for (const k of VAR_KEYS) {
        if (!steps[k]) continue;
        for (const dir of [1, -1]) {
          const next = { ...cur.sizes, [k]: snap(cur.sizes[k] + dir * steps[k], vars[k]) };
          if (next[k] === cur.sizes[k]) continue;
          const ev = evalAt(next);
          if (ev.score < cur.score - 1e-9) {
            L("refine", `Start ${si + 1}: ${k} ${cur.sizes[k]} → ${next[k]} · LCOE ₹${cur.lcoe.toFixed(4)} → ₹${ev.lcoe.toFixed(4)} · DFR ${(ev.dfrCheck * 100).toFixed(2)}%${ev.feasible ? "" : " (infeasible)"}`, { evals });
            cur = ev;
            improved = true;
          }
        }
      }
      // coupled move: storage power and energy together (keeps duration)
      if (steps.bessMw && steps.bessMwh) {
        for (const dir of [1, -1]) {
          const next = { ...cur.sizes, bessMw: snap(cur.sizes.bessMw + dir * steps.bessMw, vars.bessMw), bessMwh: snap(cur.sizes.bessMwh + dir * steps.bessMwh * 4, vars.bessMwh) };
          const ev = evalAt(next);
          if (ev.score < cur.score - 1e-9) {
            L("refine", `Start ${si + 1}: battery MW+MWh together → ${Math.round(next.bessMw)} MW / ${Math.round(next.bessMwh)} MWh · LCOE ₹${ev.lcoe.toFixed(4)}`, { evals });
            cur = ev;
            improved = true;
          }
        }
      }
      if (!improved) {
        let any = false;
        for (const k of VAR_KEYS) {
          if (steps[k] > vars[k].step) {
            steps[k] = Math.max(vars[k].step, snap(steps[k] / 2, { ...vars[k], min: 0 }));
            any = true;
          }
        }
        if (!any) break;
        L("refine", `Start ${si + 1}: no improving move; halving steps → ${VAR_KEYS.filter((k) => steps[k]).map((k) => `${k} ${steps[k]}`).join(", ")}`);
      }
    }
    L("refine", `Start ${si + 1} converged: ${fmtSizes(cur.sizes)} · LCOE ₹${cur.lcoe.toFixed(4)} · DFR ${(cur.dfrCheck * 100).toFixed(2)}%`, { evals });
    results.push(cur);
    if (onProgress) onProgress({ stage: "refine", done: si + 1, total: starts.length, evals });
  });
  results.sort((a, b) => a.score - b.score);
  const ranked = [...cache.values()].filter((e) => e.feasible && !e.durationViolation).sort((a, b) => a.score - b.score);
  const alternatives = [];
  for (const e of ranked) {
    if (alternatives.length >= 8) break;
    // distinct plant mixes only (BESS power alone is a weak differentiator)
    const mix = (x) => [x.sizes.solarMw, x.sizes.windMw, x.sizes.bessMwh].join("|");
    if (!alternatives.some((x) => mix(x) === mix(e))) alternatives.push(e);
  }
  let best = results[0] || seeds[0];
  // neighbourhood check: exhaustively evaluate every design within ±3 double-steps of the
  // answer (7 × 7 × 7 around solar, wind and battery power), adopt anything cheaper and repeat
  // around the new answer until a round finds nothing better (max 4 rounds)
  for (let round = 1; round <= 4; round += 1) {
    const axes = VAR_KEYS.filter((k) => !vars[k].locked).map((k) => ({ k, stride: vars[k].step * 2 }));
    const combos = [];
    const walk = (i, cur) => {
      if (i === axes.length) { combos.push(cur); return; }
      for (let d = -3; d <= 3; d += 1) walk(i + 1, { ...cur, [axes[i].k]: snap(best.sizes[axes[i].k] + d * axes[i].stride, vars[axes[i].k]) });
    };
    walk(0, { ...best.sizes });
    const before = evals;
    let improvedBy = null;
    for (const c of combos) {
      const ev = evalAt(c);
      if (ev.feasible && !ev.durationViolation && ev.score < best.score - 1e-9) { improvedBy = ev; best = ev; }
    }
    const span = axes.map((a) => `${a.k} ±${a.stride * 3}`).join(", ");
    L("verify", improvedBy
      ? `Neighbourhood check ${round} (${combos.length} designs, ${span}; ${evals - before} new): found a cheaper feasible design and adopted it: ${fmtSizes(best.sizes)} · LCOE ₹${best.lcoe.toFixed(4)}`
      : `Neighbourhood check ${round} (${combos.length} designs, ${span}; ${evals - before} new): no cheaper feasible design; the answer is a local optimum ✓`, { evals });
    if (!improvedBy) break;
  }
  // ---- HiGHS: wait for the LP optimum (the caller resumes with it, or with nothing) ------
  const ext = yield { stage: "await-seeds" };
  let highs = null;
  if (ext?.log?.length) for (const line of ext.log) if (log.length < 4000) log.push(line);
  if (ext?.highs) highs = ext.highs;
  if (ext?.error) {
    highs = { ok: false, error: ext.error };
    L("highs", `HiGHS unavailable (${ext.error}); continuing with the search results only`);
  }

  // ---- stage 2: the 25-year tariff is the objective ------------------------------------
  let tariffRanked = null;
  if (tariffMode) {
    const tlog = (tag, r) => L("tariff", `${tag}${fmtSizes(r.sizes)} → 25-yr tariff ₹${r.tariff.toFixed(4)}/kWh · lowest yearly DFR ${(r.minDfr * 100).toFixed(2)}% (year ${r.worstYear})${r.feasible ? "" : " ✗ misses DFR"} · aug capex ₹${Math.round(r.augCapexCr)} cr`, { sizes: r.sizes, tariff: r.tariff, dfr: r.minDfr, feasible: r.feasible });
    // shortlist: refine results + best screening designs, including ones just below the target
    // (the screening envelope is conservative, the yearly check may accept them)
    const mixKey = (z) => VAR_KEYS.map((k) => z[k]).join("|");
    const highsDesigns = [];
    if (highs?.ok && highs.sizes) {
      const free = VAR_KEYS.filter((k) => !vars[k].locked);
      const combos = [{}];
      for (const k of free) {
        const st = vars[k].step || 1;
        const lo = snap(Math.floor(highs.sizes[k] / st) * st, vars[k]);
        const hi = snap(Math.ceil(highs.sizes[k] / st) * st, vars[k]);
        const next = [];
        for (const c of combos) for (const v of new Set([lo, hi])) next.push({ ...c, [k]: v });
        combos.splice(0, combos.length, ...next);
      }
      for (const c of combos) {
        const sizes = { ...Object.fromEntries(VAR_KEYS.map((k) => [k, vars[k].locked ? vars[k].value : highs.sizes[k]])), ...c };
        highsDesigns.push({ sizes });
      }
      const rs = (v) => (Number.isFinite(v) ? `₹${v.toFixed(4)}` : "n/a");
      L("highs", `HiGHS LP optimum ${fmtSizes(highs.sizes)} (linearised tariff ${rs(highs.tariff)}/kWh, proven lower bound ${rs(highs.lowerBound)}); pricing its ${highsDesigns.length} rounded neighbours with the exact 25-year model`);
    }
    const pool = [...highsDesigns, ...results, ...[...cache.values()].filter((e) => !e.durationViolation && e.dfrCheck >= model.dfrTarget - 0.02).sort((a, b) => a.score - b.score)];
    const shortlist = [];
    for (const e of pool) {
      if (shortlist.length >= 40) break;
      if (!shortlist.some((x) => mixKey(x.sizes) === mixKey(e.sizes))) shortlist.push(e);
    }
    L("tariff", `Solving the 25-year tariff (target equity IRR ${(model.fin.targetEquityIrr * 100).toFixed(1)}%) for ${shortlist.length} shortlisted designs; DFR must hold in every year`);
    let tbest = null;
    shortlist.forEach((e, i) => {
      const r = tariffAt(e.sizes);
      tlog(`#${i + 1}: `, r);
      if (!tbest || r.score < tbest.score) tbest = r;
      if (onProgress && i % 4 === 0) onProgress({ stage: "tariff", done: i + 1, total: shortlist.length, evals });
    });
    L("tariff", `Best of the shortlist: ${fmtSizes(tbest.sizes)} at ₹${tbest.tariff.toFixed(4)}/kWh`);
    // pattern search on the tariff itself
    const free = VAR_KEYS.filter((k) => !vars[k].locked);
    const steps = Object.fromEntries(free.map((k) => [k, vars[k].step * 4]));
    for (let guard = 0; guard < 200; guard += 1) {
      let moved = false;
      for (const k of free) {
        for (const dir of [1, -1]) {
          const next = { ...tbest.sizes, [k]: snap(tbest.sizes[k] + dir * steps[k], vars[k]) };
          if (next[k] === tbest.sizes[k]) continue;
          const r = tariffAt(next);
          if (r.score < tbest.score - 1e-9) {
            L("tariff", `Refine: ${k} ${tbest.sizes[k]} → ${next[k]} · tariff ₹${tbest.tariff.toFixed(4)} → ₹${r.tariff.toFixed(4)} · lowest yearly DFR ${(r.minDfr * 100).toFixed(2)}%`);
            tbest = r;
            moved = true;
          }
        }
      }
      if (onProgress && guard % 3 === 0) onProgress({ stage: "tariff", done: tariffEvals, total: tariffEvals + 20, evals });
      if (!moved) {
        let any = false;
        for (const k of free) if (steps[k] > vars[k].step) { steps[k] = Math.max(vars[k].step, steps[k] / 2); any = true; }
        if (!any) break;
      }
    }
    // neighbourhood check on the tariff
    for (let round = 1; round <= 3; round += 1) {
      const combos = [];
      const walk = (i, cur) => {
        if (i === free.length) { combos.push(cur); return; }
        for (let d = -2; d <= 2; d += 1) walk(i + 1, { ...cur, [free[i]]: snap(tbest.sizes[free[i]] + d * vars[free[i]].step * 2, vars[free[i]]) });
      };
      walk(0, { ...tbest.sizes });
      const before = tariffEvals;
      let better = null;
      for (const c of combos) {
        const r = tariffAt(c);
        if (r.score < tbest.score - 1e-9) { better = r; tbest = r; }
      }
      L("verify", better
        ? `Tariff neighbourhood check ${round} (${combos.length} designs, ±${free.map((k) => `${k} ${vars[k].step * 4}`).join(", ")}; ${tariffEvals - before} new): cheaper design adopted: ${fmtSizes(tbest.sizes)} at ₹${tbest.tariff.toFixed(4)}`
        : `Tariff neighbourhood check ${round} (${combos.length} designs; ${tariffEvals - before} new): no lower tariff nearby; the answer is a local optimum of the 25-year tariff ✓`);
      if (!better) break;
    }
    tariffRanked = [...tcache.values()].filter((r) => r.feasible).sort((a, b) => a.tariff - b.tariff);
    if (highs?.ok) {
      const onGrid = highsDesigns.map((d) => tariffAt(d.sizes)).sort((a, b) => a.score - b.score)[0];
      if (onGrid && Number.isFinite(highs.tariff)) L("highs", `Exact model at the rounded HiGHS design ${fmtSizes(onGrid.sizes)}: ₹${onGrid.tariff.toFixed(4)}/kWh (LP estimate ₹${highs.tariff.toFixed(4)}; difference ₹${(onGrid.tariff - highs.tariff).toFixed(4)} from rounding, tax-loss timing and interpolated years)`);
    }
    const finalEv = evalAt(tbest.sizes);
    best = { ...finalEv, tariff: tbest.tariff, minLifetimeDfr: tbest.minDfr, worstYear: tbest.worstYear, feasible: tbest.feasible, durationViolation: finalEv.durationViolation, score: tbest.score };
    L("result", `25-year tariff optimum: ${fmtSizes(best.sizes)} · ₹${tbest.tariff.toFixed(4)}/kWh for ${(model.fin.targetEquityIrr * 100).toFixed(1)}% equity IRR · lowest yearly DFR ${(tbest.minDfr * 100).toFixed(2)}% in year ${tbest.worstYear} · ${tariffEvals} full 25-year models in ${(tariffMs / 1000).toFixed(2)} s (${(tariffMs / Math.max(1, tariffEvals)).toFixed(1)} ms each)`, { sizes: best.sizes, tariff: tbest.tariff });
  }

  // independent re-check of the winner: fresh dispatch of year 1 (and the degraded envelope)
  const y1 = simulate(ctx, best.sizes);
  const worst = model.designCheck === "lifetime" ? simulate(ctx, best.sizes, model.worstFactors) : null;
  const ms = Date.now() - started;
  L("result", `Best: ${fmtSizes(best.sizes)} · ${best.tariff ? `25-yr tariff ₹${best.tariff.toFixed(4)}/kWh · ` : ""}LCOE ₹${best.lcoe.toFixed(4)}/kWh · capex ₹${Math.round(best.capexCr)} cr`, { sizes: best.sizes, lcoe: best.lcoe, dfr: best.dfrCheck });
  L("result", `Re-check: year-1 DFR ${(y1.dfr * 100).toFixed(3)}%${worst ? `, degraded-year DFR ${(worst.dfr * 100).toFixed(3)}%` : ""}, lowest month ${(y1.minMonthlyDfr * 100).toFixed(2)}% → ${best.feasible && !best.durationViolation ? "meets" : "does NOT meet"} the ${(model.dfrTarget * 100).toFixed(1)}% target`);
  L("result", `Work: ${evals} unique designs (${cacheHits} repeat look-ups served from cache), ${evals * simsPerEval} full-year dispatches = ${((evals * simsPerEval * HOURS) / 1e6).toFixed(1)} million simulated hours in ${(simMs / 1000).toFixed(2)} s (${((simMs / Math.max(1, evals * simsPerEval))).toFixed(2)} ms per dispatch); total ${(ms / 1000).toFixed(2)} s`);
  return {
    log: log.sort((a, b) => a.t - b.t), // HiGHS lines carry their own times
    stats: { evals, cacheHits, dispatches: evals * simsPerEval + tariffEvals * (model.fin.years || 25), simulatedHours: (evals * simsPerEval + tariffEvals * (model.fin.years || 25)) * HOURS, simMs: Math.round(simMs + tariffMs), ms, gridPoints: solarGrid.length * windGrid.length, starts: starts.length, tariffEvals, tariffMs: Math.round(tariffMs) },
    tariffRanked: tariffRanked ? tariffRanked.slice(0, 12).map(({ deliveredMwh, exportMwh, ...r }) => r) : null,
    tariffMap,
    highs,
    best,
    feasible: Boolean(best?.feasible && !best?.durationViolation),
    alternatives,
    cloud,
    evals,
    ms,
  };
}

/**
 * Run the optimizer to completion. `external` is what the caller would resume the
 * "await-seeds" step with ({ highs, log } from a HiGHS run, or { error }); null = search only.
 */
export function optimize(ctx, model, onProgress, external = null) {
  const it = optimizeSteps(ctx, model, onProgress);
  let r = it.next();
  while (!r.done) r = it.next(r.value.stage === "await-seeds" ? external : undefined);
  return r.value;
}

/** Request body for the engine's HiGHS sizing LP (/api/rtc/lp). */
export function highsPayload(ctx, model, seed) {
  const round = (arr, d) => Array.from(arr, (v) => Math.round(v * 10 ** d) / 10 ** d);
  const vars = {};
  for (const k of VAR_KEYS) {
    const v = model.vars[k];
    vars[k] = { locked: Boolean(v.locked), value: v.value, min: Math.min(v.min, v.max), max: Math.max(v.min, v.max), step: v.step };
  }
  return {
    ctx: {
      demand: round(ctx.demand, 4),
      solarCf: round(ctx.solarCf, 6),
      windCf: round(ctx.windCf, 6),
      plantMw: ctx.plantMw,
      lossPct: ctx.lossPct || 0,
      sellSurplus: Boolean(ctx.sellSurplus),
      extraExportMw: ctx.extraExportMw || 0,
    },
    bess: model.bess,
    costs: model.costs,
    fin: model.fin,
    dfrTarget: model.dfrTarget,
    dfrBasis: model.dfrBasis,
    vars,
    seed: seed || null,
    tariffGuess: seed?.tariff || null,
  };
}

// ---------------------------------------------------------------- 25-year financial model

export function irr(flows) {
  const npv = (r) => flows.reduce((s, cf, i) => s + cf / (1 + r) ** i, 0);
  let lo = -0.99;
  let hi = 1.5;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (!Number.isFinite(fLo) || fLo * fHi > 0) return NaN;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (fm * fLo > 0) { lo = mid; fLo = fm; } else hi = mid;
    if (hi - lo < 1e-9) break;
  }
  return (lo + hi) / 2;
}

export function npvAt(rate, flows) {
  return flows.reduce((s, cf, i) => s + cf / (1 + rate) ** i, 0);
}

/** Simulate every PPA year (degradation, augmentation, demand growth). */
export function simulateLifetime(ctx, sizes, fin, bess) {
  const years = fin.years || 25;
  const out = [];
  for (let y = 1; y <= years; y += 1) {
    const f = yearFactors(y, fin, bess);
    const r = simulate(ctx, sizes, f);
    out.push({ year: y, ...f, ...r, hourly: undefined });
  }
  return out;
}

function cashflows(ops, sizes, costs, fin, bess, dfrTarget, tariff) {
  const years = fin.years || 25;
  const capex = capexCr(sizes, costs);
  const debt0 = capex.total * fin.debtFraction;
  const equity0 = capex.total - debt0;
  const aug = augmentationScheduleCr(sizes, costs, bess, years);
  const tenor = Math.min(years, Math.max(1, Math.round(fin.tenorYears)));
  const annuity = debt0 * crf(fin.interestRate, tenor);
  const bookBase = capex.total * (1 - fin.salvagePct);
  let debt = debt0;
  let wdvBlock = capex.total;
  let lossCf = 0;
  let prevRecv = 0;
  let augBookDep = 0;
  const rows = [];
  const equityFlows = [-equity0];
  const projectFlows = [-capex.total];
  let cumEquity = -equity0;
  let payback = null;
  const omBase = omCr(sizes, fin);
  for (let y = 1; y <= years; y += 1) {
    const op = ops[y - 1];
    const trf = tariff * (1 + fin.tariffEscalation) ** (y - 1);
    const energyRev = op.deliveredMWh * trf * RS_CR_PER_MWH_AT_1RS;
    // op.surplusRevenueCr: surplus sold at hourly market prices (Tender to Bid, IEX); else a flat price
    const surplusRev = fin.sellSurplus ? (op.surplusRevenueCr ?? op.excessMWh * fin.surplusPrice * RS_CR_PER_MWH_AT_1RS) : 0;
    const shortfallMWh = Math.max(0, dfrTarget * op.demandMWh - op.deliveredMWh);
    const penalty = shortfallMWh * (fin.shortfallPenalty || 0) * RS_CR_PER_MWH_AT_1RS;
    const revenue = energyRev + surplusRev - penalty;
    const esc = (1 + fin.omEscalation) ** (y - 1);
    const om = omBase * esc;
    const insurance = capex.hard * fin.insurancePct;
    const other = (fin.otherFixedCr || 0) * esc;
    // biomass fuel (Tender to Bid): Rs/kWh of biomass generation, escalating; 0 for Round the clock
    const fuel = (op.biomassMWh || 0) * (fin.biomassFuelRsPerKwh || 0) * (1 + (fin.biomassFuelEscalation || 0)) ** (y - 1) * RS_CR_PER_MWH_AT_1RS;
    // dispatchable plants (Tender to Bid): fixed charge per MW and energy cost per kWh (RECs for
    // non-RE), each escalating at the plant's rate; none for Round the clock
    const plantCost = {};
    let plantsTotal = 0;
    for (const pl of costs.plants || []) {
      const esc = (1 + (pl.escalation || 0)) ** (y - 1);
      const fixed = ((sizes[`${pl.id}Mw`] || 0) * (pl.fixedLakhPerMw || 0)) / 100 * esc;
      const energy = (op[`${pl.id}MWh`] || 0) * ((pl.energyRsPerKwh || 0) + (pl.recRsPerKwh || 0)) * esc * RS_CR_PER_MWH_AT_1RS;
      plantCost[`${pl.id}Cost`] = fixed + energy;
      plantCost[`${pl.id}Mu`] = (op[`${pl.id}MWh`] || 0) / 1000;
      plantsTotal += fixed + energy;
    }
    const opex = om + insurance + other + fuel + plantsTotal;
    const ebitda = revenue - opex;
    // book depreciation (SLM), augmentation depreciated over remaining life
    if (aug[y] > 0) augBookDep += aug[y] / Math.max(1, years - y + 1);
    const bookDep = (y <= fin.bookLifeYears ? bookBase / fin.bookLifeYears : 0) + augBookDep;
    // debt
    const opening = debt;
    const interest = opening * fin.interestRate;
    let principal = 0;
    if (y <= tenor && opening > 1e-9) {
      principal = fin.repayment === "annuity" ? Math.min(opening, annuity - interest) : Math.min(opening, debt0 / tenor);
    }
    debt = opening - principal;
    // tax depreciation
    wdvBlock += aug[y];
    let taxDep;
    if (fin.taxDepreciation === "wdv") {
      taxDep = wdvBlock * fin.wdvRate;
      wdvBlock -= taxDep;
    } else {
      taxDep = bookDep;
    }
    const pbt = ebitda - bookDep - interest;
    let taxable = ebitda - interest - taxDep;
    if (taxable > 0 && lossCf > 0) {
      const use = Math.min(lossCf, taxable);
      taxable -= use;
      lossCf -= use;
    } else if (taxable < 0) {
      lossCf += -taxable;
      taxable = 0;
    }
    const tax = taxable * fin.taxRate;
    const pat = pbt - tax;
    const recv = (revenue * fin.receivableDays) / 365;
    const dWc = recv - prevRecv;
    prevRecv = recv;
    const cfads = ebitda - tax - dWc - aug[y];
    const debtService = interest + principal;
    const dscr = debtService > 1e-9 ? cfads / debtService : null;
    let fcfe = cfads - debtService;
    let projectCf = ebitda - Math.max(0, (ebitda - taxDep) * fin.taxRate) - dWc - aug[y];
    if (y === years) {
      const terminal = capex.total * fin.salvagePct + recv;
      fcfe += terminal - debt;
      projectCf += terminal;
    }
    equityFlows.push(fcfe);
    projectFlows.push(projectCf);
    cumEquity += fcfe;
    if (payback === null && cumEquity >= 0) payback = y;
    rows.push({
      year: y,
      tariff: trf,
      demandMu: op.demandMWh / 1000,
      deliveredMu: op.deliveredMWh / 1000,
      dfr: op.dfr,
      minMonthlyDfr: op.minMonthlyDfr,
      excessMu: op.excessMWh / 1000,
      curtailMu: op.curtailMWh / 1000,
      shortfallMu: shortfallMWh / 1000,
      solarFactor: op.solarFactor,
      bessFactor: op.bessFactor,
      energyRevenue: energyRev,
      surplusRevenue: surplusRev,
      penalty,
      revenue,
      om,
      insurance,
      other,
      fuel,
      biomassMu: (op.biomassMWh || 0) / 1000,
      ...plantCost,
      opex,
      ebitda,
      bookDep,
      interest,
      pbt,
      taxDep,
      tax,
      pat,
      receivables: recv,
      dWc,
      augCapex: aug[y],
      cfads,
      openingDebt: opening,
      principal,
      closingDebt: debt,
      debtService,
      dscr,
      fcfe,
      cumEquity,
      projectCf,
    });
  }
  return { rows, equityFlows, projectFlows, capex, debt0, equity0, payback };
}

export function runFinancialModel(ctx, sizes, { costs, fin, bess, dfrTarget, tariffLocked, ops: givenOps = null, solveBy = "irr" }) {
  // givenOps: year-by-year energy from another dispatch (the Tender to Bid HiGHS run)
  const ops = givenOps || simulateLifetime(ctx, sizes, fin, bess);
  const solveTariff = () => {
    let lo = 0.5;
    let hi = 30;
    for (let i = 0; i < 70; i += 1) {
      const mid = (lo + hi) / 2;
      const flows = cashflows(ops, sizes, costs, fin, bess, dfrTarget, mid).equityFlows;
      // solveBy "npv" (Tender to Bid): equity NPV at the target IRR, which stays defined when a
      // trial tariff gives an IRR beyond the IRR search range; "irr" is the Round-the-clock rule
      if (solveBy === "npv") {
        if (npvAt(fin.targetEquityIrr, flows) < 0) lo = mid;
        else hi = mid;
        continue;
      }
      const r = irr(flows);
      if (!Number.isFinite(r) || r < fin.targetEquityIrr) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const tariff = tariffLocked ? fin.tariff : solveTariff();
  const cf = cashflows(ops, sizes, costs, fin, bess, dfrTarget, tariff);
  const equityIrr = irr(cf.equityFlows);
  const projectIrr = irr(cf.projectFlows);
  const dscrs = cf.rows.map((r) => r.dscr).filter((v) => v !== null && Number.isFinite(v));
  const r = fin.discountRate;
  // levelised cost of delivered energy (pre-financing, pre-tax)
  let pvCost = cf.capex.total;
  let pvEnergy = 0;
  let pvTariffRev = 0;
  cf.rows.forEach((row) => {
    const df = (1 + r) ** row.year;
    pvCost += (row.opex + row.augCapex) / df;
    pvEnergy += row.deliveredMu * 1000 / df;
    pvTariffRev += (row.deliveredMu * 1000 * row.tariff) / df;
  });
  const lcoe = pvEnergy > 0 ? pvCost / (pvEnergy * RS_CR_PER_MWH_AT_1RS) : NaN;
  const levelisedTariff = pvEnergy > 0 ? pvTariffRev / pvEnergy : NaN;
  const sum = (k) => cf.rows.reduce((s, row) => s + row[k], 0);
  return {
    tariff,
    tariffLocked: Boolean(tariffLocked),
    levelisedTariff,
    lcoe,
    equityIrr,
    projectIrr,
    equityNpv: npvAt(fin.targetEquityIrr, cf.equityFlows),
    projectNpv: npvAt(r, cf.projectFlows),
    minDscr: dscrs.length ? Math.min(...dscrs) : null,
    avgDscr: dscrs.length ? dscrs.reduce((a, b) => a + b, 0) / dscrs.length : null,
    payback: cf.payback,
    capex: cf.capex,
    debt: cf.debt0,
    equity: cf.equity0,
    rows: cf.rows,
    equityFlows: cf.equityFlows,
    projectFlows: cf.projectFlows,
    totals: {
      deliveredMu: sum("deliveredMu"),
      revenue: sum("revenue"),
      ebitda: sum("ebitda"),
      pat: sum("pat"),
      tax: sum("tax"),
      augCapex: sum("augCapex"),
      penalty: sum("penalty"),
    },
    minLifetimeDfr: Math.min(...cf.rows.map((row) => row.dfr)),
  };
}

/**
 * How ageing moves the 25-year tariff: the same plant with no ageing, with solar and wind
 * degradation, and with battery fade + augmentation as configured.
 */
export function tariffAgeingBreakdown(ctx, sizes, { costs, fin, bess, dfrTarget }) {
  const run = (f, b) => runFinancialModel(ctx, sizes, { costs, fin: f, bess: b, dfrTarget, tariffLocked: false });
  const noAgeFin = { ...fin, solarDegradation: 0, windDegradation: 0 };
  const noAgeBess = { ...bess, annualDegradation: 0 };
  const ideal = run(noAgeFin, noAgeBess);
  const gen = run(fin, noAgeBess);
  const all = run(fin, bess);
  return {
    ideal: { tariff: ideal.tariff, minDfr: ideal.minLifetimeDfr, deliveredMu: ideal.totals.deliveredMu },
    gen: { tariff: gen.tariff, minDfr: gen.minLifetimeDfr, deliveredMu: gen.totals.deliveredMu },
    all: { tariff: all.tariff, minDfr: all.minLifetimeDfr, deliveredMu: all.totals.deliveredMu, augCapexCr: all.totals.augCapex, penaltyCr: all.totals.penalty },
    genImpact: gen.tariff - ideal.tariff,
    bessImpact: all.tariff - gen.tariff,
  };
}

export function buildContext({ demand, solarCf, windCf, plantMw, bess, lossPct = 0, sellSurplus = false, extraExportMw = 0 }) {
  return { demand, solarCf, windCf, plantMw, bess, lossPct, sellSurplus, extraExportMw };
}

export function buildModel({ inputs, costs, fin, bess, vars, objective = "tariff", gridPoints = 11 }) {
  const finWithGrowth = { ...fin, demandGrowth: inputs.demandGrowth || 0 };
  return {
    costs,
    fin: finWithGrowth,
    bess,
    vars,
    objective,
    gridPoints,
    dfrTarget: inputs.dfrTarget,
    dfrBasis: inputs.dfrBasis,
    designCheck: inputs.designCheck,
    worstFactors: worstYearFactors(finWithGrowth, bess),
  };
}
