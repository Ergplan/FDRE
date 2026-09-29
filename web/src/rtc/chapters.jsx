import React, { useMemo } from "react";
import { BatteryCharging, Clock3, Download, Sun, Target, Wind, X, Zap } from "lucide-react";
import * as E from "./engine";
import { LiveChart, PaintChart } from "./charts";
import { DATA_COLORS } from "../chartTheme";
import { Field, HOUR_LABELS, LockButton, NumberInput, SelectBox, Stat, SwitchBox, UploadButton, downloadText, heatmapOption, nf, pf } from "./ui";

// ---------------------------------------------------------------- chapter catalogue

export const CHAPTERS = [
  { id: "energy", title: "Energy needed", icon: Zap, color: "#d4ff3f" },
  { id: "type", title: "Supply type", icon: Clock3, color: "#4fd1c5" },
  { id: "dfr", title: "DFR", icon: Target, color: "#7ddc9a" },
  { id: "solar", title: "Solar", icon: Sun, color: DATA_COLORS.solar },
  { id: "wind", title: "Wind", icon: Wind, color: DATA_COLORS.wind },
  { id: "bess", title: "Battery storage", icon: BatteryCharging, color: DATA_COLORS.bess },
];

// Daily consumption shapes (relative to the daily mean) for the supply-type presets.
const range = (a, b, v, arr) => { for (let h = a; h <= b; h += 1) arr[h] = v; return arr; };
export const HOUR_PRESETS = [
  { id: "rtc", label: "Round the clock", note: "Flat supply every hour", shape: new Array(24).fill(1) },
  { id: "peak", label: "Peak-weighted", note: "Morning 06–09 and evening 17–22 peaks", shape: range(17, 22, 1.35, range(6, 9, 1.3, range(10, 16, 0.85, new Array(24).fill(0.8)))) },
  { id: "day", label: "Day-time", note: "Industrial shift 06–18", shape: range(6, 18, 1.55, new Array(24).fill(0.4)) },
  { id: "night", label: "Night-weighted", note: "Higher load 19–05", shape: range(6, 18, 0.62, new Array(24).fill(1.38)) },
];
export const MONTH_PRESETS = [
  { id: "flat", label: "No seasonality", shape: new Array(12).fill(1) },
  { id: "summer", label: "Summer peak", shape: [0.95, 0.97, 1.08, 1.15, 1.15, 1.02, 0.92, 0.92, 0.95, 1.0, 0.97, 0.94] },
];

const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
export function supplyTypeLabel(state) {
  if (state.demandUpload) return "Uploaded profile";
  const p = HOUR_PRESETS.find((x) => same(x.shape, state.hourShape));
  return p ? p.label : "Custom drawn";
}

export function chapterSummary(id, state, derived) {
  const { inputs, vars } = state;
  const fixed = (k) => (vars[k].locked ? `${nf(vars[k].value)} fixed` : `${nf(vars[k].min)}–${nf(vars[k].max)}`);
  switch (id) {
    case "energy": return `${nf(inputs.annualEnergyMu)} MU · ${nf(inputs.plantCapacityMw)} MW`;
    case "type": return supplyTypeLabel(state);
    case "dfr": return `${pf(inputs.dfrTarget, 0)} ${inputs.dfrBasis === "monthly" ? "every month" : "annual"}`;
    case "solar": return `${fixed("solarMw")} MW · CUF ${pf(derived.solarCuf, 1)}`;
    case "wind": return `${fixed("windMw")} MW · CUF ${pf(derived.windCuf, 1)}`;
    case "bess": return `${fixed("bessMw")} MW · ${fixed("bessMwh")} MWh`;
    default: return "";
  }
}

// ---------------------------------------------------------------- shared pieces

