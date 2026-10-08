import React, { useMemo } from "react";
import { ArrowRight, TriangleAlert } from "lucide-react";
import * as E from "../rtc/engine";
import FinanceView from "../rtc/FinanceView";
import { Section, Stat, nf, pf } from "../rtc/ui";
import { activeRules, capexBySource, opsFromLp } from "./model";
import { SourceChip } from "./RequirementsStep";

const FUEL_LINES = [["Biomass fuel", "fuel", 1, -1], ["Biomass generation (MU)", "biomassMu", 1]];

/** Step 4: the 25-year financial model of the sized plant, priced as the bid. */
export default function FinanceStep({ state, patch, set, lockProps, goto }) {
  const { lp, fin, costs, bess } = state;
  const prov = state.provenance || {};
  const sizes = lp?.sizes;
  const annualTarget = activeRules(state).find((r) => r.id === "annual" || (r.hours === "all" && r.basis === "annual"))?.target ?? 0;
  const ops = useMemo(() => (lp ? opsFromLp(lp, fin, bess) : null), [lp, fin, bess]);
  const finance = useMemo(
    () => (lp ? E.runFinancialModel(null, sizes, { costs, fin, bess, dfrTarget: annualTarget, tariffLocked: state.tariffLocked, ops, solveBy: "npv" }) : null),
    [lp, sizes, costs, fin, bess, annualTarget, state.tariffLocked, ops],
  );
  if (!lp || !finance) {
    return (
      <Section index="4" title="Financials">
        <p className="rtc-note">Size the plant first: the financial model prices the least-tariff design.</p>
        <button type="button" className="primary" onClick={() => goto("size")}>Go to sizing <ArrowRight size={14} /></button>
      </Section>
    );
  }
  const capex = capexBySource(sizes, costs);
  const ceiling = state.ceilingTariff;
  const headroom = ceiling ? ceiling - finance.tariff : null;
  const crore = (inr) => inr / 1e7;
  const emd = state.guarantees?.emdPerMwInr ? crore(state.guarantees.emdPerMwInr * state.plantMw) : null;
  const pbg = state.guarantees?.pbgPerMwInr ? crore(state.guarantees.pbgPerMwInr * state.plantMw) : null;
  const termChanged = (lp.lifetime?.length || 0) !== (fin.years || 25);
  const y1 = finance.rows[0];

  return (
    <>
      <Section index="4" title="Bid tariff" note={`Tariff that gives a ${pf(fin.targetEquityIrr, 1)} equity IRR on the least-tariff plant`}>
        {termChanged && <div className="alert"><TriangleAlert size={14} /> The PPA term changed after sizing: size the plant again so every year is modelled.</div>}
        <div className="rtc-grid rtc-grid-4" data-testid="bid-finance">
          <Stat label={finance.tariffLocked ? "Tariff (fixed)" : "Bid tariff"} value={`₹${nf(finance.tariff, 3)}/kWh`} detail={`HiGHS screening ₹${nf(lp.tariff, 3)}`} />
          <div className="bid-input-with-src">
            <Stat label="Ceiling tariff" value={ceiling ? `₹${nf(ceiling, 2)}/kWh` : "Not stated"} detail={headroom === null ? "" : headroom >= 0 ? `₹${nf(headroom, 3)} below the ceiling` : `₹${nf(-headroom, 3)} above the ceiling`} tone={headroom !== null && headroom < 0 ? "bad" : undefined} />
            <SourceChip source={prov.ceiling} />
          </div>
          <Stat label="Equity IRR" value={pf(finance.equityIrr, 2)} detail={`project IRR ${pf(finance.projectIrr, 2)}`} />
          <Stat label="Minimum DSCR" value={nf(finance.minDscr, 2)} detail={`average ${nf(finance.avgDscr, 2)}`} tone={finance.minDscr !== null && finance.minDscr < 1.1 ? "bad" : undefined} />
          <Stat label="Project cost" value={`₹${nf(finance.capex.total, 0)} cr`} detail={`₹${nf(finance.capex.total / state.plantMw, 2)} cr per contracted MW`} />
          <Stat label="Levelised cost" value={`₹${nf(finance.lcoe, 3)}/kWh`} detail={`at ${pf(fin.discountRate, 1)}`} />
          <Stat label="Year-1 supply" value={`${nf(y1.deliveredMu, 0)} MU`} detail={`${pf(y1.dfr, 1)} of contracted`} />
          <Stat label="Year-1 biomass fuel" value={`₹${nf(y1.fuel, 1)} cr`} detail={`${nf(y1.biomassMu, 0)} MU at ₹${nf(fin.biomassFuelRsPerKwh, 2)}/kWh`} />
        </div>
      </Section>

      <Section index="4.1" title="Money at stake" note="Capex by source and the guarantees the tender asks for">
        <div className="rtc-grid rtc-grid-4">
          <Stat label="Solar capex" value={`₹${nf(capex.solar, 0)} cr`} detail={`${nf(sizes.solarMw, 0)} MW`} />
          <Stat label="Wind capex" value={`₹${nf(capex.wind, 0)} cr`} detail={`${nf(sizes.windMw, 0)} MW`} />
          <Stat label="Biomass capex" value={`₹${nf(capex.biomass, 0)} cr`} detail={`${nf(sizes.biomassMw || 0, 0)} MW`} />
          <Stat label="Battery capex" value={`₹${nf(capex.bess, 0)} cr`} detail={`${nf(sizes.bessMwh, 0)} MWh`} />
          <div className="bid-input-with-src">
            <Stat label="Bid security (EMD)" value={emd === null ? "Not stated" : `₹${nf(emd, 2)} cr`} detail={emd === null ? "" : `for ${nf(state.plantMw, 0)} MW`} />
            <SourceChip source={prov["guarantees.emd"]} />
          </div>
          <div className="bid-input-with-src">
            <Stat label="Performance guarantee (PBG)" value={pbg === null ? "Not stated" : `₹${nf(pbg, 2)} cr`} detail={pbg === null ? "" : `for ${nf(state.plantMw, 0)} MW`} />
            <SourceChip source={prov["guarantees.pbg"]} />
          </div>
          <Stat label="Equity" value={`₹${nf(finance.equity, 0)} cr`} detail={`debt ₹${nf(finance.debt, 0)} cr`} />
          <Stat label="Equity payback" value={finance.payback ? `year ${finance.payback}` : "beyond term"} />
        </div>
        {state.notes?.length > 0 && (
          <ul className="bid-notes">
            {state.notes.map((n) => <li key={n.id}><strong>{n.label}:</strong> {n.display}{n.note ? ` · ${n.note}` : ""} <SourceChip source={n.source} compact /></li>)}
          </ul>
        )}
      </Section>

      <div className="story-divider"><span>Financial model · {fin.years} years</span></div>
      <FinanceView state={state} patch={patch} set={set} lockProps={lockProps} finance={finance} sizes={{ ...sizes, biomassMw: sizes.biomassMw || 0 }} extraLines={FUEL_LINES} />
    </>
  );
}
