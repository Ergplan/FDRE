// SECI CfD-I bid model: the plant's day-by-day operation over the CfD term and the financial model
// that solves the strike price for the bidder's target equity IRR. Tender terms come from
// ./terms.js (each quoted from the RfS, the CfDA or an amendment); everything else is the bidder's
// input.
//
// Operation, every day from the SCD to the end of the term:
//   * the 2 Peak Hours are the two highest-priced hours of 18:00-24:00 in the market chosen for
//     selling (the RPD bids "with the objective of maximizing revenue", CfDA 4.4.1.iii);
//   * the day's supply is Contracted MW x 2 h x availability, from wind output in those hours (own
//     RE) and the battery;
//   * the battery is charged before 18:00 from own solar and wind first (cheapest hours of the
//     merchant market first), then from the green market (GDAM, hourly price + charges) and group-
//     company RE (fixed price + charges), cheapest first, within each Contract Year's limits
//     (Amendment-02: 25% green market for the whole term, a further 75% for charging until 36
//     months from the Effective Date, then a further 50% from group companies, all measured on
//     the energy discharged);
//   * own RE not needed for charging is sold in the merchant market (within the connection's
//     Contracted MW) on days the peak supply is met, or curtailed;
//   * weekly shortfall beyond 10% of 14 MWh/MW is penalised at 1.5 x (the week's highest evening
//     price across markets - SP).
// Settlement (Amendment-03): the RPD receives the strike price for every kWh supplied, whatever
// the market price; the market price only moves money between the RPD and the CfD Pool.

import * as E from "../rtc/engine.js";
import { scaleToCuf } from "../bid/model.js";
import { TENDER } from "./terms.js";

export const BENCHMARK_NOTE = "Industry benchmark (2025–26 Indian prices and norms), not from the tender";
const pct = true;

/** Every input, by section. The tender fixes none of these; each starts empty unless noted. */
export const FIELDS = [
  // ---- the project
  { section: "project", key: "contractedMw", label: "Contracted capacity you bid", unit: "MW", min: TENDER.bidMinMw, max: TENDER.bidMaxMw, step: 1, hint: "50 to 150 MW in whole MW, one bid for your group (RfS 6.1)" },
  { section: "project", key: "essMwhPerMw", label: "Battery energy", unit: "MWh per contracted MW", min: 2, max: 6, step: 0.05, hint: "At least 2 (Amd-02: X MW / 2X MWh)" },
  { section: "project", key: "essMwPerMw", label: "Battery power", unit: "MW per contracted MW", min: 1, max: 3, step: 0.05, hint: "At least 1" },
  { section: "project", key: "solarMw", label: "Own solar", unit: "MWac", min: 0, max: 5000, step: 5, hint: "Co-located; “Optimise own RE” finds the least-tariff size" },
  { section: "project", key: "windMw", label: "Own wind", unit: "MW", min: 0, max: 5000, step: 5, hint: "0 for none" },
  { section: "project", key: "reCodMonths", label: "RE generation commissioned", unit: "months after the SCD", min: 0, max: 21, step: 1, hint: "Tender: by 36 months from the Effective Date = 21 months after the SCD" },
  { section: "project", key: "availability", label: "Plant availability", unit: "%", pct, min: 50, max: 100, step: 0.5, hint: "Share of the daily 2 MWh/MW actually delivered" },
  // ---- resource and battery
  { section: "resource", key: "solarCuf", label: "Solar CUF (AC)", unit: "%", pct, min: 5, max: 40, step: 0.1 },
  { section: "resource", key: "solarDegradation", label: "Solar degradation", unit: "%/yr", pct, min: 0, max: 3, step: 0.05 },
  { section: "resource", key: "windCuf", label: "Wind CUF", unit: "%", pct, min: 5, max: 60, step: 0.1, hint: "Needed only with own wind" },
  { section: "resource", key: "rte", label: "Battery round-trip efficiency (AC)", unit: "%", pct, min: 60, max: 100, step: 0.5 },
  { section: "resource", key: "essDegradation", label: "Battery degradation", unit: "%/yr", pct, min: 0, max: 5, step: 0.1 },
  // ---- sourcing and markets
  { section: "sourcing", key: "marketCharges", label: "Charges on green-market power", unit: "₹/kWh", min: 0, max: 3, step: 0.01, hint: "Exchange fee, transmission charges and losses on power bought in the GDAM" },
  { section: "sourcing", key: "groupPrice", label: "Group-company RE price", unit: "₹/kWh", min: 0, max: 10, step: 0.01, hint: "Used only if you source from group companies (after 36 months)" },
  { section: "sourcing", key: "groupCharges", label: "Charges on group-company power", unit: "₹/kWh", min: 0, max: 3, step: 0.01 },
  { section: "sourcing", key: "priceEscalation", label: "Market price escalation", unit: "%/yr", pct, min: -5, max: 10, step: 0.1, hint: "Applied to the 2025–26 IEX prices" },
  { section: "sourcing", key: "recPrice", label: "REC price", unit: "₹/REC (MWh)", min: 0, max: 2000, step: 10, hint: "You keep 50% (CfDA 9.2.vi)" },
  // ---- costs
  { section: "costs", key: "essCrPerMwh", label: "Battery capex (all-in)", unit: "₹ cr/MWh", min: 0, max: 5, step: 0.01 },
  { section: "costs", key: "solarCrPerMw", label: "Solar capex", unit: "₹ cr/MWac", min: 0, max: 10, step: 0.05, hint: "Domestic cells and modules (RfS Annexure-B 1.d)" },
  { section: "costs", key: "windCrPerMw", label: "Wind capex", unit: "₹ cr/MW", min: 0, max: 15, step: 0.05 },
  { section: "costs", key: "evacuationCrPerMw", label: "Transmission to the ISTS substation", unit: "₹ cr per contracted MW", min: 0, max: 3, step: 0.01, hint: "Line and bay at 220 kV or above (CfDA Delivery Point)" },
  { section: "costs", key: "preopPct", label: "Pre-operative & IDC", unit: "% of hard cost", pct, min: 0, max: 30, step: 0.5 },
  { section: "costs", key: "augDecline", label: "Battery price fall (augmentation)", unit: "%/yr", pct, min: 0, max: 20, step: 0.5, hint: "Augmentation keeps the usable MWh: degraded MWh replaced each year" },
  { section: "costs", key: "essOmLakhPerMwh", label: "Battery O&M", unit: "₹ lakh/MWh/yr", min: 0, max: 10, step: 0.05 },
  { section: "costs", key: "solarOmLakhPerMw", label: "Solar O&M", unit: "₹ lakh/MW/yr", min: 0, max: 20, step: 0.1 },
  { section: "costs", key: "windOmLakhPerMw", label: "Wind O&M", unit: "₹ lakh/MW/yr", min: 0, max: 30, step: 0.1 },
  { section: "costs", key: "otherFixedLakhPerMw", label: "Scheduling, forecasting, fees, admin", unit: "₹ lakh per contracted MW/yr", min: 0, max: 20, step: 0.1 },
  { section: "costs", key: "insurancePct", label: "Insurance", unit: "% of capex/yr", pct, min: 0, max: 3, step: 0.05 },
  { section: "costs", key: "omEscalation", label: "O&M escalation", unit: "%/yr", pct, min: 0, max: 15, step: 0.25 },
  { section: "costs", key: "pxFee", label: "Exchange fee on energy sold", unit: "₹/kWh", min: 0, max: 0.5, step: 0.005, hint: "Yours (CfDA 4.2.7)" },
  { section: "costs", key: "lcCostPct", label: "Letter of Credit cost", unit: "% of LC/yr", pct, min: 0, max: 5, step: 0.05, hint: "LC = 2000 × MW × (₹10 − SP) × 30 (CfDA 10.4.2)" },
  { section: "costs", key: "pbgCostPct", label: "Bank guarantee cost (EMD, PBG)", unit: "% of the guarantee/yr", pct, min: 0, max: 5, step: 0.05, hint: "Amounts and validity from the RfS (17, 18.1)" },
  { section: "costs", key: "gstRate", label: "GST on SECI's charges", unit: "%", pct, min: 0, max: 28, step: 1, hint: "On the RfS cost, bid fee and Contract Administration Charges; a cost if you cannot set it off" },
  // ---- finance
  { section: "fin", key: "targetEquityIrr", label: "Target equity IRR", unit: "%", pct, min: 0, max: 40, step: 0.25 },
  { section: "fin", key: "debtFraction", label: "Debt share", unit: "% of capex", pct, min: 0, max: 95, step: 1 },
  { section: "fin", key: "interestRate", label: "Interest rate", unit: "%", pct, min: 0, max: 25, step: 0.05 },
  { section: "fin", key: "tenorYears", label: "Loan tenor", unit: "years", min: 1, max: 15, step: 1, hint: "Within the 15-year term" },
  { section: "fin", key: "taxRate", label: "Corporate tax", unit: "%", pct, min: 0, max: 50, step: 0.01, hint: "Sec. 115BAA: 25.17%" },
  { section: "fin", key: "essLifeYears", label: "Battery depreciation life", unit: "years", min: 5, max: 30, step: 1 },
  { section: "fin", key: "reLifeYears", label: "RE depreciation life", unit: "years", min: 5, max: 35, step: 1 },
  { section: "fin", key: "discountRate", label: "Discount rate (levelised cost)", unit: "%", pct, min: 0, max: 25, step: 0.25 },
];