/** Plant size: fixed (locked) or searched by the optimizer between min and max. */
export function SizeCard({ label, unit, spec, onChange, color }) {
  return (
    <div className={`size-card ${spec.locked ? "is-locked" : ""}`} style={{ "--chapter": color }}>
      <div className="size-card-top">
        <span>{label}</span>
        <LockButton locked={spec.locked} onToggle={() => onChange({ locked: !spec.locked })} title={spec.locked ? "Fixed: the optimizer keeps this size" : "Free: the optimizer chooses this size"} />
      </div>
      <div className="size-card-value">
        <NumberInput value={spec.value} onCommit={(v) => onChange({ value: v })} step={spec.step} min={0} digits={1} />
        <em>{unit}</em>
      </div>
      {spec.locked ? (
        <small>Fixed. The optimizer keeps this size.</small>
      ) : (
        <div className="size-card-range">
          <small>Optimizer range</small>
          <NumberInput value={spec.min} onCommit={(v) => onChange({ min: Math.min(v, spec.max) })} step={spec.step} min={0} digits={1} />
          <span>–</span>
          <NumberInput value={spec.max} onCommit={(v) => onChange({ max: Math.max(v, spec.min) })} step={spec.step} min={0} digits={1} />
        </div>
      )}
    </div>
  );
}

