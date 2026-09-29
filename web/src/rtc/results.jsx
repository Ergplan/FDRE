import React, { useEffect, useMemo, useRef, useState } from "react";
import { BatteryCharging, ChevronLeft, ChevronRight, RotateCcw, Sun, Wind } from "lucide-react";
import * as E from "./engine";
import { FlowChart, LiveChart } from "./charts";
import { DATA_COLORS } from "../chartTheme";
import { Section, Stat, nf, pf } from "./ui";

// ---------------------------------------------------------------- count-up numbers

function CountUp({ value, format, duration = 1400, play }) {
  const [shown, setShown] = useState(play ? 0 : value);
  const raf = useRef(0);
  useEffect(() => {
    if (!play || !Number.isFinite(value)) { setShown(value); return undefined; }
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - (1 - k) ** 3;
      setShown(value * eased);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, play, duration]);
  return <>{format(shown)}</>;
}

// ---------------------------------------------------------------- the answer

export function Answer({ sizes, sim, finance, capex, inputs, revealKey, optimized, targetIrr }) {
  const play = revealKey > 0;
  const ok = sim.dfr >= inputs.dfrTarget - 1e-6;
  const dur = sizes.bessMw > 0 ? sizes.bessMwh / sizes.bessMw : 0;
  const mix = [
    { key: "solar", label: "Solar", icon: Sun, color: DATA_COLORS.solar, value: sizes.solarMw, unit: "MWac" },
    { key: "wind", label: "Wind", icon: Wind, color: DATA_COLORS.wind, value: sizes.windMw, unit: "MW" },
    { key: "bess", label: "Battery", icon: BatteryCharging, color: DATA_COLORS.bess, value: sizes.bessMw, unit: "MW", extra: `${nf(sizes.bessMwh)} MWh · ${nf(dur, 1)} h` },
  ];
  return (
    <section className={`answer ${play ? "is-revealed" : ""}`} key={revealKey} id="rtc-answer">
      <header className="answer-head">
        <span className="rtc-index">{optimized ? "THE ANSWER" : "CURRENT DESIGN"}</span>
        <h2>{optimized ? "Least-cost round-the-clock plant" : "Your design, before optimizing"}</h2>
      </header>
      <div className="answer-mix">
        {mix.map((m, i) => {
          const Icon = m.icon;
          return (
            <div key={m.key} className="answer-cell" style={{ "--chapter": m.color, animationDelay: `${i * 140}ms` }}>
              <span><Icon size={14} /> {m.label}</span>
              <strong><CountUp value={m.value} play={play} format={(v) => nf(v)} /><em>{m.unit}</em></strong>
              {m.extra && <small>{m.extra}</small>}
            </div>
          );
        })}
      </div>
      <div className="answer-kpis">
        <div className="answer-kpi answer-kpi-main" style={{ animationDelay: "420ms" }}>
          <span>{finance.tariffLocked ? `Tariff (fixed) · equity IRR ${pf(finance.equityIrr, 1)}` : `Tariff for ${pf(targetIrr, 1)} equity IRR`}</span>
          <strong>₹<CountUp value={finance.tariff} play={play} format={(v) => v.toFixed(3)} /><em>/kWh</em></strong>
        </div>
        <div className="answer-kpi" style={{ animationDelay: "520ms" }}>
          <span>LCOE</span>
          <strong>₹<CountUp value={finance.lcoe} play={play} format={(v) => v.toFixed(3)} /></strong>
        </div>
        <div className={`answer-kpi ${ok ? "good" : "bad"}`} style={{ animationDelay: "620ms" }}>
          <span>DFR year 1 · target {pf(inputs.dfrTarget, 0)}</span>
          <strong><CountUp value={sim.dfr * 100} play={play} format={(v) => `${v.toFixed(2)}%`} /></strong>
        </div>
        <div className="answer-kpi" style={{ animationDelay: "720ms" }}>
          <span>Project cost</span>
          <strong>₹<CountUp value={capex.total} play={play} format={(v) => nf(v)} /><em>cr</em></strong>
        </div>
        <div className="answer-kpi" style={{ animationDelay: "820ms" }}>
          <span>Min DSCR · payback</span>
          <strong>{nf(finance.minDscr, 2)}<em>× · yr {finance.payback ?? "–"}</em></strong>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- dispatch: day / month / year

const SUPPLY = [
  ["solar", "Solar", DATA_COLORS.solar],
  ["wind", "Wind", DATA_COLORS.wind],
  ["discharge", "Battery", DATA_COLORS.bess],
];

function aggregate(hourly, keyOf, n) {
  const out = Object.fromEntries(["solar", "wind", "discharge", "unmet", "excess", "curtail", "demand", "charge"].map((k) => [k, new Array(n).fill(0)]));
  for (let t = 0; t < E.HOURS; t += 1) {
    const i = keyOf(t);
    if (i < 0) continue;
    for (const k in out) out[k][i] += hourly[k][t];
  }
  return out;
}

function stackOption(labels, agg, unit, { dfrLine = true, target } = {}) {
  const r = (arr) => arr.map((v) => Number(v.toFixed(2)));
  const dfr = agg.demand.map((d, i) => (d > 0 ? Number((((agg.solar[i] + agg.wind[i] + agg.discharge[i]) / d) * 100).toFixed(2)) : null));
  return {
    animation: true,
    animationDuration: 500,
    grid: { left: 58, right: dfrLine ? 52 : 20, top: 40, bottom: 30 },
    legend: { top: 0, left: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: labels },
    yAxis: [{ type: "value", name: unit }, ...(dfrLine ? [{ type: "value", name: "DFR %", min: 0, max: 100, splitLine: { show: false } }] : [])],
    series: [
      ...SUPPLY.map(([k, n, c]) => ({ name: n, type: "bar", stack: "s", data: r(agg[k]), itemStyle: { color: c } })),
      { name: "Shortfall", type: "bar", stack: "s", data: r(agg.unmet), itemStyle: { color: "rgba(255,107,95,0.3)", borderColor: DATA_COLORS.unmet, borderWidth: 1 } },
      { name: "Sold", type: "bar", stack: "s", data: r(agg.excess), itemStyle: { color: "rgba(111,207,151,0.35)", borderColor: DATA_COLORS.surplus, borderWidth: 1 } },
      { name: "Curtailed", type: "bar", stack: "s", data: r(agg.curtail), itemStyle: { color: "rgba(134,134,127,0.16)", borderColor: "#6a6a64", borderWidth: 1, borderType: "dashed" } },
      ...(dfrLine ? [{
        name: "DFR", type: "line", yAxisIndex: 1, data: dfr, showSymbol: labels.length <= 31, symbolSize: 5,
        lineStyle: { color: DATA_COLORS.demand, width: 2 }, itemStyle: { color: DATA_COLORS.demand },
        markLine: target ? { silent: true, symbol: "none", lineStyle: { color: DATA_COLORS.signal, type: "dashed" }, label: { formatter: "target", color: DATA_COLORS.signal }, data: [{ yAxis: target * 100 }] } : undefined,
      }] : []),
    ],
  };
}

function EnergyFlowSummary({ sim }) {
  const gen = sim.solarGenMWh + sim.windGenMWh;
  return (
    <div className="rtc-stats flush-top single-col-stats">
      <Stat label="Generated" value={`${MU(gen)} MU`} detail={`solar ${MU(sim.solarGenMWh)} · wind ${MU(sim.windGenMWh)}`} />
      <Stat label="Used by the customer" value={`${MU(sim.deliveredMWh)} MU`} detail={`${pf(sim.deliveredMWh / gen, 1)} of generation, incl. battery`} />
      <Stat label="Sold to grid" value={`${MU(sim.excessMWh)} MU`} detail={sim.sellSurplus ? "surplus sales on" : "surplus sales off"} />
      <Stat label="Curtailed" value={`${MU(sim.curtailMWh)} MU`} detail={`${pf(sim.curtailMWh / gen, 1)} of generation · see below`} tone={sim.curtailMWh / gen > 0.15 ? "bad" : undefined} />
    </div>
  );
}

export function DispatchStory({ sim, inputs, sizes }) {
  const [scale, setScale] = useState("day");
  const [month, setMonth] = useState(() => sim.monthlyDfr.indexOf(sim.minMonthlyDfr));
  const h = sim.hourly;

  const yearAgg = useMemo(() => aggregate(h, (t) => E.MONTH_OF_HOUR[t], 12), [h]);
  const monthStart = useMemo(() => E.MONTH_DAYS.slice(0, month).reduce((a, b) => a + b, 0), [month]);
  const monthAgg = useMemo(() => aggregate(h, (t) => {
    const day = Math.floor(t / 24) - monthStart;
    return day >= 0 && day < E.MONTH_DAYS[month] ? day : -1;
  }, E.MONTH_DAYS[month]), [h, month, monthStart]);

  const yearOption = useMemo(() => {
    const o = stackOption(E.MONTHS, Object.fromEntries(Object.entries(yearAgg).map(([k, v]) => [k, v.map((x) => x / 1000)])), "MU", { target: inputs.dfrTarget });
    return o;
  }, [yearAgg, inputs.dfrTarget]);
  const monthOption = useMemo(() => stackOption(
    Array.from({ length: E.MONTH_DAYS[month] }, (_, i) => String(i + 1)),
    Object.fromEntries(Object.entries(monthAgg).map(([k, v]) => [k, v.map((x) => x)])),
    "MWh",
    { target: inputs.dfrTarget },
  ), [monthAgg, month, inputs.dfrTarget]);
  const socOption = useMemo(() => {
    const t0 = Date.UTC(2026, 0, 1);
    return {
      animation: false,
      grid: { left: 52, right: 20, top: 16, bottom: 58 },
      tooltip: { trigger: "axis", valueFormatter: (v) => `${nf(v, 1)}%` },
      xAxis: { type: "time" },
      yAxis: { type: "value", min: 0, max: 100, name: "SoC %" },
      dataZoom: [{ type: "inside", start: 45, end: 47 }, { type: "slider", start: 45, end: 47, bottom: 8, height: 20 }],
      series: [{ name: "State of charge", type: "line", data: Array.from(h.soc, (v, i) => [t0 + i * 3600000, Number((v * 100).toFixed(1))]), sampling: "lttb", lineStyle: { color: DATA_COLORS.bess, width: 1.4 }, areaStyle: { color: "rgba(169,139,255,0.12)" } }],
    };
  }, [h]);

  const mDemand = sim.monthlyDemandMWh[month];
  const mDel = sim.monthlyDeliveredMWh[month];
  const ok = sim.dfr >= inputs.dfrTarget - 1e-6;

  return (
    <Section
      index="D"
      title="Dispatch"
      note="How the plant meets demand, hour by hour, day by day and month by month"
      actions={(
        <div className="seg seg-strong" role="tablist" aria-label="Dispatch time scale">
          {[["day", "Day"], ["month", "Month"], ["year", "Year"]].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={scale === id} className={scale === id ? "active" : ""} onClick={() => setScale(id)}>{label}</button>
          ))}
        </div>
      )}
    >
      <div className="rtc-stats flush-top">
        <Stat label="DFR year 1" value={pf(sim.dfr, 2)} detail={`target ${pf(inputs.dfrTarget, 0)}`} tone={ok ? "good" : "bad"} />
        <Stat label="Lowest month" value={pf(sim.minMonthlyDfr, 1)} detail={E.MONTHS[sim.monthlyDfr.indexOf(sim.minMonthlyDfr)]} />
        <Stat label="Delivered" value={`${nf(sim.deliveredMWh / 1000, 1)} MU`} detail={`of ${nf(sim.demandMWh / 1000, 1)} MU`} />
        <Stat label="Curtailed" value={`${nf(sim.curtailMWh / 1000, 1)} MU`} detail={`${pf(sim.curtailMWh / Math.max(1, sim.solarGenMWh + sim.windGenMWh), 1)} of generation · ${nf(sim.excessMWh / 1000, 1)} MU sold`} />
        <Stat label="Battery cycles" value={nf(sim.cycles, 0)} detail={`${nf(sizes.bessMw)} MW / ${nf(sizes.bessMwh)} MWh`} />
      </div>

      {scale === "day" && (
        <div className="dispatch-pane">
          <p className="rtc-note">Hour by hour. Step through the year with ‹ ›, switch to 7 days, lock the y-axis or export a PNG.</p>
          <FlowChart hourly={h} height={440} key="day" />
          <div className="rtc-card" style={{ marginTop: 14 }}>
            <div className="rtc-card-head"><span>Battery state of charge · drag the slider to move through the year</span></div>
            <LiveChart option={socOption} height={220} />
          </div>
        </div>
      )}
      {scale === "month" && (
        <div className="dispatch-pane">
          <div className="chapter-toolbar">
            <div className="month-stepper">
              <button type="button" className="rtc-icon-btn" onClick={() => setMonth((m) => (m + 11) % 12)} aria-label="Previous month"><ChevronLeft size={16} /></button>
              <div className="seg">
                {E.MONTHS.map((m, i) => (
                  <button key={m} type="button" className={`${month === i ? "active" : ""} ${sim.monthlyDfr[i] < inputs.dfrTarget ? "is-short" : ""}`} onClick={() => setMonth(i)}>{m}</button>
                ))}
              </div>
              <button type="button" className="rtc-icon-btn" onClick={() => setMonth((m) => (m + 1) % 12)} aria-label="Next month"><ChevronRight size={16} /></button>
            </div>
            <span className="rtc-note">{E.MONTHS[month]}: DFR {pf(mDemand > 0 ? mDel / mDemand : 1, 1)} · {nf(mDel / 1000, 1)} of {nf(mDemand / 1000, 1)} MU</span>
          </div>
          <LiveChart option={monthOption} height={380} />
        </div>
      )}
      {scale === "year" && (
        <div className="dispatch-pane">
          <div className="rtc-grid rtc-grid-2 tight-top">
            <LiveChart option={yearOption} height={380} />
            <EnergyFlowSummary sim={sim} />
          </div>
        </div>
      )}
    </Section>
  );
}