export const CHOICES = {
  effectiveDate: { label: "Effective Date of the CfDA", hint: "The SCD is 15 months later (Amd-02); the term runs 15 years from the SCD (Amd-03)" },
  sellMarket: { label: "Market you sell the peak supply in", options: [["DAM", "DAM (brown: RECs issued)"], ["GDAM", "GDAM (green: no RECs)"], ["RTM", "RTM (brown: RECs issued)"]] },
  useMarket: { label: "Buy green-market power to charge the battery", hint: "Up to 25% of each year's energy (plus 75% until month 36)" },
  useGroup: { label: "Group-company RE for charging (after 36 months)", hint: "Up to 50% of each year's energy" },
  merchant: { label: "Sell surplus own RE in the market", hint: "In the GDAM, within the connection, on days the peak supply is met (CfDA 4.4.1.v)" },
  augmentation: { label: "Battery capacity over the term", options: [["annual", "Augment every year (keep the MWh)"], ["none", "No augmentation (capacity fades)"]] },
  afterTerm: { label: "After the 15-year term", options: [["none", "Nothing (value ends with the term)"], ["merchant", "Keep selling at market prices"]] },
};

export const BENCHMARKS = {
  effectiveDate: "2027-02-01",
  essMwhPerMw: 2, essMwPerMw: 1, solarMw: null, windMw: 0, reCodMonths: 21, availability: 0.97,
  solarCuf: 0.25, solarDegradation: 0.005, windCuf: 0.33, rte: 0.87, essDegradation: 0.02,
  marketCharges: 0.3, groupPrice: 3.0, groupCharges: 0.3, priceEscalation: 0, recPrice: 150,
  essCrPerMwh: 1.0, solarCrPerMw: 4.0, windCrPerMw: 6.5, evacuationCrPerMw: 0.3, preopPct: 0.05, augDecline: 0.05,
  essOmLakhPerMwh: 1.2, solarOmLakhPerMw: 4, windOmLakhPerMw: 9, otherFixedLakhPerMw: 2, insurancePct: 0.003, omEscalation: 0.05,
  pxFee: 0.02, lcCostPct: 0.01, pbgCostPct: 0.01, gstRate: 0.18,
  targetEquityIrr: 0.14, debtFraction: 0.75, interestRate: 0.09, tenorYears: 12, taxRate: 0.2517, essLifeYears: 15, reLifeYears: 25, discountRate: 0.1,
  sellMarket: "DAM", useMarket: true, useGroup: false, merchant: true, augmentation: "annual", afterTerm: "none", merchantYears: 0,
};

export const DEFAULT_CONTRACTED_MW = 100;
export const STORAGE_KEY = "fdre.cfd.v1";

