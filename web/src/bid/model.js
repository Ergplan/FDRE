// Tender to Bid: model state, the inputs the bidder must give, the HiGHS sizing request and the
// financial-model inputs. Every constraint comes from the tender (see tenderMap.js: tenderTerms);
// every plant parameter and cost comes from the bidder. Nothing is filled in for the bidder:
// sizing is refused until each source switched on has all of its inputs.
import * as E from "../rtc/engine.js";

export const BIOMASS_COLOR = "#c08552";
export const HYDRO_COLOR = "#3fa7d6";
export const THERMAL_COLOR = "#8d8d99";

/** The supply sources a bidder can bring, in display order. green: counts as renewable. */
export const SOURCES = [
  { id: "solar", title: "Solar", green: true },
  { id: "wind", title: "Wind", green: true },
  { id: "hydro", title: "Hydro", green: true },
  { id: "biomass", title: "Biomass", green: true },
  { id: "thermal", title: "Thermal (non-RE)", green: false },
  { id: "bess", title: "Battery storage", green: null },
];
export const SOURCE_IDS = SOURCES.map((s) => s.id);

const pct = true;
/**
 * The inputs each source needs. key: field in state.src[id]; pct: entered in %, stored as a
 * fraction; options: a choice; optional: may stay empty. Capacity (fixed MW, or the most the
 * optimizer may build) is asked for every source separately.
 */