function Group({ title, children, note }) {
  return (
    <div className="chapter-group">
      <div className="chapter-group-head"><span>{title}</span>{note && <small>{note}</small>}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- 01 energy needed

export function EnergyChapter({ state, patch, lockProps, isLocked, setTriplet, loadFactor, demand, peakDemand, sim }) {
  const { inputs } = state;
  const avgMw = (inputs.annualEnergyMu * 1000) / E.HOURS;
  const matrix = useMemo(() => E.monthHourMatrix(demand), [demand]);
  const avgDay = useMemo(() => HOUR_LABELS.map((_, h) => matrix.reduce((s, r) => s + r[h], 0) / 12), [matrix]);
  const heat = useMemo(() => {
    const vals = matrix.flat();
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return heatmapOption(matrix, { name: "Demand", unit: "MW", min: hi - lo < 1 ? 0 : lo, max: Math.max(hi, inputs.plantCapacityMw), colors: ["#151515", "#3d4a12", "#d4ff3f"] });
  }, [matrix, inputs.plantCapacityMw]);
  const dayOption = useMemo(() => ({
    animation: false,
    grid: { left: 52, right: 16, top: 28, bottom: 30 },
    tooltip: { trigger: "axis", valueFormatter: (v) => `${nf(v, 1)} MW` },
    legend: { top: 0, right: 0 },
    xAxis: { type: "category", data: HOUR_LABELS },
    yAxis: { type: "value", min: 0 },
    series: [
      { name: "Average demand", type: "line", step: "middle", data: avgDay.map((v) => Number(v.toFixed(2))), lineStyle: { color: "#d4ff3f", width: 2 }, itemStyle: { color: "#d4ff3f" }, areaStyle: { color: "rgba(212,255,63,0.08)" } },
      { name: "Plant capacity", type: "line", data: HOUR_LABELS.map(() => inputs.plantCapacityMw), lineStyle: { color: "#f4f4f1", type: "dashed", width: 1 }, itemStyle: { color: "#f4f4f1" } },
    ],
  }), [avgDay, inputs.plantCapacityMw]);

  return (
    <>
      <p className="chapter-lead">How much energy does the customer need, and through how big a connection? Lock any two of energy, capacity and load factor, and editing one moves the third.</p>
      <div className="rtc-grid rtc-grid-3">
        <Field label="Annual energy requirement" unit="MU" value={inputs.annualEnergyMu} onChange={(v) => setTriplet("energy", v)} {...lockProps("annualEnergyMu")} step={5} min={1} hint={`${nf(avgMw, 1)} MW average`} />
        <Field label="Plant capacity" unit="MW" value={inputs.plantCapacityMw} onChange={(v) => setTriplet("plant", v)} {...lockProps("plantCapacityMw")} step={1} min={1} disabled={isLocked("loadFactor") && isLocked("annualEnergyMu")} hint="Maximum delivery / export" />
        <Field label="Load factor" pct value={loadFactor} onChange={(v) => setTriplet("lf", v)} {...lockProps("loadFactor")} step={0.1} min={1} max={100} disabled={isLocked("annualEnergyMu") && isLocked("plantCapacityMw")} hint="Energy ÷ (capacity × 8760)" digits={3} />
        <Field label="Demand growth" pct value={inputs.demandGrowth} onChange={(v) => patch("inputs", { demandGrowth: v })} {...lockProps("demandGrowth")} step={0.1} hint="per year, in the 25-year model" />
        <Field label="Losses to delivery point" pct value={inputs.lossPct} onChange={(v) => patch("inputs", { lossPct: v })} {...lockProps("lossPct")} step={0.1} min={0} max={30} hint="Auxiliary + transmission" />
        <div className="rtc-stat-pair">
          <Stat label="Peak demand" value={`${nf(peakDemand, 1)} MW`} detail={peakDemand > inputs.plantCapacityMw + 1e-6 ? "above plant capacity" : "within capacity"} tone={peakDemand > inputs.plantCapacityMw + 1e-6 ? "bad" : undefined} />
          <Stat label="Year-1 demand" value={`${nf(sim.demandMWh / 1000, 0)} MU`} detail={`${nf(avgMw, 1)} MW average`} />
        </div>
      </div>
      <div className="rtc-grid rtc-grid-2">
        <div className="rtc-card"><div className="rtc-card-head"><span>Average day vs plant capacity (MW)</span></div><LiveChart option={dayOption} height={250} /></div>
        <div className="rtc-card"><div className="rtc-card-head"><span>Demand · month × hour (MW)</span></div><LiveChart option={heat} height={250} /></div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 02 supply type

export function TypeChapter({ state, set, lockProps, isLocked, readUpload, peakDemand }) {
  const custom = Boolean(state.demandUpload);
  const locked = isLocked("demandProfile");
  const hourMean = state.hourShape.reduce((a, b) => a + b, 0) / 24;
  const current = HOUR_PRESETS.find((p) => same(p.shape, state.hourShape));
  const season = MONTH_PRESETS.find((p) => same(p.shape, state.monthShape));
  const cap = state.inputs.plantCapacityMw;
  return (
    <>
      <p className="chapter-lead">When does the customer need the energy? Pick a pattern or draw your own on the charts. Energy is always rescaled to the annual requirement.</p>
      <div className="preset-grid">
        {HOUR_PRESETS.map((p) => (
          <button key={p.id} type="button" className={`preset ${current?.id === p.id && !custom ? "active" : ""}`} disabled={locked || custom} onClick={() => set("hourShape", [...p.shape])}>
            <MiniShape shape={p.shape} />
            <strong>{p.label}</strong>
            <small>{p.note}</small>
          </button>
        ))}
        <div className={`preset ${!current && !custom ? "active" : ""} ${custom ? "active" : ""}`}>
          <MiniShape shape={state.hourShape} />
          <strong>{custom ? "Uploaded 8760" : "Custom drawn"}</strong>
          <small>{custom ? state.demandUpload.name : "Drag on the chart below"}</small>
        </div>
      </div>
      <div className="chapter-toolbar">
        <div className="seg">
          {MONTH_PRESETS.map((p) => (
            <button key={p.id} type="button" disabled={locked || custom} className={season?.id === p.id ? "active" : ""} onClick={() => set("monthShape", [...p.shape])}>{p.label}</button>
          ))}
        </div>
        <div className="chapter-toolbar-end">
          <button type="button" className="secondary" onClick={() => downloadText("rtc_demand_template.csv", E.profileTemplateCsv("demand"))}><Download size={14} /> Template</button>
          <UploadButton label="Upload 8760" onFile={(f) => readUpload(f, "demand", "demandUpload")} disabled={locked} />
          {custom && <button type="button" className="secondary" disabled={locked} onClick={() => set("demandUpload", null)}><X size={14} /> Clear upload</button>}
          <LockButton locked={locked} onToggle={() => lockProps("demandProfile").onLock()} title="Lock the consumption profile" />
        </div>
      </div>
      {peakDemand > cap + 1e-6 && (
        <div className="alert">This pattern peaks at {nf(peakDemand, 0)} MW, above the {nf(cap, 0)} MW plant capacity, so some demand can never be served. Raise the plant capacity or lower the annual energy.</div>
      )}
      <div className="rtc-grid rtc-grid-2">
        <div className="rtc-card">
          <div className="rtc-card-head"><span>Hourly shape · relative to daily mean</span></div>
          <PaintChart values={state.hourShape} labels={HOUR_LABELS} onChange={(v) => set("hourShape", v)} locked={custom || locked} min={0} max={2} step={0.01} color="#4fd1c5" markValue={hourMean} markLabel="mean" />
        </div>
        <div className="rtc-card">
          <div className="rtc-card-head"><span>Monthly shape · relative daily energy</span></div>
          <PaintChart values={state.monthShape} labels={E.MONTHS} onChange={(v) => set("monthShape", v)} locked={custom || locked} min={0} max={2} step={0.01} color="#4fd1c5" />
        </div>
      </div>
    </>
  );
}

function MiniShape({ shape }) {
  const max = Math.max(...shape, 1e-6);
  const pts = shape.map((v, i) => `${(i / (shape.length - 1)) * 100},${30 - (v / max) * 26}`).join(" ");
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mini-shape" aria-hidden="true">
      <polyline points={`0,32 ${pts} 100,32`} />
    </svg>
  );
}

// ---------------------------------------------------------------- 03 DFR

export function DfrChapter({ state, patch, lockProps, maxDfr, sim }) {
  const { inputs, fin } = state;
  return (
    <>
      <p className="chapter-lead">The demand fulfilment ratio is the share of the customer’s demand that must be met from the plant. The optimizer rejects any design below it.</p>
      <div className="dfr-dial">
        <div className="dfr-track">
          <i className="dfr-fill" style={{ width: `${Math.min(100, inputs.dfrTarget * 100)}%` }} />
          <i className="dfr-max" style={{ left: `${Math.min(100, maxDfr * 100)}%` }} title="Maximum achievable with this plant capacity" />
          <i className="dfr-now" style={{ left: `${Math.min(100, sim.dfr * 100)}%` }} title="Current design, year 1" />
        </div>
        <div className="dfr-legend">
          <span><b className="sw-target" /> Target {pf(inputs.dfrTarget, 1)}</span>
          <span><b className="sw-now" /> Current design {pf(sim.dfr, 1)}</span>
          <span><b className="sw-max" /> Achievable ceiling {pf(maxDfr, 1)}</span>
        </div>
        <input type="range" min={50} max={100} step={0.5} value={inputs.dfrTarget * 100} disabled={lockProps("dfrTarget").locked} onChange={(e) => patch("inputs", { dfrTarget: Number(e.target.value) / 100 })} aria-label="DFR target" />
      </div>
      <div className="rtc-grid rtc-grid-3">
        <Field label="DFR target" pct value={inputs.dfrTarget} onChange={(v) => patch("inputs", { dfrTarget: v })} {...lockProps("dfrTarget")} step={0.5} min={1} max={100} />
        <SelectBox label="Measured over" value={inputs.dfrBasis} onChange={(v) => patch("inputs", { dfrBasis: v })} {...lockProps("dfrBasis")} options={[["annual", "The year (annual energy)"], ["monthly", "Every month"]]} />
        <SelectBox label="Design check" value={inputs.designCheck} onChange={(v) => patch("inputs", { designCheck: v })} {...lockProps("designCheck")} options={[["lifetime", "Year 1 + most degraded year"], ["year1", "Year 1 only"]]} hint="Degraded: worst solar, wind and battery year" />
        <Field label="Shortfall penalty" unit="₹/kWh" value={fin.shortfallPenalty} onChange={(v) => patch("fin", { shortfallPenalty: v })} {...lockProps("fin.shortfallPenalty")} step={0.05} min={0} hint="On energy below DFR × demand" />
      </div>
      <Group title="What happens to surplus" note="Energy the customer cannot take and the battery cannot store">
        <p className="chapter-lead small">
          To hold the DFR through nights and lean-wind months, the plant is built bigger than the average need, so on sunny and windy hours it makes more than the customer and the battery can absorb.
          That surplus is <b>curtailed</b> (inverters and turbines back down; no revenue) unless you <b>sell</b> it. Selling uses the plant capacity the customer is not using at that hour, plus any extra export capacity you have.
        </p>
        <div className="rtc-grid rtc-grid-4">
          <SwitchBox label="Sell surplus energy" checked={fin.sellSurplus} onChange={(v) => patch("fin", { sellSurplus: v })} {...lockProps("fin.sellSurplus")} hint={fin.sellSurplus ? "Surplus is exported and paid" : "All surplus is curtailed"} />
          <Field label="Surplus price" unit="₹/kWh" value={fin.surplusPrice} onChange={(v) => patch("fin", { surplusPrice: v })} {...lockProps("fin.surplusPrice")} disabled={!fin.sellSurplus} step={0.05} min={0} hint="Exchange / DISCOM / third party" />
          <Field label="Extra export capacity" unit="MW" value={fin.extraExportMw || 0} onChange={(v) => patch("fin", { extraExportMw: v })} {...lockProps("fin.extraExportMw")} disabled={!fin.sellSurplus} step={5} min={0} hint={`On top of the ${nf(inputs.plantCapacityMw)} MW plant capacity`} />
          <div className="rtc-stat-pair stacked">
            <Stat label="Sold · year 1" value={`${nf(sim.excessMWh / 1000, 1)} MU`} detail={fin.sellSurplus ? `₹${nf((sim.excessMWh * fin.surplusPrice) / 1e4, 0)} cr / yr` : "sales off"} />
            <Stat label="Curtailed · year 1" value={`${nf(sim.curtailMWh / 1000, 1)} MU`} detail={`${pf(sim.curtailMWh / Math.max(1, sim.solarGenMWh + sim.windGenMWh), 1)} of generation`} />
          </div>
        </div>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- 04 / 05 solar and wind

export function ResourceChapter({ kind, state, patch, set, setVar, lockProps, isLocked, cf, base, readUpload }) {
  const isSolar = kind === "solar";
  const meta = CHAPTERS.find((c) => c.id === kind);
  const upload = state[`${kind}Upload`];
  const scaleKey = `${kind}MonthScale`;
  const lockKey = `${kind}Profile`;
  const varKey = isSolar ? "solarMw" : "windMw";
  const monthly = useMemo(() => E.monthlyMeans(cf).map((v) => Number((v * 100).toFixed(2))), [cf]);
  const baseMonthly = useMemo(() => E.monthlyMeans(base).map((v) => Number((v * 100).toFixed(2))), [base]);
  const overlays = useMemo(() => [{ name: "Base profile", data: baseMonthly, color: "#86867f", dash: true }], [baseMonthly]);
  const matrix = useMemo(() => E.monthHourMatrix(cf).map((r) => r.map((v) => v * 100)), [cf]);
  const heat = useMemo(() => heatmapOption(matrix, { name: kind, unit: "%", max: isSolar ? 90 : 70, colors: ["#121212", isSolar ? "#6b4f16" : "#1d4661", meta.color] }), [matrix, kind, isSolar, meta.color]);
  const cuf = E.mean(cf);
  const scaled = state[scaleKey].some((v) => Math.abs(v - 1) > 1e-6);
  const { costs, fin } = state;

  function paintMonthly(values) {
    const next = state[scaleKey].map((s, m) => (monthly[m] > 0 ? Math.max(0, s * (values[m] / monthly[m])) : s));
    set(scaleKey, next.map((v) => Number(v.toFixed(5))));
  }

  return (
    <>
      <p className="chapter-lead">
        {isSolar
          ? "Solar sets the daytime supply. Load an hourly PVsyst/SolarGIS profile, or use the synthetic Beed profile tuned to your CUF."
          : "Wind fills the evening and the monsoon. Load an hourly wind profile, or use the synthetic Beed profile tuned to your CUF."}
      </p>
      <div className="chapter-split">
        <SizeCard label={`${meta.title} capacity`} unit={isSolar ? "MWac" : "MW"} spec={state.vars[varKey]} onChange={(v) => setVar(varKey, v)} color={meta.color} />
        <Group title="Cost & performance">
          <div className="rtc-grid rtc-grid-3">
            <Field label="Capex" unit="₹ cr/MW" value={isSolar ? costs.solarCrPerMw : costs.windCrPerMw} onChange={(v) => patch("costs", isSolar ? { solarCrPerMw: v } : { windCrPerMw: v })} {...lockProps(isSolar ? "costs.solarCrPerMw" : "costs.windCrPerMw")} step={0.05} min={0} />
            <Field label="O&M" unit="₹ lakh/MW/yr" value={isSolar ? fin.solarOmLakhPerMw : fin.windOmLakhPerMw} onChange={(v) => patch("fin", isSolar ? { solarOmLakhPerMw: v } : { windOmLakhPerMw: v })} {...lockProps(isSolar ? "fin.solarOmLakhPerMw" : "fin.windOmLakhPerMw")} step={0.1} min={0} />
            <Field label="Degradation" pct value={isSolar ? fin.solarDegradation : fin.windDegradation} onChange={(v) => patch("fin", isSolar ? { solarDegradation: v } : { windDegradation: v })} {...lockProps(isSolar ? "fin.solarDegradation" : "fin.windDegradation")} step={0.05} min={0} max={3} hint="per year" />
          </div>
        </Group>
      </div>
      <Group
        title="Generation profile"
        note={upload ? `Uploaded: ${upload.name} · ${upload.note}` : `Synthetic ${E.BEED_SITE.name} profile`}
      >
        <div className="chapter-toolbar">
          <div className={`rtc-grid ${isSolar ? "rtc-grid-4" : "rtc-grid-3"} grow`}>
            {isSolar ? (
              <>
                <Field label="Annual AC CUF" pct value={state.inputs.solarCuf} onChange={(v) => patch("inputs", { solarCuf: v })} {...lockProps("solarCuf")} disabled={Boolean(upload)} step={0.1} min={5} max={40} />
                <Field label="DC/AC ratio" value={state.inputs.solarDcAc} onChange={(v) => patch("inputs", { solarDcAc: v })} {...lockProps("solarDcAc")} disabled={Boolean(upload)} step={0.05} min={1} max={2} />
              </>
            ) : (
              <Field label="Annual CUF" pct value={state.inputs.windCuf} onChange={(v) => patch("inputs", { windCuf: v })} {...lockProps("windCuf")} disabled={Boolean(upload)} step={0.1} min={10} max={55} />
            )}
            <Field label="Upload reference MW" unit="MW" value={state[`${kind}RefMw`] ?? 0} onChange={(v) => set(`${kind}RefMw`, v)} {...lockProps(`${kind}RefMw`)} step={1} min={0} hint="For MW uploads; 0 = use the maximum" />
            <Stat label="Modelled CUF" value={pf(cuf, 2)} detail={scaled ? "after monthly redraw" : "as loaded"} />
          </div>
        </div>
        <div className="chapter-toolbar">
          <div className="chapter-toolbar-end">
            <button type="button" className="secondary" onClick={() => downloadText(`rtc_${kind}_template.csv`, E.profileTemplateCsv(kind))}><Download size={14} /> Template</button>
            <UploadButton label="Upload 8760" onFile={(f) => readUpload(f, kind, `${kind}Upload`)} disabled={isLocked(lockKey)} />
            {upload && <button type="button" className="secondary" disabled={isLocked(lockKey)} onClick={() => set(`${kind}Upload`, null)}><X size={14} /> Use synthetic</button>}
            <LockButton locked={isLocked(lockKey)} onToggle={() => lockProps(lockKey).onLock()} title={`Lock the ${kind} profile`} />
          </div>
        </div>
        <div className="rtc-grid rtc-grid-2">
          <div className="rtc-card">
            <div className="rtc-card-head">
              <span>Monthly CUF % · drag to rescale months</span>
              <button type="button" className="rtc-link" disabled={!scaled || isLocked(lockKey)} onClick={() => set(scaleKey, new Array(12).fill(1))}>Undo redraw</button>
            </div>
            <PaintChart values={monthly} labels={E.MONTHS} onChange={paintMonthly} locked={isLocked(lockKey)} min={0} max={isSolar ? 45 : 75} step={0.1} color={meta.color} valueFormatter={(v) => v.toFixed(1)} unit="%" overlays={overlays} />
          </div>
          <div className="rtc-card">
            <div className="rtc-card-head"><span>Capacity factor · month × hour (%)</span></div>
            <LiveChart option={heat} height={260} />
          </div>
        </div>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- 06 battery

export function BessChapter({ state, patch, setVar, lockProps, sizes, sim }) {
  const { bess, costs, fin } = state;
  const color = CHAPTERS.find((c) => c.id === "bess").color;
  const duration = sizes.bessMw > 0 ? sizes.bessMwh / sizes.bessMw : 0;
  return (
    <>
      <p className="chapter-lead">The battery shifts surplus solar and wind into the hours they cannot cover. It charges only from the plant, never from the grid.</p>
      <div className="rtc-grid rtc-grid-3">
        <SizeCard label="Power" unit="MW" spec={state.vars.bessMw} onChange={(v) => setVar("bessMw", v)} color={color} />
        <SizeCard label="Energy" unit="MWh" spec={state.vars.bessMwh} onChange={(v) => setVar("bessMwh", v)} color={color} />
        <div className="rtc-stat-pair stacked">
          <Stat label="Duration" value={`${nf(duration, 2)} h`} detail={`${nf(sizes.bessMw)} MW / ${nf(sizes.bessMwh)} MWh`} />
          <Stat label="Year-1 cycles" value={nf(sim.cycles, 0)} detail={`${nf(sim.dischargeMWh / 1000, 1)} MU discharged`} />
        </div>
      </div>
      <Group title="Cost">
        <div className="rtc-grid rtc-grid-3">
          <Field label="Energy capex" unit="₹ cr/MWh" value={costs.bessCrPerMwh} onChange={(v) => patch("costs", { bessCrPerMwh: v })} {...lockProps("costs.bessCrPerMwh")} step={0.05} min={0} hint="All-in incl. PCS unless split" />
          <Field label="PCS capex (optional)" unit="₹ cr/MW" value={costs.bessPcsCrPerMw} onChange={(v) => patch("costs", { bessPcsCrPerMw: v })} {...lockProps("costs.bessPcsCrPerMw")} step={0.05} min={0} />
          <Field label="O&M" unit="₹ lakh/MWh/yr" value={fin.bessOmLakhPerMwh} onChange={(v) => patch("fin", { bessOmLakhPerMwh: v })} {...lockProps("fin.bessOmLakhPerMwh")} step={0.1} min={0} />
        </div>
      </Group>
      <Group title="Performance">
        <div className="rtc-grid rtc-grid-4">
          <Field label="Round-trip efficiency" pct value={bess.rte} onChange={(v) => patch("bess", { rte: v })} {...lockProps("bess.rte")} step={0.5} min={50} max={100} hint="AC-AC" />
          <Field label="Minimum SoC" pct value={bess.minSoc} onChange={(v) => patch("bess", { minSoc: Math.min(v, bess.maxSoc - 0.05) })} {...lockProps("bess.minSoc")} step={1} min={0} max={50} />
          <Field label="Maximum SoC" pct value={bess.maxSoc} onChange={(v) => patch("bess", { maxSoc: Math.max(v, bess.minSoc + 0.05) })} {...lockProps("bess.maxSoc")} step={1} min={50} max={100} hint={`Usable depth ${pf(bess.maxSoc - bess.minSoc, 0)}`} />
          <Field label="Initial SoC" pct value={bess.initSoc} onChange={(v) => patch("bess", { initSoc: v })} {...lockProps("bess.initSoc")} step={5} min={0} max={100} />
          <Field label="Min duration" unit="h" value={bess.minDurationH} onChange={(v) => patch("bess", { minDurationH: Math.min(v, bess.maxDurationH) })} {...lockProps("bess.minDurationH")} step={0.5} min={0} hint="Optimizer MWh/MW window" />
          <Field label="Max duration" unit="h" value={bess.maxDurationH} onChange={(v) => patch("bess", { maxDurationH: Math.max(v, bess.minDurationH) })} {...lockProps("bess.maxDurationH")} step={0.5} min={0.5} />
        </div>
      </Group>
      <Group title="Ageing & augmentation">
        <div className="rtc-grid rtc-grid-4">
          <Field label="Capacity fade" pct value={bess.annualDegradation} onChange={(v) => patch("bess", { annualDegradation: v })} {...lockProps("bess.annualDegradation")} step={0.1} min={0} max={10} hint="per year" />
          <SelectBox label="Augmentation" value={bess.augmentation} onChange={(v) => patch("bess", { augmentation: v })} {...lockProps("bess.augmentation")} options={[["annual", "Annual top-up to nameplate"], ["oneTime", "One-time restore"], ["none", "None"]]} />
          <Field label="Augmentation year" value={bess.augmentationYear} onChange={(v) => patch("bess", { augmentationYear: Math.round(v) })} {...lockProps("bess.augmentationYear")} disabled={bess.augmentation !== "oneTime"} step={1} min={2} max={25} />
          <Field label="Price decline" pct value={bess.costDeclinePct} onChange={(v) => patch("bess", { costDeclinePct: v })} {...lockProps("bess.costDeclinePct")} step={0.5} min={0} max={20} hint="per year, prices augmentation" />
        </div>
      </Group>
    </>
  );
}