export function defaultCfdState() {
  const inputs = Object.fromEntries(FIELDS.map((f) => [f.key, null]));
  return {
    version: 1,
    step: "model",
    inputs: { ...inputs, contractedMw: DEFAULT_CONTRACTED_MW, effectiveDate: null, sellMarket: null, useMarket: null, useGroup: null, merchant: null, augmentation: null, afterTerm: null, merchantYears: null },
    filled: {}, // key -> true while the value is a benchmark
  };
}

export function mergeCfdState(saved) {
  const base = defaultCfdState();
  if (!saved || saved.version !== 1) return base;
  return { ...base, ...saved, inputs: { ...base.inputs, ...(saved.inputs || {}) }, filled: { ...(saved.filled || {}) } };
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Fill every empty input with its benchmark; the solar size stays empty (the optimiser sets it). */
export function fillBenchmarks(state) {
  const inputs = { ...state.inputs };
  const filled = { ...state.filled };
  for (const [key, value] of Object.entries(BENCHMARKS)) {
    if (value === null) continue;
    if (inputs[key] === null || inputs[key] === undefined || inputs[key] === "") {
      inputs[key] = value;
      filled[key] = true;
    }
  }
  if (!isNum(inputs.solarMw) && isNum(inputs.contractedMw)) {
    inputs.solarMw = inputs.contractedMw; // a first guess; "Optimise own RE" refines it
    filled.solarMw = true;
  }
  return { ...state, inputs, filled };
}

/** The inputs still needed, as readable lines (the model runs once this is empty). */
export function missingInputs(state) {
  const i = state.inputs;
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.effectiveDate || "")) out.push("Effective Date of the CfDA");
  if (isNum(i.contractedMw) && (!Number.isInteger(i.contractedMw) || i.contractedMw < TENDER.bidMinMw || i.contractedMw > TENDER.bidMaxMw)) {
    out.push("Contracted capacity: 50 to 150 MW in whole MW (RfS 6.1)");
  }
  for (const key of ["sellMarket", "useMarket", "useGroup", "merchant", "augmentation", "afterTerm"]) {
    if (i[key] === null || i[key] === undefined) out.push(CHOICES[key].label);
  }
  const optional = new Set(["windCuf", "windCrPerMw", "windOmLakhPerMw", "groupPrice", "groupCharges", "recPrice"]);
  for (const f of FIELDS) {
    if (optional.has(f.key)) continue;
    if (!isNum(i[f.key])) out.push(f.label);
  }
  if (isNum(i.windMw) && i.windMw > 0) for (const key of ["windCuf", "windCrPerMw", "windOmLakhPerMw"]) if (!isNum(i[key])) out.push(FIELDS.find((f) => f.key === key).label);
  if (i.useGroup) for (const key of ["groupPrice", "groupCharges"]) if (!isNum(i[key])) out.push(FIELDS.find((f) => f.key === key).label);
  if ((i.sellMarket === "DAM" || i.sellMarket === "RTM") && !isNum(i.recPrice)) out.push("REC price");
  if (i.afterTerm === "merchant" && !isNum(i.merchantYears)) out.push("Years of market sales after the term");
  if (isNum(i.essMwhPerMw) && i.essMwhPerMw < TENDER.essHoursMin) out.push("Battery energy: at least 2 MWh per contracted MW");
  if (isNum(i.essMwPerMw) && i.essMwPerMw < 1) out.push("Battery power: at least 1 MW per contracted MW");
  if (isNum(i.reCodMonths) && i.reCodMonths > TENDER.reCodMonths - TENDER.essScdMonths) out.push("RE generation: commissioned by 21 months after the SCD");
  return out;
}

// ---------------------------------------------------------------- dates

const DAY_MS = 86400000;
export const parseDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
export const fmtDate = (t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
export const addDays = (t, n) => t + n * DAY_MS;
export function addMonths(t, n) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last));
}

/** The tender's dates for an Effective Date (each from a quoted term). */
export function keyDates(effectiveDate) {
  const ed = parseDate(effectiveDate);
  const scd = addMonths(ed, TENDER.essScdMonths);
  const loa = addDays(ed, -TENDER.loaToEdDays); // the Effective Date is the 30th day from the LoA (RfS 21.4)
  return {
    loa,
    docsDue: addDays(loa, TENDER.docsDueDays), // PBG, Contract Administration Charges, documents (RfS 21.4)
    ed,
    finClose: addMonths(scd, -TENDER.finCloseMonthsBeforeScd),
    scd,
    lastWithPenalty: addMonths(scd, TENDER.delayMonthsMax),
    pbgUntil: addMonths(scd, TENDER.pbgAfterScdMonths), // PBG validity (RfS 18.1)
    reDeadline: addMonths(ed, TENDER.reCodMonths),
    extraUntil: addMonths(ed, TENDER.extraMarketMonths),
    end: addMonths(scd, TENDER.termYears * 12),
  };
}

/** Contract Years: the SCD to the next 31 March, then April-March, the last ending with the term. */
export function contractYears(scd, end) {
  const out = [];
  let start = scd;
  while (start < end) {
    const d = new Date(start);
    const fyEnd = Date.UTC(d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(), 3, 1);
    const stop = Math.min(fyEnd, end);
    out.push({ index: out.length + 1, start, end: stop, days: Math.round((stop - start) / DAY_MS) });
    start = stop;
  }
  return out;
}

/** Day of the 365-day price year (0 = 1 Jan); 29 February uses 28 February's prices. */
function priceDay(t) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  let doy = Math.round((t - Date.UTC(y, 0, 1)) / DAY_MS);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (leap && doy >= 59) doy -= 1;
  return Math.min(364, doy);
}

// ---------------------------------------------------------------- inputs for the simulation

