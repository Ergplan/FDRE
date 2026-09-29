import React, { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import { EnergyFlowChartView } from "energy-flow-chart/react";
import { THEME_NAME, DATA_COLORS } from "../chartTheme";

/** ECharts instance that persists across renders; option changes are applied in place. */
export function LiveChart({ option, height = 320, onEvents, notMerge = true }) {
  const ref = useRef(null);
  const inst = useRef(null);
  useEffect(() => {
    const chart = echarts.init(ref.current, THEME_NAME, { renderer: "canvas" });
    inst.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      inst.current = null;
    };
  }, []);
  useEffect(() => {
    inst.current?.setOption(option, { notMerge });
  }, [option, notMerge]);
  useEffect(() => {
    const chart = inst.current;
    if (!chart || !onEvents) return undefined;
    const entries = Object.entries(onEvents);
    entries.forEach(([name, fn]) => chart.on(name, fn));
    return () => entries.forEach(([name, fn]) => chart.off(name, fn));
  }, [onEvents]);
  return <div ref={ref} className="echart" style={{ height }} />;
}

/**
 * Bar/line chart the user edits with the mouse: press inside the plot and drag to "paint"
 * values. Intermediate categories are interpolated so fast strokes leave no gaps. The
 * change is committed on release. `locked` disables editing.
 */
