// Tender to Bid: model state, the HiGHS sizing request and the financial-model inputs.
// The dispatch and sizing come from the engine's LP (fdre_rtc_lp.py, with biomass and the
// tender's supply rules); the 25-year financial model is the Round-the-clock one.
import * as E from "../rtc/engine.js";

export const BIOMASS_COLOR = "#c08552";
export const SOURCE_KEYS = ["solar", "wind", "biomass", "bess"];

export const DEFAULT_BIOMASS = {
  availability: 0.9, // highest hourly output, as a share of capacity
  maxPlf: 0.8, // fuel-limited yearly output, as a share of capacity × 8760
  minLoad: 0.3, // minimum stable load while the plant runs (it runs all year)
};

export const DEFAULT_RULES = [
  { id: "annual", label: "Annual supply", basis: "annual", hours: "all", target: 0.8, enabled: true },
  { id: "monthly", label: "Monthly supply", basis: "monthly", hours: "all", target: 0.7, enabled: false },
  { id: "peak", label: "Peak-hour supply", basis: "monthly", hours: "peak", target: 0.9, enabled: false },
];

/** Size ranges that scale with the contracted capacity. */
export function scaledVars(plantMw, prev = null) {
  const p = Math.max(1, plantMw);
  const step = p >= 1000 ? 10 : 5;
  const spec = (key, max, value) => {
    const old = prev?.[key];
    if (old?.locked) return { ...old };
    return { value, min: Math.min(old?.min ?? 0, max), max, step, locked: false };
  };
  return {
    solarMw: spec("solarMw", Math.round(p * 4), Math.round(p * 1.6)),
    windMw: spec("windMw", Math.round(p * 3), Math.round(p * 1.0)),
    bessMw: spec("bessMw", Math.round(p * 1.5), Math.round(p * 0.4)),
    bessMwh: spec("bessMwh", Math.round(p * 6), Math.round(p * 1.6)),
    biomassMw: spec("biomassMw", Math.round(p * 1), Math.round(p * 0.2)),
  };
}

export function defaultBidState() {
  const { site, ...inputs } = E.DEFAULT_RTC_INPUTS;
  const plantMw = 300;
  return {
    version: 1,
    step: "tender",
    tender: null, // { name, readAt, mode, tenderType, result }
    accepted: {}, // proposal id -> true/false chosen on the Requirements screen
    provenance: {}, // model input -> { label, path, page, quote, status }
    plantMw,
    peak: { start: 18, hours: 4 },
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
    sources: { solar: true, wind: true, biomass: true, bess: true },
    vars: scaledVars(plantMw),
    inputs: { solarCuf: inputs.solarCuf, windCuf: inputs.windCuf, solarDcAc: inputs.solarDcAc, lossPct: 0 },
    solarUpload: null,
    windUpload: null,
    solarMonthScale: new Array(12).fill(1),
    windMonthScale: new Array(12).fill(1),
    bess: { ...E.DEFAULT_BESS },
    biomass: { ...DEFAULT_BIOMASS },
    costs: { ...E.DEFAULT_COSTS, biomassCrPerMw: 7.0 },
    fin: { ...E.DEFAULT_FINANCE, biomassOmLakhPerMw: 35, biomassFuelRsPerKwh: 4.0, biomassFuelEscalation: 0.04 },
    tariffLocked: false,
    locks: {},
    site: { label: "Profiles: Beed, Maharashtra (change in Size)", constraint: null, places: [] },
    ceilingTariff: null,
    guarantees: { emdPerMwInr: null, pbgPerMwInr: null },
    // surplus sold on the exchange at hourly IEX prices (GDAM / DAM / RTM), or at a flat price
    market: { source: "GDAM", escalation: 0 },
    notes: [], // tender facts shown but not modelled
    lp: null, // last sizing (without the hourly dispatch)
  };
}

export function mergeBidState(saved) {
  const base = defaultBidState();
  if (!saved || saved.version !== 1) return base;
  const merged = { ...base, ...saved };
  for (const k of ["peak", "sources", "inputs", "bess", "biomass", "costs", "fin", "locks", "site", "guarantees", "accepted", "provenance", "market"]) {
    merged[k] = { ...base[k], ...(saved[k] || {}) };
  }
  merged.vars = Object.fromEntries(Object.keys(base.vars).map((k) => [k, { ...base.vars[k], ...(saved.vars?.[k] || {}) }]));
  merged.rules = Array.isArray(saved.rules) && saved.rules.length ? saved.rules : base.rules;
  if (!["tender", "requirements", "size", "finance"].includes(merged.step)) merged.step = "tender";
  return merged;
}

