import React, { useMemo, useState } from "react";
import { CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import { Section, Stat, nf, pf } from "../rtc/ui";
import { LiveChart } from "../rtc/charts";
import Cite from "./Cite.jsx";
import { TENDER } from "./terms.js";
import { fmtDate, penaltyCr, simulate } from "./model.js";

const COLORS = { own: "#7ddc9a", market: "#3fa7d6", group: "#4fd1c5", sale: "#f2b84b", ess: "#a98bff", price: "#ff8a5f" };

function SourcesChart({ years }) {
  const option = useMemo(() => ({
    animation: false,
    grid: { left: 64, right: 16, top: 34, bottom: 40 },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis", valueFormatter: (v) => `${nf(v, 0)} MWh` },
    xAxis: { type: "category", data: years.map((y) => `CY ${y.index}`) },
    yAxis: { type: "value", name: "MWh supplied" },
    series: [
      { name: "Own RE", type: "bar", stack: "s", data: years.map((y) => Math.round(y.ownSuppliedMwh)), itemStyle: { color: COLORS.own } },
      { name: "Green market", type: "bar", stack: "s", data: years.map((y) => Math.round(y.shareMarket * y.deliveredMwh)), itemStyle: { color: COLORS.market } },
      { name: "Group RE", type: "bar", stack: "s", data: years.map((y) => Math.round(y.shareGroup * y.deliveredMwh)), itemStyle: { color: COLORS.group } },
      { name: "Required (2 MWh/MW a day)", type: "line", step: "middle", data: years.map((y) => Math.round(y.requiredMwh)), symbol: "none", lineStyle: { color: "#f4f4f1", type: "dashed", width: 1 }, itemStyle: { color: "#f4f4f1" } },
    ],
  }), [years]);
  return <LiveChart option={option} height={300} />;
}

function DayChart({ day }) {
  const option = useMemo(() => {
    if (!day) return null;
    const labels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
    const out = Array.from({ length: 24 }, (_, h) => (day.chosen.includes(h) ? (day.windDirect[h] || 0) + day.essOut / day.chosen.length : 0));
    return {
      animation: false,
      grid: { left: 56, right: 56, top: 34, bottom: 40 },
      legend: { top: 0, right: 0 },
      tooltip: { trigger: "axis", valueFormatter: (v) => (typeof v === "number" ? nf(v, 1) : v) },
      xAxis: { type: "category", data: labels, axisLabel: { interval: 2 } },
      yAxis: [{ type: "value", name: "MW" }, { type: "value", name: "₹/kWh", min: 0, splitLine: { show: false } }],
      series: [
        { name: "Solar + wind output", type: "line", areaStyle: { opacity: 0.18, color: COLORS.own }, lineStyle: { width: 1, color: COLORS.own }, symbol: "none", itemStyle: { color: COLORS.own }, data: day.solar.map((v, h) => Number((v + day.wind[h]).toFixed(1))),
          markArea: { silent: true, itemStyle: { color: "rgba(212,255,63,0.07)" }, data: [[{ xAxis: labels[18] }, { xAxis: labels[23] }]] } },
        { name: "Charging from own RE", type: "bar", stack: "c", data: day.own.map((v) => -Number(v.toFixed(1))), itemStyle: { color: COLORS.own } },
        { name: "Charging from green market", type: "bar", stack: "c", data: day.market.map((v) => -Number(v.toFixed(1))), itemStyle: { color: COLORS.market } },
        { name: "Charging from group RE", type: "bar", stack: "c", data: day.group.map((v) => -Number(v.toFixed(1))), itemStyle: { color: COLORS.group } },
        { name: "Supply to the exchange", type: "bar", data: out.map((v) => Number(v.toFixed(1))), itemStyle: { color: COLORS.ess } },
        { name: "Surplus sold", type: "bar", data: day.sale.map((v) => Number(v.toFixed(1))), itemStyle: { color: COLORS.sale } },
        { name: "Selling-market price", type: "line", yAxisIndex: 1, symbol: "none", data: day.price.map((v) => Number(v.toFixed(2))), lineStyle: { color: COLORS.price, width: 1.4 }, itemStyle: { color: COLORS.price } },
        { name: "GDAM price (charging)", type: "line", yAxisIndex: 1, symbol: "none", data: day.buyPrice.map((v) => Number(v.toFixed(2))), lineStyle: { color: COLORS.market, width: 1, type: "dashed" }, itemStyle: { color: COLORS.market } },
      ],
    };
  }, [day]);
  if (!day) return null;
  return <LiveChart option={option} height={320} />;
}

/** Step 5: how the plant runs, day by day over the term, against the tender's limits. */
export default function OperationsStep({ model }) {
  const [k, setK] = useState(200);
  const sim = model?.sim;
  const totalDays = sim ? Math.round((sim.dates.end - sim.dates.scd) / 86400000) : 0;
  const day = useMemo(() => (model ? simulate(model.inputs, model.book, model.prof, { record: [Math.min(k, totalDays - 1)] }).days[Math.min(k, totalDays - 1)] : null), [model, k, totalDays]);
  if (!model) return <p className="rtc-note bid-hint">Fill in Plant and sourcing and Costs to see how the plant runs.</p>;
  const years = sim.years;
  const sp = model.sp;
  const after = years.filter((y) => y.start >= sim.dates.extraUntil);
  const supply = years.reduce((a, y) => a + y.deliveredMwh, 0) / years.reduce((a, y) => a + y.requiredMwh, 0);
  const maxMarketAfter = after.length ? Math.max(...after.map((y) => y.shareMarket)) : null;
  const maxGroup = after.length ? Math.max(...after.map((y) => y.shareGroup)) : null;
  const minOwnAfter = after.length ? Math.min(...after.map((y) => y.shareOwn)) : null;
  const shortDays = years.reduce((a, y) => a + y.shortDays, 0);
  const penaltyWeeks = years.reduce((a, y) => a + y.weeks.filter((w) => w.beyondMwh > 1e-6).length, 0);
  const penalty = years.reduce((a, y) => a + (sp ? penaltyCr(y, sp) : 0), 0);
  return (
    <>
      <Section index="5" title="Operations over the term" note={`Day by day from the SCD (${fmtDate(sim.dates.scd)}) to the end of the term (${fmtDate(sim.dates.end)}), with IEX prices of Sep 2025 – Sep 2026`}>
        <div className="rtc-grid rtc-grid-4" data-testid="cfd-ops-kpis">
          <Stat label="Supplied" value={pf(supply, 1)} detail={`of 2 MWh/MW a day; availability ${pf(model.inputs.availability, 1)}`} />
          <Stat label="Own RE share (after month 36)" value={minOwnAfter !== null ? pf(minOwnAfter, 1) : "–"} detail="lowest Contract Year" />
          <Stat label="Green market share (after month 36)" value={maxMarketAfter !== null ? pf(maxMarketAfter, 1) : "–"} detail="highest; limit 25%" tone={maxMarketAfter > TENDER.marketShare + 1e-6 ? "bad" : undefined} />
          <Stat label="Group RE share" value={maxGroup !== null ? pf(maxGroup, 1) : "–"} detail="highest; limit 50%" />
          <Stat label="Days short of charging power" value={nf(shortDays)} detail={shortDays ? "the sourcing limits bind: more own RE needed" : "none"} tone={shortDays ? "bad" : undefined} />
          <Stat label="Weeks with a penalty" value={nf(penaltyWeeks)} detail={penaltyWeeks ? `₹${nf(penalty, 2)} cr over the term at SP ₹${nf(sp, 2)}` : "supply ≥ 90% every week"} tone={penaltyWeeks ? "bad" : undefined} />
          <Stat label="Surplus RE sold" value={`${nf(years.reduce((a, y) => a + y.merchantMwh, 0) / 1000, 0)} GWh`} detail={`₹${nf(years.reduce((a, y) => a + y.merchantRevCr, 0), 0)} cr over the term`} />
          <Stat label="Curtailed" value={`${nf(years.reduce((a, y) => a + y.curtailedMwh, 0) / 1000, 1)} GWh`} />
        </div>
      </Section>
      <Section index="5.1" title="Where the supplied energy came from" note="Each Contract Year (April–March), against the tender's limits">
        <SourcesChart years={years} />
        <div className="cfd-table" data-testid="cfd-ops-table">
          <div className="cfd-row head"><span>Contract Year</span><span>Supplied</span><span>Own RE</span><span>Green market</span><span>Group RE</span><span>Charging cost</span><span>Surplus sold</span><span>Weeks penalised</span></div>
          {years.map((y) => {
            const extraDays = y.marketCapMwh / (model.inputs.contractedMw * TENDER.mwhPerMwDay) - TENDER.marketShare * y.days;
            const cap = y.days ? (TENDER.marketShare * y.days + Math.max(0, extraDays)) / y.days : TENDER.marketShare;
            const marketOk = y.shareMarket <= cap + 1e-6;
            return (
              <div key={y.index} className={`cfd-row ${y.shortDays ? "bad" : ""}`}>
                <span><strong>CY {y.index}</strong><small>{fmtDate(y.start)} · {y.days} days</small></span>
                <span>{pf(y.supplyShare, 1)}<small>{nf(y.deliveredMwh / 1000, 1)} GWh</small></span>
                <span>{pf(y.shareOwn, 1)}</span>
                <span className={marketOk ? "ok" : "bad"}>{marketOk ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {pf(y.shareMarket, 1)}<small>limit {pf(cap, 0)}</small></span>
                <span>{pf(y.shareGroup, 1)}<small>limit {pf(y.groupCapMwh / Math.max(1, y.requiredMwh), 0)}</small></span>
                <span>₹{nf(y.marketCostCr + y.groupCostCr, 2)} cr</span>
                <span>{nf(y.merchantMwh / 1000, 1)} GWh<small>₹{nf(y.merchantRevCr, 1)} cr</small></span>
                <span>{y.weeks.filter((w) => w.beyondMwh > 1e-6).length}{y.shortDays ? <small><TriangleAlert size={11} /> {y.shortDays} days short</small> : null}</span>
              </div>
            );
          })}
        </div>
        <p className="rtc-note">Limits: green market 25% all term plus 75% until month 36 <Cite id="market75" />; group RE 50% after month 36 <Cite id="group50" />; shortfall beyond 10% a week is penalised <Cite id="tolerance" />.</p>
      </Section>
      <Section index="5.2" title="A day of operation" note="Pick any day of the term">
        <div className="cfd-day-pick">
          <input type="range" min="0" max={Math.max(0, totalDays - 1)} value={Math.min(k, totalDays - 1)} onChange={(e) => setK(Number(e.target.value))} aria-label="Day of the term" data-testid="cfd-day" />
          {day && <span><strong>{fmtDate(day.date)}</strong> · supplied {nf(day.delivered, 0)} of {nf(day.required, 0)} MWh in {day.chosen.map((h) => `${String(h).padStart(2, "0")}:00`).sort().join(" and ")}</span>}
        </div>
        <DayChart day={day} />
      </Section>
    </>
  );
}
