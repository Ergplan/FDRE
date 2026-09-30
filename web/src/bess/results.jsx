import React, { useMemo, useState } from "react";
import { AlertTriangle, BatteryCharging, CheckCircle2, Download, Gauge, IndianRupee, XCircle } from "lucide-react";
import * as B from "./engine";
import { LiveChart } from "../rtc/charts";
import { DATA_COLORS } from "../chartTheme";
import { Section, Stat, downloadText, nf, pf } from "../rtc/ui";

const lakh = (v) => `₹${nf(v / 1e5, 3)}`;

function CountUp({ value, digits = 0, play }) {
  const [shown, setShown] = useState(play ? 0 : value);
  React.useEffect(() => {
    if (!play || !Number.isFinite(value)) { setShown(value); return undefined; }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / 1300);
      setShown(value * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, play]);
  return <>{nf(shown, digits)}</>;
}

// ---------------------------------------------------------------- the bid

export function BidAnswer({ state, res, optimized, revealKey }) {
  const { req } = state;
  const play = revealKey > 0;
  const ceiling = req.ceilingTariff;
  const below = ceiling ? 1 - res.charge / ceiling : null;
  const s = res.strategy;
  const day1 = res.plan.cohorts[0].mwh;
  return (
    <section className={`answer ${play ? "is-revealed" : ""}`} key={revealKey} id="bess-answer">
      <header className="answer-head">
        <span className="rtc-index">{optimized ? "THE BID" : "CURRENT STRATEGY"}</span>
        <h2>{optimized ? `Lowest capacity charge for ${nf(req.powerMw)} MW / ${nf(req.energyMwh)} MWh` : "Your battery strategy, before optimizing"}</h2>
      </header>
      <div className="answer-mix">
        <div className="answer-cell" style={{ "--chapter": DATA_COLORS.bess }}>
          <span><BatteryCharging size={14} /> Day-one battery</span>
          <strong><CountUp value={day1} play={play} /><em>MWh DC</em></strong>
          <small>{pf(day1 / res.plan.baseDc - 1, 1)} above the {nf(res.plan.baseDc)} MWh that lasts through year 1 · PCS {nf(res.plan.pcsMw)} MW</small>
        </div>
        <div className="answer-cell" style={{ "--chapter": "#4fd1c5" }}>
          <span><Gauge size={14} /> Augmentation</span>
          <strong><CountUp value={res.augMwh} play={play} /><em>MWh added</em></strong>
          <small>{res.augEvents.length ? `${res.augEvents.length} campaign${res.augEvents.length > 1 ? "s" : ""} (${s.interval ? `every ${s.interval} yr` : "only when needed"}) · ₹${nf(res.augCapexCr)} cr` : "none needed"}{res.unplanned ? ` · ${res.unplanned} unplanned` : ""}</small>
        </div>
        <div className="answer-cell" style={{ "--chapter": "#f5b83d" }}>
          <span><IndianRupee size={14} /> Capital cost</span>
          <strong>₹<CountUp value={res.capex.net} play={play} /><em>cr net</em></strong>
          <small>₹{nf(res.capex.total)} cr less ₹{nf(res.capex.vgf)} cr VGF · ₹{nf(res.capex.total / req.energyMwh, 2)} cr/MWh</small>
        </div>
      </div>
      <div className="answer-kpis">
        <div className="answer-kpi answer-kpi-main">
          <span>Capacity charge for {pf(state.fin.targetEquityIrr, 1)} equity IRR</span>
          <strong>₹<CountUp value={res.charge / 1e5} digits={3} play={play} /><em>lakh/MW/month</em></strong>
        </div>
        <div className={`answer-kpi ${below === null ? "" : below >= 0 ? "good" : "bad"}`}>
          <span>Ceiling {ceiling ? lakh(ceiling) : "not stated"}</span>
          <strong>{below === null ? "–" : `${below >= 0 ? "" : "+"}${nf(Math.abs(below) * 100, 1)}%`}</strong>
          <small>{below === null ? "" : below >= 0 ? "below the ceiling" : "above: bid not admissible"}</small>
        </div>
        <div className="answer-kpi">
          <span>Levelised cost of storage</span>
          <strong>₹{nf(res.lcos, 2)}<em>/kWh</em></strong>
        </div>
        <div className="answer-kpi">
          <span>Annual revenue</span>
          <strong>₹{nf(res.rows[0].capacityRevenue)}<em>cr</em></strong>
        </div>
        <div className="answer-kpi">
          <span>Min DSCR · project IRR</span>
          <strong>{nf(res.minDscr, 2)}<em>× · {pf(res.projectIrr, 1)}</em></strong>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- compliance

export function Compliance({ state, res }) {
  const items = B.compliance(state.req, state.tech, res);
  const src = state.reqSource || {};
  const srcKey = { "Contracted power": "powerMw", "Energy every year": "energyMwh", "Discharge duration": "durationH", Cycles: "cyclesPerDay", "Round-trip efficiency": "minRte", Availability: "availability", "Contract term": "contractYears", "Ceiling tariff": "ceilingTariff" };
  const bad = items.filter((i) => !i.ok).length;
  return (
    <Section index="C" title="Tender compliance" note={bad ? `${bad} requirement${bad > 1 ? "s" : ""} not met` : "Every requirement is met in every year"}>
      <div className="table-wrap">
        <table>
          <thead><tr><th /><th>Requirement</th><th>Tender</th><th>Design</th><th>Note</th><th>Source</th></tr></thead>
          <tbody>
            {items.map((i) => {
              const s = src[srcKey[i.label]];
              return (
                <tr key={i.label} className={i.ok ? "" : "row-warn"}>
                  <td>{i.ok ? <CheckCircle2 size={15} color="var(--good)" /> : <XCircle size={15} color="var(--bad, #ff6b5f)" />}</td>
                  <td><strong>{i.label}</strong></td>
                  <td>{i.required}</td>
                  <td>{i.design}</td>
                  <td className="muted">{i.note}</td>
                  <td>{s?.page ? `p. ${s.page}${s.clause ? ` · cl. ${s.clause}` : ""}` : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- capacity over the term

export function CapacityTrajectory({ state, res }) {
  const { req } = state;
  const option = useMemo(() => {
    const years = res.plan.years;
    const cohorts = [...new Set(years.flatMap((y) => y.byCohort.map((c) => c.year)))].sort((a, b) => a - b);
    const shades = ["#a98bff", "#4fd1c5", "#5ab4e8", "#7ddc9a", "#f5b83d", "#ff9f6b", "#d4ff3f", "#c9b8ff"];
    return {
      animation: true,
      grid: { left: 60, right: 96, top: 40, bottom: 36 },
      legend: { top: 0, left: 0, type: "scroll" },
      tooltip: { trigger: "axis", valueFormatter: (v) => (v === null || v === undefined ? "–" : nf(v, 1)) },
      xAxis: { type: "category", data: years.map((y) => `Y${y.year}`) },
      yAxis: [{ type: "value", name: "MWh at delivery point" }, { type: "value", name: "RTE %", min: 70, max: 100, splitLine: { show: false } }],
      series: [
        ...cohorts.map((cy, i) => ({
          name: cy === 1 ? "Day-one battery" : `Added in year ${cy}${years[cy - 1]?.augKind === "unplanned" ? " (unplanned)" : ""}`,
          type: "bar", stack: "e", barWidth: "58%",
          itemStyle: { color: shades[i % shades.length], opacity: cy === 1 ? 0.9 : 0.8 },
          data: years.map((y) => { const c = y.byCohort.find((x) => x.year === cy); return c ? Number(c.poiMwh.toFixed(1)) : null; }),
        })),
        {
          name: "Contracted energy", type: "line", step: "middle", symbol: "none", data: years.map(() => req.energyMwh),
          lineStyle: { color: DATA_COLORS.demand, type: "dashed", width: 2 }, itemStyle: { color: DATA_COLORS.demand },
        },
        {
          name: "AC round-trip efficiency", type: "line", yAxisIndex: 1, data: years.map((y) => Number((y.rte * 100).toFixed(2))),
          lineStyle: { color: DATA_COLORS.signal, width: 2 }, itemStyle: { color: DATA_COLORS.signal }, symbolSize: 5,
          markLine: { silent: true, symbol: "none", lineStyle: { color: "#ff6b5f", type: "dotted" }, label: { formatter: `min RTE ${nf(req.minRte * 100, 0)}%`, color: "#ff6b5f" }, data: [{ yAxis: req.minRte * 100 }] },
        },
      ],
    };
  }, [res, req]);
  return (
    <Section index="T" title="Energy over the contract term" note="Year-end energy each battery block can deliver; augmentation keeps the total above the contracted energy">
      <div className="rtc-stats flush-top">
        <Stat label="Lowest year-end energy" value={`${nf(req.energyMwh + res.minMarginMwh, 0)} MWh`} detail={`contracted ${nf(req.energyMwh)} MWh`} tone={res.minMarginMwh >= -1e-6 ? "good" : "bad"} />
        <Stat label="Installed by the end" value={`${nf(res.plan.years.at(-1).installedDcMwh)} MWh DC`} detail={`day one ${nf(res.plan.cohorts[0].mwh)} MWh`} />
        <Stat label="Augmentation" value={res.augEvents.length ? res.augEvents.map((e) => `Y${e.year}`).join(" · ") : "none"} detail={res.augEvents.length ? `${nf(res.augMwh)} MWh · ₹${nf(res.augCapexCr)} cr` : ""} />
        <Stat label="RTE in the last year" value={pf(res.endRte, 1)} detail={`tender minimum ${pf(state.req.minRte, 0)}`} tone={res.endRte < state.req.minRte ? "bad" : undefined} />
      </div>
      <LiveChart option={option} height={380} />
    </Section>
  );
}

// ---------------------------------------------------------------- typical day

export function TypicalDay({ state, res }) {
  const [year, setYear] = useState(1);
  const N = res.plan.years.length;
  const d = useMemo(() => B.typicalDay(state.req, state.tech, res, year), [state.req, state.tech, res, year]);
  const option = useMemo(() => ({
    animation: false,
    grid: { left: 58, right: 58, top: 36, bottom: 30 },
    legend: { top: 0, left: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`) },
    yAxis: [{ type: "value", name: "MW" }, { type: "value", name: "SoC %", min: 0, max: 100, splitLine: { show: false } }],
    series: [
      { name: "Discharge", type: "bar", stack: "p", data: d.power.map((v) => (v > 0 ? Math.round(v) : 0)), itemStyle: { color: DATA_COLORS.bess } },
      { name: "Charge", type: "bar", stack: "p", data: d.power.map((v) => (v < 0 ? Math.round(v) : 0)), itemStyle: { color: "rgba(169,139,255,0.35)", borderColor: DATA_COLORS.bess, borderType: "dashed" } },
      { name: "State of charge", type: "line", yAxisIndex: 1, smooth: true, data: d.soc.map((v) => Number((v * 100).toFixed(1))), lineStyle: { color: DATA_COLORS.signal, width: 2 }, itemStyle: { color: DATA_COLORS.signal }, areaStyle: { color: "rgba(212,255,63,0.08)" } },
    ],
  }), [d]);
  return (
    <Section
      index="D"
      title="A day of operation"
      note={`${state.req.cyclesPerDay} cycle${state.req.cyclesPerDay > 1 ? "s" : ""} per day at ${nf(state.req.powerMw)} MW; the state of charge is the share of what the battery can hold in that year`}
      actions={(
        <label className="year-slider">Year {year}
          <input type="range" min={1} max={N} value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
      )}
    >
      <div className="rtc-stats flush-top">
        <Stat label="Energy the battery holds" value={`${nf(d.usableMwh)} MWh`} detail={`year ${year}, at the delivery point`} />
        <Stat label="Headroom over the contract" value={pf(d.headroom, 1)} tone={d.headroom < -1e-6 ? "bad" : undefined} />
        <Stat label="Round-trip efficiency" value={pf(d.rte, 1)} detail={`charge ${nf(state.req.energyMwh / d.rte)} MWh per cycle`} />
      </div>
      <LiveChart option={option} height={320} />
    </Section>
  );
}

// ---------------------------------------------------------------- strategies

export function StrategyMap({ opt, current, onPick }) {
  const option = useMemo(() => {
    if (!opt) return null;
    const vals = opt.cells.map((c) => c.z);
    const lo = Math.min(...vals);
    const hi = Math.min(Math.max(...vals), lo * 1.2);
    return {
      animation: false,
      grid: { left: 64, right: 90, top: 16, bottom: 52 },
      tooltip: { formatter: (p) => { const c = p.data.cell; return `Day-one oversize <b>${nf(c.sizes.oversize * 100, 0)}%</b>, augment every <b>${c.sizes.interval} yr</b><br/>₹${nf(c.z, 3)} lakh/MW/month${c.unplanned ? `<br/>${c.unplanned} unplanned top-up${c.unplanned > 1 ? "s" : ""}` : ""}<br/><i>click to load</i>`; } },
      xAxis: { type: "category", name: "Day-one oversize %", nameLocation: "middle", nameGap: 30, data: opt.axes.solarGrid.map((v) => `${v}`) },
      yAxis: { type: "category", name: "Augment every … years", data: opt.axes.windGrid.map((v) => `${v}`) },
      visualMap: { dimension: 2, min: Number(lo.toFixed(3)), max: Number(hi.toFixed(3)), calculable: true, right: 0, top: "middle", itemHeight: 180, precision: 2, text: ["lakh/MW/mo", ""], inRange: { color: ["#fde725", "#6ece58", "#1f9e89", "#31688e", "#482878"] }, outOfRange: { color: "#482878" }, textStyle: { color: "#86867f" } },
      series: [{
        type: "heatmap",
        data: opt.cells.map((c) => ({ value: [c.si, c.wi, Number(c.z.toFixed(4))], cell: c })),
        itemStyle: { borderColor: "#0a0a0a", borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: DATA_COLORS.signal, borderWidth: 2 } },
      }],
    };
  }, [opt]);
  const events = useMemo(() => ({ click: (p) => { const c = p?.data?.cell; if (c) onPick({ oversize: c.sizes.oversize, interval: c.sizes.interval }); } }), [onPick]);
  if (!opt) return null;
  return (
    <Section index="M" title="Every strategy" note={`${opt.evals} strategies priced, each with its own capacity charge; click one to load it`}>
      <LiveChart option={option} height={Math.max(320, 26 * opt.axes.windGrid.length + 80)} onEvents={events} />
      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table>
          <thead><tr><th>#</th><th className="num">Day-one oversize</th><th className="num">Augment every</th><th className="num">₹ lakh/MW/month</th><th className="num">Unplanned top-ups</th><th /></tr></thead>
          <tbody>
            {opt.ranked.slice(0, 8).map((r, i) => {
              const on = Math.abs(r.oversize - current.oversize) < 1e-6 && r.interval === (current.interval || opt.axes.windGrid.at(-1));
              return (
                <tr key={i} className={on ? "selected" : ""}>
                  <td>{i + 1}</td>
                  <td className="num">{nf(r.oversize * 100, 0)}%</td>
                  <td className="num">{r.interval} yr</td>
                  <td className="num">{nf(r.chargeLakh, 3)}</td>
                  <td className="num">{r.unplanned || "–"}</td>
                  <td className="lib-actions">{on ? <span className="pill pass">loaded</span> : <button type="button" className="rtc-link" onClick={() => onPick({ oversize: r.oversize, interval: r.interval })}>Load</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- finance

export function FinanceTable({ state, res }) {
  const [open, setOpen] = useState(false);
  const rows = res.rows;
  const csv = () => {
    const cols = ["year", "tariff", "revenue", "om", "rtePenalty", "chargingCost", "ebitda", "aug", "interest", "principal", "tax", "cfads", "dscr", "fcfe", "rte"];
    downloadText(`bess_financial_model_${state.req.powerMw}MW.csv`, [cols.join(","), ...rows.map((r) => cols.map((c) => (r[c] === null ? "" : Number(r[c]).toFixed(4))).join(","))].join("\n"));
  };
  const chart = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 20, top: 36, bottom: 30 },
    legend: { top: 0, left: 0 },
    tooltip: { trigger: "axis", valueFormatter: (v) => `₹${nf(v, 1)} cr` },
    xAxis: { type: "category", data: rows.map((r) => `Y${r.year}`) },
    yAxis: { type: "value", name: "₹ cr" },
    series: [
      { name: "Revenue", type: "bar", data: rows.map((r) => r.revenue), itemStyle: { color: "#4fd1c5" } },
      { name: "O&M and penalties", type: "bar", data: rows.map((r) => -r.opex), itemStyle: { color: "#f5b83d" } },
      { name: "Augmentation", type: "bar", data: rows.map((r) => -r.aug), itemStyle: { color: DATA_COLORS.bess } },
      { name: "Debt service", type: "bar", data: rows.map((r) => -r.ds), itemStyle: { color: "#5ab4e8" } },
      { name: "Equity cash flow", type: "line", data: rows.map((r) => r.fcfe), lineStyle: { color: DATA_COLORS.signal, width: 2 }, itemStyle: { color: DATA_COLORS.signal } },
    ],
  }), [rows]);
  return (
    <Section
      index="F"
      title={`Financial model · ${rows.length} years`}
      note="Capacity charge solved for the target equity IRR"
      actions={(
        <>
          <button type="button" className="secondary" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} yearly table</button>
          <button type="button" className="secondary" onClick={csv}><Download size={14} /> CSV</button>
        </>
      )}
    >
      <div className="rtc-stats flush-top">
        <Stat label="Equity IRR" value={pf(res.equityIrr, 2)} detail={`target ${pf(state.fin.targetEquityIrr, 1)}`} />
        <Stat label="Project IRR" value={pf(res.projectIrr, 2)} />
        <Stat label="Debt · equity" value={`₹${nf(res.debt)} · ₹${nf(res.equity)} cr`} detail={`${pf(state.fin.debtFraction, 0)} debt at ${pf(state.fin.interestRate, 1)}`} />
        <Stat label="DSCR" value={`${nf(res.minDscr, 2)} min`} detail={`average ${nf(res.avgDscr, 2)}`} tone={res.minDscr < 1.1 ? "bad" : undefined} />
        <Stat label="Capital cost" value={`₹${nf(res.capex.total)} cr`} detail={`DC ₹${nf(res.capex.dc)} · PCS ₹${nf(res.capex.pcs)} · BoP ₹${nf(res.capex.bop)}`} />
      </div>
      <LiveChart option={chart} height={300} />
      {open && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Year</th><th className="num">Revenue</th><th className="num">O&M</th><th className="num">RTE penalty</th><th className="num">EBITDA</th><th className="num">Augmentation</th><th className="num">Interest</th><th className="num">Principal</th><th className="num">Tax</th><th className="num">DSCR</th><th className="num">Equity CF</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.year}>
                  <td>{r.year}</td>
                  {[r.revenue, r.om, r.rtePenalty, r.ebitda, r.aug, r.interest, r.principal, r.tax].map((v, i) => <td key={i} className="num">{nf(v, 1)}</td>)}
                  <td className="num">{r.dscr === null ? "–" : nf(r.dscr, 2)}</td>
                  <td className="num">{nf(r.fcfe, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- tender insights

export function TenderInsights({ tender }) {
  if (!tender) return null;
  const flags = tender.risk_flags || [];
  const amend = (tender.amendments || []).filter((a) => a && Object.values(a).some(Boolean));
  const fieldRows = (tender.requirements || []).filter((f) => ["availabilityPenalty", "rtePenalty", "emdLakhPerMw", "pbgLakhPerMw", "minBidMw", "maxBidMw", "connectionKv", "location", "tariffBasis"].includes(f.key));
  return (
    <Section index="R" title="Tender insights" note={`${tender.source_name} · penalties, securities and risks found in the document`}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th>What the tender says</th><th>Source</th></tr></thead>
          <tbody>
            {fieldRows.map((f) => (
              <tr key={f.key}><td><strong>{f.label}</strong></td><td className="activity-detail">{f.display}</td><td>{f.page ? `p. ${f.page}${f.clause ? ` · cl. ${f.clause}` : ""}` : "–"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {flags.length > 0 && (
        <div className="bess-flags">
          {flags.map((f, i) => (
            <div key={i} className="bess-flag">
              <AlertTriangle size={14} />
              <div>{Object.entries(f).map(([k, v]) => <p key={k}><b>{k}:</b> {String(v)}</p>)}</div>
            </div>
          ))}
        </div>
      )}
      {amend.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr>{Object.keys(amend[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
            <tbody>{amend.map((a, i) => <tr key={i}>{Object.values(a).map((v, j) => <td key={j}>{String(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