/** Hourly prices in ₹/kWh from the IEX price year, and each day's hour orderings (fixed for the year). */
export function priceBook(prices, sellMarket) {
  const series = (m) => Float64Array.from(prices.markets[m].hourlyRsPerMwh, (v) => v / 1000);
  const sell = series(sellMarket);
  const buy = series("GDAM");
  const merchant = series("GDAM");
  const all = ["DAM", "GDAM", "RTM"].filter((m) => prices.markets[m]).map(series);
  const maxAll = new Float64Array(E.HOURS);
  for (let t = 0; t < E.HOURS; t += 1) maxAll[t] = Math.max(...all.map((s) => s[t]));
  const peakOrder = []; // per day: the 18:00-24:00 hours, highest sell price first
  const chargeOrder = []; // per day: hours 0-17, cheapest merchant price first (own RE charges first there)
  const buyOrder = []; // per day: hours 0-17, cheapest GDAM price first
  const peakRef = new Float64Array(365); // per day: highest evening price across markets (penalty reference)
  for (let d = 0; d < 365; d += 1) {
    const b = d * 24;
    const peak = [];
    for (let h = TENDER.peakStart; h < TENDER.peakEnd; h += 1) peak.push(h);
    peakOrder.push(peak.sort((x, y) => sell[b + y] - sell[b + x] || x - y));
    const day = Array.from({ length: TENDER.peakStart }, (_, h) => h);
    chargeOrder.push([...day].sort((x, y) => merchant[b + x] - merchant[b + y] || x - y));
    buyOrder.push([...day].sort((x, y) => buy[b + x] - buy[b + y] || x - y));
    let ref = 0;
    for (let h = TENDER.peakStart; h < TENDER.peakEnd; h += 1) ref = Math.max(ref, maxAll[b + h]);
    peakRef[d] = ref;
  }
  return { sell, buy, merchant, maxAll, peakOrder, chargeOrder, buyOrder, peakRef, sellMarket };
}

/** Hourly own-RE output per MW (year 1) at the bidder's CUFs. */
export function profiles(inputs) {
  const flat = () => new Float64Array(E.HOURS);
  return {
    solar: isNum(inputs.solarCuf) ? scaleToCuf(E.synthSolarCf({ targetCuf: inputs.solarCuf, dcAc: 1.4 }), inputs.solarCuf) : flat(),
    wind: isNum(inputs.windCuf) && isNum(inputs.windMw) && inputs.windMw > 0 ? scaleToCuf(E.synthWindCf({ targetCuf: inputs.windCuf }), inputs.windCuf) : flat(),
  };
}

// ---------------------------------------------------------------- operations

/**
 * Every day of the term. Returns totals per Contract Year (and the weeks for the penalty), plus
 * the hourly flows of the days asked for in `record` (day numbers from the SCD).
 */
