import React from "react";
import { Gauge } from "lucide-react";
import * as E from "./engine";
import { Section, Stat, nf, pf } from "./ui";

/** Year 1 from the 33 kV bus to the billing meter, and what is billed there. */
export default function PlantToMeter({ sizes, sim, inputs, finance, fin }) {
  const ev = sim.evac;
  const genBus = sim.solarGenMWh + sim.windGenMWh;
  const lostRoundTrip = sim.chargeMWh - sim.dischargeMWh;
  const exportBus = ev.efficiency > 0 ? sim.excessMWh / ev.efficiency : 0;
  const y1 = finance.rows[0];
  const MU = (v) => nf(v / 1000, 2);
  const solarCufBus = sizes.solarMw > 0 ? sim.solarGenMWh / (sizes.solarMw * E.HOURS) : null;
  const rows = [
    ["Generated at the 33 kV main bus bar", genBus, "group"],
    ["solar", sim.solarGenMWh, "indent"],
    ["wind", sim.windGenMWh, "indent"],
    ["Into the battery", -sim.chargeMWh, "indent"],
    ["Back from the battery", sim.dischargeMWh, "indent"],
    ["Curtailed", -sim.curtailMWh, "indent"],
    ["Injected at the 33 kV bus toward the GSS", ev.injectedMWh, "total"],
    [`Power transformer 33/220 kV (${pf(ev.trafoLossPct, 2)})`, -ev.trafoLossMWh, "loss"],
    [`220 kV transmission line (${pf(ev.lineLossPct, 2)})`, -ev.lineLossMWh, "loss"],
    ["At the billing meter, 220 kV GSS", ev.meterMWh, "total meter"],
    ["delivered to the customer (DFR, tariff)", sim.deliveredMWh, "indent"],
    ["surplus sold", sim.excessMWh, "indent"],
  ];
  return (
    <Section index="P" title="From the plant to the billing meter" note="What the dispatch sends from the 33 kV bus to the 220 kV GSS in year 1; each technology's path and its losses are drawn in its chapter">
      <div className="rtc-stats flush-top" data-testid="rtc-meter-stats">
        <Stat label="Billing metering point" value="220 kV GSS" detail="interface meters (main and check) at the point of interconnection" />
        <Stat label="Reaches the meter" value={pf(ev.efficiency, 3)} detail={`of each MWh injected at 33 kV: −${pf(ev.trafoLossPct, 2)} transformer, −${pf(ev.lineLossPct, 2)} line`} />
        <Stat label="Lost on the way · year 1" value={`${MU(ev.trafoLossMWh + ev.lineLossMWh)} MU`} detail={`₹${nf(((ev.trafoLossMWh + ev.lineLossMWh) * finance.tariff) / 1e4, 2)} cr of revenue at ₹${nf(finance.tariff, 3)}/kWh`} />
        <Stat label="Solar CUF" value={solarCufBus === null ? "–" : pf(solarCufBus * ev.efficiency, 2)} detail={solarCufBus === null ? "no solar" : `at the 220 kV meter; ${pf(solarCufBus, 2)} at the 33 kV bus`} />
        <Stat label="DFR at the meter" value={pf(sim.dfr, 2)} detail={`${nf(sim.deliveredMWh / 1000, 1)} of ${nf(sim.demandMWh / 1000, 1)} MU · target ${pf(inputs.dfrTarget, 0)}`} tone={sim.dfr >= inputs.dfrTarget - 1e-6 ? "good" : "bad"} />
      </div>
      <div className="rtc-grid rtc-grid-2 meter-grid">
        <div className="table-wrap" data-testid="rtc-meter-ladder">
          <table>
            <thead><tr><th>Year 1, 33 kV bus → 220 kV meter</th><th className="num">MU</th></tr></thead>
            <tbody>
              {rows.map(([label, v, kind]) => (
                <tr key={label} className={kind.includes("total") ? "rtc-model-total" : kind === "group" ? "rtc-model-group-row" : ""}>
                  <td className={kind === "indent" ? "rtc-indent" : kind === "loss" ? "rtc-indent rtc-loss" : ""}>{label}</td>
                  <td className={`rtc-num ${kind === "loss" ? "rtc-loss" : ""}`}>{v < 0 ? `(${MU(-v)})` : MU(v)}</td>
                </tr>
              ))}
              <tr><td className="rtc-indent rtc-muted">battery round-trip loss (in “into” − “back”)</td><td className="rtc-num rtc-muted">{MU(lostRoundTrip)}</td></tr>
              <tr><td className="rtc-indent rtc-muted">surplus at the bus before losses</td><td className="rtc-num rtc-muted">{MU(exportBus)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="meter-notes">
          <div className="meter-def">
            <Gauge size={16} />
            <div>
              <strong>Billing metering point</strong>
              <p>The interface meters (main and check) at the 220 kV bay of the GSS, the point of interconnection. The customer's bill, the DFR, the plant capacity limit and surplus sales are all on the units these meters record. The units generated are measured at the plant's 33 kV main bus bar (your hourly file).</p>
            </div>
          </div>
          <div className="meter-def">
            <div>
              <strong>What the losses cost</strong>
              <p>
                Year 1: the meter records {MU(ev.meterMWh)} MU of the {MU(ev.injectedMWh)} MU injected at 33 kV. At ₹{nf(finance.tariff, 3)}/kWh the {MU(ev.trafoLossMWh + ev.lineLossMWh)} MU lost is ₹{nf(((ev.trafoLossMWh + ev.lineLossMWh) * finance.tariff) / 1e4, 2)} crore a year.
                The optimizer sizes the plant for the DFR at the meter, so it builds enough to cover these losses; every year of the financial model bills only the metered units (revenue {y1 ? `₹${nf(y1.energyRevenue, 1)} cr in year 1` : ""}).
                {fin.sellSurplus ? " Surplus is sold on the metered units too." : ""}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
