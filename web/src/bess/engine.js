// BESS tender bid engine (browser). Sizes a standalone battery to the tender's requirements for
// the whole contract term and solves the capacity charge (Rs/MW/month) that gives the target
// equity IRR.
//
// Sizing: the battery must deliver the contracted energy at the delivery point in every year.
// Capacity fades with calendar ageing and cycling; it is kept up by oversizing on day one and
// by adding battery blocks (augmentation) at a chosen interval. Each augmentation adds just
// enough to meet the requirement until the next one; if the plant would fall short before a
// scheduled augmentation, an unplanned top-up is added in that year. The optimizer searches
// every day-one oversize × augmentation interval and picks the lowest capacity charge.

export const DEFAULT_REQ = {
  powerMw: 250,
  energyMwh: 500,
  cyclesPerDay: 2,
  annualCycles: 730,
  minRte: 0.85,
  availability: 0.95,
  availabilityBasis: "monthly",
  contractYears: 12,
  scodMonths: 18,
  tariffBasis: "capacity",
  ceilingTariff: null, // Rs/MW/month
  vgfLakhPerMwh: 0,
  vgfPct: 0,
  chargingBy: "procurer",
  maintainCapacity: true,
};

export const DEFAULT_TECH = {
  chemistry: "LFP",
  dod: 0.9, // usable share of the DC nameplate
  dcRte: 0.94, // battery (DC) round-trip efficiency at beginning of life
  pcsEff: 0.978, // one-way PCS + transformer efficiency
  auxPct: 0.015, // auxiliary consumption, counted inside the AC round-trip efficiency
  rteFadePerYear: 0.002, // round-trip efficiency lost per year
  firstYearFade: 0.02, // extra capacity fade in year 1 (formation, early ageing)
  calendarFade: 0.01, // capacity fade per year from calendar ageing
  cycleFadePer1000: 0.025, // capacity fade per 1,000 full cycles
  pcsMarginPct: 0.05, // PCS rating above the contracted power
  expectedAvailability: 0.98,
};

export const DEFAULT_COSTS = {
  dcCrPerMwh: 0.78, // containerised LFP DC block, Rs cr/MWh
  pcsCrPerMw: 0.28, // PCS + MV transformer, Rs cr/MW
  bopCrPerMwh: 0.12, // civil, HVAC, fire, SCADA, EMS per MWh of contracted energy
  gridCr: 0, // bay / line / substation works
  preopPct: 0.04,
  cellPriceDecline: 0.05, // yearly fall in the DC block price (augmentation is bought later)
  augEventCr: 3, // fixed cost of each augmentation campaign (engineering, logistics, commissioning)
  omLakhPerMwYr: 3.0, // fixed O&M per MW of contracted power
  omLakhPerMwhYr: 0.9, // O&M + insurance per MWh of installed DC capacity
  omEscalation: 0.04,
  chargingPrice: 3.0, // Rs/kWh, for developer-paid charging and RTE shortfall compensation
  availabilityPenaltyFactor: 1.5,
};

export const DEFAULT_FIN = {
  targetEquityIrr: 0.14,
  debtFraction: 0.7,
  interestRate: 0.095,
  tenorYears: 10,
  taxRate: 0.2517,
  wdvRate: 0.4,
  salvagePct: 0.05,
  receivableDays: 60,
  tariffEscalation: 0,
  discountRate: 0.1,
};

export const SEARCH = { oversizeMax: 0.6, oversizeStep: 0.02, maxInterval: 12 };

const CR = 1e7;

// ---------------------------------------------------------------- physics

/** AC-to-AC round-trip efficiency at the delivery point in a year (auxiliary included). */
export function rteAt(year, tech) {
  return tech.dcRte * tech.pcsEff ** 2 * (1 - tech.auxPct) * (1 - tech.rteFadePerYear) ** (year - 1);
}

/** DC nameplate MWh needed to deliver the contracted energy with a fresh battery. */
export function requiredDcMwh(req, tech) {
  return req.energyMwh / (tech.dod * Math.sqrt(tech.dcRte) * tech.pcsEff * Math.sqrt(1 - tech.auxPct));
}

/** State of health at the end of `age` years in service (age >= 1). */
export function soh(age, req, tech) {
  const perYear = tech.calendarFade + tech.cycleFadePer1000 * (req.annualCycles / 1000);
  return Math.max(0, 1 - tech.firstYearFade - perYear * age);
}