export function simulate(inputs, book, prof, { record = [] } = {}) {
  const X = inputs.contractedMw;
  const P = X * inputs.essMwPerMw;
  const capNominal = X * inputs.essMwhPerMw;
  const S = inputs.solarMw || 0;
  const W = inputs.windMw || 0;
  const rte = inputs.rte;
  const avail = inputs.availability;
  const dates = keyDates(inputs.effectiveDate);
  const reCod = addMonths(dates.scd, inputs.reCodMonths);
  const cys = contractYears(dates.scd, dates.end);
  const brown = inputs.sellMarket === "DAM" || inputs.sellMarket === "RTM";
  const keep = new Set(record);
  const days = {};
  const out = cys.map((cy) => {
    // the Contract Year's sourcing limits, in MWh supplied (Amd-02: on the energy discharged)
    let extraDays = 0;
    let groupDays = 0;
    for (let t = cy.start; t < cy.end; t += DAY_MS) {
      if (t < dates.extraUntil) extraDays += 1; else groupDays += 1;
    }
    const daily = X * TENDER.mwhPerMwDay;
    return {
      ...cy,
      requiredMwh: daily * cy.days,
      marketCapMwh: inputs.useMarket ? daily * (TENDER.marketShare * cy.days + TENDER.extraMarketShare * extraDays) : 0,
      groupCapMwh: inputs.useGroup ? daily * TENDER.groupShare * groupDays : 0,
      deliveredMwh: 0, windDirectMwh: 0, essOutMwh: 0, chargeOwnMwh: 0, chargeMarketMwh: 0, chargeGroupMwh: 0,
      marketCostCr: 0, groupCostCr: 0, merchantMwh: 0, merchantRevCr: 0, curtailedMwh: 0, shortMwh: 0, shortDays: 0,
      mcpDeliveredCr: 0, ownSuppliedMwh: 0, recMwh: 0, reDays: 0, solarMwh: 0, windMwh: 0, weeks: [],
    };
  });
  const weeks = new Map(); // Contract Week (Monday start) -> { required, supplied, ref, cy }
  let cyIdx = 0;
  let marketUsed = 0;
  let groupUsed = 0;
  for (let t = dates.scd, k = 0; t < dates.end; t += DAY_MS, k += 1) {
    while (cyIdx < out.length - 1 && t >= out[cyIdx].end) { cyIdx += 1; marketUsed = 0; groupUsed = 0; }
    const cy = out[cyIdx];
    const year = Math.floor(k / 365) + 1;
    const esc = (1 + inputs.priceEscalation) ** (year - 1);
    const solarF = (1 - inputs.solarDegradation) ** (year - 1);
    const cap = inputs.augmentation === "annual" ? capNominal : capNominal * Math.max(0.4, 1 - inputs.essDegradation * (year - 1));
    const reOn = t >= reCod;
    const extra = t < dates.extraUntil;
    const d = priceDay(t);
    const b = d * 24;
    const sol = new Float64Array(24);
    const wnd = new Float64Array(24);
    if (reOn) {
      for (let h = 0; h < 24; h += 1) {
        sol[h] = S * prof.solar[b + h] * solarF;
        wnd[h] = W * prof.wind[b + h];
      }
      cy.reDays += 1;
    }
    // the day's two peak hours and what each must supply
    const chosen = book.peakOrder[d].slice(0, TENDER.peakHours);
    const perHour = X * avail;
    let windDirect = 0;
    let essNeed = 0;
    const direct = {};
    for (const h of chosen) {
      direct[h] = Math.min(wnd[h], perHour);
      windDirect += direct[h];
      essNeed += Math.min(P, perHour - direct[h]);
    }
    essNeed = Math.min(essNeed, cap);
    let chargeLeft = essNeed / rte;
    const room = new Float64Array(TENDER.peakStart).fill(P);
    const own = new Float64Array(TENDER.peakStart);
    const mkt = new Float64Array(TENDER.peakStart);
    const grp = new Float64Array(TENDER.peakStart);
    // own RE charges first, in the hours its market value is lowest
    for (const h of book.chargeOrder[d]) {
      if (chargeLeft <= 1e-9) break;
      const c = Math.min(sol[h] + wnd[h], room[h], chargeLeft);
      own[h] = c; room[h] -= c; chargeLeft -= c;
    }
    // then bought power, cheapest first, within the Contract Year's limits (MWh supplied)
    if (chargeLeft > 1e-9 && (inputs.useMarket || (inputs.useGroup && !extra))) {
      const offers = [];
      if (inputs.useMarket) for (const h of book.buyOrder[d]) offers.push({ h, src: "m", price: book.buy[b + h] * esc + inputs.marketCharges });
      if (inputs.useGroup && !extra) for (let h = 0; h < TENDER.peakStart; h += 1) offers.push({ h, src: "g", price: inputs.groupPrice + inputs.groupCharges });
      offers.sort((x, y) => x.price - y.price || x.h - y.h);
      for (const o of offers) {
        if (chargeLeft <= 1e-9) break;
        const budget = o.src === "m" ? (cy.marketCapMwh - marketUsed) / rte : (cy.groupCapMwh - groupUsed) / rte;
        const c = Math.min(room[o.h], chargeLeft, Math.max(0, budget));
        if (c <= 1e-9) continue;
        room[o.h] -= c; chargeLeft -= c;
        if (o.src === "m") { mkt[o.h] += c; marketUsed += c * rte; cy.marketCostCr += c * o.price * 1e-4; } else { grp[o.h] += c; groupUsed += c * rte; cy.groupCostCr += c * o.price * 1e-4; }
      }
    }
    const charged = essNeed / rte - Math.max(0, chargeLeft);
    const essOut = charged * rte;
    const delivered = windDirect + essOut;
    const met = chargeLeft <= 1e-6;
    // own RE not used: sold (within the connection, once the day's supply is met) or curtailed
    let merchantMwh = 0;
    let merchantRev = 0;
    let curtailed = 0;
    const sale = new Float64Array(24);
    for (let h = 0; h < 24; h += 1) {
      const gen = sol[h] + wnd[h];
      const used = h < TENDER.peakStart ? own[h] : (direct[h] || 0);
      const spare = Math.max(0, gen - used);
      if (spare <= 0) continue;
      const injected = h < TENDER.peakStart ? 0 : (direct[h] || 0) + (chosen.includes(h) ? essOut / chosen.length : 0);
      const s = inputs.merchant && met ? Math.min(spare, Math.max(0, X - injected)) : 0;
      sale[h] = s;
      merchantMwh += s;
      merchantRev += s * book.merchant[b + h] * esc * 1e-4;
      curtailed += spare - s;
    }
    let ownCharged = 0;
    let solarDay = 0;
    let windDay = 0;
    for (let h = 0; h < 24; h += 1) { solarDay += sol[h]; windDay += wnd[h]; }
    for (let h = 0; h < TENDER.peakStart; h += 1) ownCharged += own[h];
    const ownSupplied = windDirect + ownCharged * rte * (charged > 0 ? Math.min(1, essOut / (charged * rte)) : 0);
    let mcp = 0;
    for (const h of chosen) mcp += book.sell[b + h] * esc * (direct[h] + essOut / chosen.length);
    Object.assign(cy, {
      deliveredMwh: cy.deliveredMwh + delivered, windDirectMwh: cy.windDirectMwh + windDirect, essOutMwh: cy.essOutMwh + essOut,
      chargeOwnMwh: cy.chargeOwnMwh + ownCharged, chargeMarketMwh: cy.chargeMarketMwh + mkt.reduce((a, v) => a + v, 0), chargeGroupMwh: cy.chargeGroupMwh + grp.reduce((a, v) => a + v, 0),
      merchantMwh: cy.merchantMwh + merchantMwh, merchantRevCr: cy.merchantRevCr + merchantRev, curtailedMwh: cy.curtailedMwh + curtailed,
      shortMwh: cy.shortMwh + Math.max(0, chargeLeft) * rte, shortDays: cy.shortDays + (met ? 0 : 1),
      mcpDeliveredCr: cy.mcpDeliveredCr + mcp * 1e-4, ownSuppliedMwh: cy.ownSuppliedMwh + ownSupplied,
      recMwh: cy.recMwh + (brown ? ownSupplied : 0), solarMwh: cy.solarMwh + solarDay, windMwh: cy.windMwh + windDay,
    });
    // Contract Week (Monday to Sunday) for the weekly shortfall
    const dow = (new Date(t).getUTCDay() + 6) % 7; // 0 = Monday
    const wk = t - dow * DAY_MS;
    const w = weeks.get(wk) || { start: wk, required: 0, supplied: 0, ref: 0, cy: cyIdx };
    w.required += X * TENDER.mwhPerMwDay;
    w.supplied += delivered;
    w.ref = Math.max(w.ref, book.peakRef[d] * esc);
    w.cy = cyIdx;
    weeks.set(wk, w);
    if (keep.has(k)) {
      days[k] = { date: t, chosen, solar: Array.from(sol), wind: Array.from(wnd), own: [...own, ...new Array(6).fill(0)], market: [...mkt, ...new Array(6).fill(0)], group: [...grp, ...new Array(6).fill(0)],
        sale: Array.from(sale), essOut, windDirect: direct, delivered, required: X * TENDER.mwhPerMwDay, price: Array.from({ length: 24 }, (_, h) => book.sell[b + h] * esc), buyPrice: Array.from({ length: 24 }, (_, h) => book.buy[b + h] * esc) };
    }
  }
  for (const w of weeks.values()) {
    const beyond = Math.max(0, w.required * (1 - TENDER.weeklyTolerance) - w.supplied);
    out[w.cy].weeks.push({ start: w.start, required: w.required, supplied: w.supplied, beyondMwh: beyond, ref: w.ref });
  }
  for (const cy of out) {
    const supplied = Math.max(1e-9, cy.deliveredMwh);
    cy.shareOwn = cy.ownSuppliedMwh / supplied;
    cy.shareMarket = (cy.chargeMarketMwh * rte) / supplied;
    cy.shareGroup = (cy.chargeGroupMwh * rte) / supplied;
    cy.supplyShare = cy.deliveredMwh / cy.requiredMwh;
  }
  return { years: out, dates: { ...dates, reCod }, days };
}