export const SOURCE_FIELDS = {
  solar: [
    { key: "cuf", label: "CUF (AC)", unit: "%", pct, min: 5, max: 45, step: 0.1, group: "Operation", hint: "Annual energy ÷ (AC MW × 8,760 h)" },
    { key: "dcAc", label: "DC:AC ratio", unit: "×", min: 1, max: 2.5, step: 0.05, group: "Operation", hint: "Shapes the hourly profile (clipping)", profileOnly: true },
    { key: "degradation", label: "Annual degradation", unit: "%/yr", pct, min: 0, max: 3, step: 0.05, group: "Operation" },
    { key: "capex", label: "Capex", unit: "₹ cr/MW", min: 0, step: 0.05, group: "Cost" },
    { key: "om", label: "O&M", unit: "₹ lakh/MW/yr", min: 0, step: 0.1, group: "Cost" },
  ],
  wind: [
    { key: "cuf", label: "CUF", unit: "%", pct, min: 10, max: 60, step: 0.1, group: "Operation" },
    { key: "capex", label: "Capex", unit: "₹ cr/MW", min: 0, step: 0.05, group: "Cost" },
    { key: "om", label: "O&M", unit: "₹ lakh/MW/yr", min: 0, step: 0.1, group: "Cost" },
  ],
  hydro: [
    { key: "cuf", label: "Annual CUF", unit: "%", pct, min: 1, max: 100, step: 0.5, group: "Operation", hint: "Energy available over the year" },
    { key: "availability", label: "Availability", unit: "%", pct, min: 1, max: 100, step: 1, group: "Operation", hint: "Highest hourly output" },
    { key: "capex", label: "Capex", unit: "₹ cr/MW", min: 0, step: 0.1, group: "Cost", hint: "0 when the power is bought under contract" },
    { key: "fixed", label: "Fixed cost / capacity charge", unit: "₹ lakh/MW/yr", min: 0, step: 1, group: "Cost" },
    { key: "energy", label: "Energy cost", unit: "₹/kWh", min: 0, step: 0.05, group: "Cost" },
    { key: "escalation", label: "Cost escalation", unit: "%/yr", pct, min: 0, max: 15, step: 0.25, group: "Cost" },
  ],
  biomass: [
    { key: "availability", label: "Availability", unit: "%", pct, min: 1, max: 100, step: 1, group: "Operation", hint: "Highest hourly output" },
    { key: "cuf", label: "CUF (fuel-limited)", unit: "%", pct, min: 1, max: 100, step: 1, group: "Operation", hint: "Most energy per year" },
    { key: "minLoad", label: "Minimum stable load", unit: "%", pct, min: 0, max: 100, step: 5, group: "Operation", hint: "The plant runs all year at least this much" },
    { key: "capex", label: "Capex", unit: "₹ cr/MW", min: 0, step: 0.1, group: "Cost" },
    { key: "om", label: "O&M", unit: "₹ lakh/MW/yr", min: 0, step: 1, group: "Cost" },
    { key: "fuel", label: "Fuel cost", unit: "₹/kWh", min: 0, step: 0.05, group: "Cost", hint: "per kWh generated" },
    { key: "fuelEscalation", label: "Fuel escalation", unit: "%/yr", pct, min: 0, max: 15, step: 0.25, group: "Cost" },
  ],
  thermal: [
    { key: "availability", label: "Availability", unit: "%", pct, min: 1, max: 100, step: 1, group: "Operation", hint: "Highest hourly output" },
    { key: "cuf", label: "Maximum CUF", unit: "%", pct, min: 1, max: 100, step: 1, group: "Operation", hint: "Most energy per year" },
    { key: "minLoad", label: "Technical minimum", unit: "%", pct, min: 0, max: 100, step: 5, group: "Operation", hint: "Lowest output while scheduled (0 if fully flexible)" },
    { key: "capex", label: "Capex", unit: "₹ cr/MW", min: 0, step: 0.1, group: "Cost", hint: "0 when the power is bought under contract" },
    { key: "fixed", label: "Fixed / capacity charge", unit: "₹ lakh/MW/yr", min: 0, step: 1, group: "Cost" },
    { key: "energy", label: "Energy (variable) charge", unit: "₹/kWh", min: 0, step: 0.05, group: "Cost" },
    { key: "rec", label: "REC cost", unit: "₹/kWh", min: 0, step: 0.01, group: "Cost", hint: "RECs for every non-RE kWh, so supply stays 100% green" },
    { key: "escalation", label: "Cost escalation", unit: "%/yr", pct, min: 0, max: 15, step: 0.25, group: "Cost" },
  ],
  bess: [
    { key: "duration", label: "Discharge duration", options: [["4", "4 hours"], ["2", "2 hours"], ["free", "Optimizer chooses (1–8 h)"]], group: "Operation" },
    { key: "rte", label: "Round-trip efficiency", unit: "%", pct, min: 50, max: 100, step: 0.5, group: "Operation" },
    { key: "minSoc", label: "Minimum state of charge", unit: "%", pct, min: 0, max: 50, step: 1, group: "Operation" },
    { key: "maxSoc", label: "Maximum state of charge", unit: "%", pct, min: 50, max: 100, step: 1, group: "Operation" },
    { key: "degradation", label: "Capacity fade", unit: "%/yr", pct, min: 0, max: 10, step: 0.25, group: "Operation" },
    { key: "augmentation", label: "Augmentation", options: [["annual", "Every year"], ["none", "None"]], group: "Operation" },
    { key: "capex", label: "Capex", unit: "₹ cr/MWh", min: 0, step: 0.05, group: "Cost" },
    { key: "om", label: "O&M", unit: "₹ lakh/MWh/yr", min: 0, step: 0.1, group: "Cost" },
  ],
};

/** Financing and project costs the bidder must give before sizing (they set the tariff). */
export const FINANCE_FIELDS = [
  { section: "fin", key: "targetEquityIrr", label: "Target equity IRR", unit: "%", pct, min: 0, max: 40, step: 0.25 },
  { section: "fin", key: "debtFraction", label: "Debt share", unit: "%", pct, min: 0, max: 95, step: 1 },
  { section: "fin", key: "interestRate", label: "Interest rate", unit: "%", pct, min: 0, max: 25, step: 0.05 },
  { section: "fin", key: "tenorYears", label: "Loan tenor", unit: "years", min: 1, max: 25, step: 1 },
  { section: "fin", key: "taxRate", label: "Corporate tax", unit: "%", pct, min: 0, max: 50, step: 0.01 },
  { section: "fin", key: "omEscalation", label: "O&M escalation", unit: "%/yr", pct, min: 0, max: 15, step: 0.25 },
  { section: "fin", key: "insurancePct", label: "Insurance", unit: "% of hard cost/yr", pct, min: 0, max: 3, step: 0.05 },
  { section: "fin", key: "tariffEscalation", label: "Tariff escalation", unit: "%/yr", pct, min: 0, max: 10, step: 0.1, hint: "0 for a fixed tariff" },
  { section: "costs", key: "preopPct", label: "Pre-operative & IDC", unit: "% of hard cost", pct, min: 0, max: 30, step: 0.5 },
  { section: "costs", key: "evacuationCr", label: "Transmission / evacuation", unit: "₹ cr", min: 0, step: 5, hint: "Lump sum" },
];