/** Energy at the delivery point from all blocks at the end of year y. */
function poiEnergy(cohorts, y, req, tech) {
  let dc = 0;
  for (const c of cohorts) if (c.year <= y) dc += c.mwh * soh(y - c.year + 1, req, tech);
  return dc * tech.dod * Math.sqrt(tech.dcRte) * tech.pcsEff * Math.sqrt(1 - tech.auxPct);
}

/**
 * Battery build-out for one strategy: day-one oversize and augmentation interval (years).
 * Oversize is measured against the smallest battery that still meets the contract at the end
 * of year 1 (the DC needed when new, grossed up for the first year's fade).
 */
export function buildPlan(req, tech, { oversize, interval }) {
  const N = Math.round(req.contractYears);
  const reqDc = requiredDcMwh(req, tech);
  const baseDc = reqDc / Math.max(0.05, soh(1, req, tech));
  const toDc = reqDc / req.energyMwh; // DC MWh per MWh at the delivery point, fresh
  const cohorts = [{ year: 1, mwh: baseDc * (1 + oversize), kind: "initial" }];
  const augYears = new Set();
  if (interval && interval < N) for (let y = 1 + interval; y <= N; y += interval) augYears.add(y);
  const nextAug = (y) => { for (let z = y + 1; z <= N; z += 1) if (augYears.has(z)) return z; return N + 1; };
  const years = [];
  for (let y = 1; y <= N; y += 1) {
    let added = 0;
    let kind = null;
    const horizon = Math.min(nextAug(y) - 1, N);
    const addToCover = (h) => {
      const short = req.energyMwh - poiEnergy(cohorts, h, req, tech);
      if (short <= 1e-9) return 0;
      const mwh = (short * toDc) / soh(h - y + 1, req, tech);
      if (y === 1) { cohorts[0].mwh += mwh; return 0; } // part of the day-one purchase
      cohorts.push({ year: y, mwh, kind: kind || "planned" });
      return mwh;
    };
    if (augYears.has(y)) { kind = "planned"; added += addToCover(horizon); }
    // unplanned top-up when the plant would miss the requirement this year
    if (poiEnergy(cohorts, y, req, tech) < req.energyMwh - 1e-6) { kind = "unplanned"; added += addToCover(horizon); }
    const start = poiEnergy(cohorts, y - 1 < 1 ? 1 : y, req, tech);
    years.push({
      year: y,
      augMwh: added,
      augKind: added > 1e-6 ? kind : null,
      endPoiMwh: poiEnergy(cohorts, y, req, tech),
      startPoiMwh: start,
      installedDcMwh: cohorts.filter((c) => c.year <= y).reduce((s, c) => s + c.mwh, 0),
      rte: rteAt(y, tech),
      byCohort: cohorts.filter((c) => c.year <= y).map((c) => ({ year: c.year, kind: c.kind, poiMwh: c.mwh * soh(y - c.year + 1, req, tech) * tech.dod * Math.sqrt(tech.dcRte) * tech.pcsEff * Math.sqrt(1 - tech.auxPct) })),
    });
  }
  return { cohorts, years, reqDc, baseDc, pcsMw: req.powerMw * (1 + tech.pcsMarginPct) };
}

// ---------------------------------------------------------------- finance

function capexOf(req, tech, costs, plan) {
  const dc = plan.cohorts[0].mwh * costs.dcCrPerMwh;
  const pcs = plan.pcsMw * costs.pcsCrPerMw;
  const bop = req.energyMwh * costs.bopCrPerMwh;
  const hard = dc + pcs + bop + (costs.gridCr || 0);
  const total = hard * (1 + (costs.preopPct || 0));
  const vgf = Math.min(total * 0.4, (req.vgfLakhPerMwh || 0) * req.energyMwh / 100 + (req.vgfPct || 0) * total);
  return { dc, pcs, bop, grid: costs.gridCr || 0, hard, total, vgf, net: total - vgf };
}

function irr(flows) {
  const npv = (r) => flows.reduce((s, cf, i) => s + cf / (1 + r) ** i, 0);
  let lo = -0.99;
  let hi = 1.5;
  let fLo = npv(lo);
  if (!Number.isFinite(fLo) || fLo * npv(hi) > 0) return NaN;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (f * fLo > 0) { lo = mid; fLo = f; } else hi = mid;
    if (hi - lo < 1e-9) break;
  }
  return (lo + hi) / 2;
}