// ---------------------------------------------------------------- finance

const yearsBetween = (a, b) => (b - a) / (365.25 * DAY_MS);

/** Weekly shortfall penalty in a Contract Year at strike price sp (₹ cr). */
export const penaltyCr = (cy, sp) => cy.weeks.reduce((a, w) => a + TENDER.penaltyMultiple * Math.max(0, w.ref - sp) * w.beyondMwh * 1e-4, 0);

/** The Letter of Credit to SECI (₹ cr) at strike price sp: 2000 kWh × MW × (C − SP) × 30, C = ₹10. */
export const lcCr = (mw, sp) => (2000 * mw * Math.max(0, TENDER.lcMinPrice - sp) * TENDER.lcDays) / 1e7;

/**
 * What the RfS asks of a bid for this plant (₹ crore): the bid securities and SECI's charges, from the
 * installed AC capacities (solar and wind MW, battery MWh), and the eligibility thresholds.
 */
export function rfsAmounts(inputs) {
  const X = isNum(inputs.contractedMw) ? inputs.contractedMw : 0;
  const cap = { solarMw: inputs.solarMw || 0, windMw: inputs.windMw || 0, essMwh: X * (inputs.essMwhPerMw || TENDER.essHoursMin) };
  const lakh = (rates) => Object.keys(rates).reduce((a, k) => a + rates[k] * cap[k], 0);
  const gst = isNum(inputs.gstRate) ? inputs.gstRate : 0;
  const rfsCost = TENDER.rfsCostLakh / 100;
  const bidFee = Math.min(TENDER.bidFeeLakhPerMw * X, TENDER.bidFeeMaxLakh) / 100;
  const cac = (TENDER.cacLakhPerMw * X) / 100;
  return {
    ...cap,
    emdCr: lakh(TENDER.emdLakh) / 100,
    pbgCr: lakh(TENDER.pbgLakh) / 100,
    rfsCostCr: rfsCost, bidFeeCr: bidFee, cacCr: cac, gst,
    seciChargesCr: (rfsCost + bidFee + cac) * (1 + gst), // not refunded; with GST
    netWorthCr: lakh(TENDER.netWorthLakh) / 100,
    turnoverCr: (TENDER.turnoverLakhPerMw * X) / 100,
    pbditCr: (TENDER.pbditLakhPerMw * X) / 100,
    lineOfCreditCr: (TENDER.lineOfCreditLakhPerMw * X) / 100,
  };
}

/** Years each bank guarantee is held: the EMD for its validity, the PBG from 20 days after the LoA to 6 months after the SCD; each + the 30-day claim period. */
export const BG_YEARS = {
  emd: TENDER.emdValidityMonths / 12 + TENDER.bgClaimDays / 365,
  pbg: (TENDER.essScdMonths + TENDER.pbgAfterScdMonths) / 12 + (TENDER.loaToEdDays - TENDER.docsDueDays + TENDER.bgClaimDays) / 365,
};

export function capex(inputs) {
  const X = inputs.contractedMw;
  const pre = 1 + inputs.preopPct;
  const ess = X * inputs.essMwhPerMw * inputs.essCrPerMwh;
  const evac = X * inputs.evacuationCrPerMw;
  const solar = (inputs.solarMw || 0) * inputs.solarCrPerMw;
  const wind = (inputs.windMw || 0) * (inputs.windCrPerMw || 0);
  const seci = rfsAmounts(inputs).seciChargesCr; // RfS cost, bid fee, Contract Administration Charges, with GST
  return { ess, evac, solar, wind, seci, preopEss: (ess + evac) * inputs.preopPct, preopRe: (solar + wind) * inputs.preopPct,
    atScd: (ess + evac) * pre + seci, atRe: (solar + wind) * pre, total: (ess + evac + solar + wind) * pre + seci };
}

/** Rate r at which the dated flows' NPV is zero (bisection), or NaN. */
export function xirr(flows) {
  const npv = (r) => flows.reduce((a, f) => a + f.cf / (1 + r) ** f.t, 0);
  let lo = -0.95;
  let hi = 2;
  let fLo = npv(lo);
  if (!Number.isFinite(fLo) || fLo * npv(hi) > 0) return NaN;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (fm * fLo > 0) { lo = mid; fLo = fm; } else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}
const npvDated = (rate, flows) => flows.reduce((a, f) => a + f.cf / (1 + rate) ** f.t, 0);

/**
 * The financial model at strike price sp: one row per period (construction, then each Contract
 * Year, then any market years after the term), in ₹ crore.
 */
