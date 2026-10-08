// Checks for the Tender to Bid model (web/src/bid): tender fields -> model inputs, the HiGHS
// request and the financial-model inputs. Run from the repository root:
//   node tools/check_bid_model.mjs [tender_intel_result.json]
// With a result file (from POST /api/bid/tender/read?sync=1) it also prints what that tender sets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../web/src/rtc/engine.js";
import { defaultBidState, energyMix, lpPayload, opsFromLp, peakHours, peakLabel, peakMask, resourceProfiles } from "../web/src/bid/model.js";
import { applyProposals, buildProposals } from "../web/src/bid/tenderMap.js";

// a tender_intel result as the engine returns it (only what the mapping reads)
const field = (path, label, value, page, quote, status = "validated") => ({
  path, key: path.split(".").pop(), label, value, status, confidence: 0.6,
  evidence: [{ page, quote, located: status === "validated", method: "exact", score: 100, resolution: "stated_page", bbox: null }], issues: [],
});
const fields = [
  field("sector.power.common.total_capacity_mw", "Total capacity", 1500, 10, "supply of 1500MW (“Base Supply Capacity”)"),
  field("sector.power.common.greenshoe_capacity_mw", "Greenshoe capacity", 500, 10, "with 500 MW greenshoe option"),
  field("sector.power.common.ppa_tenure_years", "PPA tenure", 25, 10, "for a period of 25 (twenty-five) years"),
  field("sector.power.common.location_constraint", "Location constraint", "ists_anywhere", 11, "anywhere in India"),
  field("sector.power.fdre.annual_supply_min_pct", "Annual supply floor", 80, 10, "Supply of minimum 80% CUF for each Accounting Year"),
  field("sector.power.fdre.monthly_supply_min_pct", "Monthly supply floor", 70, 10, "minimum 70% CUF on monthly basis"),
  field("sector.power.fdre.peak_supply_min_pct", "Peak supply floor", 90, 10, "Supply of minimum 90% CUF during Peak hours", "needs_review"),
  field("sector.power.fdre.peak_hours_per_day", "Peak hours", 4, 10, "Discharging 4 Hours Daily"),
  field("sector.power.fdre.biomass_permitted", "Biomass permitted", true, 9, "(Solar, Wind, Hydro, Biomass,)"),
  field("sector.power.fdre.min_solar_capacity_multiple", "Solar multiple", 2, 11, "Solar Power Capacity equivalent to twice the contracted Supply Capacity"),
  field("sector.power.fdre.green_share_min_pct", "Green share", 51, 10, "a minimum 51% shall be Traceable Green Power"),
  field("core.guarantees.emd_per_mw_inr", "EMD per MW", 100000, 5, "Amount of ₹1,00,000/- (Indian rupees One Lakh only) per MW"),
  field("core.guarantees.pbg_per_mw_inr", "PBG per MW", 2000000, 5, "Rupees Twenty Lakh only per MW"),
  { ...field("sector.power.common.tariff_ceiling_inr_per_kwh", "Ceiling tariff", null, 1, ""), status: "not_found", value: null, evidence: [] },
];
const synthetic = {
  mode: "rules", tender_type: "fdre",
  sections: [{ name: "all", label: "All", fields }],
  values: Object.fromEntries(fields.filter((f) => f.value !== null).map((f) => [f.path, f.value])),
};

const proposals = buildProposals(synthetic);
const byId = Object.fromEntries(proposals.map((p) => [p.id, p]));
assert.equal(byId.plantMw.value, 1500);
assert.match(byId.plantMw.note, /Greenshoe/);
assert.equal(byId["rule.annual"].value, 0.8);
assert.equal(byId["rule.monthly"].value, 0.7);
assert.equal(byId["rule.peak"].value, 0.9);
assert.equal(byId["rule.peak"].source.status, "needs_review");
assert.equal(byId["peak.hours"].value, 4);
assert.equal(byId["sources.biomass"].value, true);
assert.equal(byId.ceiling.stated, false, "an unstated field is not proposed");
assert.equal(byId["rule.annual"].source.page, 10);

const base = defaultBidState();
const applied = applyProposals(base, proposals, {});
assert.equal(applied.plantMw, 1500);
assert.equal(applied.fin.years, 25);
assert.deepEqual(applied.rules.map((r) => [r.id, r.target, r.enabled]), [["annual", 0.8, true], ["monthly", 0.7, true], ["peak", 0.9, true]]);
assert.equal(applied.peak.hours, 4);
assert.equal(applied.vars.solarMw.min, 3000, "solar at least twice the contracted capacity");
assert.ok(applied.vars.solarMw.max >= 4500);
assert.equal(applied.fin.sellSurplus, true);
assert.equal(applied.guarantees.emdPerMwInr, 100000);
assert.equal(applied.ceilingTariff, null);
assert.equal(applied.provenance["rule.annual"].quote, "Supply of minimum 80% CUF for each Accounting Year");
assert.ok(applied.notes.some((n) => n.id === "green"), "facts that are not modelled are listed");
// a proposal the reviewer unticks is not applied
const skipped = applyProposals(base, proposals, { "rule.monthly": false, plantMw: false });
assert.equal(skipped.plantMw, base.plantMw);
assert.equal(skipped.rules.find((r) => r.id === "monthly").enabled, false);

