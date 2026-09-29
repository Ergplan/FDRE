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
      { name: "Surplus", type: "bar", stack: "s", data: r(agg.excess.map((v, i) => v + agg.curtail[i])), itemStyle: { color: "rgba(111,207,151,0.18)", borderColor: DATA_COLORS.surplus, borderWidth: 1 } },
      ...(dfrLine ? [{
        name: "DFR", type: "line", yAxisIndex: 1, data: dfr, showSymbol: labels.length <= 31, symbolSize: 5,
        lineStyle: { color: DATA_COLORS.demand, width: 2 }, itemStyle: { color: DATA_COLORS.demand },
        markLine: target ? { silent: true, symbol: "none", lineStyle: { color: DATA_COLORS.signal, type: "dashed" }, label: { formatter: "target", color: DATA_COLORS.signal }, data: [{ yAxis: target * 100 }] } : undefined,
      }] : []),
    ],
  };
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
        <Stat label="Surplus + curtailed" value={`${nf((sim.excessMWh + sim.curtailMWh) / 1000, 1)} MU`} detail={`${pf((sim.excessMWh + sim.curtailMWh) / Math.max(1, sim.solarGenMWh + sim.windGenMWh), 1)} of generation`} />
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
            <EnergyBalance sim={sim} />
          </div>
        </div>
      )}
    </Section>
  );
}

function EnergyBalance({ sim }) {
  const rows = [
    ["Demand", sim.demandMWh],
    ["Delivered", sim.deliveredMWh],
    ["  Solar direct", sim.solarDirectMWh],
    ["  Wind direct", sim.windDirectMWh],
    ["  Battery discharge", sim.dischargeMWh],
    ["Shortfall", sim.unmetMWh],
    ["Battery charging", sim.chargeMWh],
    ["Battery losses", sim.chargeMWh - sim.dischargeMWh],
    ["Surplus exported", sim.excessMWh],
    ["Curtailed", sim.curtailMWh],
    ["Solar generation", sim.solarGenMWh],
    ["Wind generation", sim.windGenMWh],
  ];
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Energy balance · year 1</th><th className="num">MU</th><th className="num">of demand</th></tr></thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><td className={k.startsWith("  ") ? "rtc-indent" : ""}>{k.trim()}</td><td className="rtc-num">{nf(v / 1000, 2)}</td><td className="rtc-num rtc-muted">{pf(v / Math.max(1, sim.demandMWh), 1)}</td></tr>
          ))}
        </tbody>
      </table>
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
