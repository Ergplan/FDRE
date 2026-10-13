// Checks for the CfD bid model (web/src/cfd): the tender's terms and dates, the day-by-day
// operation within the sourcing limits, the weekly penalty, the Letter of Credit, and the
// financial model's strike price. Run from the repository root:   node tools/check_cfd_model.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOCUMENTS, TENDER, TERMS, termById } from "../web/src/cfd/terms.js";
import {
  addMonths, capShortfall, contractYears, defaultCfdState, fillBenchmarks, financials, keyDates, lcCr, missingInputs, modelInputs,
  optimiseOwnRe, parseDate, penaltyCr, poolFlows, priceBook, profiles, runModel, simulate, solveStrikePrice,
} from "../web/src/cfd/model.js";

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ---- terms: every one quoted, with document and page; the amended terms are the ones applied
assert.equal(new Set(TERMS.map((t) => t.id)).size, TERMS.length, "unique term ids");
for (const t of TERMS) {
  const doc = DOCUMENTS.find((d) => d.id === t.doc);
  assert.ok(doc && Number.isInteger(t.page) && t.page >= 1 && t.page <= doc.pages, `${t.id}: page within ${t.doc}`);
  assert.ok(t.quote.split(" ").length >= 6 && t.display && t.label, `${t.id}: quote and display`);
}
assert.deepEqual(TERMS.filter((t) => t.status === "replaced").map((t) => t.id), ["ceiling", "slabs"]);
assert.equal(termById.term.doc, "amd3", "the 15-year term is Amendment-03's");
assert.equal(termById.settlement.doc, "amd3", "full CfD settlement is Amendment-03's");
assert.equal(termById.ess.doc, "amd2", "the mandatory X MW / 2X MWh battery is Amendment-02's");
assert.deepEqual([TENDER.mwhPerMwDay, TENDER.peakStart, TENDER.peakEnd, TENDER.termYears, TENDER.essScdMonths, TENDER.reCodMonths], [2, 18, 24, 15, 15, 36]);

// ---- dates
assert.equal(iso(addMonths(parseDate("2027-01-31"), 1)), "2027-02-28", "month end");
const d = keyDates("2027-02-01");
assert.deepEqual(["finClose", "scd", "lastWithPenalty", "reDeadline", "end"].map((k) => iso(d[k])), ["2027-11-01", "2028-05-01", "2028-08-01", "2030-02-01", "2043-05-01"]);
const cys = contractYears(d.scd, d.end);
assert.equal(cys.length, 16);
assert.deepEqual([cys[0].days, iso(cys[1].start), cys[15].days], [335, "2029-04-01", 30], "Contract Years run April to March");
assert.equal(cys.reduce((a, c) => a + c.days, 0), Math.round((d.end - d.scd) / 86400000));

// ---- the Letter of Credit and the weekly penalty
near(lcCr(100, 5), (2000 * 100 * 5 * 30) / 1e7, 1e-12, "LC = 2000 × MW × (10 − SP) × 30");
assert.equal(lcCr(100, 12), 0, "no LC above ₹10");
near(penaltyCr({ weeks: [{ ref: 10, beyondMwh: 100 }] }, 6), 1.5 * 4 * 100 * 1e-4, 1e-12, "1.5 × (ref − SP) × MWh beyond 10%");
assert.equal(penaltyCr({ weeks: [{ ref: 5, beyondMwh: 100 }] }, 6), 0, "no penalty when the reference is below SP");

// ---- inputs: empty until filled; the benchmarks complete them
assert.ok(missingInputs(defaultCfdState()).includes("Effective Date of the CfDA"));
const st = fillBenchmarks(defaultCfdState());
assert.deepEqual(missingInputs(st), []);
assert.equal(st.filled.solarCuf, true);
assert.equal(st.inputs.contractedMw, 100, "the bid capacity is prefilled");