/** Yearly cash flows for a capacity charge (Rs/MW/month). */
function cashflows(req, tech, costs, fin, plan, capex, charge) {
  const N = plan.years.length;
  const debt0 = capex.net * fin.debtFraction;
  const equity0 = capex.net - debt0;
  const tenor = Math.min(N, Math.max(1, Math.round(fin.tenorYears)));
  let debt = debt0;
  let wdv = capex.net;
  let lossCf = 0;
  let prevRecv = 0;
  const equityFlows = [-equity0];
  const projectFlows = [-capex.net];
  const rows = [];
  const availFactor = Math.min(1, tech.expectedAvailability / req.availability);
  const availPenalty = tech.expectedAvailability < req.availability ? (req.availability - tech.expectedAvailability) / req.availability * costs.availabilityPenaltyFactor : 0;
  const decline = (y) => (1 - costs.cellPriceDecline) ** (y - 1);
  for (const yr of plan.years) {
    const y = yr.year;
    const tariff = charge * (1 + fin.tariffEscalation) ** (y - 1);
    const capacityRevenue = (tariff * req.powerMw * 12) / CR;
    const revenue = capacityRevenue * (availFactor - availPenalty);
    const dischargeMwh = req.energyMwh * req.annualCycles * Math.min(1, tech.expectedAvailability / Math.max(1e-9, req.availability) * req.availability);
    const chargeMwh = dischargeMwh / yr.rte;
    const excessLossMwh = Math.max(0, chargeMwh - dischargeMwh / req.minRte);
    const rtePenalty = (excessLossMwh * costs.chargingPrice * 1000) / CR;
    const chargingCost = req.chargingBy === "developer" ? (chargeMwh * costs.chargingPrice * 1000) / CR : 0;
    const esc = (1 + costs.omEscalation) ** (y - 1);
    const om = ((costs.omLakhPerMwYr * req.powerMw + costs.omLakhPerMwhYr * yr.installedDcMwh) / 100) * esc;
    const opex = om + rtePenalty + chargingCost;
    const aug = yr.augMwh > 1e-6 ? yr.augMwh * costs.dcCrPerMwh * decline(y) + costs.augEventCr : 0;
    const ebitda = revenue - opex;
    const opening = debt;
    const interest = opening * fin.interestRate;
    const principal = y <= tenor ? Math.min(opening, debt0 / tenor) : 0;
    debt = opening - principal;
    wdv += aug;
    const dep = wdv * fin.wdvRate;
    wdv -= dep;
    let taxable = ebitda - interest - dep;
    if (taxable > 0 && lossCf > 0) { const use = Math.min(lossCf, taxable); taxable -= use; lossCf -= use; }
    else if (taxable < 0) { lossCf -= taxable; taxable = 0; }
    const tax = taxable * fin.taxRate;
    const recv = (revenue * fin.receivableDays) / 365;
    const dWc = recv - prevRecv;
    prevRecv = recv;
    const cfads = ebitda - tax - dWc - aug;
    const ds = interest + principal;
    let fcfe = cfads - ds;
    let pcf = ebitda - Math.max(0, (ebitda - dep) * fin.taxRate) - dWc - aug;
    if (y === N) {
      const terminal = capex.total * fin.salvagePct + recv;
      fcfe += terminal - debt;
      pcf += terminal;
    }
    equityFlows.push(fcfe);
    projectFlows.push(pcf);
    rows.push({ year: y, tariff, revenue, capacityRevenue, om, rtePenalty, chargingCost, opex, aug, ebitda, interest, principal, closingDebt: debt, dep, tax, dWc, cfads, ds, dscr: ds > 1e-9 ? cfads / ds : null, fcfe, dischargeMwh, chargeMwh, rte: yr.rte });
  }
  return { rows, equityFlows, projectFlows, debt0, equity0 };
}