export function financials(inputs, sim, sp) {
  const X = inputs.contractedMw;
  const cx = capex(inputs);
  const { scd, reCod } = sim.dates;
  const tScd = 0.6; // equity and debt for the battery are spent on average ~7 months before the SCD
  const reCy = sim.years.findIndex((cy) => reCod < cy.end);
  const essMwh = X * inputs.essMwhPerMw;
  const lc = lcCr(X, sp);
  const rfs = rfsAmounts(inputs);
  const rows = [];
  // construction (battery, transmission and SECI's charges; the RE comes in the Contract Year of its
  // commissioning), with the cost of the EMD and PBG bank guarantees over their validity
  const reAtStart = reCy === 0 && reCod <= scd;
  const emdCost = rfs.emdCr * inputs.pbgCostPct * BG_YEARS.emd;
  const pbgCost = rfs.pbgCr * inputs.pbgCostPct * BG_YEARS.pbg;
  rows.push({ period: "Construction", year: 0, t: 0, days: 0, capex: cx.atScd + (reAtStart ? cx.atRe : 0), emdCost, pbgCost, bgCost: emdCost + pbgCost });
  const tail = inputs.afterTerm === "merchant" ? Math.max(0, Math.round(inputs.merchantYears || 0)) : 0;
  const last = sim.years[sim.years.length - 1];
  const fullYears = sim.years.filter((cy) => cy.days >= 360);
  const ref = fullYears[fullYears.length - 1] || last;
  const periods = [...sim.years.map((cy) => ({ cy, merchant: false })), ...Array.from({ length: tail }, (_, i) => ({ cy: ref, merchant: true, extraYear: i + 1 }))];
  let t = tScd;
  periods.forEach(({ cy, merchant, extraYear }, i) => {
    const f = merchant ? 1 : cy.days / 365;
    const opYear = merchant ? sim.years.length + extraYear : cy.index;
    const om = (1 + inputs.omEscalation) ** (opYear - 1);
    const scale = merchant ? (1 + inputs.priceEscalation) ** (extraYear) : 1;
    const reShare = merchant ? 1 : cy.reDays / Math.max(1, cy.days);
    const cfd = merchant ? 0 : sp * cy.deliveredMwh * 1e-4;
    const marketSale = merchant ? cy.mcpDeliveredCr * scale * (365 / Math.max(1, cy.days)) : 0;
    const k = merchant ? (365 / Math.max(1, cy.days)) * scale : 1;
    const rec = ((inputs.recPrice || 0) * cy.recMwh * (merchant ? 1 : 1 - TENDER.recPoolShare)) / 1e7 * (merchant ? 365 / Math.max(1, cy.days) : 1);
    const row = {
      period: merchant ? `After term ${extraYear}` : `CY ${cy.index}`,
      year: i + 1, days: merchant ? 365 : cy.days, start: merchant ? null : cy.start, end: merchant ? null : cy.end, merchant,
      cfdRevenue: cfd,
      marketSales: marketSale,
      merchantRevenue: cy.merchantRevCr * k,
      recRevenue: rec,
      essOm: (inputs.essOmLakhPerMwh * essMwh * f * om) / 100,
      reOm: (((inputs.solarMw || 0) * inputs.solarOmLakhPerMw + (inputs.windMw || 0) * (inputs.windOmLakhPerMw || 0)) * f * reShare * om) / 100,
      otherFixed: (inputs.otherFixedLakhPerMw * X * f * om) / 100,
      insurance: inputs.insurancePct * (cx.atScd + cx.atRe * reShare) * f,
      pxFees: inputs.pxFee * (cy.deliveredMwh + cy.merchantMwh) * 1e-4 * (merchant ? 365 / Math.max(1, cy.days) : 1),
      chargingMarket: cy.marketCostCr * k,
      chargingGroup: cy.groupCostCr * k,
      augmentation: inputs.augmentation === "annual" && opYear >= 2 ? essMwh * inputs.essDegradation * inputs.essCrPerMwh * (1 - inputs.augDecline) ** opYear * f : 0,
      lcCost: merchant ? 0 : inputs.lcCostPct * lc * f,
      penalty: merchant ? 0 : penaltyCr(cy, sp),
      capex: !merchant && i === reCy && !reAtStart ? cx.atRe : 0,
      t: t + f,
    };
    t += f;
    row.revenue = row.cfdRevenue + row.marketSales + row.merchantRevenue + row.recRevenue;
    row.opex = row.essOm + row.reOm + row.otherFixed + row.insurance + row.pxFees + row.chargingMarket + row.chargingGroup + row.augmentation + row.lcCost + row.penalty;
    row.ebitda = row.revenue - row.opex;
    rows.push(row);
  });
  // capex timing: the RE tranche is spent around its commissioning
  const reT = tScd + yearsBetween(scd, reCod);
  // depreciation (straight line), debt (equal principal over the tenor, each tranche from its
  // draw), tax with losses carried forward (Sec. 115BAA: no MAT)
  const drawEss = inputs.debtFraction * cx.atScd;
  const drawRe = inputs.debtFraction * cx.atRe;
  rows[0].debtDraw = drawEss + (reAtStart ? drawRe : 0);
  rows[0].equityIn = rows[0].capex - rows[0].debtDraw + rows[0].bgCost;
  let balEss = drawEss;
  let balRe = reAtStart ? drawRe : 0;
  let usedEss = 0;
  let usedRe = 0;
  let lossPool = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const f = r.days / 365;
    const cy = periods[i - 1].cy;
    const reShare = r.merchant ? 1 : cy.reDays / Math.max(1, cy.days); // share of the period the RE runs
    const commissioning = r.capex > 0;
    if (commissioning) balRe += drawRe;
    r.debtDraw = commissioning ? drawRe : 0;
    r.equityIn = r.capex - r.debtDraw;
    const depEss = usedEss < inputs.essLifeYears ? (cx.atScd / inputs.essLifeYears) * Math.min(f, inputs.essLifeYears - usedEss) : 0;
    usedEss += f;
    const reF = f * reShare;
    const depRe = reF > 0 && usedRe < inputs.reLifeYears ? (cx.atRe / inputs.reLifeYears) * Math.min(reF, inputs.reLifeYears - usedRe) : 0;
    usedRe += reF;
    r.depreciation = depEss + depRe;
    r.interest = (balEss + (commissioning ? balRe * reShare : balRe)) * inputs.interestRate * f;
    const pEss = Math.min(balEss, (drawEss / inputs.tenorYears) * f);
    const pRe = commissioning ? 0 : Math.min(balRe, (drawRe / inputs.tenorYears) * f);
    balEss -= pEss;
    balRe -= pRe;
    r.principal = pEss + pRe;
    r.debtClosing = balEss + balRe;
    r.pbt = r.ebitda - r.depreciation - r.interest;
    const taxable = r.pbt - lossPool;
    if (taxable > 0) { r.tax = taxable * inputs.taxRate; lossPool = 0; } else { r.tax = 0; lossPool = -taxable; }
    r.pat = r.pbt - r.tax;
    r.cfads = r.ebitda - r.tax;
    r.debtService = r.interest + r.principal;
    r.dscr = r.debtService > 1e-9 ? r.cfads / r.debtService : null;
    r.equityCf = r.cfads - r.debtService - r.equityIn;
    r.projectCf = r.cfads - r.capex;
  }
  rows[0].equityCf = -rows[0].equityIn;
  rows[0].projectCf = -rows[0].capex - rows[0].bgCost;
  // dated flows: construction at t = 0, each period's flows at its end; the RE spend at its commissioning
  const equityFlows = rows.map((r, i) => ({ t: i === 0 ? 0 : r.t, cf: i === 0 ? r.equityCf : r.equityCf + r.equityIn }));
  const projectFlows = rows.map((r, i) => ({ t: i === 0 ? 0 : r.t, cf: i === 0 ? r.projectCf : r.projectCf + r.capex }));
  const reRow = rows.findIndex((r, i) => i > 0 && r.capex > 0);
  if (reRow > 0) {
    equityFlows.push({ t: reT, cf: -rows[reRow].equityIn });
    projectFlows.push({ t: reT, cf: -rows[reRow].capex });
  }
  const dscrs = rows.map((r) => r.dscr).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  // levelised cost of the peak supply over the term: PV of capex, costs and tax net of other income,
  // over PV of the energy supplied (₹/kWh); the break-even strike price before the equity return
  const termRows = rows.filter((r, i) => i === 0 || !r.merchant);
  const pvEnergy = npvDated(inputs.discountRate, termRows.slice(1).map((r, i) => ({ t: r.t, cf: sim.years[i].deliveredMwh })));
  const costFlows = termRows.map((r, i) => ({ t: i === 0 ? 0 : r.t, cf: i === 0 ? r.capex + r.bgCost : r.opex + r.capex + r.tax - r.merchantRevenue - r.recRevenue }));
  return {
    sp, rows, capex: cx, lcCr: lc, pbgCr: rfs.pbgCr, emdCr: rfs.emdCr, rfs,
    equityIrr: xirr(equityFlows), projectIrr: xirr(projectFlows),
    equityNpv: npvDated(inputs.targetEquityIrr, equityFlows),
    minDscr: dscrs.length ? Math.min(...dscrs) : null, avgDscr: dscrs.length ? dscrs.reduce((a, v) => a + v, 0) / dscrs.length : null,
    levelisedCost: pvEnergy > 0 ? (npvDated(inputs.discountRate, costFlows) / pvEnergy) * 1e4 : null, // ₹/kWh, net of other revenue
    equityFlows, projectFlows,
  };
}