// peak window and the HiGHS request
assert.deepEqual(peakHours({ start: 22, hours: 4 }), [22, 23, 0, 1]);
assert.equal(peakLabel({ start: 18, hours: 4 }), "18:00–22:00");
const mask = peakMask({ start: 18, hours: 4 });
assert.equal(mask.reduce((a, b) => a + b, 0), 365 * 4);
const payload = lpPayload(applied, resourceProfiles(applied));
assert.equal(payload.ctx.demand.length, E.HOURS);
assert.equal(payload.ctx.demand[100], 1500);
assert.equal(payload.compliance.length, 3);
assert.equal(payload.peakMask.length, E.HOURS);
assert.ok(payload.vars.biomassMw && payload.biomass, "biomass offered when the tender allows it");
assert.equal(payload.vars.solarMw.min, 3000);
assert.equal(payload.returnLifetime, true);
const noBio = lpPayload({ ...applied, sources: { ...applied.sources, biomass: false, wind: false } }, resourceProfiles(applied));
assert.equal(noBio.vars.biomassMw, undefined);
assert.deepEqual(noBio.vars.windMw, { locked: true, value: 0 });

// financial model from LP lifetime energy: fuel cost flows into opex
const lp = {
  sizes: { solarMw: 3000, windMw: 900, bessMw: 400, bessMwh: 1600, biomassMw: 150 },
  tariff: 5, years: [1], perYear: [{ year: 1, dfr: 0.82, minMonthlyDfr: 0.71 }],
  lifetime: Array.from({ length: 25 }, (_, i) => ({ year: i + 1, demandMwh: 1500 * 8760, deliveredMwh: 0.82 * 1500 * 8760, exportMwh: 1e6, biomassMwh: 150 * 8760 * 0.7 })),
};
const ops = opsFromLp(lp, applied.fin, applied.bess);
assert.equal(ops.length, 25);
assert.ok(Math.abs(ops[0].dfr - 0.82) < 1e-9);
const finance = E.runFinancialModel(null, lp.sizes, { costs: applied.costs, fin: applied.fin, bess: applied.bess, dfrTarget: 0.8, ops, solveBy: "npv" });
const fuel1 = (150 * 8760 * 0.7 * applied.fin.biomassFuelRsPerKwh) / 1e4;
assert.ok(Math.abs(finance.rows[0].fuel - fuel1) < 1e-6, "year-1 fuel = MWh × Rs/kWh");
assert.ok(finance.rows[1].fuel > finance.rows[0].fuel, "fuel escalates");
assert.ok(Math.abs(finance.capex.hard - (3000 * 3.5 + 900 * 6.5 + 1600 * 1.2 + 150 * applied.costs.biomassCrPerMw)) < 1e-6, "biomass capex counted");
const noFuel = E.runFinancialModel(null, lp.sizes, { costs: applied.costs, fin: { ...applied.fin, biomassFuelRsPerKwh: 0 }, bess: applied.bess, dfrTarget: 0.8, ops, solveBy: "npv" });
assert.ok(Math.abs(finance.equityIrr - applied.fin.targetEquityIrr) < 1e-6, "bid tariff gives the target equity IRR");
assert.ok(finance.tariff > 1 && finance.tariff < 10, `bid tariff in range (${finance.tariff})`);
// fuel per delivered kWh, before tax and escalation, is a floor on how much it raises the tariff
assert.ok(finance.tariff - noFuel.tariff > (0.7 * 150 * 8760 * applied.fin.biomassFuelRsPerKwh) / (0.82 * 1500 * 8760) * 0.6, "fuel raises the bid tariff");

// energy mix splits direct delivery by generation shares
const hourly = { solar: [60, 0], wind: [20, 50], biomass: [20, 50], direct: [100, 80], discharge: [0, 20], charge: [0, 0], export: [0, 0], curtail: [0, 20], demand: [100, 100] };
const mix = energyMix(hourly);
assert.ok(Math.abs(mix.solar - 60) < 1e-9 && Math.abs(mix.wind - 60) < 1e-9 && Math.abs(mix.biomass - 60) < 1e-9 && mix.battery === 20);

console.log("Tender to Bid model checks passed");

const file = process.argv[2];
if (file) {
  const result = JSON.parse(readFileSync(file, "utf8"));
  for (const p of buildProposals(result)) {
    console.log(`${p.stated ? "✓" : "·"} ${p.group.padEnd(17)} ${p.label.padEnd(36)} ${String(p.display ?? "not stated").padEnd(34)} ${p.source ? `p.${p.source.page} ${p.source.status}` : ""}`);
  }
}