/** Capacity charge for the target equity IRR, and the full financial result. */
export function evaluate(req, tech, costs, fin, strategy, { fixedCharge = null } = {}) {
  const plan = buildPlan(req, tech, strategy);
  const capex = capexOf(req, tech, costs, plan);
  let charge = fixedCharge;
  if (charge === null) {
    let lo = 1e3;
    let hi = 5e6;
    // equity NPV at the target IRR rises with the charge: bisect on its sign
    const npv = (flows) => flows.reduce((acc, cf, i) => acc + cf / (1 + fin.targetEquityIrr) ** i, 0);
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (npv(cashflows(req, tech, costs, fin, plan, capex, mid).equityFlows) < 0) lo = mid; else hi = mid;
    }
    charge = hi;
  }
  const cf = cashflows(req, tech, costs, fin, plan, capex, charge);
  const dscrs = cf.rows.map((r) => r.dscr).filter((v) => v !== null && Number.isFinite(v));
  let pvCost = capex.net;
  let pvMwh = 0;
  cf.rows.forEach((r) => {
    const d = (1 + fin.discountRate) ** r.year;
    pvCost += (r.opex + r.aug) / d;
    pvMwh += r.dischargeMwh / d;
  });
  const augEvents = plan.years.filter((y) => y.augMwh > 1e-6);
  return {
    strategy: { ...strategy },
    charge,
    chargeLakh: charge / 1e5,
    plan,
    capex,
    rows: cf.rows,
    equityIrr: irr(cf.equityFlows),
    projectIrr: irr(cf.projectFlows),
    minDscr: dscrs.length ? Math.min(...dscrs) : null,
    avgDscr: dscrs.length ? dscrs.reduce((a, b) => a + b, 0) / dscrs.length : null,
    lcos: pvMwh > 0 ? (pvCost * CR) / (pvMwh * 1000) : NaN, // Rs/kWh discharged
    augCapexCr: cf.rows.reduce((s, r) => s + r.aug, 0),
    augMwh: augEvents.reduce((s, y) => s + y.augMwh, 0),
    augEvents: augEvents.map((y) => ({ year: y.year, mwh: y.augMwh, kind: y.augKind })),
    unplanned: augEvents.filter((y) => y.augKind === "unplanned").length,
    minMarginMwh: Math.min(...plan.years.map((y) => y.endPoiMwh - req.energyMwh)),
    endRte: plan.years.at(-1).rte,
    debt: cf.debt0,
    equity: cf.equity0,
  };
}

// ---------------------------------------------------------------- optimizer

/** Every oversize × interval (the surface), then a fine oversize search at the best interval. */
export function optimize(req, tech, costs, fin, onCell) {
  const t0 = Date.now();
  const N = Math.round(req.contractYears);
  const maxK = Math.min(SEARCH.maxInterval, N);
  const xGrid = [];
  for (let o = 0; o <= SEARCH.oversizeMax + 1e-9; o += SEARCH.oversizeStep) xGrid.push(Math.round(o * 1000) / 1000);
  const yGrid = [];
  for (let k = 1; k <= maxK; k += 1) yGrid.push(k);
  const log = [];
  const cells = [];
  let best = null;
  let evals = 0;
  xGrid.forEach((o, si) => {
    yGrid.forEach((k, wi) => {
      const r = evaluate(req, tech, costs, fin, { oversize: o, interval: k >= N ? 0 : k });
      evals += 1;
      const cell = { si, wi, z: r.chargeLakh, feasible: true, sizes: { oversize: o, interval: k }, unplanned: r.unplanned };
      cells.push(cell);
      if (onCell) onCell(cell);
      if (!best || r.charge < best.charge) best = r;
    });
  });
  log.push(`Surface: ${xGrid.length} oversize × ${yGrid.length} augmentation intervals = ${evals} strategies, each with its own capacity charge for ${(fin.targetEquityIrr * 100).toFixed(1)}% equity IRR`);
  // fine search on oversize at the best interval
  const k = best.strategy.interval;
  const o0 = best.strategy.oversize;
  for (let o = Math.max(0, o0 - SEARCH.oversizeStep); o <= o0 + SEARCH.oversizeStep + 1e-9; o += 0.0025) {
    const r = evaluate(req, tech, costs, fin, { oversize: Math.round(o * 10000) / 10000, interval: k });
    evals += 1;
    if (r.charge < best.charge) best = r;
  }
  log.push(`Refined day-one oversize in 0.25% steps: best ${(best.strategy.oversize * 100).toFixed(2)}% with augmentation every ${best.strategy.interval || N} years`);
  const ranked = cells
    .map((c) => ({ ...c.sizes, chargeLakh: c.z, unplanned: c.unplanned }))
    .sort((a, b) => a.chargeLakh - b.chargeLakh);
  return {
    best,
    axes: { solarGrid: xGrid.map((o) => Math.round(o * 100)), windGrid: yGrid, total: cells.length },
    cells,
    ranked: ranked.slice(0, 12),
    evals,
    ms: Date.now() - t0,
    log,
  };
}

