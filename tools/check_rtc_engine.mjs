// Smoke/consistency checks for the RTC engine (web/src/rtc/engine.js).
// Run from the repository root: node tools/check_rtc_engine.mjs
import assert from "node:assert/strict";
import {
  HOURS, DEFAULT_RTC_INPUTS, DEFAULT_BESS, DEFAULT_COSTS, DEFAULT_FINANCE, DEFAULT_VARS,
  synthSolarCf, synthWindCf, buildDemand, buildContext, buildModel, simulate, optimize,
  runFinancialModel, parseProfileCsv, mean, irr,
} from "../web/src/rtc/engine.js";

const inputs = DEFAULT_RTC_INPUTS;
const solarCf = synthSolarCf({ targetCuf: inputs.solarCuf, dcAc: inputs.solarDcAc });
const windCf = synthWindCf({ targetCuf: inputs.windCuf });
assert.equal(solarCf.length, HOURS);
assert.ok(Math.abs(mean(solarCf) - inputs.solarCuf) < 1e-4, "solar CUF calibrated");
assert.ok(Math.abs(mean(windCf) - inputs.windCuf) < 1e-4, "wind CUF calibrated");

const demand = buildDemand({ annualEnergyMu: inputs.annualEnergyMu });
const total = demand.reduce((a, b) => a + b, 0);
assert.ok(Math.abs(total - 2455e3) < 1e-3, "demand sums to annual energy");

const ctx = buildContext({ demand, solarCf, windCf, plantMw: inputs.plantCapacityMw, bess: DEFAULT_BESS });
const t0 = performance.now();
const r = simulate(ctx, { solarMw: 500, windMw: 350, bessMw: 150, bessMwh: 600 });
const simMs = performance.now() - t0;
// energy balance: generation = direct + charge + excess + curtail; delivered = direct + discharge
const gen = r.solarGenMWh + r.windGenMWh;
const balance = r.solarDirectMWh + r.windDirectMWh + r.chargeMWh + r.excessMWh + r.curtailMWh;
assert.ok(Math.abs(gen - balance) < 1e-3 * gen, "generation balance");
assert.ok(Math.abs(r.deliveredMWh - (r.solarDirectMWh + r.windDirectMWh + r.dischargeMWh)) < 1e-3, "delivery balance");
assert.ok(r.dischargeMWh <= r.chargeMWh * DEFAULT_BESS.rte + 600, "BESS discharge bounded by RTE");
console.log(`simulate: ${simMs.toFixed(2)} ms, DFR ${(r.dfr * 100).toFixed(2)}%, cycles ${r.cycles.toFixed(0)}`);

// surplus: curtailed unless sold; selling exports through spare plant capacity + extra export MW
const reasons = r.curtailReasons;
assert.ok(Math.abs(reasons.batteryFull + reasons.batteryPower + reasons.noStorage - r.curtailMWh) < 1e-3, "curtailment reasons add up");
assert.equal(r.excessMWh, 0, "no export when surplus sales are off");
const ctxSell = buildContext({ demand, solarCf, windCf, plantMw: inputs.plantCapacityMw, bess: DEFAULT_BESS, sellSurplus: true, extraExportMw: 100 });
const rs = simulate(ctxSell, { solarMw: 500, windMw: 350, bessMw: 150, bessMwh: 600 });
assert.ok(rs.excessMWh > 0 && rs.curtailMWh < r.curtailMWh, "selling with export capacity converts curtailment into exports");
assert.ok(Math.abs(rs.excessMWh + rs.curtailMWh - r.curtailMWh) < 1e-3, "sold + curtailed = surplus");
assert.ok(Math.abs(rs.deliveredMWh - r.deliveredMWh) < 1e-6, "selling surplus never changes supply to the customer");
const bt = r.byTech;
assert.ok(Math.abs(bt.solar.direct + bt.solar.charge + bt.solar.export + bt.solar.curtail - r.solarGenMWh) < 1e-2, "solar flows add up");
assert.ok(Math.abs(bt.wind.direct + bt.wind.charge + bt.wind.export + bt.wind.curtail - r.windGenMWh) < 1e-2, "wind flows add up");
console.log(`surplus: ${(r.curtailMWh / 1000).toFixed(1)} MU curtailed when not sold; with sales + 100 MW extra export ${(rs.excessMWh / 1000).toFixed(1)} MU sold, ${(rs.curtailMWh / 1000).toFixed(1)} MU curtailed`);