// ---- operation on synthetic prices: cheap midday, dear evening
const flat = (fn) => Array.from({ length: 8760 }, (_, t) => fn(t % 24));
const synth = { markets: Object.fromEntries(["DAM", "GDAM", "RTM"].map((m) => [m, { hourlyRsPerMwh: flat((h) => (h >= 9 && h < 16 ? 2500 : h >= 18 ? 9000 : 5000)), hourOfDayMeanRsPerMwh: Array.from({ length: 24 }, (_, h) => (h >= 18 ? 9000 : 4000)) }])) };
const inputs = { ...modelInputs(st), solarMw: 60 };
const book = priceBook(synth, inputs.sellMarket);
assert.deepEqual(book.peakOrder[10].slice(0, 2), [18, 19], "ties: the earlier evening hours");
const sim = simulate(inputs, book, profiles(inputs));
for (const y of sim.years) {
  assert.ok(y.deliveredMwh <= y.requiredMwh + 1e-6, `CY ${y.index}: no more than 2 MWh/MW a day`);
  assert.ok(y.chargeMarketMwh * inputs.rte <= y.marketCapMwh + 1e-6, `CY ${y.index}: green market within its limit`);
  assert.equal(y.chargeGroupMwh, 0, "no group RE when not chosen");
  if (y.end <= sim.dates.reCod) assert.equal(y.chargeOwnMwh, 0, "no own RE before it is commissioned");
}
const late = sim.years.filter((y) => y.start >= sim.dates.extraUntil);
assert.ok(late.every((y) => y.shareMarket <= TENDER.marketShare + 1e-6), "after month 36: green market ≤ 25%");
assert.equal(capShortfall(sim), 0, "60 MW of solar is enough");
near(sim.years[3].deliveredMwh, sim.years[3].requiredMwh * inputs.availability, 1e-6, "supply = 2 MWh/MW × availability");
// too little own RE: the 25% limit binds and days fall short, penalised weekly
const thin = simulate({ ...inputs, solarMw: 5 }, book, profiles(inputs));
assert.ok(capShortfall(thin) > 0 && thin.years[5].shortDays > 0, "5 MW of solar cannot cover 75% of supply");

// ---- finance: the strike price earns exactly the target equity IRR
const s = solveStrikePrice(inputs, sim);
near(s.fin.equityIrr, inputs.targetEquityIrr, 1e-4, "equity IRR at the target");
near(s.fin.equityNpv, 0, 1e-3, "equity NPV at the target is nil");
assert.ok(s.bid >= s.sp && s.bid - s.sp < 0.01, "bid rounded up to two decimals");
near(s.fin.rows[2].cfdRevenue, s.sp * sim.years[1].deliveredMwh * 1e-4, 1e-9, "CfD revenue = SP × energy supplied");
const dearer = solveStrikePrice({ ...inputs, essCrPerMwh: inputs.essCrPerMwh * 1.2 }, sim);
assert.ok(dearer.sp > s.sp, "a dearer battery needs a higher strike price");
const fin = financials(inputs, sim, s.sp);
const capex = fin.rows.reduce((a, r) => a + (r.capex || 0), 0);
near(capex, fin.capex.total, 1e-6, "all capex is spent");
near(fin.rows.at(-1).debtClosing, 0, 1e-6, "debt repaid within the term");
const pool = poolFlows(sim, s.sp);
near(pool[1].netCr, sim.years[1].mcpDeliveredCr - s.sp * sim.years[1].deliveredMwh * 1e-4, 1e-12, "Pool: (MCP − SP) × energy");

// ---- the real IEX price year: the model solves and the optimiser meets every day's supply
const prices = JSON.parse(readFileSync(new URL("../web/public/market/iex_hourly_prices.json", import.meta.url), "utf8"));
const real = runModel(st, prices);
assert.ok(real.sp > 0 && Number.isFinite(real.fin.equityIrr));
const best = await optimiseOwnRe(st, prices);
assert.ok(best.ok && best.solarMw > 0, "a feasible own-RE size");
const opt = runModel({ ...st, inputs: { ...st.inputs, solarMw: best.solarMw } }, prices);
assert.ok(opt.sp <= real.sp + 1e-9, "the optimised size is no dearer");
assert.equal(capShortfall(opt.sim), 0);

console.log(`CfD model checks passed (strike price ₹${opt.bid.toFixed(2)}/kWh with ${best.solarMw} MW of solar on the benchmark inputs)`);