// ---------------------------------------------------------------- compliance

export function compliance(req, tech, res) {
  const items = [];
  const add = (label, required, design, ok, note = "") => items.push({ label, required, design, ok, note });
  add("Contracted power", `${req.powerMw} MW`, `${Math.round(res.plan.pcsMw)} MW PCS`, res.plan.pcsMw >= req.powerMw);
  add("Energy every year", `${req.energyMwh} MWh at the delivery point`, `lowest ${Math.round(req.energyMwh + res.minMarginMwh)} MWh (year-end)`, res.minMarginMwh >= -1e-6, res.augEvents.length ? `${res.augEvents.length} augmentation${res.augEvents.length > 1 ? "s" : ""}` : "no augmentation");
  add("Discharge duration", `${(req.energyMwh / req.powerMw).toFixed(2)} h`, `${(req.energyMwh / req.powerMw).toFixed(2)} h at ${req.powerMw} MW`, true);
  add("Cycles", `${req.cyclesPerDay}/day · ${req.annualCycles}/yr`, `${req.annualCycles} full cycles/yr in the fade model`, true, `${(tech.cycleFadePer1000 * req.annualCycles / 1000 * 100).toFixed(1)}%/yr cycle fade`);
  const worstRte = Math.min(...res.plan.years.map((y) => y.rte));
  add("Round-trip efficiency", `≥ ${(req.minRte * 100).toFixed(1)}%`, `${(res.plan.years[0].rte * 100).toFixed(1)}% → ${(worstRte * 100).toFixed(1)}% (year ${res.plan.years.length})`, worstRte >= req.minRte - 1e-9, worstRte < req.minRte ? "shortfall compensated at the charging price in the model" : "");
  add("Availability", `≥ ${(req.availability * 100).toFixed(1)}% ${req.availabilityBasis || ""}`, `${(tech.expectedAvailability * 100).toFixed(1)}% expected`, tech.expectedAvailability >= req.availability);
  add("Contract term", `${req.contractYears} years`, `modelled ${res.plan.years.length} years`, true);
  if (req.ceilingTariff) add("Ceiling tariff", `₹${(req.ceilingTariff / 1e5).toFixed(2)} lakh/MW/month`, `₹${res.chargeLakh.toFixed(3)} lakh/MW/month`, res.charge <= req.ceilingTariff, res.charge <= req.ceilingTariff ? `${((1 - res.charge / req.ceilingTariff) * 100).toFixed(1)}% below the ceiling` : "above the ceiling: the bid would be rejected");
  return items;
}

/** A typical day: charge/discharge windows for the tender's cycles, power and state of charge. */
export function typicalDay(req, tech, res, year) {
  const yr = res.plan.years[Math.max(0, Math.min(res.plan.years.length - 1, year - 1))];
  const dur = req.energyMwh / req.powerMw;
  const cycles = Math.max(1, Math.min(3, Math.round(req.cyclesPerDay)));
  const windows = [
    { charge: 10, discharge: 18 }, // solar hours → evening peak
    { charge: 1, discharge: 6 }, // night off-peak → morning peak
    { charge: 13, discharge: 21 },
  ].slice(0, cycles);
  const usableMwh = yr.endPoiMwh; // energy available at the delivery point
  const rte = yr.rte;
  const power = new Array(24).fill(0);
  for (const w of windows) {
    const chargeHours = Math.ceil(dur / Math.sqrt(rte));
    for (let h = 0; h < chargeHours; h += 1) power[(w.charge + h) % 24] = -Math.min(req.powerMw, req.energyMwh / Math.sqrt(rte) / chargeHours * 1.0);
    for (let h = 0; h < Math.ceil(dur); h += 1) power[(w.discharge + h) % 24] = Math.min(req.powerMw, req.energyMwh / Math.ceil(dur));
  }
  // state of charge at the delivery point, as a share of what the battery can hold this year
  const soc = [];
  let e = 0.05 * usableMwh;
  for (let h = 0; h < 24; h += 1) {
    if (power[h] < 0) e += -power[h] * Math.sqrt(rte);
    else e -= power[h];
    e = Math.max(0, Math.min(usableMwh, e));
    soc.push(usableMwh > 0 ? e / usableMwh : 0);
  }
  const headroom = usableMwh / req.energyMwh - 1;
  return { power, soc, usableMwh, rte, headroom: Math.abs(headroom) < 1e-6 ? 0 : headroom };
}