const blankSource = (id) => ({
  capacity: { mode: null, mw: null }, // mode "fixed": exactly mw; "optimise": 0 to mw
  ...Object.fromEntries(SOURCE_FIELDS[id].map((f) => [f.key, null])),
  ...(id === "hydro" ? { monthlyCuf: null } : {}),
});

const FIN_REQUIRED = Object.fromEntries(FINANCE_FIELDS.filter((f) => f.section === "fin").map((f) => [f.key, null]));

export function defaultBidState() {
  return {
    version: 2,
    step: "tender",
    tender: null, // { name, mode, seedKey, result }
    accepted: {}, // tender proposal id -> true/false (a value the page does not prove is used only when ticked)
    bid: { baseMw: null, greenshoe: null }, // the bidder's answers on the Bid capacity step
    sources: Object.fromEntries(SOURCE_IDS.map((id) => [id, false])),
    src: Object.fromEntries(SOURCE_IDS.map((id) => [id, blankSource(id)])),
    solarUpload: null,
    windUpload: null,
    solarMonthScale: new Array(12).fill(1),
    windMonthScale: new Array(12).fill(1),
    // financing: the terms asked for before sizing are empty; the rest are shown and editable on Financials
    fin: { ...E.DEFAULT_FINANCE, ...FIN_REQUIRED, sellSurplus: false },
    costs: { preopPct: null, evacuationCr: null },
    // sale of what the tender lets the supplier sell (asked only when it allows a sale)
    market: { sell: null, source: "GDAM", escalation: 0, flatPrice: null },
    tariffLocked: false,
    locks: {},
    lp: null, // last sizing (without the hourly dispatch)
  };
}

export function mergeBidState(saved) {
  const base = defaultBidState();
  if (!saved || saved.version !== 2) return base;
  const merged = { ...base, ...saved };
  for (const k of ["bid", "sources", "fin", "costs", "market", "locks", "accepted"]) merged[k] = { ...base[k], ...(saved[k] || {}) };
  merged.src = Object.fromEntries(SOURCE_IDS.map((id) => [id, { ...base.src[id], ...(saved.src?.[id] || {}), capacity: { ...base.src[id].capacity, ...(saved.src?.[id]?.capacity || {}) } }]));
  if (!STEP_IDS.includes(merged.step)) merged.step = "tender";
  return merged;
}

export const STEP_IDS = ["tender", "capacity", "sources", "size", "finance"];

// ---------------------------------------------------------------- what is missing

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** The contracted capacity to size for: the bid plus the greenshoe when the bidder plans for it. */
export function plantMw(state, terms) {
  const base = state.bid.baseMw;
  if (!isNum(base) || base <= 0) return null;
  return base + (state.bid.greenshoe && isNum(terms?.greenshoeMw) ? terms.greenshoeMw : 0);
}

/** Problems with the bid capacity: missing answers, or a capacity the tender does not allow. */
export function capacityIssues(state, terms) {
  const out = [];
  if (!isNum(state.bid.baseMw) || state.bid.baseMw <= 0) out.push("Enter the capacity you bid");
  if (isNum(terms?.greenshoeMw) && state.bid.greenshoe === null) out.push("Say whether to plan for the greenshoe capacity");
  if (isNum(state.bid.baseMw) && isNum(terms?.baseMw) && terms.partAllowed === false && state.bid.baseMw !== terms.baseMw) {
    out.push(`The tender allows no part capacity: the bid must be ${terms.baseMw} MW`);
  }
  if (isNum(state.bid.baseMw) && isNum(terms?.baseMw) && state.bid.baseMw > terms.baseMw) out.push(`The bid is above the tender's ${terms.baseMw} MW`);
  return out;
}

