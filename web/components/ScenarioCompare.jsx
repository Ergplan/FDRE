"use client";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { scenarioApi } from "@/src/scenarios/client";
import { fieldsFor, formatField, MODULE_LABEL } from "@/lib/summaryFields";

const LiveChart = dynamic(() => import("@/src/rtc/charts").then((m) => m.LiveChart), { ssr: false, loading: () => <div className="empty-chart">Loading chart</div> });

// Which direction is "better" for highlighting.
const BEST = { tariff: "min", lcoe: "min", capexCr: "min", equityIrr: "max", projectIrr: "max", minDscr: "max", dfr: "max", minLifetimeDfr: "max", penaltyGwh: "min", payback: "min", curtailMu: "min" };
const PALETTE = ["#5ab4e8", "#f5b83d", "#a98bff", "#6fcf97", "#ff6b5f", "#e07b39", "#d4ff3f", "#f4f4f1"];

export default function ScenarioCompare({ items, missing }) {
  const summaries = items.map((i) => i.current.summary || {});
  const fields = fieldsFor(summaries);
  const names = items.map((i) => i.scenario.name);

  const best = useMemo(() => Object.fromEntries(fields.map((f) => {
    const dir = BEST[f.key];
    const vals = summaries.map((s) => Number(s[f.key])).filter(Number.isFinite);
    if (!dir || vals.length < 2) return [f.key, null];
    return [f.key, dir === "min" ? Math.min(...vals) : Math.max(...vals)];
  })), [fields, summaries]);

  const sizeOption = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 20, top: 36, bottom: 40 },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: names, axisLabel: { interval: 0, width: 140, overflow: "truncate" } },
    yAxis: { type: "value", name: "MW / MWh" },
    series: [
      ["solarMw", "Solar MW", "#f5b83d"], ["windMw", "Wind MW", "#5ab4e8"], ["bessMw", "BESS MW", "#a98bff"], ["bessMwh", "BESS MWh", "#7a64c9"],
    ].map(([k, n, c]) => ({ name: n, type: "bar", data: summaries.map((s) => s[k] ?? null), itemStyle: { color: c } })),
  }), [names, summaries]);

  const econOption = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 60, top: 36, bottom: 40 },
    legend: { top: 0, left: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: names, axisLabel: { interval: 0, width: 140, overflow: "truncate" } },
    yAxis: [{ type: "value", name: "₹ cr" }, { type: "value", name: "₹/kWh", splitLine: { show: false } }],
    series: [
      { name: "Project cost", type: "bar", data: summaries.map((s) => s.capexCr ?? null), itemStyle: { color: "#3a3a3a" } },
      { name: "Tariff", type: "line", yAxisIndex: 1, data: summaries.map((s) => s.tariff ?? null), itemStyle: { color: "#d4ff3f" }, lineStyle: { color: "#d4ff3f" }, symbolSize: 8 },
      { name: "LCOE", type: "line", yAxisIndex: 1, data: summaries.map((s) => s.lcoe ?? null), itemStyle: { color: "#6fcf97" }, lineStyle: { color: "#6fcf97", type: "dashed" }, symbolSize: 8 },
    ],
  }), [names, summaries]);

  if (items.length < 1) {
    return <div className="empty-state"><h2>Nothing to compare</h2><p className="note">Select two or more scenarios in the library.</p><a className="primary" href="/scenarios"><ArrowLeft size={14} /> Back to library</a></div>;
  }

  return (
    <>
      <div className="toolbar">
        <a className="secondary" href="/scenarios"><ArrowLeft size={14} /> Library</a>
        <a className="primary" href={scenarioApi.exportUrl(items.map((i) => i.scenario.id))}><Download size={14} /> Export comparison (Excel)</a>
        {missing.length > 0 && <span className="rtc-note">{missing.length} scenario(s) could not be found and were skipped.</span>}
      </div>
      <div className="table-wrap">
        <table className="compare">
          <thead>
            <tr>
              <th>Metric</th>
              {items.map((i, k) => (
                <th key={i.scenario.id}>
                  <span className="rtc-dot" style={{ background: PALETTE[k % PALETTE.length] }} />
                  <a href={`/scenarios/${i.scenario.id}`}>{i.scenario.name}</a>
                  <small>{MODULE_LABEL[i.scenario.module]} · v{i.current.version}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key}>
                <td>{f.label} <em className="rtc-unit">{f.unit}</em></td>
                {summaries.map((s, k) => {
                  const v = Number(s[f.key]);
                  const isBest = best[f.key] !== null && Number.isFinite(v) && Math.abs(v - best[f.key]) < 1e-9;
                  return <td key={k} className={`num ${isBest ? "best" : ""}`}>{formatField(f, s[f.key])}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rtc-grid rtc-grid-2 rtc-flush">
        <section className="rtc-section"><header><div><h2>Plant sizes</h2></div></header><LiveChart option={sizeOption} height={320} /></section>
        <section className="rtc-section"><header><div><h2>Cost and tariff</h2></div></header><LiveChart option={econOption} height={320} /></section>
      </div>
    </>
  );
}
