// Dark ECharts theme matching styles.css, plus the energy-flow-chart theme for the
// Ergplan/charting library. Colour is reserved for data; chrome stays grey.
import * as echarts from "echarts";
import { registerTheme as registerFlowTheme } from "energy-flow-chart";

export const THEME_NAME = "fdre-dark";

export const DATA_COLORS = {
  solar: "#f5b83d",
  wind: "#5ab4e8",
  bess: "#a98bff",
  surplus: "#6fcf97",
  unmet: "#ff6b5f",
  demand: "#f4f4f1",
  signal: "#d4ff3f",
  muted: "#86867f",
};

const MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace';
const axis = {
  axisLine: { lineStyle: { color: "#3a3a3a" } },
  axisTick: { lineStyle: { color: "#3a3a3a" } },
  axisLabel: { color: "#86867f", fontFamily: MONO, fontSize: 10.5 },
  splitLine: { lineStyle: { color: "#1f1f1f" } },
  nameTextStyle: { color: "#86867f", fontFamily: MONO, fontSize: 10.5 },
};

echarts.registerTheme(THEME_NAME, {
  color: ["#5ab4e8", "#f5b83d", "#a98bff", "#6fcf97", "#ff6b5f", "#e07b39", "#d4ff3f", "#f4f4f1"],
  backgroundColor: "transparent",
  textStyle: { color: "#c2c2bc", fontFamily: '"Inter Tight", Inter, ui-sans-serif, system-ui, sans-serif' },
  title: { textStyle: { color: "#f4f4f1" }, subtextStyle: { color: "#86867f" } },
  legend: { textStyle: { color: "#c2c2bc", fontFamily: MONO, fontSize: 10.5 }, inactiveColor: "#4a4a4a" },
  tooltip: {
    backgroundColor: "#121212",
    borderColor: "#333333",
    borderWidth: 1,
    textStyle: { color: "#f4f4f1", fontSize: 12 },
    extraCssText: "border-radius:0;box-shadow:none;",
  },
  categoryAxis: axis,
  valueAxis: axis,
  timeAxis: axis,
  logAxis: axis,
  dataZoom: {
    backgroundColor: "transparent",
    borderColor: "#2a2a2a",
    fillerColor: "rgba(244,244,241,0.08)",
    handleStyle: { color: "#f4f4f1", borderColor: "#f4f4f1" },
    moveHandleStyle: { color: "#3a3a3a" },
    textStyle: { color: "#86867f", fontFamily: MONO, fontSize: 10 },
    dataBackground: { lineStyle: { color: "#4a4a4a" }, areaStyle: { color: "#1f1f1f" } },
    selectedDataBackground: { lineStyle: { color: "#86867f" }, areaStyle: { color: "#2a2a2a" } },
  },
  visualMap: { textStyle: { color: "#86867f", fontFamily: MONO } },
  markLine: { label: { color: "#c2c2bc" } },
  bar: { itemStyle: { borderRadius: 0 } },
  line: { symbol: "none", lineStyle: { width: 1.6 } },
});

registerFlowTheme({
  name: "fdre",
  dark: {
    surface: "#121212",
    page: "#0a0a0a",
    ink: "#f4f4f1",
    ink2: "#c2c2bc",
    muted: "#86867f",
    grid: "#1f1f1f",
    axis: "#3a3a3a",
    border: "rgba(255,255,255,0.10)",
    tooltip: "#181818",
    band: "rgba(255,255,255,0.04)",
    accent: "#d4ff3f",
    roles: { demand: "ink" },
    palette: ["#f5b83d", "#5ab4e8", "#a98bff", "#6fcf97", "#ff6b5f"],
  },
});