// ---------------------------------------------------------------- hours and profiles

export function peakHours(peak) {
  const n = Math.max(1, Math.min(24, Math.round(peak.hours || 0)));
  const start = ((Math.round(peak.start || 0) % 24) + 24) % 24;
  return Array.from({ length: n }, (_, k) => (start + k) % 24);
}

export function peakMask(peak) {
  const hours = new Set(peakHours(peak));
  const mask = new Uint8Array(E.HOURS);
  for (let t = 0; t < E.HOURS; t += 1) if (hours.has(E.HOUR_OF_DAY[t])) mask[t] = 1;
  return mask;
}

export function peakLabel(peak) {
  const hrs = peakHours(peak);
  const end = (hrs[hrs.length - 1] + 1) % 24;
  return `${String(hrs[0]).padStart(2, "0")}:00–${String(end).padStart(2, "0")}:00`;
}

export function resourceProfiles(state) {
  const { inputs } = state;
  const solarBase = state.solarUpload ? Float64Array.from(state.solarUpload.values) : E.synthSolarCf({ targetCuf: inputs.solarCuf, dcAc: inputs.solarDcAc });
  const windBase = state.windUpload ? Float64Array.from(state.windUpload.values) : E.synthWindCf({ targetCuf: inputs.windCuf });
  return {
    solarCf: E.applyMonthlyScale(solarBase, state.solarMonthScale),
    windCf: E.applyMonthlyScale(windBase, state.windMonthScale),
  };
}

export function activeRules(state) {
  return state.rules.filter((r) => r.enabled && r.target > 0);
}

// ---------------------------------------------------------------- IEX market prices

export const MARKET_URL = "/market/iex_hourly_prices.json";
export const MARKETS = ["GDAM", "DAM", "RTM"];
let pricesPromise = null;

/** The hourly IEX price year (Rs/MWh per market), fetched once per page load. */
export function loadMarketPrices() {
  if (!pricesPromise) {
    pricesPromise = fetch(MARKET_URL, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`market prices unavailable (${r.status})`);
        return r.json();
      })
      .catch((err) => {
        pricesPromise = null;
        throw err;
      });
  }
  return pricesPromise;
}

/** The chosen market's 8,760 hourly prices in Rs/kWh, or null for a flat price. */
export function marketSeries(state, prices) {
  const m = prices?.markets?.[state.market?.source];
  return m ? m.hourlyRsPerMwh.map((v) => v / 1000) : null;
}

export function marketLabel(state, prices) {
  const src = state.market?.source;
  if (!src || src === "flat") return `flat ₹${state.fin.surplusPrice}/kWh`;
  const m = prices?.markets?.[src];
  return m ? `IEX ${src} (avg ₹${(m.meanRsPerMwh / 1000).toFixed(2)}/kWh)` : `IEX ${src}`;
}

// ---------------------------------------------------------------- HiGHS request

const round = (arr, d) => Array.from(arr, (v) => Math.round(v * 10 ** d) / 10 ** d);

export function lpPayload(state, { solarCf, windCf }, prices = null) {
  const { sources, vars, bess } = state;
  const off = { locked: true, value: 0 };
  const spec = (k) => {
    const v = vars[k];
    return { locked: Boolean(v.locked), value: v.value, min: Math.min(v.min, v.max), max: Math.max(v.min, v.max), step: v.step };
  };
  const rules = activeRules(state);
  const payload = {
    ctx: {
      demand: new Array(E.HOURS).fill(state.plantMw), // round-the-clock supply at the contracted capacity
      solarCf: round(solarCf, 6),
      windCf: round(windCf, 6),
      plantMw: state.plantMw,
      lossPct: state.inputs.lossPct || 0,
      sellSurplus: Boolean(state.fin.sellSurplus),
      extraExportMw: state.fin.extraExportMw || 0,
    },
    bess: { ...bess },
    costs: { ...state.costs },
    fin: { ...state.fin, demandGrowth: 0 },
    dfrTarget: rules.find((r) => r.hours === "all")?.target ?? 0,
    dfrBasis: "annual",
    vars: {
      solarMw: sources.solar ? spec("solarMw") : off,
      windMw: sources.wind ? spec("windMw") : off,
      bessMw: sources.bess ? spec("bessMw") : off,
      bessMwh: sources.bess ? spec("bessMwh") : off,
    },
    compliance: rules.map(({ id, label, basis, hours, target }) => ({ id, label, basis, hours, target })),
    returnLifetime: true,
    returnHourly: true,
    tariffGuess: state.lp?.tariff || 5.5,
  };
  if (sources.biomass) {
    payload.vars.biomassMw = spec("biomassMw");
    payload.biomass = { ...state.biomass };
  }
  const series = state.fin.sellSurplus ? marketSeries(state, prices) : null;
  if (series) {
    payload.ctx.surplusPrice = series.map((v) => Math.round(v * 1000) / 1000);
    payload.fin.surplusEscalation = state.market.escalation || 0;
  }
  if (rules.some((r) => r.hours === "peak")) payload.peakMask = Array.from(peakMask(state.peak));
  return payload;
}