/** The smallest solar the tender requires (MW), or null. */
export function solarMinMw(state, terms) {
  const p = plantMw(state, terms);
  return isNum(terms?.solarMultiple) && p ? Math.round(terms.solarMultiple * p) : null;
}

/** Missing or invalid inputs of one source, as messages. */
export function sourceIssues(state, id, terms) {
  const s = state.src[id];
  const out = [];
  const title = SOURCES.find((x) => x.id === id).title;
  if (!s.capacity.mode) out.push(`${title}: choose fixed capacity or let the optimizer size it`);
  else if (!isNum(s.capacity.mw) || s.capacity.mw <= 0) out.push(`${title}: enter the ${s.capacity.mode === "fixed" ? "capacity" : "largest capacity the optimizer may build"}`);
  for (const f of SOURCE_FIELDS[id]) {
    if (f.profileOnly && (id === "solar" ? state.solarUpload : state.windUpload)) continue;
    const v = s[f.key];
    if (f.options ? !v : !isNum(v)) out.push(`${title}: ${f.label.toLowerCase()}`);
  }
  if (id === "solar") {
    const min = solarMinMw(state, terms);
    if (min && isNum(s.capacity.mw) && s.capacity.mw < min) out.push(`Solar: the tender requires at least ${min} MW (${terms.solarMultiple} × contracted capacity)`);
  }
  if (["biomass", "thermal"].includes(id) && isNum(s.minLoad) && isNum(s.availability) && s.minLoad > s.availability) out.push(`${title}: minimum load above availability`);
  if (id === "bess" && isNum(s.minSoc) && isNum(s.maxSoc) && s.minSoc >= s.maxSoc) out.push("Battery: minimum state of charge must be below the maximum");
  return out;
}

