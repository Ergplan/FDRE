// Checks for the Tender to Bid model (web/src/bid): the tender's terms from the WBSEDCL reading,
// the inputs the bidder must give, the HiGHS request and the financial-model inputs. Run from
// the repository root:   node tools/check_bid_model.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../web/src/rtc/engine.js";
import {
  BENCHMARKS, SOURCE_FIELDS, capacityIssues, capacityWarnings, defaultBidState, energyMix, fillBenchmarks, lpPayload, missingInputs,
  modelInputs, opsFromLp, plantMw, resourceProfiles, scaleToCuf, solarMinMw,
} from "../web/src/bid/model.js";
import { buildProposals, isUsed, mergeReadings, tenderDates, tenderTerms } from "../web/src/bid/tenderMap.js";

// ---- the tender's terms, from the built-in WBSEDCL reading (nothing else)
const { result } = JSON.parse(readFileSync(new URL("../web/db/seed/tenders/wbsedcl-re-rtc-2026-01.json", import.meta.url), "utf8"));
const terms = tenderTerms(result);
assert.equal(terms.baseMw, 1500);
assert.equal(terms.greenshoeMw, 500);
assert.equal(terms.partAllowed, false, "no part capacity (p. 12)");
assert.equal(terms.greenshoeStart, "2029-04-01");
assert.equal(terms.greenshoeSameTariff, true);
assert.deepEqual(terms.rules.map((r) => [r.id, r.target, r.basis, r.hours]), [["annual", 0.8, "annual", "all"], ["monthly", 0.7, "monthly", "all"], ["peak", 0.9, "monthly", "any"]]);
assert.equal(terms.peak.hours, 4);
assert.equal(terms.peak.setBy, "procurer");
assert.deepEqual(terms.permitted, { solar: true, wind: true, hydro: true, biomass: true, thermal: true, bess: true });
assert.equal(terms.greenMin, 0.51);
assert.equal(terms.solarMultiple, 2);
assert.equal(terms.mandatory.solar, true);
assert.equal(terms.mandatory.bess, false);
assert.equal(terms.sale, "mandated_solar");
assert.equal(terms.years, 25);
assert.equal(terms.ceiling, null, "the tender states no ceiling tariff");
assert.equal(terms.emdPerMw, 100000);
assert.equal(terms.pbgPerMw, 2000000);
const solarRow = buildProposals(result).find((x) => x.id === "solar.min");
assert.equal(solarRow.display, "2 × the contracted capacity: 3 GW for the base capacity, 1 GW more if the greenshoe is exercised; anywhere in India");
assert.ok(/3 GW corresponding to the Base Supply Capacity/.test(solarRow.source.quote) && /anywhere in India/.test(solarRow.source.quote), "the full requirement is quoted");
// every date the tender prints, for the calendar
const dates = tenderDates(result);
assert.deepEqual(dates.map((d) => d.date), ["2026-09-23", "2026-10-05", "2026-10-07", "2026-10-09", "2026-10-14", "2026-10-27", "2026-11-02", "2026-11-06", "2026-11-20", "2026-12-16", "2027-09-30", "2028-07-01", "2029-04-01"]);
assert.ok(dates.every((d) => d.source?.page && d.source?.quote), "each date has its page and quote");
assert.equal(dates.find((d) => d.kind === "deadline").date, "2026-10-27");
for (const p of buildProposals(result).filter((x) => x.stated)) {
  assert.ok(p.source?.page && p.source?.quote, `${p.id} carries its page and quote`);
}
// a value the page does not prove is applied only when ticked
const tampered = JSON.parse(JSON.stringify(result));
const monthly = tampered.sections.flatMap((s) => s.fields).find((f) => f.path === "sector.power.fdre.monthly_supply_min_pct");
monthly.issues = [{ rule: "value_in_quotes", message: "not printed", warning: false }];
const t2 = tenderTerms(tampered);
assert.ok(!t2.rules.some((r) => r.id === "monthly"), "an unproved floor is not applied");
assert.ok(tenderTerms(tampered, { "rule.monthly": true }).rules.some((r) => r.id === "monthly"), "applied once ticked");
assert.equal(isUsed({ stated: true, source: { proved: true }, id: "x" }, { x: false }), false, "a proved term can be unticked");