const MU = (v) => nf(v / 1000, 1);

/** Where every MWh generated in year 1 ends up, and why surplus was curtailed. */
export function EnergyFlow({ sim, inputs, fin }) {
  const bt = sim.byTech;
  const gen = sim.solarGenMWh + sim.windGenMWh;
  const surplus = sim.excessMWh + sim.curtailMWh;
  const cr = sim.curtailReasons;
  const lost = sim.chargeMWh - sim.dischargeMWh;
  const option = useMemo(() => {
    const nodes = [
      { name: "Solar", itemStyle: { color: DATA_COLORS.solar } },
      { name: "Wind", itemStyle: { color: DATA_COLORS.wind } },
      { name: "Battery", itemStyle: { color: DATA_COLORS.bess } },
      { name: "Customer", itemStyle: { color: "#f4f4f1" } },
      { name: "Sold to grid", itemStyle: { color: DATA_COLORS.surplus } },
      { name: "Curtailed", itemStyle: { color: "#6a6a64" } },
      { name: "Battery losses", itemStyle: { color: "#4a4a4a" } },
    ];
    const L = (source, target, v) => (v > 1 ? { source, target, value: Number((v / 1000).toFixed(2)) } : null);
    const links = [
      L("Solar", "Customer", bt.solar.direct), L("Solar", "Battery", bt.solar.charge), L("Solar", "Sold to grid", bt.solar.export), L("Solar", "Curtailed", bt.solar.curtail),
      L("Wind", "Customer", bt.wind.direct), L("Wind", "Battery", bt.wind.charge), L("Wind", "Sold to grid", bt.wind.export), L("Wind", "Curtailed", bt.wind.curtail),
      L("Battery", "Customer", sim.dischargeMWh), L("Battery", "Battery losses", lost),
    ].filter(Boolean);
    const used = new Set(links.flatMap((l) => [l.source, l.target]));
    return {
      animation: false,
      tooltip: { trigger: "item", formatter: (p) => (p.dataType === "edge" ? `${p.data.source} → ${p.data.target}<br/><b>${nf(p.data.value, 1)} MU</b>` : `${p.name}<br/><b>${nf(p.value, 1)} MU</b>`) },
      series: [{
        type: "sankey",
        left: 8, right: 150, top: 8, bottom: 8,
        nodeWidth: 14, nodeGap: 14, draggable: false,
        emphasis: { focus: "adjacency" },
        lineStyle: { color: "gradient", opacity: 0.38, curveness: 0.5 },
        label: { color: "#c2c2bc", fontSize: 12, formatter: (p) => `${p.name}  ${nf(p.value, 0)} MU` },
        data: nodes.filter((n) => used.has(n.name)),
        links,
      }],
    };
  }, [sim]);

  const reasonRows = [
    ["Battery already full", cr.batteryFull],
    ["Battery charging at its MW limit", cr.batteryPower],
    ["No battery in the design", cr.noStorage],
  ].filter(([, v]) => v > 1);
  const exportNote = sim.sellSurplus
    ? `Surplus is sold through spare plant capacity plus ${nf(fin.extraExportMw || 0)} MW of extra export capacity (up to ${nf(sim.exportLimitMw)} MW in total) at ₹${nf(fin.surplusPrice, 2)}/kWh. Anything beyond that is curtailed.`
    : "Surplus sales are off, so no energy is exported. Every MWh the customer and the battery cannot take is curtailed: turbines and inverters are backed down and the energy earns nothing.";

  return (
    <div className="energy-flow">
      <div className="rtc-card">
        <div className="rtc-card-head"><span>Where the energy goes · year 1 (MU)</span><span>{MU(gen)} MU generated</span></div>
        <LiveChart option={option} height={340} />
      </div>
      <div className="energy-flow-side">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Energy balance · year 1</th><th className="num">MU</th><th className="num">share</th></tr></thead>
            <tbody>
              <tr className="rtc-model-group"><td colSpan={3}>Customer demand</td></tr>
              <tr><td>Demand</td><td className="rtc-num">{MU(sim.demandMWh)}</td><td className="rtc-num rtc-muted">100%</td></tr>
              <tr><td className="rtc-indent">Met directly by solar</td><td className="rtc-num">{MU(sim.solarDirectMWh)}</td><td className="rtc-num rtc-muted">{pf(sim.solarDirectMWh / sim.demandMWh, 1)}</td></tr>
              <tr><td className="rtc-indent">Met directly by wind</td><td className="rtc-num">{MU(sim.windDirectMWh)}</td><td className="rtc-num rtc-muted">{pf(sim.windDirectMWh / sim.demandMWh, 1)}</td></tr>
              <tr><td className="rtc-indent">Met by the battery</td><td className="rtc-num">{MU(sim.dischargeMWh)}</td><td className="rtc-num rtc-muted">{pf(sim.dischargeMWh / sim.demandMWh, 1)}</td></tr>
              <tr className="rtc-model-total"><td>Delivered (DFR)</td><td className="rtc-num">{MU(sim.deliveredMWh)}</td><td className="rtc-num">{pf(sim.dfr, 1)}</td></tr>
              <tr><td>Shortfall</td><td className="rtc-num">{MU(sim.unmetMWh)}</td><td className="rtc-num rtc-muted">{pf(sim.unmetMWh / sim.demandMWh, 1)}</td></tr>
              <tr className="rtc-model-group"><td colSpan={3}>Plant generation</td></tr>
              <tr><td>Generated (solar {MU(sim.solarGenMWh)} + wind {MU(sim.windGenMWh)})</td><td className="rtc-num">{MU(gen)}</td><td className="rtc-num rtc-muted">100%</td></tr>
              <tr><td className="rtc-indent">Straight to the customer</td><td className="rtc-num">{MU(sim.solarDirectMWh + sim.windDirectMWh)}</td><td className="rtc-num rtc-muted">{pf((sim.solarDirectMWh + sim.windDirectMWh) / gen, 1)}</td></tr>
              <tr><td className="rtc-indent">Into the battery</td><td className="rtc-num">{MU(sim.chargeMWh)}</td><td className="rtc-num rtc-muted">{pf(sim.chargeMWh / gen, 1)}</td></tr>
              <tr><td className="rtc-indent">… returned to the customer</td><td className="rtc-num">{MU(sim.dischargeMWh)}</td><td className="rtc-num rtc-muted" /></tr>
              <tr><td className="rtc-indent">… lost in round trip</td><td className="rtc-num">{MU(lost)}</td><td className="rtc-num rtc-muted" /></tr>
              <tr><td className="rtc-indent">Sold to grid</td><td className="rtc-num">{MU(sim.excessMWh)}</td><td className="rtc-num rtc-muted">{pf(sim.excessMWh / gen, 1)}</td></tr>
              <tr className="rtc-model-total"><td className="rtc-indent">Curtailed (wasted)</td><td className="rtc-num">{MU(sim.curtailMWh)}</td><td className="rtc-num">{pf(sim.curtailMWh / gen, 1)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="curtail-note">
          <strong>What happens to curtailed power</strong>
          <p>
            In the hours the plant produces more than the customer needs (up to the {nf(inputs.plantCapacityMw)} MW plant capacity) and the battery can take, the extra {MU(surplus)} MU is surplus. {exportNote}
          </p>
          {reasonRows.length > 0 && (
            <ul>
              {reasonRows.map(([k, v]) => <li key={k}><span>{k}</span><b>{MU(v)} MU</b></li>)}
            </ul>
          )}
          {sim.curtailMWh > 1 && (
            <p className="rtc-note">
              To use it: sell surplus with extra export capacity (DFR chapter), add battery MW or MWh, or reduce solar and wind and accept a lower DFR margin. The optimizer already balances the cost of that overbuild against the DFR target.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- alternatives

export function Alternatives({ opt, sizes, target, applySizes }) {
  const [open, setOpen] = useState(false);
  const scatter = useMemo(() => {
    if (!opt || !open) return null;
    const pt = (p) => [p.capexCr, p.dfr * 100, p.lcoe, p];
    const tip = (p) => {
      const q = p.value[3];
      return `<b>${nf(q.solarMw)} MW solar · ${nf(q.windMw)} MW wind</b><br/>Battery ${nf(q.bessMw)} MW / ${nf(q.bessMwh)} MWh<br/>DFR ${nf(q.dfr * 100, 2)}% · LCOE ₹${nf(q.lcoe, 3)} · ₹${nf(q.capexCr, 0)} cr<br/><i>click to load</i>`;
    };
    const best = opt.best;
    return {
      animation: false,
      grid: { left: 60, right: 20, top: 30, bottom: 70 },
      legend: { top: 0, right: 0 },
      tooltip: { trigger: "item", formatter: tip },
      xAxis: { type: "value", name: "Project cost ₹ cr", nameLocation: "middle", nameGap: 28, scale: true },
      yAxis: { type: "value", name: "DFR %", scale: true, max: 100 },
      dataZoom: [{ type: "inside", xAxisIndex: 0 }, { type: "inside", yAxisIndex: 0 }, { type: "slider", xAxisIndex: 0, bottom: 8, height: 16 }],
      series: [
        { name: "Below target", type: "scatter", data: opt.cloud.filter((p) => !p.feasible).map(pt), symbolSize: 5, itemStyle: { color: "rgba(134,134,127,0.45)" } },
        { name: "Meets target", type: "scatter", data: opt.cloud.filter((p) => p.feasible).map(pt), symbolSize: 7, itemStyle: { color: DATA_COLORS.wind, opacity: 0.85 }, markLine: { silent: true, symbol: "none", lineStyle: { color: DATA_COLORS.signal, type: "dashed" }, label: { formatter: `DFR ${nf(target * 100, 0)}%`, color: DATA_COLORS.signal }, data: [{ yAxis: target * 100 }] } },
        best ? { name: "Optimum", type: "scatter", data: [[best.capexCr, best.dfrCheck * 100, best.lcoe, { ...best.sizes, dfr: best.dfrCheck, lcoe: best.lcoe, capexCr: best.capexCr }]], symbol: "diamond", symbolSize: 16, itemStyle: { color: DATA_COLORS.signal } } : null,
      ].filter(Boolean),
    };
  }, [opt, open, target]);
  const events = useMemo(() => ({ click: (p) => { const q = p?.value?.[3]; if (q) applySizes({ solarMw: q.solarMw, windMw: q.windMw, bessMw: q.bessMw, bessMwh: q.bessMwh }); } }), [applySizes]);
  if (!opt) return null;
  const same = (a) => ["solarMw", "windMw", "bessMw", "bessMwh"].every((k) => Math.abs(a[k] - sizes[k]) < 1e-9);
  return (
    <Section
      index="X"
      title="Explore alternatives"
      note={`${nf(opt.evals)} designs evaluated in ${nf(opt.ms / 1000, 1)} s`}
      actions={<button type="button" className="secondary" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} solution space</button>}
    >
      {open && <LiveChart option={scatter} height={400} onEvents={events} />}
      <div className="table-wrap" style={{ marginTop: open ? 16 : 0 }}>
        <table>
          <thead><tr><th>#</th><th className="num">Solar MW</th><th className="num">Wind MW</th><th className="num">Battery MW</th><th className="num">Battery MWh</th><th className="num">DFR yr 1</th><th className="num">DFR check</th><th className="num">LCOE ₹/kWh</th><th className="num">Capex ₹ cr</th><th /></tr></thead>
          <tbody>
            {(opt.alternatives.length ? opt.alternatives : [opt.best]).map((a, i) => (
              <tr key={i} className={same(a.sizes) ? "selected" : ""}>
                <td>{i + 1}</td>
                <td className="num">{nf(a.sizes.solarMw)}</td>
                <td className="num">{nf(a.sizes.windMw)}</td>
                <td className="num">{nf(a.sizes.bessMw)}</td>
                <td className="num">{nf(a.sizes.bessMwh)}</td>
                <td className="num">{pf(a.dfr, 2)}</td>
                <td className="num">{pf(a.dfrCheck, 2)}</td>
                <td className="num">{nf(a.lcoe, 3)}</td>
                <td className="num">{nf(a.capexCr, 0)}</td>
                <td className="lib-actions">{same(a.sizes) ? <span className="pill pass">loaded</span> : <button type="button" className="rtc-link" onClick={() => applySizes(a.sizes)}>Load</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {opt.previous && !same(opt.previous) && (
        <div className="panel-actions left-actions"><button type="button" className="secondary" onClick={() => applySizes(opt.previous)}><RotateCcw size={14} /> Restore the design from before the run</button></div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- optimizer log

const LOG_STAGES = [["all", "All"], ["setup", "Setup"], ["grid", "Surface"], ["refine", "Refine"], ["verify", "Verify"], ["result", "Result"]];

export function SolverLog({ opt }) {
  const [stage, setStage] = useState("all");
  const [open, setOpen] = useState(false);
  if (!opt?.log?.length) return null;
  const st = opt.stats || {};
  const rows = stage === "all" ? opt.log : opt.log.filter((l) => l.stage === stage);
  const download = () => {
    const lines = [
      `Round-the-clock optimizer log · ${opt.at || new Date().toISOString()}`,
      `designs ${st.evals} · dispatches ${st.dispatches} · simulated hours ${st.simulatedHours} · ${st.ms} ms`,
      "",
      ...opt.log.map((l) => `${String(l.t).padStart(6)} ms  ${l.stage.padEnd(7)} ${l.msg}`),
    ];
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `rtc_optimizer_log_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Section
      index="L"
      title="Optimizer log"
      note="What the optimizer searched, every point of the cost surface, each improvement, and the final checks"
      actions={(
        <>
          <button type="button" className="secondary" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} log</button>
          <button type="button" className="secondary" onClick={download}>Download .txt</button>
        </>
      )}
    >
      <div className="rtc-stats flush-top">
        <Stat label="Designs evaluated" value={nf(st.evals)} detail={`${nf(st.cacheHits)} repeats from cache`} />
        <Stat label="Full-year dispatches" value={nf(st.dispatches)} detail="8,760 hours each" />
        <Stat label="Hours simulated" value={`${nf((st.simulatedHours || 0) / 1e6, 1)} M`} detail={`${nf(st.simMs / Math.max(1, st.dispatches), 2)} ms per dispatch`} />
        <Stat label="Run time" value={`${nf((st.ms || 0) / 1000, 2)} s`} detail={`${nf(st.gridPoints)} surface points · ${st.starts} refine starts`} />
      </div>
      {open && (
        <>
          <div className="chapter-toolbar" style={{ marginTop: 12 }}>
            <div className="seg">
              {LOG_STAGES.map(([id, label]) => (
                <button key={id} type="button" className={stage === id ? "active" : ""} onClick={() => setStage(id)}>
                  {label}{id !== "all" ? ` (${opt.log.filter((l) => l.stage === id).length})` : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="solver-log" role="log">
            {rows.map((l, i) => (
              <div key={i} className={`log-line log-${l.stage} ${/best so far|✓|adopted/.test(l.msg) ? "log-hi" : ""} ${/misses DFR|does NOT/.test(l.msg) ? "log-lo" : ""}`}>
                <span className="log-t">{String(l.t).padStart(5)} ms</span>
                <span className="log-s">{l.stage}</span>
                <span className="log-m">{l.msg}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}