// monotonicity: more storage never reduces DFR
const r2 = simulate(ctx, { solarMw: 500, windMw: 350, bessMw: 150, bessMwh: 900 });
assert.ok(r2.dfr >= r.dfr - 1e-9, "DFR monotone in MWh");

const model = buildModel({ inputs, costs: DEFAULT_COSTS, fin: DEFAULT_FINANCE, bess: DEFAULT_BESS, vars: DEFAULT_VARS });
const t1 = performance.now();
const opt = optimize(ctx, model);
console.log(`optimize: ${opt.evals} evaluations in ${(performance.now() - t1).toFixed(0)} ms`);
console.log("best", opt.best.sizes, `DFR ${(opt.best.dfr * 100).toFixed(2)}% (check ${(opt.best.dfrCheck * 100).toFixed(2)}%)`, `LCOE ${opt.best.lcoe.toFixed(3)} Rs/kWh`, `capex ${opt.best.capexCr.toFixed(0)} cr`);
assert.ok(opt.feasible, "optimizer finds a feasible design");
assert.equal(opt.best.sizes.bessMwh, opt.best.sizes.bessMw * DEFAULT_BESS.durationH, "battery energy follows the chosen duration");
const opt2h = optimize(ctx, buildModel({ inputs, costs: DEFAULT_COSTS, fin: DEFAULT_FINANCE, bess: { ...DEFAULT_BESS, durationH: 2 }, vars: DEFAULT_VARS, gridPoints: 7 }));
assert.equal(opt2h.best.sizes.bessMwh, opt2h.best.sizes.bessMw * 2, "2-hour battery");
console.log("2-hour best", opt2h.best.sizes, `LCOE ${opt2h.best.lcoe.toFixed(3)} feasible ${opt2h.feasible}`);
assert.ok(opt.best.dfrCheck >= inputs.dfrTarget - 1e-6);

// locks are honoured
const locked = { ...DEFAULT_VARS, windMw: { ...DEFAULT_VARS.windMw, value: 250, locked: true } };
const optL = optimize(ctx, buildModel({ inputs, costs: DEFAULT_COSTS, fin: DEFAULT_FINANCE, bess: DEFAULT_BESS, vars: locked }));
assert.equal(optL.best.sizes.windMw, 250, "locked wind held");

const fm = runFinancialModel(ctx, opt.best.sizes, { costs: DEFAULT_COSTS, fin: DEFAULT_FINANCE, bess: DEFAULT_BESS, dfrTarget: inputs.dfrTarget, tariffLocked: false });
assert.equal(fm.rows.length, 25);
assert.ok(Math.abs(fm.equityIrr - DEFAULT_FINANCE.targetEquityIrr) < 1e-4, "tariff solve hits target IRR");
assert.ok(fm.rows.at(-1).closingDebt < 1e-6, "debt fully repaid");
console.log(`finance: tariff ${fm.tariff.toFixed(3)} Rs/kWh, LCOE ${fm.lcoe.toFixed(3)}, project IRR ${(fm.projectIrr * 100).toFixed(2)}%, min DSCR ${fm.minDscr.toFixed(2)}, min lifetime DFR ${(fm.minLifetimeDfr * 100).toFixed(2)}%`);
const fmLocked = runFinancialModel(ctx, opt.best.sizes, { costs: DEFAULT_COSTS, fin: { ...DEFAULT_FINANCE, tariff: fm.tariff + 0.5 }, bess: DEFAULT_BESS, dfrTarget: inputs.dfrTarget, tariffLocked: true });
assert.ok(fmLocked.equityIrr > fm.equityIrr, "higher locked tariff raises IRR");

assert.ok(Math.abs(irr([-100, 110]) - 0.1) < 1e-6);

// uploads
const csv = ["hour,cf", ...Array.from({ length: HOURS }, (_, i) => `${i + 1},${(i % 24) / 48}`)].join("\n");
const parsed = parseProfileCsv(csv);
assert.equal(parsed.values.length, HOURS);
const mw = Array.from({ length: 35040 }, () => "50").join("\n");
const parsedMw = parseProfileCsv(mw, { referenceMw: 100 });
assert.ok(Math.abs(mean(parsedMw.values) - 0.5) < 1e-9, "15-min MW upload normalised");
assert.throws(() => parseProfileCsv("1\n2\n3"));
console.log("RTC engine checks passed");