/** Everything that stops the sizing, as messages (empty when it can run). */
export function missingInputs(state, terms) {
  const out = [...capacityIssues(state, terms)];
  const on = SOURCE_IDS.filter((id) => state.sources[id]);
  if (!on.some((id) => id !== "bess")) out.push("Switch on at least one generating source");
  for (const id of SOURCE_IDS) {
    if (terms?.mandatory?.[id] && !state.sources[id]) out.push(`${SOURCES.find((x) => x.id === id).title} is required by the tender`);
  }
  for (const id of on) out.push(...sourceIssues(state, id, terms));
  for (const f of FINANCE_FIELDS) if (!isNum(state[f.section][f.key])) out.push(`Financing: ${f.label.toLowerCase()}`);
  if (terms?.sale && terms.sale !== "not_allowed" && state.market.sell === null) out.push("Say whether to sell in the market what the tender allows");
  if (state.market.sell && state.market.source === "flat" && !isNum(state.market.flatPrice)) out.push("Market: enter the flat sale price");
  if (!terms?.rules?.length) out.push("The tender sets no supply floor to size for");
  return out;
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

/** Hours of the day a peak floor measured over "any" hours applies to: the tender's windows, or all. */
export function anyHours(peak) {
  const windows = peak?.windows || [];
  if (!windows.length) return Array.from({ length: 24 }, (_, h) => h);
  const out = new Set();
  for (const w of windows) {
    const a = Number(String(w.start).slice(0, 2));
    const b = Number(String(w.end).slice(0, 2));
    for (let h = a; h !== b; h = (h + 1) % 24) out.add(h);
  }
  return [...out].sort((x, y) => x - y);
}

export function anyMask(peak) {
  const hours = new Set(anyHours(peak));
  const mask = new Uint8Array(E.HOURS);
  for (let t = 0; t < E.HOURS; t += 1) if (hours.has(E.HOUR_OF_DAY[t])) mask[t] = 1;
  return mask;
}

export function peakLabel(peak) {
  const hrs = peakHours(peak);
  const end = (hrs[hrs.length - 1] + 1) % 24;
  return `${String(hrs[0]).padStart(2, "0")}:00–${String(end).padStart(2, "0")}:00`;
}

/** A capacity-factor series scaled so its mean is the bidder's CUF (no hour above 1). */
export function scaleToCuf(cf, cuf) {
  let out = Float64Array.from(cf);
  for (let k = 0; k < 60; k += 1) {
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    if (mean <= 0) break;
    const f = cuf / mean;
    if (Math.abs(f - 1) < 1e-9) break;
    out = out.map((v) => Math.min(1, v * f));
  }
  return out;
}

/** Hourly solar and wind capacity factors: the chosen profile's shape at the bidder's CUF. */
export function resourceProfiles(state) {
  const { solar, wind } = state.src;
  const flat = () => new Float64Array(E.HOURS);
  const solarShape = state.solarUpload ? Float64Array.from(state.solarUpload.values) : (isNum(solar.cuf) ? E.synthSolarCf({ targetCuf: solar.cuf, dcAc: solar.dcAc || 1 }) : flat());
  const windShape = state.windUpload ? Float64Array.from(state.windUpload.values) : (isNum(wind.cuf) ? E.synthWindCf({ targetCuf: wind.cuf }) : flat());
  return {
    solarCf: isNum(solar.cuf) ? scaleToCuf(E.applyMonthlyScale(solarShape, state.solarMonthScale), solar.cuf) : flat(),
    windCf: isNum(wind.cuf) ? scaleToCuf(E.applyMonthlyScale(windShape, state.windMonthScale), wind.cuf) : flat(),
  };
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
  if (!src || src === "flat") return `flat ₹${state.market.flatPrice}/kWh`;
  const m = prices?.markets?.[src];
  return m ? `IEX ${src} (avg ₹${(m.meanRsPerMwh / 1000).toFixed(2)}/kWh)` : `IEX ${src}`;
}

// ---------------------------------------------------------------- model inputs

const SIZE_KEY = { solar: "solarMw", wind: "windMw", hydro: "hydroMw", biomass: "biomassMw", thermal: "thermalMw", bess: "bessMw" };

/** The bidder's inputs in the engine's terms: costs, finance, battery, biomass, plants and size ranges. */
export function modelInputs(state, terms) {
  const { src, sources } = state;
  const on = (id) => Boolean(sources[id]);
  const s = src;
  const costs = {
    solarCrPerMw: on("solar") ? s.solar.capex : 0,
    windCrPerMw: on("wind") ? s.wind.capex : 0,
    bessCrPerMwh: on("bess") ? s.bess.capex : 0,
    bessPcsCrPerMw: 0,
    biomassCrPerMw: on("biomass") ? s.biomass.capex : 0,
    evacuationCr: state.costs.evacuationCr || 0,
    preopPct: state.costs.preopPct || 0,
    plants: ["hydro", "thermal"].filter(on).map((id) => ({
      id,
      capexCrPerMw: s[id].capex,
      fixedLakhPerMw: s[id].fixed,
      energyRsPerKwh: s[id].energy,
      recRsPerKwh: id === "thermal" ? s.thermal.rec : 0,
      escalation: s[id].escalation,
    })),
  };
  const selling = Boolean(state.market?.sell) && Boolean(terms?.sale) && terms.sale !== "not_allowed";
  const fin = {
    ...state.fin,
    years: terms?.years || state.fin.years,
    sellSurplus: selling,
    surplusPrice: selling && state.market.source === "flat" ? state.market.flatPrice || 0 : 0,
    solarOmLakhPerMw: on("solar") ? s.solar.om : 0,
    windOmLakhPerMw: on("wind") ? s.wind.om : 0,
    bessOmLakhPerMwh: on("bess") ? s.bess.om : 0,
    biomassOmLakhPerMw: on("biomass") ? s.biomass.om : 0,
    biomassFuelRsPerKwh: on("biomass") ? s.biomass.fuel : 0,
    biomassFuelEscalation: on("biomass") ? s.biomass.fuelEscalation : 0,
    solarDegradation: on("solar") ? s.solar.degradation : 0,
    windDegradation: 0,
  };
  const duration = s.bess.duration === "free" ? null : Number(s.bess.duration) || null;
  const bess = {
    ...E.DEFAULT_BESS,
    rte: s.bess.rte ?? E.DEFAULT_BESS.rte,
    minSoc: s.bess.minSoc ?? 0,
    maxSoc: s.bess.maxSoc ?? 1,
    initSoc: Math.min(s.bess.maxSoc ?? 1, Math.max(s.bess.minSoc ?? 0, 0.5)),
    annualDegradation: on("bess") ? s.bess.degradation || 0 : 0,
    augmentation: s.bess.augmentation || "none",
    costDeclinePct: 0,
    durationH: duration,
  };
  const p = plantMw(state, terms) || 1;
  const range = (id) => {
    const c = s[id].capacity;
    if (!on(id) || !isNum(c.mw)) return { locked: true, value: 0 };
    let min = 0;
    if (id === "solar") min = Math.min(c.mw, solarMinMw(state, terms) || 0);
    return c.mode === "fixed" ? { locked: true, value: c.mw } : { locked: false, value: c.mw, min, max: c.mw };
  };
  const vars = {
    solarMw: range("solar"),
    windMw: range("wind"),
    bessMw: range("bess"),
    bessMwh: on("bess") && isNum(s.bess.capacity.mw)
      ? (s.bess.capacity.mode === "fixed" && duration ? { locked: true, value: s.bess.capacity.mw * duration } : { locked: false, value: 0, min: 0, max: s.bess.capacity.mw * (duration || 8) })
      : { locked: true, value: 0 },
  };
  if (on("biomass")) vars.biomassMw = range("biomass");
  for (const id of ["hydro", "thermal"]) if (on(id)) vars[`${id}Mw`] = range(id);
  const biomass = on("biomass") ? { availability: s.biomass.availability, maxPlf: s.biomass.cuf, minLoad: s.biomass.minLoad || 0 } : null;
  const plants = ["hydro", "thermal"].filter(on).map((id) => ({
    id,
    green: id === "hydro",
    availability: s[id].availability,
    minLoad: id === "thermal" ? s.thermal.minLoad || 0 : 0,
    cuf: s[id].cuf,
    ...(id === "hydro" && Array.isArray(s.hydro.monthlyCuf) && s.hydro.monthlyCuf.every(isNum) ? { cuf: null, monthlyCuf: s.hydro.monthlyCuf } : {}),
    capexCrPerMw: s[id].capex,
    fixedLakhPerMw: s[id].fixed,
    energyRsPerKwh: s[id].energy,
    recRsPerKwh: id === "thermal" ? s.thermal.rec : 0,
    escalation: s[id].escalation,
  }));
  return { costs, fin, bess, vars, biomass, plants, plantMw: p };
}

// ---------------------------------------------------------------- HiGHS request

const round = (arr, d) => Array.from(arr, (v) => Math.round(v * 10 ** d) / 10 ** d);

export function lpPayload(state, terms, { solarCf, windCf }, prices = null) {
  const m = modelInputs(state, terms);
  const rules = terms.rules || [];
  const selling = Boolean(state.market.sell) && Boolean(terms.sale) && terms.sale !== "not_allowed";
  const payload = {
    ctx: {
      demand: new Array(E.HOURS).fill(m.plantMw), // round-the-clock supply at the contracted capacity
      solarCf: round(solarCf, 6),
      windCf: round(windCf, 6),
      plantMw: m.plantMw,
      lossPct: 0,
      sellSurplus: selling,
      extraExportMw: 0,
    },
    bess: m.bess,
    costs: { ...m.costs },
    fin: { ...m.fin, demandGrowth: 0, sellSurplus: selling, surplusPrice: selling && state.market.source === "flat" ? state.market.flatPrice : 0 },
    dfrTarget: rules.find((r) => r.hours === "all")?.target ?? 0,
    dfrBasis: "annual",
    vars: m.vars,
    compliance: rules.map(({ id, label, basis, hours, target }) => ({ id, label, basis, hours, target })),
    returnLifetime: true,
    returnHourly: true,
    tariffGuess: state.lp?.tariff || 5.5,
  };
  delete payload.costs.plants;
  if (m.biomass) payload.biomass = m.biomass;
  if (m.plants.length) payload.plants = m.plants;
  // the tender's least green share applies once a non-RE source supplies
  if (m.plants.some((pl) => !pl.green)) payload.greenShareMin = terms.greenMin ?? 0;
  const series = selling ? marketSeries(state, prices) : null;
  if (series) {
    payload.ctx.surplusPrice = series.map((v) => Math.round(v * 1000) / 1000);
    payload.fin.surplusEscalation = state.market.escalation || 0;
  }
  if (selling) {
    payload.ppaFirst = true; // supply the PPA before selling anything
    if (terms.sale === "mandated_solar") {
      payload.exportSources = "solar";
      // the mandated solar sells over its own interconnection: only its output limits the sale
      payload.ctx.extraExportMw = m.vars.solarMw.locked ? m.vars.solarMw.value : m.vars.solarMw.max;
    }
  }
  if (rules.some((r) => r.hours === "peak")) payload.peakMask = Array.from(peakMask(terms.peak));
  else if (rules.some((r) => r.hours === "any") && terms.peak?.windows?.length) payload.peakMask = Array.from(anyMask(terms.peak));
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

/** Sizes the optimizer left at the top of their range: it would have built more. */
export function sizesAtMax(lp, state) {
  return SOURCE_IDS.filter((id) => {
    const c = state.src[id].capacity;
    const size = lp?.sizes?.[SIZE_KEY[id]];
    return state.sources[id] && c.mode === "optimise" && isNum(c.mw) && size !== undefined && size >= c.mw - 0.5;
  });
}

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
      hydroMWh: row.hydroMwh || 0,
      thermalMWh: row.thermalMwh || 0,
      // surplus sale revenue at the hourly market price, when the sizing used one
      ...(lp.market && row.exportRevenueCr !== undefined ? { surplusRevenueCr: row.exportRevenueCr } : {}),
    };
  });
}

