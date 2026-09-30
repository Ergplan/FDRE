// Checks for the BESS tender bid engine (web/src/bess/engine.js).
// Run from the repository root: node tools/check_bess_engine.mjs
import assert from "node:assert/strict";
import * as B from "../web/src/bess/engine.js";

const req = { ...B.DEFAULT_REQ, powerMw: 500, energyMwh: 1000, contractYears: 12, vgfLakhPerMwh: 18, ceilingTariff: 380000 };
const { DEFAULT_TECH: tech, DEFAULT_COSTS: costs, DEFAULT_FIN: fin } = B;

// every strategy keeps the contracted energy in every year (planned or unplanned augmentation)
for (const s of [{ oversize: 0, interval: 0 }, { oversize: 0.2, interval: 5 }, { oversize: 0.5, interval: 0 }, { oversize: 0, interval: 1 }]) {
  const r = B.evaluate(req, tech, costs, fin, s);
  assert.ok(r.minMarginMwh >= -1e-6, `energy met every year for ${JSON.stringify(s)}`);
  assert.ok(Math.abs(r.equityIrr - fin.targetEquityIrr) < 1e-4, "capacity charge gives the target equity IRR");
  assert.equal(r.plan.years.length, 12);
}
// oversize 0 = just enough for year 1
const p0 = B.buildPlan(req, tech, { oversize: 0, interval: 0 });
assert.ok(Math.abs(p0.years[0].endPoiMwh - req.energyMwh) < 1e-6, "zero oversize meets year 1 exactly");

// the optimizer's answer is no worse than any strategy on its grid
const o = B.optimize(req, tech, costs, fin);
assert.ok(o.cells.every((c) => o.best.chargeLakh <= c.z + 1e-9), "optimum is the lowest charge on the grid");
assert.equal(o.cells.length, o.axes.solarGrid.length * o.axes.windGrid.length);
console.log(`optimum: oversize ${(o.best.strategy.oversize * 100).toFixed(2)}%, augment every ${o.best.strategy.interval || "-"} yr, ₹${o.best.chargeLakh.toFixed(3)} lakh/MW/month · ${o.evals} strategies in ${o.ms} ms`);

// economics move the right way
const base = B.evaluate(req, tech, costs, fin, o.best.strategy).charge;
assert.ok(B.evaluate({ ...req, vgfLakhPerMwh: 0 }, tech, costs, fin, o.best.strategy).charge > base, "VGF lowers the charge");
assert.ok(B.evaluate(req, tech, { ...costs, dcCrPerMwh: costs.dcCrPerMwh * 1.2 }, fin, o.best.strategy).charge > base, "dearer cells raise the charge");
assert.ok(B.evaluate(req, { ...tech, calendarFade: tech.calendarFade * 2 }, costs, fin, o.best.strategy).augMwh > o.best.augMwh, "faster fade needs more augmentation");
// cheap augmentation campaigns favour frequent augmentation; expensive ones favour oversizing
const pricey = B.optimize(req, tech, { ...costs, augEventCr: 40 }, fin).best.strategy;
assert.ok(pricey.oversize > o.best.strategy.oversize || (pricey.interval || 99) > (o.best.strategy.interval || 99), "costly campaigns shift to oversizing / fewer campaigns");
console.log(`costly campaigns (₹40 cr each): oversize ${(pricey.oversize * 100).toFixed(1)}%, augment every ${pricey.interval || "-"} yr`);

// compliance and RTE
const items = B.compliance(req, tech, o.best);
assert.ok(items.find((i) => i.label === "Energy every year").ok);
assert.equal(items.find((i) => i.label === "Ceiling tariff").ok, o.best.charge <= req.ceilingTariff);
const weak = B.evaluate({ ...req, minRte: 0.9 }, tech, costs, fin, o.best.strategy);
assert.ok(weak.rows.some((r) => r.rtePenalty > 0) && weak.charge > base, "RTE below the tender minimum is compensated and priced");
const day = B.typicalDay(req, tech, o.best, 1);
assert.ok(Math.max(...day.soc) <= 1 + 1e-9 && day.power.filter((v) => v > 0).length === 2 * Math.ceil(req.energyMwh / req.powerMw));
console.log("BESS engine checks passed");