// ---- a first round: the tender's 1,500 MW, solar + biomass + battery sized by the optimizer; parameters empty
const blank = { ...defaultBidState(), tender: { result } };
assert.deepEqual(blank.bid, { baseMw: 1500, greenshoe: false });
assert.deepEqual(Object.entries(blank.sources).filter(([, v]) => v).map(([k]) => k), ["solar", "biomass", "bess"]);
assert.equal(blank.src.solar.capacity.mode, "optimise");
assert.deepEqual(capacityIssues(blank, terms), []);
assert.deepEqual(capacityWarnings(blank, terms), [], "1,500 MW is the tender's capacity");
assert.deepEqual(capacityWarnings({ ...blank, bid: { baseMw: 250, greenshoe: false } }, terms), ["The tender allows no part capacity: a compliant bid is 1500 MW"]);
const missing0 = missingInputs(blank, terms);
assert.ok(missing0.includes("Solar: cuf (ac)"), missing0.join("; "));
assert.ok(missing0.some((m) => m.startsWith("Financing:")));
assert.ok(!missing0.some((m) => /largest capacity|enter the capacity/.test(m)), "optimised sizes need no limit");
for (const id of Object.keys(blank.src)) {
  for (const f of SOURCE_FIELDS[id]) assert.equal(blank.src[id][f.key], null, `${id}.${f.key} starts empty`);
}
// "Fill up for me please": benchmarks in every empty field, marked; entered values kept
const typed = { ...blank, src: { ...blank.src, solar: { ...blank.src.solar, cuf: 0.27 } } };
const quick = fillBenchmarks(typed, terms);
assert.deepEqual(missingInputs(quick, terms), [], "one click completes a round");
assert.equal(quick.src.solar.cuf, 0.27, "a value the bidder typed is kept");
assert.equal(quick.filled["solar.cuf"], undefined);
assert.equal(quick.src.biomass.fuel, BENCHMARKS.biomass.fuel);
assert.equal(quick.filled["biomass.fuel"], true, "benchmark values are marked");
assert.equal(quick.fin.targetEquityIrr, BENCHMARKS.fin.targetEquityIrr);
assert.equal(quick.market.sell, false, "market sale left off by the benchmarks");
assert.equal(quick.src.thermal.minLoad, 0.55, "thermal technical minimum 55% (IEGC)");
assert.equal(quick.src.thermal.ramp, 0.01, "thermal ramp 1%/min");
const qp = lpPayload(quick, terms, resourceProfiles(quick));
assert.equal(qp.ctx.demand[0], 1500);
assert.equal(qp.vars.solarMw.min, 3000, "tender solar minimum: 3 GW for the 1,500 MW base");
assert.equal(qp.costs.solarCrPerMw, 4.0, "solar benchmark ₹4 cr/MWac");
assert.equal(qp.biomass.minLoad, 0.55, "biomass technical minimum 55% (IEGC)");
assert.ok(Math.abs(qp.biomass.rampPerHour - 0.6) < 1e-9, "1%/min ramp = 60% of capacity per hour");
assert.equal(qp.vars.solarMw.max, 18000, "automatic limit 12 × contracted");
assert.equal(qp.vars.biomassMw.max, 1500);
assert.equal(qp.vars.bessMw.max, 6000);
assert.equal(qp.vars.bessMwh.max, 24000);
const withGs = lpPayload({ ...quick, bid: { baseMw: 1500, greenshoe: true } }, terms, resourceProfiles(quick));
assert.equal(withGs.vars.solarMw.min, 4000, "4 GW when the greenshoe is exercised");
assert.deepEqual(qp.vars.windMw, { locked: true, value: 0 });
assert.equal(qp.plants, undefined, "no hydro or thermal by default");

// ---- reading merge: the rule-based fields stay, the model fills the rest
const modelReading = JSON.parse(JSON.stringify(result));
modelReading.mode = "llm"; modelReading.model = "gpt-test"; modelReading.provider = "openai";
const mf = Object.fromEntries(modelReading.sections.flatMap((s) => s.fields).map((f) => [f.path, f]));
Object.assign(mf["sector.power.fdre.availability_shortfall_penalty"], { status: "validated", value: "A penalty clause", evidence: [{ page: 20, quote: "q", located: true }] });
modelReading.values["sector.power.fdre.availability_shortfall_penalty"] = "A penalty clause";
Object.assign(mf["sector.power.common.total_capacity_mw"], { value: 999 }); // a model value for a field the rules found
modelReading.values["sector.power.common.total_capacity_mw"] = 999;
const merged = mergeReadings(result, modelReading);
assert.equal(merged.mode, "rules+llm");
assert.equal(merged.values["sector.power.fdre.availability_shortfall_penalty"], "A penalty clause");
assert.equal(merged.values["sector.power.common.total_capacity_mw"], 1500, "the rule-based value wins where both read it");
assert.equal(merged.counts.found, result.counts.found + 1);
assert.equal(merged.merged.fromModel, 1);
assert.equal(tenderTerms(merged).baseMw, 1500);