const GEN_KEYS = ["solar", "wind", "hydro", "biomass", "thermal"];

/** Where year-1 energy came from: direct delivery split by each hour's generation shares. */
export function energyMix(hourly) {
  const out = { solar: 0, wind: 0, hydro: 0, biomass: 0, thermal: 0, battery: 0, export: 0, curtail: 0, unmet: 0, demand: 0, exportRevenueCr: 0 };
  if (!hourly) return out;
  for (let t = 0; t < hourly.direct.length; t += 1) {
    const gen = GEN_KEYS.map((k) => hourly[k]?.[t] || 0);
    const g = gen.reduce((a, b) => a + b, 0);
    const d = hourly.direct[t];
    if (g > 0) GEN_KEYS.forEach((k, i) => { out[k] += (d * gen[i]) / g; });
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
  const plant = (id) => (sizes[`${id}Mw`] || 0) * ((costs.plants || []).find((p) => p.id === id)?.capexCrPerMw || 0) * pre;
  return {
    solar: (sizes.solarMw || 0) * costs.solarCrPerMw * pre,
    wind: (sizes.windMw || 0) * costs.windCrPerMw * pre,
    hydro: plant("hydro"),
    biomass: (sizes.biomassMw || 0) * (costs.biomassCrPerMw || 0) * pre,
    thermal: plant("thermal"),
    bess: ((sizes.bessMwh || 0) * costs.bessCrPerMwh + (sizes.bessMw || 0) * (costs.bessPcsCrPerMw || 0)) * pre,
  };
}

export { SIZE_KEY };