/** The strike price at which the equity IRR equals the target (bisection on the equity NPV). */
export function solveStrikePrice(inputs, sim) {
  let lo = 0;
  let hi = 40;
  const f = (sp) => financials(inputs, sim, sp).equityNpv;
  if (f(hi) < 0) return { sp: null, reason: "Even ₹40/kWh does not reach the target IRR" };
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid; else hi = mid;
    if (hi - lo < 1e-6) break;
  }
  const sp = hi;
  return { sp, bid: Math.ceil(sp * 100 - 1e-9) / 100, fin: financials(inputs, sim, sp) };
}

/** Numbers for the model: the inputs with derived values, or null when something is missing. */
export function modelInputs(state) {
  if (missingInputs(state).length) return null;
  const i = { ...state.inputs };
  if (!isNum(i.windMw)) i.windMw = 0;
  if (!isNum(i.recPrice)) i.recPrice = 0;
  return i;
}

/** Simulate and solve: operations by Contract Year and the bid. */
export function runModel(state, prices, opts = {}) {
  const inputs = modelInputs(state);
  if (!inputs || !prices) return null;
  const book = priceBook(prices, inputs.sellMarket);
  const prof = profiles(inputs);
  const sim = simulate(inputs, book, prof, opts);
  const solved = solveStrikePrice(inputs, sim);
  return { inputs, sim, ...solved, book, prof };
}

/** Feasible when no day after the RE is online falls short for lack of charging energy. */
export const capShortfall = (sim) => sim.years.reduce((a, cy) => a + cy.shortMwh, 0);

/**
 * The own solar (and wind, if any) that gives the lowest strike price with every day's supply met:
 * a coarse grid then a finer one around the best, on solar; then the same on wind when wind is in
 * the bid. Calls onProgress(done, total) between evaluations; resolves to { solarMw, windMw, sp }.
 */
export async function optimiseOwnRe(state, prices, { onProgress, signal } = {}) {
  const base = modelInputs(state);
  if (!base) throw new Error("Fill in the inputs first.");
  const book = priceBook(prices, base.sellMarket);
  const X = base.contractedMw;
  const evaluate = (solarMw, windMw) => {
    const inputs = { ...base, solarMw, windMw };
    const sim = simulate(inputs, book, profiles(inputs));
    const s = solveStrikePrice(inputs, sim);
    const short = capShortfall(sim);
    return { solarMw, windMw, sp: s.sp ?? Infinity, short, ok: short < 1e-3 * X };
  };
  const better = (a, b) => (a.ok !== b.ok ? a.ok : a.sp < b.sp);
  const tick = () => new Promise((r) => { setTimeout(r, 0); });
  let best = evaluate(base.solarMw || 0, base.windMw || 0);
  const scan = async (key, values, total, done0) => {
    let done = done0;
    for (const v of values) {
      if (signal?.aborted) throw new Error("Stopped.");
      const cand = key === "solar" ? evaluate(v, best.windMw) : evaluate(best.solarMw, v);
      if (better(cand, best)) best = cand;
      done += 1;
      if (done % 4 === 0) { onProgress?.(done, total); await tick(); }
    }
    return done;
  };
  const coarse = (maxMul) => Array.from({ length: 41 }, (_, i) => Math.round((i / 40) * maxMul * X));
  const fine = (center) => Array.from({ length: 21 }, (_, i) => Math.max(0, Math.round(center + (i - 10) * 0.01 * X)));
  const hasWind = (base.windMw || 0) > 0 && isNum(base.windCuf);
  const total = 41 + 21 + (hasWind ? 62 : 0);
  let done = await scan("solar", coarse(3), total, 0);
  done = await scan("solar", fine(best.solarMw), total, done);
  if (hasWind) {
    done = await scan("wind", coarse(2), total, done);
    await scan("wind", fine(best.windMw), total, done);
  }
  onProgress?.(total, total);
  return best;
}

/** The CfD Pool at this strike price: this project's net pay-in each Contract Year (₹ cr, + = into the Pool). */
export function poolFlows(sim, sp) {
  return sim.years.map((cy) => ({ cy: cy.index, netCr: cy.mcpDeliveredCr - sp * cy.deliveredMwh * 1e-4, mcpAvg: cy.deliveredMwh > 0 ? (cy.mcpDeliveredCr * 1e4) / cy.deliveredMwh : 0 }));
}