// ---- a complete bid: every number below is the bidder's (test values)
const filled = (() => {
  const s = defaultBidState();
  s.tender = { result };
  s.bid = { baseMw: 1500, greenshoe: true };
  s.sources = { solar: true, wind: true, hydro: true, biomass: true, thermal: true, bess: true };
  s.src.solar = { capacity: { mode: "optimise", mw: 8000 }, cuf: 0.26, dcAc: 1.4, degradation: 0.005, capex: 3.6, om: 4 };
  s.src.wind = { capacity: { mode: "optimise", mw: 4000 }, cuf: 0.35, capex: 6.8, om: 9 };
  s.src.hydro = { capacity: { mode: "fixed", mw: 300 }, cuf: 0.45, availability: 1, capex: 0, fixed: 150, energy: 1.2, escalation: 0.02, monthlyCuf: null };
  s.src.biomass = { capacity: { mode: "optimise", mw: 500 }, availability: 0.9, cuf: 0.8, minLoad: 0.3, ramp: 0.005, capex: 7, om: 35, fuel: 4, fuelEscalation: 0.04 };
  s.src.thermal = { capacity: { mode: "optimise", mw: 800 }, availability: 0.85, cuf: 0.85, minLoad: 0, ramp: 0.01, capex: 0, fixed: 120, energy: 3, rec: 0.15, escalation: 0.03 };
  s.src.bess = { capacity: { mode: "optimise", mw: 3000 }, duration: "4", rte: 0.87, minSoc: 0.05, maxSoc: 0.95, degradation: 0.02, augmentation: "annual", capex: 1.2, om: 1.2 };
  s.fin = { ...s.fin, targetEquityIrr: 0.14, debtFraction: 0.7, interestRate: 0.09, tenorYears: 15, taxRate: 0.2517, omEscalation: 0.05, insurancePct: 0.003, tariffEscalation: 0 };
  s.costs = { preopPct: 0.05, evacuationCr: 0 };
  s.market = { sell: true, source: "flat", escalation: 0, flatPrice: 2.5 };
  return s;
})();
assert.deepEqual(missingInputs(filled, terms), []);
assert.equal(plantMw(filled, terms), 2000);
assert.equal(solarMinMw(filled, terms), 4000);
assert.ok(missingInputs({ ...filled, src: { ...filled.src, solar: { ...filled.src.solar, capacity: { mode: "fixed", mw: 3000 } } } }, terms)
  .some((m) => m.includes("at least 4000 MW")), "solar below the tender minimum is refused");

// ---- the HiGHS request uses the tender's constraints and the bidder's numbers only
const profiles = resourceProfiles(filled);
const meanCf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
assert.ok(Math.abs(meanCf(profiles.solarCf) - 0.26) < 1e-3, "solar profile at the bidder's CUF");
assert.ok(Math.abs(meanCf(profiles.windCf) - 0.35) < 1e-3, "wind profile at the bidder's CUF");
assert.ok(Math.abs(meanCf(scaleToCuf(new Float64Array([0.1, 0.9, 0.5, 0.0]), 0.5)) - 0.5) < 1e-6);
const payload = lpPayload(filled, terms, profiles);
assert.equal(payload.ctx.demand[100], 2000);
assert.deepEqual(payload.compliance.map((r) => [r.id, r.target, r.hours]), [["annual", 0.8, "all"], ["monthly", 0.7, "all"], ["peak", 0.9, "any"]]);
assert.equal(payload.peakMask, undefined, "the procurer picks the hours: every hour of the day is checked");
assert.equal(payload.vars.solarMw.min, 4000);
assert.equal(payload.vars.solarMw.max, 8000);
assert.deepEqual(payload.vars.hydroMw, { locked: true, value: 300 });
assert.equal(payload.vars.bessMwh.max, 3000 * 4);
assert.equal(payload.greenShareMin, 0.51, "non-RE in the bid: the tender's green share applies");
assert.deepEqual(payload.plants.map((p) => [p.id, p.green, p.cuf, p.recRsPerKwh]), [["hydro", true, 0.45, 0], ["thermal", false, 0.85, 0.15]]);
assert.equal(payload.biomass.maxPlf, 0.8);
assert.ok(Math.abs(payload.biomass.rampPerHour - 0.3) < 1e-9, "0.5%/min = 30% per hour");
assert.ok(Math.abs(payload.plants.find((p) => p.id === "thermal").rampPerHour - 0.6) < 1e-9);
assert.equal(payload.ppaFirst, true);
assert.equal(payload.exportSources, "solar", "only the mandated solar may be sold");
assert.equal(payload.ctx.extraExportMw, 8000);
assert.equal(payload.fin.surplusPrice, 2.5);
assert.equal(payload.costs.plants, undefined, "plant costs travel in plants[]");
assert.equal(payload.fin.years, 25);
const noThermal = lpPayload({ ...filled, sources: { ...filled.sources, thermal: false } }, terms, profiles);
assert.equal(noThermal.greenShareMin, undefined, "all-renewable bid: nothing to cap");
assert.equal(noThermal.vars.thermalMw, undefined);
const noSale = lpPayload({ ...filled, market: { ...filled.market, sell: false } }, terms, profiles);
assert.equal(noSale.ctx.sellSurplus, false);