export function PaintChart({
  values,
  labels,
  onChange,
  locked = false,
  min = 0,
  max = 2,
  step = 0.01,
  color = DATA_COLORS.demand,
  type = "bar",
  height = 260,
  unit = "",
  valueFormatter = (v) => v.toFixed(2),
  overlays = [],
  markValue = null,
  markLabel = "",
}) {
  const ref = useRef(null);
  const inst = useRef(null);
  const local = useRef([...values]);
  const painting = useRef(false);
  const lastIdx = useRef(null);
  const cfg = useRef({});
  cfg.current = { locked, min, max, step, onChange, labels };

  const buildOption = (data) => ({
    animation: false,
    grid: { left: 52, right: 16, top: 26, bottom: 30 },
    tooltip: { trigger: "axis", valueFormatter: (v) => (Number.isFinite(v) ? `${valueFormatter(v)}${unit}` : "–") },
    xAxis: { type: "category", data: labels, axisPointer: { type: "shadow" } },
    yAxis: { type: "value", min, max, axisLabel: { formatter: (v) => valueFormatter(v) } },
    series: [
      {
        name: "Edit",
        type,
        data,
        barWidth: "62%",
        showSymbol: type === "line",
        symbolSize: 7,
        itemStyle: { color },
        lineStyle: { color, width: 2 },
        areaStyle: type === "line" ? { color, opacity: 0.08 } : undefined,
        markLine: markValue !== null ? {
          silent: true,
          symbol: "none",
          lineStyle: { color: DATA_COLORS.signal, type: "dashed" },
          label: { formatter: markLabel, color: DATA_COLORS.signal, position: "insideEndTop", fontSize: 10 },
          data: [{ yAxis: markValue }],
        } : undefined,
      },
      ...overlays.map((o) => ({ name: o.name, type: o.type || "line", data: o.data, silent: true, showSymbol: false, lineStyle: { color: o.color, width: 1.4, type: o.dash ? "dashed" : "solid" }, itemStyle: { color: o.color }, z: 1 })),
    ],
  });

  useEffect(() => {
    const chart = echarts.init(ref.current, THEME_NAME, { renderer: "canvas" });
    inst.current = chart;
    const zr = chart.getZr();
    const paintAt = (x, y) => {
      const { min: lo, max: hi, step: st, labels: lbls } = cfg.current;
      const pt = chart.convertFromPixel({ seriesIndex: 0 }, [x, y]);
      if (!pt) return;
      const idx = Math.max(0, Math.min(lbls.length - 1, Math.round(pt[0])));
      const val = Math.max(lo, Math.min(hi, Math.round(pt[1] / st) * st));
      const data = local.current;
      const from = lastIdx.current ?? idx;
      const prevVal = lastIdx.current === null ? val : data[from];
      const span = Math.abs(idx - from);
      for (let k = 0; k <= span; k += 1) {
        const i = from + Math.sign(idx - from) * k;
        data[i] = span === 0 ? val : prevVal + ((val - prevVal) * k) / span;
      }
      data[idx] = val;
      lastIdx.current = idx;
      chart.setOption({ series: [{ data: [...data] }] });
    };
    const down = (e) => {
      if (cfg.current.locked || !chart.containPixel("grid", [e.offsetX, e.offsetY])) return;
      painting.current = true;
      lastIdx.current = null;
      paintAt(e.offsetX, e.offsetY);
    };
    const move = (e) => {
      if (!cfg.current.locked) zr.setCursorStyle(chart.containPixel("grid", [e.offsetX, e.offsetY]) ? "crosshair" : "default");
      if (painting.current) paintAt(e.offsetX, e.offsetY);
    };
    const up = () => {
      if (!painting.current) return;
      painting.current = false;
      lastIdx.current = null;
      cfg.current.onChange?.(local.current.map((v) => Number(v.toFixed(6))));
    };
    zr.on("mousedown", down);
    zr.on("mousemove", move);
    zr.on("mouseup", up);
    zr.on("globalout", up);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    if (painting.current) return;
    local.current = [...values];
    inst.current?.setOption(buildOption(local.current), { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, labels, min, max, color, type, markValue, overlays, locked]);

  return (
    <div className={`paint-chart ${locked ? "is-locked" : ""}`}>
      <div ref={ref} className="echart" style={{ height }} />
      <span className="paint-hint">{locked ? "Locked" : "Drag on the chart to redraw"}</span>
    </div>
  );
}

const FLOW_SERIES = [
  { key: "solar", label: "Solar", color: DATA_COLORS.solar },
  { key: "wind", label: "Wind", color: DATA_COLORS.wind },
  { key: "bess", label: "BESS discharge", color: DATA_COLORS.bess },
  { key: "unmet", label: "Shortfall", color: DATA_COLORS.unmet, pattern: "hatch", countInTotal: false },
  { key: "excess", label: "Surplus export", color: DATA_COLORS.surplus, pattern: "hatch", countInTotal: false },
  { key: "demand", label: "Demand", type: "line", dash: "6 4", color: { light: "#0b0b0b", dark: "#f4f4f1" } },
];

const FLOW_TOOLBAR = { range: true, stepper: true, view: false, todScale: false, lock: true, export: true };

/** Hourly supply stack using the Ergplan/charting energy-flow-chart library. */
export function FlowChart({ hourly, year = 2026, height = 440, rangeMode = "day" }) {
  const data = useMemo(() => {
    if (!hourly) return null;
    const n = hourly.demand.length;
    const t0 = Date.UTC(year, 0, 1);
    const t = new Array(n);
    for (let i = 0; i < n; i += 1) t[i] = t0 + (i + 1) * 3600000; // end-stamped hours
    const pick = (arr) => Array.from(arr, (v) => Math.round(v * 100) / 100);
    return {
      t,
      stepMinutes: 60,
      values: {
        solar: pick(hourly.solar),
        wind: pick(hourly.wind),
        bess: pick(hourly.discharge),
        unmet: pick(hourly.unmet),
        excess: pick(hourly.excess),
        demand: pick(hourly.demand),
      },
    };
  }, [hourly, year]);
  if (!data) return <div className="empty-chart">No dispatch</div>;
  return (
    <div className="rtc-flow">
      <EnergyFlowChartView
        data={data}
        series={FLOW_SERIES}
        theme="fdre"
        mode="dark"
        unit="MW"
        yLabel="Power (MW)"
        height={height}
        rangeMode={rangeMode}
        toolbar={FLOW_TOOLBAR}
        live={false}
      />
    </div>
  );
}