/** POST the request and read the NDJSON stream (log lines, progress, result). */
export async function runSizing(payload, { onLog, onProgress, signal } = {}) {
  const res = await fetch("/api/rtc/lp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `engine returned ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error || j.detail || msg;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      const ev = JSON.parse(raw);
      if (ev.type === "log") onLog?.(ev);
      else if (ev.type === "progress") onProgress?.(ev);
      else if (ev.type === "result") result = ev.result;
      else if (ev.type === "error") throw new Error(ev.error);
    }
  }
  if (!result) throw new Error("The engine closed the connection before the sizing finished.");
  return result;
}

// ---------------------------------------------------------------- results

/** Year-by-year operations for runFinancialModel, from the LP's lifetime energy. */
export function opsFromLp(lp, fin, bess) {
  const years = fin.years || 25;
  const life = lp.lifetime || [];
  const reps = [...(lp.perYear || [])].sort((a, b) => a.year - b.year);
  const repFor = (y) => reps.filter((r) => r.year <= y).pop() || reps[0] || {};
  return Array.from({ length: years }, (_, i) => {
    const y = i + 1;
    const row = life[Math.min(i, life.length - 1)] || {};
    const f = E.yearFactors(y, fin, bess);
    const demandMWh = row.demandMwh || 0;
    const deliveredMWh = row.deliveredMwh || 0;
    return {
      year: y,
      ...f,
      demandMWh,
      deliveredMWh,
      dfr: demandMWh > 0 ? deliveredMWh / demandMWh : 1,
      minMonthlyDfr: repFor(y).minMonthlyDfr ?? NaN,
      excessMWh: row.exportMwh || 0,
      curtailMWh: NaN,
      biomassMWh: row.biomassMwh || 0,
      // surplus sale revenue at the hourly market price, when the sizing used one
      ...(lp.market && row.exportRevenueCr !== undefined ? { surplusRevenueCr: row.exportRevenueCr } : {}),
    };
  });
}

/** Where year-1 energy came from: direct delivery split by each hour's generation shares. */
export function energyMix(hourly) {
  const out = { solar: 0, wind: 0, biomass: 0, battery: 0, export: 0, curtail: 0, unmet: 0, demand: 0, peakDelivered: 0, exportRevenueCr: 0 };
  if (!hourly) return out;
  for (let t = 0; t < hourly.direct.length; t += 1) {
    const s = hourly.solar[t];
    const w = hourly.wind[t];
    const b = hourly.biomass[t];
    const g = s + w + b;
    const d = hourly.direct[t];
    if (g > 0) {
      out.solar += (d * s) / g;
      out.wind += (d * w) / g;
      out.biomass += (d * b) / g;
    }
    out.battery += hourly.discharge[t];
    out.export += hourly.export[t];
    if (hourly.price) out.exportRevenueCr += hourly.export[t] * hourly.price[t] * 1e-4;
    out.curtail += hourly.curtail[t];
    out.demand += hourly.demand[t];
    out.unmet += Math.max(0, hourly.demand[t] - d - hourly.discharge[t]);
  }
  return out;
}

export function capexBySource(sizes, costs) {
  const pre = 1 + (costs.preopPct || 0);
  return {
    solar: (sizes.solarMw || 0) * costs.solarCrPerMw * pre,
    wind: (sizes.windMw || 0) * costs.windCrPerMw * pre,
    biomass: (sizes.biomassMw || 0) * (costs.biomassCrPerMw || 0) * pre,
    bess: ((sizes.bessMwh || 0) * costs.bessCrPerMwh + (sizes.bessMw || 0) * (costs.bessPcsCrPerMw || 0)) * pre,
  };
}