// ---- financial model from the LP's lifetime energy, with hydro and thermal costs
const m = modelInputs(filled, terms);
const lp = {
  sizes: { solarMw: 4000, windMw: 1200, bessMw: 900, bessMwh: 3600, biomassMw: 200, hydroMw: 300, thermalMw: 600 },
  tariff: 5, years: [1], perYear: [{ year: 1, dfr: 0.82, minMonthlyDfr: 0.71 }],
  lifetime: Array.from({ length: 25 }, (_, i) => ({ year: i + 1, demandMwh: 2000 * 8760, deliveredMwh: 0.82 * 2000 * 8760, exportMwh: 1e6, biomassMwh: 1.2e6, hydroMwh: 1.1e6, thermalMwh: 3e6 })),
};
const ops = opsFromLp(lp, m.fin, m.bess);
assert.equal(ops[0].hydroMWh, 1.1e6);
const fin = E.runFinancialModel(null, lp.sizes, { costs: m.costs, fin: m.fin, bess: m.bess, dfrTarget: 0.8, ops, solveBy: "npv" });
const thermal1 = (600 * 120) / 100 + (3e6 * (3 + 0.15)) / 1e4;
assert.ok(Math.abs(fin.rows[0].thermalCost - thermal1) < 1e-6, "thermal: capacity charge + energy + RECs");
assert.ok(Math.abs(fin.rows[1].thermalCost - thermal1 * 1.03) < 1e-6, "thermal cost escalates");
const hydro1 = (300 * 150) / 100 + (1.1e6 * 1.2) / 1e4;
assert.ok(Math.abs(fin.rows[0].hydroCost - hydro1) < 1e-6);
assert.ok(Math.abs(fin.capex.hard - (4000 * 3.6 + 1200 * 6.8 + 3600 * 1.2 + 200 * 7)) < 1e-6, "contracted hydro and thermal have no capex here");
assert.ok(Math.abs(fin.rows[0].surplusRevenue - 1e6 * 2.5 * 1e-4) < 1e-9, "flat sale price");
assert.ok(Math.abs(fin.equityIrr - 0.14) < 1e-6, "bid tariff gives the bidder's equity IRR");
const cheaper = E.runFinancialModel(null, lp.sizes, { costs: { ...m.costs, plants: m.costs.plants.map((p) => (p.id === "thermal" ? { ...p, recRsPerKwh: 0 } : p)) }, fin: m.fin, bess: m.bess, dfrTarget: 0.8, ops, solveBy: "npv" });
assert.ok(fin.tariff > cheaper.tariff, "RECs raise the bid tariff");

// energy mix splits direct delivery over every source's generation
const hourly = { solar: [60, 0], wind: [20, 50], biomass: [0, 0], hydro: [20, 0], thermal: [0, 50], direct: [100, 80], discharge: [0, 20], charge: [0, 0], export: [0, 0], curtail: [0, 20], demand: [100, 100] };
const mix = energyMix(hourly);
assert.ok(Math.abs(mix.solar - 60) < 1e-9 && Math.abs(mix.wind - 60) < 1e-9 && Math.abs(mix.hydro - 20) < 1e-9 && Math.abs(mix.thermal - 40) < 1e-9 && mix.battery === 20);

console.log("Tender to Bid model checks passed");
