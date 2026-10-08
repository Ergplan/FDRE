// Checks for the Tender to Bid model (web/src/bid): the tender's terms from the WBSEDCL reading,
// the inputs the bidder must give, the HiGHS request and the financial-model inputs. Run from
// the repository root:   node tools/check_bid_model.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../web/src/rtc/engine.js";
import {
  SOURCE_FIELDS, capacityIssues, defaultBidState, energyMix, lpPayload, missingInputs, modelInputs, opsFromLp, plantMw,
  resourceProfiles, scaleToCuf, solarMinMw,
} from "../web/src/bid/model.js";
import { buildProposals, isUsed, tenderTerms } from "../web/src/bid/tenderMap.js";

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

// ---- nothing is filled in for the bidder: sizing waits for every input
const blank = { ...defaultBidState(), tender: { result } };
const missing0 = missingInputs(blank, terms);
assert.ok(missing0.includes("Enter the capacity you bid"));
assert.ok(missing0.includes("Solar is required by the tender"));
assert.ok(missing0.some((m) => m.startsWith("Financing:")));
assert.deepEqual(capacityIssues({ ...blank, bid: { baseMw: 1000, greenshoe: false } }, terms), ["The tender allows no part capacity: the bid must be 1500 MW"]);
for (const id of Object.keys(blank.src)) {
  for (const f of SOURCE_FIELDS[id]) assert.equal(blank.src[id][f.key], null, `${id}.${f.key} starts empty`);
}

// ---- a complete bid: every number below is the bidder's (test values)
const filled = (() => {
  const s = defaultBidState();
  s.tender = { result };
  s.bid = { baseMw: 1500, greenshoe: true };
  s.sources = { solar: true, wind: true, hydro: true, biomass: true, thermal: true, bess: true };
  s.src.solar = { capacity: { mode: "optimise", mw: 8000 }, cuf: 0.26, dcAc: 1.4, degradation: 0.005, capex: 3.6, om: 4 };
  s.src.wind = { capacity: { mode: "optimise", mw: 4000 }, cuf: 0.35, capex: 6.8, om: 9 };
  s.src.hydro = { capacity: { mode: "fixed", mw: 300 }, cuf: 0.45, availability: 1, capex: 0, fixed: 150, energy: 1.2, escalation: 0.02, monthlyCuf: null };
  s.src.biomass = { capacity: { mode: "optimise", mw: 500 }, availability: 0.9, cuf: 0.8, minLoad: 0.3, capex: 7, om: 35, fuel: 4, fuelEscalation: 0.04 };
  s.src.thermal = { capacity: { mode: "optimise", mw: 800 }, availability: 0.85, cuf: 0.85, minLoad: 0, capex: 0, fixed: 120, energy: 3, rec: 0.15, escalation: 0.03 };
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
