import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BatteryCharging,
  Download,
  Loader2,
  Lock,
  RotateCcw,
  Save,
  Sun,
  Unlock,
  Upload,
  Wind,
  X,
  Zap,
} from "lucide-react";
import * as E from "./engine";
import { FlowChart, LiveChart, PaintChart } from "./charts";
import { DATA_COLORS } from "../chartTheme";
import SaveDialog from "../scenarios/SaveDialog";

// ---------------------------------------------------------------- state

const STORAGE_KEY = "fdre.rtc.v1";
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const VAR_META = {
  solarMw: { label: "Solar", unit: "MWac", icon: Sun, color: DATA_COLORS.solar },
  windMw: { label: "Wind", unit: "MW", icon: Wind, color: DATA_COLORS.wind },
  bessMw: { label: "BESS power", unit: "MW", icon: BatteryCharging, color: DATA_COLORS.bess },
  bessMwh: { label: "BESS energy", unit: "MWh", icon: BatteryCharging, color: DATA_COLORS.bess },
};
const SUBTABS = [
  ["load", "Load"],
  ["resource", "Resource"],
  ["storage", "Storage & cost"],
  ["optimizer", "Optimizer"],
  ["dispatch", "Dispatch"],
  ["finance", "Financial model"],
];

function defaultState() {
  const { site, ...inputs } = E.DEFAULT_RTC_INPUTS;
  return {
    view: "load",
    inputs,
    hourShape: [...E.FLAT_HOUR_SHAPE],
    monthShape: [...E.FLAT_MONTH_SHAPE],
    demandUpload: null,
    solarUpload: null,
    windUpload: null,
    solarMonthScale: new Array(12).fill(1),
    windMonthScale: new Array(12).fill(1),
    bess: { ...E.DEFAULT_BESS },
    costs: { ...E.DEFAULT_COSTS },
    fin: { ...E.DEFAULT_FINANCE },
    vars: structuredClone(E.DEFAULT_VARS),
    objective: "lcoe",
    gridPoints: 11,
    tariffLocked: false,
    locks: { loadFactor: false },
  };
}

function mergeState(saved) {
  const base = defaultState();
  const merged = { ...base, ...saved };
  for (const k of ["inputs", "bess", "costs", "fin", "locks"]) merged[k] = { ...base[k], ...(saved[k] || {}) };
  merged.vars = Object.fromEntries(Object.keys(base.vars).map((k) => [k, { ...base.vars[k], ...(saved.vars?.[k] || {}) }]));
  return merged;
}

function loadState() {
  const base = defaultState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    return mergeState(JSON.parse(raw));
  } catch {
    return base;
  }
}

let sessionState = null; // survives switching dashboard tabs
let sessionOpt = null;
let sessionLinked = null;
let openedScenarioKey = null;

/** Keep saved optimizer results compact: the scatter cloud is thinned to 1,500 points. */
function compactOpt(opt) {
  if (!opt) return null;
  const step = Math.max(1, Math.ceil((opt.cloud?.length || 0) / 1500));
  return { ...opt, cloud: (opt.cloud || []).filter((_, i) => i % step === 0) };
}

// ---------------------------------------------------------------- formatting

const nf = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "–" : new Intl.NumberFormat("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v)));
const pf = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "–");

function downloadText(name, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- lockable inputs

function LockButton({ locked, onToggle, title }) {
  return (
    <button
      type="button"
      className={`lock-btn ${locked ? "on" : ""}`}
      onClick={onToggle}
      title={title || (locked ? "Locked: click to unlock" : "Unlocked: click to lock")}
      aria-pressed={locked}
    >
      {locked ? <Lock size={12} /> : <Unlock size={12} />}
    </button>
  );
}

function NumberInput({ value, onCommit, disabled, step = "any", scale = 1, digits = 4, min, max }) {
  const [draft, setDraft] = useState(null);
  const shown = Number.isFinite(value) ? String(Number((value * scale).toFixed(digits))) : "";
  return (
    <input
      type="number"
      step={step}
      value={draft ?? shown}
      disabled={disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) {
          let v = n;
          if (min !== undefined) v = Math.max(min, v);
          if (max !== undefined) v = Math.min(max, v);
          onCommit(v / scale);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** Label + number input + lock toggle. Locked fields cannot be edited. */
function Field({ label, value, onChange, locked, onLock, unit, pct = false, step, min, max, hint, disabled, digits, lockDisables = true }) {
  return (
    <div className={`rtc-field ${locked ? "is-locked" : ""}`}>
      <div className="rtc-field-top">
        <span>{label}</span>
        {onLock && <LockButton locked={locked} onToggle={onLock} />}
      </div>
      <div className="rtc-field-input">
        <NumberInput value={value} onCommit={onChange} disabled={disabled || (locked && lockDisables)} step={step} scale={pct ? 100 : 1} digits={digits ?? 4} min={min} max={max} />
        {(unit || pct) && <em>{pct ? "%" : unit}</em>}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function SelectBox({ label, value, onChange, locked, onLock, options, hint }) {
  return (
    <div className={`rtc-field ${locked ? "is-locked" : ""}`}>
      <div className="rtc-field-top">
        <span>{label}</span>
        {onLock && <LockButton locked={locked} onToggle={onLock} />}
      </div>
      <select value={value} disabled={locked} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function SwitchBox({ label, checked, onChange, locked, onLock, hint }) {
  return (
    <div className={`rtc-field ${locked ? "is-locked" : ""}`}>
      <div className="rtc-field-top">
        <span>{label}</span>
        {onLock && <LockButton locked={locked} onToggle={onLock} />}
      </div>
      <button type="button" className={`rtc-switch ${checked ? "on" : ""}`} disabled={locked} onClick={() => onChange(!checked)}>
        <i />
        {checked ? "On" : "Off"}
      </button>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Section({ index, title, note, actions, children, className = "" }) {
  return (
    <section className={`rtc-section ${className}`}>
      <header>
        <div>
          {index && <span className="rtc-index">{index}</span>}
          <h2>{title}</h2>
        </div>
        <div className="rtc-section-actions">
          {note && <span className="rtc-note">{note}</span>}
          {actions}
        </div>
      </header>
      {children}
    </section>
  );
}

function UploadButton({ label, onFile, disabled }) {
  const ref = useRef(null);
  return (
    <>
      <button type="button" className="secondary" disabled={disabled} onClick={() => ref.current?.click()}>
        <Upload size={14} /> {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept=".csv,.txt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </>
  );
}

function Stat({ label, value, detail, tone }) {
  return (
    <div className={`rtc-stat ${tone ? `tone-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

// ---------------------------------------------------------------- chart options

function heatmapOption(matrix, { name, unit, max, min = 0, colors }) {
  const data = [];
  matrix.forEach((row, m) => row.forEach((v, h) => data.push([h, m, Number(v.toFixed(3))])));
  const hi = max ?? Math.max(...data.map((d) => d[2]), 1e-6);
  const lo = Math.min(min, hi * 0.5);
  return {
    animation: false,
    grid: { left: 44, right: 16, top: 10, bottom: 58 },
    tooltip: { formatter: (p) => `${E.MONTHS[p.value[1]]} · ${HOUR_LABELS[p.value[0]]}:00<br/><b>${nf(p.value[2], unit === "%" ? 1 : 1)} ${unit}</b>` },
    xAxis: { type: "category", data: HOUR_LABELS, splitArea: { show: false } },
    yAxis: { type: "category", data: E.MONTHS, inverse: true },
    visualMap: { min: lo, max: hi, calculable: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 160, itemWidth: 10, inRange: { color: colors }, text: [`${unit}`, ""] },
    series: [{ name, type: "heatmap", data, progressive: 0 }],
  };
}

// ---------------------------------------------------------------- main tab

export default function RtcTab({ initialScenario = null }) {
  // a scenario opened from the library replaces the working state once per page load
  const openKey = initialScenario ? `${initialScenario.scenario.id}@${initialScenario.current.version}` : null;
  const fresh = openKey && openKey !== openedScenarioKey;
  const [state, setState] = useState(() => (fresh ? mergeState(initialScenario.current.inputs?.state || {}) : sessionState || loadState()));
  const [opt, setOpt] = useState(() => (fresh ? initialScenario.current.results?.opt || null : sessionOpt));
  const [linked, setLinked] = useState(() => (fresh ? { id: initialScenario.scenario.id, name: initialScenario.scenario.name, version: initialScenario.current.version } : sessionLinked));
  const [showSave, setShowSave] = useState(false);
  useEffect(() => { if (fresh) openedScenarioKey = openKey; }, [fresh, openKey]);
  useEffect(() => { sessionLinked = linked; }, [linked]);
  const [optBusy, setOptBusy] = useState(null);
  const [message, setMessage] = useState(fresh ? `Opened “${initialScenario.scenario.name}” version ${initialScenario.current.version}.` : "");
  const workerRef = useRef(null);

  useEffect(() => {
    sessionState = state;
    const id = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* storage full or blocked: the page still works without it */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [state]);
  useEffect(() => { sessionOpt = opt; }, [opt]);
  useEffect(() => () => workerRef.current?.terminate(), []);

  const patch = useCallback((section, values) => setState((s) => ({ ...s, [section]: { ...s[section], ...values } })), []);
  const set = useCallback((key, value) => setState((s) => ({ ...s, [key]: value })), []);
  const isLocked = (key) => Boolean(state.locks[key]);
  const toggleLock = (key) => setState((s) => ({ ...s, locks: { ...s.locks, [key]: !s.locks[key] } }));
  const lockProps = (key) => ({ locked: isLocked(key), onLock: () => toggleLock(key) });
  const setVar = (k, values) => setState((s) => ({ ...s, vars: { ...s.vars, [k]: { ...s.vars[k], ...values } } }));

  // ---- model (computed from a deferred copy so typing stays responsive)
  const d = useDeferredValue(state);
  const { inputs } = d;
  const solarBase = useMemo(
    () => (d.solarUpload ? Float64Array.from(d.solarUpload.values) : E.synthSolarCf({ targetCuf: inputs.solarCuf, dcAc: inputs.solarDcAc })),
    [d.solarUpload, inputs.solarCuf, inputs.solarDcAc],
  );
  const windBase = useMemo(() => (d.windUpload ? Float64Array.from(d.windUpload.values) : E.synthWindCf({ targetCuf: inputs.windCuf })), [d.windUpload, inputs.windCuf]);
  const solarCf = useMemo(() => E.applyMonthlyScale(solarBase, d.solarMonthScale), [solarBase, d.solarMonthScale]);
  const windCf = useMemo(() => E.applyMonthlyScale(windBase, d.windMonthScale), [windBase, d.windMonthScale]);
  const demand = useMemo(
    () => E.buildDemand({ annualEnergyMu: inputs.annualEnergyMu, hourShape: d.hourShape, monthShape: d.monthShape, custom: d.demandUpload?.values }),
    [inputs.annualEnergyMu, d.hourShape, d.monthShape, d.demandUpload],
  );
  const ctx = useMemo(
    () => E.buildContext({ demand, solarCf, windCf, plantMw: inputs.plantCapacityMw, bess: d.bess, lossPct: inputs.lossPct }),
    [demand, solarCf, windCf, inputs.plantCapacityMw, d.bess, inputs.lossPct],
  );
  const sizes = useMemo(() => Object.fromEntries(Object.entries(d.vars).map(([k, v]) => [k, v.value])), [d.vars]);
  const sim = useMemo(() => E.simulate(ctx, sizes, { hourly: true }), [ctx, sizes]);
  const finInput = useMemo(() => ({ ...d.fin, demandGrowth: inputs.demandGrowth }), [d.fin, inputs.demandGrowth]);
  const finance = useMemo(
    () => E.runFinancialModel(ctx, sizes, { costs: d.costs, fin: finInput, bess: d.bess, dfrTarget: inputs.dfrTarget, tariffLocked: d.tariffLocked }),
    [ctx, sizes, d.costs, finInput, d.bess, inputs.dfrTarget, d.tariffLocked],
  );
  const capex = useMemo(() => E.capexCr(sizes, d.costs), [sizes, d.costs]);
  const loadFactor = (inputs.annualEnergyMu * 1000) / (inputs.plantCapacityMw * E.HOURS);
  const peakDemand = useMemo(() => Math.max(...demand), [demand]);
  const maxDfr = sim.demandMWh > 0 ? 1 - sim.demandAboveCapMWh / sim.demandMWh : 1;
  const stale = d !== state;

  // ---- demand triplet (plant capacity, annual energy, load factor) linked through locks
  function setTriplet(field, value) {
    setState((s) => {
      const { locks } = s;
      let E0 = s.inputs.annualEnergyMu;
      let P = s.inputs.plantCapacityMw;
      const LF = (E0 * 1000) / (P * E.HOURS);
      if (field === "plant") {
        P = value;
        if (locks.loadFactor && !locks.annualEnergyMu) E0 = (P * E.HOURS * LF) / 1000;
      } else if (field === "energy") {
        E0 = value;
        if (locks.loadFactor && !locks.plantCapacityMw) P = (E0 * 1000) / (E.HOURS * LF);
      } else if (field === "lf") {
        if (!locks.annualEnergyMu) E0 = (P * E.HOURS * value) / 1000;
        else if (!locks.plantCapacityMw) P = (E0 * 1000) / (E.HOURS * value);
      }
      return { ...s, inputs: { ...s.inputs, annualEnergyMu: E0, plantCapacityMw: P } };
    });
  }

  async function readUpload(file, kind, target) {
    try {
      const text = await file.text();
      const refMw = kind === "demand" ? null : state[`${kind}RefMw`];
      const parsed = E.parseProfileCsv(text, { kind: kind === "demand" ? "demand" : "cf", referenceMw: refMw });
      set(target, { name: file.name, note: parsed.note, values: Array.from(parsed.values, (v) => Number(v.toFixed(5))) });
      if (kind !== "demand") set(`${kind}MonthScale`, new Array(12).fill(1));
      setMessage("");
    } catch (err) {
      setMessage(`${file.name}: ${err.message}`);
    }
  }

  // ---- optimizer
  function runOptimizer() {
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./optimizer.worker.js", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const id = Date.now();
    setOptBusy({ stage: "grid", done: 0, total: 1, evals: 0 });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") setOptBusy(msg.progress);
      else if (msg.type === "error") {
        setOptBusy(null);
        setMessage(`Optimizer: ${msg.error}`);
        worker.terminate();
      } else if (msg.type === "done") {
        setOptBusy(null);
        const result = { ...msg.result, previous: sizes, at: new Date().toISOString() };
        setOpt(result);
        if (result.best) applySizes(result.best.sizes);
        worker.terminate();
      }
    };
    worker.postMessage({
      id,
      ctx: { demand: ctx.demand, solarCf: ctx.solarCf, windCf: ctx.windCf, plantMw: ctx.plantMw, bess: ctx.bess, lossPct: ctx.lossPct },
      modelInput: { inputs: state.inputs, costs: state.costs, fin: state.fin, bess: state.bess, vars: state.vars, objective: state.objective, gridPoints: state.gridPoints },
    });
  }

  const applySizes = useCallback((next) => {
    setState((s) => ({
      ...s,
      vars: Object.fromEntries(Object.entries(s.vars).map(([k, v]) => [k, v.locked ? v : { ...v, value: next[k] ?? v.value }])),
    }));
  }, []);

  function cancelOptimizer() {
    workerRef.current?.terminate();
    workerRef.current = null;
    setOptBusy(null);
  }

  function resetAll() {
    if (!window.confirm("Reset every Round-the-clock input, profile and lock to the defaults?")) return;
    setState(defaultState());
    setOpt(null);
    setLinked(null);
  }

  function buildSave() {
    const { hourly, ...simSummary } = sim;
    return {
      inputs: { state: { ...state, view: "load" } },
      results: { opt: compactOpt(opt), sim: simSummary, finance, capex },
      summary: {
        annualEnergyMu: inputs.annualEnergyMu,
        plantCapacityMw: inputs.plantCapacityMw,
        dfrTarget: inputs.dfrTarget,
        solarMw: sizes.solarMw,
        windMw: sizes.windMw,
        bessMw: sizes.bessMw,
        bessMwh: sizes.bessMwh,
        dfr: sim.dfr,
        minMonthlyDfr: sim.minMonthlyDfr,
        minLifetimeDfr: finance.minLifetimeDfr,
        deliveredMu: sim.deliveredMWh / 1000,
        curtailMu: sim.curtailMWh / 1000,
        capexCr: capex.total,
        tariff: finance.tariff,
        tariffLocked: finance.tariffLocked,
        lcoe: finance.lcoe,
        equityIrr: finance.equityIrr,
        projectIrr: finance.projectIrr,
        minDscr: finance.minDscr,
        payback: finance.payback,
      },
    };
  }

  const dfrOk = sim.dfr >= inputs.dfrTarget - 1e-6 && (inputs.dfrBasis !== "monthly" || sim.minMonthlyDfr >= inputs.dfrTarget - 1e-6);

  return (
    <div className="rtc">
      <section className="rtc-hero">
        <div className="rtc-hero-copy">
          <div className="eyebrow"><Activity size={13} /> RTC · {E.BEED_SITE.name} · {E.BEED_SITE.lat.toFixed(2)}°N {E.BEED_SITE.lon.toFixed(2)}°E</div>
          <h1>Round the<br />clock</h1>
          <p>Least-cost solar, wind and battery sizing for firm supply against an hourly consumption profile, with a 25-year project finance model.</p>
          <div className="rtc-spec">
            <div><span>Annual energy</span><strong>{nf(inputs.annualEnergyMu, 0)}<em>MU</em></strong></div>
            <div><span>Plant capacity</span><strong>{nf(inputs.plantCapacityMw, 0)}<em>MW</em></strong></div>
            <div><span>DFR target</span><strong>{pf(inputs.dfrTarget, 0)}</strong></div>
            <div><span>Load factor</span><strong>{pf(loadFactor, 1)}</strong></div>
          </div>
        </div>
        <div className="rtc-hero-panel">
          <div className="rtc-hero-kpi">
            <span>Year-1 DFR</span>
            <strong className={dfrOk ? "ok" : "bad"}>{pf(sim.dfr, 2)}</strong>
            <small>{dfrOk ? "meets target" : `below ${pf(inputs.dfrTarget, 0)} target`} · min month {pf(sim.minMonthlyDfr, 1)}</small>
          </div>
          <div className="rtc-hero-kpi">
            <span>{d.tariffLocked ? "Tariff (fixed)" : `Tariff @ ${pf(d.fin.targetEquityIrr, 0)} equity IRR`}</span>
            <strong>₹{nf(finance.tariff, 3)}<em>/kWh</em></strong>
            <small>LCOE ₹{nf(finance.lcoe, 3)}/kWh · equity IRR {pf(finance.equityIrr, 2)}</small>
          </div>
          <div className="rtc-hero-kpi">
            <span>Project cost</span>
            <strong>₹{nf(capex.total, 0)}<em>cr</em></strong>
            <small>min DSCR {nf(finance.minDscr, 2)} · payback yr {finance.payback ?? "–"}</small>
          </div>
        </div>
      </section>

      <section className="rtc-design">
        {Object.entries(VAR_META).map(([k, meta]) => {
          const v = state.vars[k];
          const Icon = meta.icon;
          return (
            <div key={k} className={`rtc-design-cell ${v.locked ? "is-locked" : ""}`}>
              <div className="rtc-design-top">
                <span><Icon size={13} style={{ color: meta.color }} /> {meta.label}</span>
                <LockButton locked={v.locked} onToggle={() => setVar(k, { locked: !v.locked })} title={v.locked ? "Held fixed by the optimizer" : "Free for the optimizer"} />
              </div>
              <div className="rtc-design-value">
                <NumberInput value={v.value} onCommit={(val) => setVar(k, { value: val })} step={v.step} min={0} digits={1} />
                <em>{meta.unit}</em>
              </div>
            </div>
          );
        })}
        <div className="rtc-design-cell rtc-design-action">
          {optBusy ? (
            <button type="button" className="secondary full" onClick={cancelOptimizer}><Loader2 className="spin" size={15} /> {optBusy.stage === "grid" ? `Grid ${Math.round((optBusy.done / Math.max(optBusy.total, 1)) * 100)}%` : `Refine ${optBusy.done}/${optBusy.total}`} · stop</button>
          ) : (
            <button type="button" className="primary full" onClick={runOptimizer}><Zap size={15} /> Optimize least cost</button>
          )}
          <small>{opt ? `${nf(opt.evals)} designs · ${nf(opt.ms / 1000, 1)} s · ${opt.feasible ? "feasible" : "target not reachable"}` : "Locked sizes stay fixed"}</small>
        </div>
      </section>

      <nav className="rtc-subnav">
        {SUBTABS.map(([id, label], i) => (
          <button key={id} type="button" className={state.view === id ? "active" : ""} onClick={() => set("view", id)}>
            <span>{String(i + 1).padStart(2, "0")}</span>{label}
          </button>
        ))}
        <div className="rtc-subnav-tail">
          {stale && <span className="rtc-live"><Loader2 className="spin" size={12} /> updating</span>}
          {linked && <span className="rtc-live" title="Saved scenario this workspace is linked to">{linked.name} · v{linked.version}</span>}
          <button type="button" className="rtc-reset" onClick={() => setShowSave(true)} disabled={stale}><Save size={13} /> Save</button>
          <a className="rtc-reset" href="/scenarios?module=rtc">Open</a>
          <button type="button" className="rtc-reset" onClick={resetAll}><RotateCcw size={13} /> Reset</button>
        </div>
      </nav>

      {message && (
        <div className="alert">
          {message}
          <button type="button" className="rtc-icon-btn" onClick={() => setMessage("")} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
      {maxDfr < inputs.dfrTarget && (
        <div className="alert">
          Demand above the {nf(inputs.plantCapacityMw, 0)} MW plant capacity ({nf(sim.demandAboveCapMWh / 1000, 1)} MU) cannot be served, so the maximum achievable DFR is {pf(maxDfr, 1)}. Raise the plant capacity or flatten the consumption profile.
        </div>
      )}

      {state.view === "load" && (
        <LoadView state={state} patch={patch} set={set} lockProps={lockProps} isLocked={isLocked} setTriplet={setTriplet} loadFactor={loadFactor} demand={demand} peakDemand={peakDemand} readUpload={readUpload} sim={sim} />
      )}
      {state.view === "resource" && (
        <ResourceView state={state} patch={patch} set={set} lockProps={lockProps} isLocked={isLocked} solarCf={solarCf} windCf={windCf} solarBase={solarBase} windBase={windBase} readUpload={readUpload} sizes={sizes} />
      )}
      {state.view === "storage" && <StorageCostView state={state} patch={patch} lockProps={lockProps} capex={capex} sizes={sizes} sim={sim} />}
      {state.view === "optimizer" && (
        <OptimizerView state={state} set={set} setVar={setVar} patch={patch} lockProps={lockProps} opt={opt} applySizes={applySizes} sizes={sizes} optBusy={optBusy} runOptimizer={runOptimizer} />
      )}
      {state.view === "dispatch" && <DispatchView sim={sim} inputs={inputs} sizes={sizes} />}
      {state.view === "finance" && <FinanceView state={state} patch={patch} set={set} lockProps={lockProps} finance={finance} sizes={sizes} />}
      {showSave && (
        <SaveDialog
          module="rtc"
          linked={linked}
          defaultName={`RTC ${nf(inputs.annualEnergyMu, 0)} MU · ${nf(inputs.plantCapacityMw, 0)} MW · DFR ${pf(inputs.dfrTarget, 0)}`}
          build={buildSave}
          onSaved={(next) => { setLinked(next); setShowSave(false); setMessage(`Saved “${next.name}” version ${next.version}.`); }}
          onClose={() => setShowSave(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 01 load

function LoadView({ state, patch, set, lockProps, isLocked, setTriplet, loadFactor, demand, peakDemand, readUpload, sim }) {
  const { inputs } = state;
  const custom = Boolean(state.demandUpload);
  const avgMw = (inputs.annualEnergyMu * 1000) / E.HOURS;
  const hourMean = state.hourShape.reduce((a, b) => a + b, 0) / 24;
  const impliedHourMw = useMemo(() => {
    const rows = E.monthHourMatrix(demand);
    return HOUR_LABELS.map((_, h) => rows.reduce((s, r) => s + r[h], 0) / 12);
  }, [demand]);
  const overlays = useMemo(() => [], []);
  const matrix = useMemo(() => E.monthHourMatrix(demand), [demand]);
  const heat = useMemo(() => {
    const vals = matrix.flat();
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    // a flat RTC profile would render as one solid block: anchor the scale at zero in that case
    return heatmapOption(matrix, { name: "Demand", unit: "MW", min: hi - lo < 1 ? 0 : lo, max: Math.max(hi, inputs.plantCapacityMw), colors: ["#151515", "#3a3a3a", "#d9d9d4"] });
  }, [matrix, inputs.plantCapacityMw]);
  const profileOption = useMemo(() => ({
    animation: false,
    grid: { left: 52, right: 16, top: 24, bottom: 30 },
    tooltip: { trigger: "axis", valueFormatter: (v) => `${nf(v, 1)} MW` },
    legend: { top: 0, right: 0 },
    xAxis: { type: "category", data: HOUR_LABELS },
    yAxis: { type: "value", min: 0 },
    series: [
      { name: "Average demand", type: "line", step: "middle", data: impliedHourMw.map((v) => Number(v.toFixed(2))), lineStyle: { color: DATA_COLORS.demand, width: 2 }, itemStyle: { color: DATA_COLORS.demand }, areaStyle: { color: "rgba(244,244,241,0.06)" } },
      { name: "Plant capacity", type: "line", data: HOUR_LABELS.map(() => inputs.plantCapacityMw), lineStyle: { color: DATA_COLORS.signal, type: "dashed", width: 1 }, itemStyle: { color: DATA_COLORS.signal } },
    ],
  }), [impliedHourMw, inputs.plantCapacityMw]);

  return (
    <>
      <Section index="01.1" title="Requirement" note="Plant capacity, annual energy and load factor are linked: lock two to drive the third">
        <div className="rtc-grid rtc-grid-4">
          <Field label="Annual energy requirement" unit="MU" value={inputs.annualEnergyMu} onChange={(v) => setTriplet("energy", v)} {...lockProps("annualEnergyMu")} step={5} min={1} hint={`${nf(avgMw, 1)} MW average`} />
          <Field label="Plant capacity" unit="MW" value={inputs.plantCapacityMw} onChange={(v) => setTriplet("plant", v)} {...lockProps("plantCapacityMw")} step={1} min={1} disabled={isLocked("loadFactor") && isLocked("annualEnergyMu")} hint="Maximum delivery / export" />
          <Field label="Load factor" pct value={loadFactor} onChange={(v) => setTriplet("lf", v)} {...lockProps("loadFactor")} step={0.1} min={1} max={100} disabled={isLocked("annualEnergyMu") && isLocked("plantCapacityMw")} hint="Energy ÷ (capacity × 8760)" digits={3} />
          <Field label="DFR target" pct value={inputs.dfrTarget} onChange={(v) => patch("inputs", { dfrTarget: v })} {...lockProps("dfrTarget")} step={0.5} min={1} max={100} hint="Demand fulfilment ratio" />
          <SelectBox label="DFR measured" value={inputs.dfrBasis} onChange={(v) => patch("inputs", { dfrBasis: v })} {...lockProps("dfrBasis")} options={[["annual", "Annual energy"], ["monthly", "Every month"]]} />
          <SelectBox label="Design check" value={inputs.designCheck} onChange={(v) => patch("inputs", { designCheck: v })} {...lockProps("designCheck")} options={[["lifetime", "Year 1 + degraded envelope"], ["year1", "Year 1 only"]]} hint="Envelope: worst solar, wind and BESS year" />
          <Field label="Demand growth" pct value={inputs.demandGrowth} onChange={(v) => patch("inputs", { demandGrowth: v })} {...lockProps("demandGrowth")} step={0.1} hint="per year, applied in the 25-year model" />
          <Field label="Losses to delivery point" pct value={inputs.lossPct} onChange={(v) => patch("inputs", { lossPct: v })} {...lockProps("lossPct")} step={0.1} min={0} max={30} hint="Auxiliary + transmission" />
        </div>
      </Section>

      <Section
        index="01.2"
        title="Consumption profile"
        note={custom ? `Uploaded: ${state.demandUpload.name} · ${state.demandUpload.note}` : "Draw the daily and seasonal shape; energy is rescaled to the annual requirement"}
        actions={(
          <>
            <button type="button" className="secondary" onClick={() => downloadText("rtc_demand_template.csv", E.profileTemplateCsv("demand"))}><Download size={14} /> Template</button>
            <UploadButton label="Upload 8760" onFile={(f) => readUpload(f, "demand", "demandUpload")} disabled={isLocked("demandProfile")} />
            {custom && <button type="button" className="secondary" disabled={isLocked("demandProfile")} onClick={() => set("demandUpload", null)}><X size={14} /> Clear upload</button>}
            <LockButton locked={isLocked("demandProfile")} onToggle={() => lockProps("demandProfile").onLock()} title="Lock the consumption profile" />
          </>
        )}
      >
        <div className="rtc-grid rtc-grid-2">
          <div className="rtc-card">
            <div className="rtc-card-head">
              <span>Hourly shape · relative to daily mean</span>
              <button type="button" className="rtc-link" disabled={custom || isLocked("demandProfile")} onClick={() => set("hourShape", [...E.FLAT_HOUR_SHAPE])}>Flat RTC</button>
            </div>
            <PaintChart
              values={state.hourShape}
              labels={HOUR_LABELS}
              onChange={(v) => set("hourShape", v)}
              locked={custom || isLocked("demandProfile")}
              min={0}
              max={2}
              step={0.01}
              markValue={hourMean}
              markLabel="mean"
              overlays={overlays}
            />
          </div>
          <div className="rtc-card">
            <div className="rtc-card-head">
              <span>Monthly shape · relative daily energy</span>
              <button type="button" className="rtc-link" disabled={custom || isLocked("demandProfile")} onClick={() => set("monthShape", [...E.FLAT_MONTH_SHAPE])}>Flat</button>
            </div>
            <PaintChart values={state.monthShape} labels={E.MONTHS} onChange={(v) => set("monthShape", v)} locked={custom || isLocked("demandProfile")} min={0} max={2} step={0.01} />
          </div>
          <div className="rtc-card">
            <div className="rtc-card-head"><span>Resulting average day (MW) vs plant capacity</span><span>peak {nf(peakDemand, 1)} MW</span></div>
            <LiveChart option={profileOption} height={260} />
          </div>
          <div className="rtc-card">
            <div className="rtc-card-head"><span>Demand · month × hour (MW)</span><span>{nf(sim.demandMWh / 1000, 1)} MU / yr</span></div>
            <LiveChart option={heat} height={260} />
          </div>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- 02 resource

function ResourcePanel({ kind, state, patch, set, lockProps, isLocked, cf, base, readUpload, sizeMw }) {
  const isSolar = kind === "solar";
  const upload = state[`${kind}Upload`];
  const scaleKey = `${kind}MonthScale`;
  const color = isSolar ? DATA_COLORS.solar : DATA_COLORS.wind;
  const lockKey = `${kind}Profile`;
  const monthly = useMemo(() => E.monthlyMeans(cf).map((v) => Number((v * 100).toFixed(2))), [cf]);
  const baseMonthly = useMemo(() => E.monthlyMeans(base).map((v) => Number((v * 100).toFixed(2))), [base]);
  const overlays = useMemo(() => [{ name: "Base profile", data: baseMonthly, color: "#86867f", dash: true }], [baseMonthly]);
  const matrix = useMemo(() => E.monthHourMatrix(cf).map((r) => r.map((v) => v * 100)), [cf]);
  const heat = useMemo(() => heatmapOption(matrix, { name: kind, unit: "%", max: isSolar ? 90 : 70, colors: ["#121212", isSolar ? "#6b4f16" : "#1d4661", color] }), [matrix, kind, isSolar, color]);
  const cuf = E.mean(cf);
  const scaled = state[scaleKey].some((v) => Math.abs(v - 1) > 1e-6);
  const Icon = isSolar ? Sun : Wind;

  function paintMonthly(values) {
    const next = state[scaleKey].map((s, m) => (monthly[m] > 0 ? Math.max(0, s * (values[m] / monthly[m])) : s));
    set(scaleKey, next.map((v) => Number(v.toFixed(5))));
  }

  return (
    <Section
      index={isSolar ? "02.1" : "02.2"}
      title={isSolar ? "Solar resource" : "Wind resource"}
      note={upload ? `Uploaded: ${upload.name} · ${upload.note}` : `Synthetic ${E.BEED_SITE.name} profile`}
      actions={(
        <>
          <button type="button" className="secondary" onClick={() => downloadText(`rtc_${kind}_template.csv`, E.profileTemplateCsv(kind))}><Download size={14} /> Template</button>
          <UploadButton label="Upload 8760" onFile={(f) => readUpload(f, kind, `${kind}Upload`)} disabled={isLocked(lockKey)} />
          {upload && <button type="button" className="secondary" disabled={isLocked(lockKey)} onClick={() => set(`${kind}Upload`, null)}><X size={14} /> Use synthetic</button>}
          <LockButton locked={isLocked(lockKey)} onToggle={() => lockProps(lockKey).onLock()} title={`Lock the ${kind} profile`} />
        </>
      )}
    >
      <div className="rtc-grid rtc-grid-4">
        {isSolar ? (
          <>
            <Field label="Annual AC CUF (synthetic)" pct value={state.inputs.solarCuf} onChange={(v) => patch("inputs", { solarCuf: v })} {...lockProps("solarCuf")} disabled={Boolean(upload)} step={0.1} min={5} max={40} />
            <Field label="DC/AC ratio (synthetic)" value={state.inputs.solarDcAc} onChange={(v) => patch("inputs", { solarDcAc: v })} {...lockProps("solarDcAc")} disabled={Boolean(upload)} step={0.05} min={1} max={2} />
          </>
        ) : (
          <>
            <Field label="Annual CUF (synthetic)" pct value={state.inputs.windCuf} onChange={(v) => patch("inputs", { windCuf: v })} {...lockProps("windCuf")} disabled={Boolean(upload)} step={0.1} min={10} max={55} />
            <Field label="Upload reference MW" unit="MW" value={state[`${kind}RefMw`] ?? 0} onChange={(v) => set(`${kind}RefMw`, v)} {...lockProps(`${kind}RefMw`)} step={1} min={0} hint="For MW uploads; 0 = use the maximum" />
          </>
        )}
        {isSolar && <Field label="Upload reference MW" unit="MW" value={state[`${kind}RefMw`] ?? 0} onChange={(v) => set(`${kind}RefMw`, v)} {...lockProps(`${kind}RefMw`)} step={1} min={0} hint="For MW uploads; 0 = use the maximum" />}
        <div className="rtc-stat-pair">
          <Stat label={<><Icon size={12} /> Modelled CUF</>} value={pf(cuf, 2)} detail={scaled ? "after monthly redraw" : "as loaded"} />
          <Stat label="Year-1 generation" value={`${nf((cuf * sizeMw * E.HOURS) / 1000, 0)} MU`} detail={`at ${nf(sizeMw, 0)} MW`} />
        </div>
      </div>
      <div className="rtc-grid rtc-grid-2">
        <div className="rtc-card">
          <div className="rtc-card-head">
            <span>Monthly CUF % · drag to rescale months</span>
            <button type="button" className="rtc-link" disabled={!scaled || isLocked(lockKey)} onClick={() => set(scaleKey, new Array(12).fill(1))}>Undo redraw</button>
          </div>
          <PaintChart values={monthly} labels={E.MONTHS} onChange={paintMonthly} locked={isLocked(lockKey)} min={0} max={isSolar ? 45 : 75} step={0.1} color={color} valueFormatter={(v) => v.toFixed(1)} unit="%" overlays={overlays} />
        </div>
        <div className="rtc-card">
          <div className="rtc-card-head"><span>Capacity factor · month × hour (%)</span></div>
          <LiveChart option={heat} height={260} />
        </div>
      </div>
    </Section>
  );
}

function ResourceView({ state, patch, set, lockProps, isLocked, solarCf, windCf, solarBase, windBase, readUpload, sizes }) {
  const complement = useMemo(() => {
    const s = E.monthHourMatrix(solarCf);
    const w = E.monthHourMatrix(windCf);
    const avg = (m) => HOUR_LABELS.map((_, h) => m.reduce((a, r) => a + r[h], 0) / 12);
    const sa = avg(s).map((v) => v * sizes.solarMw);
    const wa = avg(w).map((v) => v * sizes.windMw);
    return {
      animation: false,
      grid: { left: 52, right: 16, top: 30, bottom: 30 },
      legend: { top: 0, right: 0 },
      tooltip: { trigger: "axis", valueFormatter: (v) => `${nf(v, 1)} MW` },
      xAxis: { type: "category", data: HOUR_LABELS },
      yAxis: { type: "value", name: "MW" },
      series: [
        { name: "Solar", type: "bar", stack: "g", data: sa.map((v) => Number(v.toFixed(1))), itemStyle: { color: DATA_COLORS.solar } },
        { name: "Wind", type: "bar", stack: "g", data: wa.map((v) => Number(v.toFixed(1))), itemStyle: { color: DATA_COLORS.wind } },
        { name: "Plant capacity", type: "line", data: HOUR_LABELS.map(() => state.inputs.plantCapacityMw), lineStyle: { color: DATA_COLORS.signal, type: "dashed", width: 1 }, itemStyle: { color: DATA_COLORS.signal } },
      ],
    };
  }, [solarCf, windCf, sizes.solarMw, sizes.windMw, state.inputs.plantCapacityMw]);
  return (
    <>
      <ResourcePanel kind="solar" state={state} patch={patch} set={set} lockProps={lockProps} isLocked={isLocked} cf={solarCf} base={solarBase} readUpload={readUpload} sizeMw={sizes.solarMw} />
      <ResourcePanel kind="wind" state={state} patch={patch} set={set} lockProps={lockProps} isLocked={isLocked} cf={windCf} base={windBase} readUpload={readUpload} sizeMw={sizes.windMw} />
      <Section index="02.3" title="Complementarity" note="Average day of the current design, before storage">
        <LiveChart option={complement} height={300} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- 03 storage & cost

function StorageCostView({ state, patch, lockProps, capex, sizes, sim }) {
  const { bess, costs } = state;
  const breakdown = [
    ["Solar", sizes.solarMw * costs.solarCrPerMw, DATA_COLORS.solar],
    ["Wind", sizes.windMw * costs.windCrPerMw, DATA_COLORS.wind],
    ["BESS energy", sizes.bessMwh * costs.bessCrPerMwh, DATA_COLORS.bess],
    ["BESS PCS", sizes.bessMw * costs.bessPcsCrPerMw, "#7a64c9"],
    ["Evacuation", costs.evacuationCr, "#86867f"],
    ["Pre-operative & IDC", capex.preop, "#4a4a4a"],
  ].filter(([, v]) => v > 0);
  const option = useMemo(() => ({
    animation: false,
    tooltip: { trigger: "item", valueFormatter: (v) => `₹${nf(v, 0)} cr` },
    grid: { left: 130, right: 60, top: 10, bottom: 20 },
    xAxis: { type: "value", name: "₹ cr" },
    yAxis: { type: "category", data: breakdown.map((b) => b[0]), inverse: true },
    series: [{ type: "bar", data: breakdown.map(([, v, c]) => ({ value: Number(v.toFixed(1)), itemStyle: { color: c } })), label: { show: true, position: "right", color: "#c2c2bc", formatter: (p) => nf(p.value, 0) } }],
  }), [breakdown.map((b) => b[1]).join("|")]);
  const duration = sizes.bessMw > 0 ? sizes.bessMwh / sizes.bessMw : 0;
  return (
    <>
      <Section index="03.1" title="Battery energy storage" note="Charged from on-site RE only">
        <div className="rtc-grid rtc-grid-4">
          <Field label="Round-trip efficiency" pct value={bess.rte} onChange={(v) => patch("bess", { rte: v })} {...lockProps("bess.rte")} step={0.5} min={50} max={100} hint="AC-AC, split evenly charge/discharge" />
          <Field label="Minimum SoC" pct value={bess.minSoc} onChange={(v) => patch("bess", { minSoc: Math.min(v, bess.maxSoc - 0.05) })} {...lockProps("bess.minSoc")} step={1} min={0} max={50} />
          <Field label="Maximum SoC" pct value={bess.maxSoc} onChange={(v) => patch("bess", { maxSoc: Math.max(v, bess.minSoc + 0.05) })} {...lockProps("bess.maxSoc")} step={1} min={50} max={100} hint={`Usable depth ${pf(bess.maxSoc - bess.minSoc, 0)}`} />
          <Field label="Initial SoC" pct value={bess.initSoc} onChange={(v) => patch("bess", { initSoc: v })} {...lockProps("bess.initSoc")} step={5} min={0} max={100} />
          <Field label="Capacity fade" pct value={bess.annualDegradation} onChange={(v) => patch("bess", { annualDegradation: v })} {...lockProps("bess.annualDegradation")} step={0.1} min={0} max={10} hint="per year" />
          <SelectBox label="Augmentation" value={bess.augmentation} onChange={(v) => patch("bess", { augmentation: v })} {...lockProps("bess.augmentation")} options={[["annual", "Annual top-up to nameplate"], ["oneTime", "One-time restore"], ["none", "None"]]} />
          <Field label="Augmentation year" value={bess.augmentationYear} onChange={(v) => patch("bess", { augmentationYear: Math.round(v) })} {...lockProps("bess.augmentationYear")} disabled={bess.augmentation !== "oneTime"} step={1} min={2} max={25} />
          <Field label="BESS price decline" pct value={bess.costDeclinePct} onChange={(v) => patch("bess", { costDeclinePct: v })} {...lockProps("bess.costDeclinePct")} step={0.5} min={0} max={20} hint="per year, prices augmentation" />
          <Field label="Min duration" unit="h" value={bess.minDurationH} onChange={(v) => patch("bess", { minDurationH: Math.min(v, bess.maxDurationH) })} {...lockProps("bess.minDurationH")} step={0.5} min={0} hint="Optimizer MWh/MW window" />
          <Field label="Max duration" unit="h" value={bess.maxDurationH} onChange={(v) => patch("bess", { maxDurationH: Math.max(v, bess.minDurationH) })} {...lockProps("bess.maxDurationH")} step={0.5} min={0.5} />
          <div className="rtc-stat-pair">
            <Stat label="Duration" value={`${nf(duration, 2)} h`} detail={`${nf(sizes.bessMw, 0)} MW / ${nf(sizes.bessMwh, 0)} MWh`} />
            <Stat label="Year-1 cycles" value={nf(sim.cycles, 0)} detail={`${nf(sim.dischargeMWh / 1000, 1)} MU discharged`} />
          </div>
        </div>
      </Section>
      <Section index="03.2" title="Capital cost" note="Rs crore; used by the optimizer and the financial model">
        <div className="rtc-grid rtc-grid-2">
          <div className="rtc-grid rtc-grid-2 rtc-tight">
            <Field label="Solar" unit="cr/MW" value={costs.solarCrPerMw} onChange={(v) => patch("costs", { solarCrPerMw: v })} {...lockProps("costs.solarCrPerMw")} step={0.05} min={0} />
            <Field label="Wind" unit="cr/MW" value={costs.windCrPerMw} onChange={(v) => patch("costs", { windCrPerMw: v })} {...lockProps("costs.windCrPerMw")} step={0.05} min={0} />
            <Field label="BESS energy" unit="cr/MWh" value={costs.bessCrPerMwh} onChange={(v) => patch("costs", { bessCrPerMwh: v })} {...lockProps("costs.bessCrPerMwh")} step={0.05} min={0} hint="All-in incl. PCS unless split below" />
            <Field label="BESS PCS (optional)" unit="cr/MW" value={costs.bessPcsCrPerMw} onChange={(v) => patch("costs", { bessPcsCrPerMw: v })} {...lockProps("costs.bessPcsCrPerMw")} step={0.05} min={0} />
            <Field label="Evacuation / pooling" unit="cr" value={costs.evacuationCr} onChange={(v) => patch("costs", { evacuationCr: v })} {...lockProps("costs.evacuationCr")} step={5} min={0} hint="Lump sum" />
            <Field label="Pre-operative & IDC" pct value={costs.preopPct} onChange={(v) => patch("costs", { preopPct: v })} {...lockProps("costs.preopPct")} step={0.5} min={0} max={30} hint="of hard cost" />
          </div>
          <div className="rtc-card">
            <div className="rtc-card-head"><span>Capex breakdown · current design</span><span>₹{nf(capex.total, 0)} cr total</span></div>
            <LiveChart option={option} height={260} />
          </div>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- 04 optimizer

function OptimizerView({ state, set, setVar, patch, lockProps, opt, applySizes, sizes, optBusy, runOptimizer }) {
  const target = state.inputs.dfrTarget;
  const scatter = useMemo(() => {
    if (!opt) return null;
    const feas = opt.cloud.filter((p) => p.feasible).map((p) => [p.capexCr, p.dfr * 100, p.lcoe, p]);
    const infeas = opt.cloud.filter((p) => !p.feasible).map((p) => [p.capexCr, p.dfr * 100, p.lcoe, p]);
    const tip = (p) => {
      const q = p.value[3];
      return `<b>${nf(q.solarMw)} MW solar · ${nf(q.windMw)} MW wind</b><br/>BESS ${nf(q.bessMw)} MW / ${nf(q.bessMwh)} MWh<br/>DFR ${nf(q.dfr * 100, 2)}% · LCOE ₹${nf(q.lcoe, 3)} · ₹${nf(q.capexCr, 0)} cr<br/><i>click to load</i>`;
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
        { name: "Below target", type: "scatter", data: infeas, symbolSize: 5, itemStyle: { color: "rgba(134,134,127,0.45)" } },
        {
          name: "Meets target",
          type: "scatter",
          data: feas,
          symbolSize: 7,
          itemStyle: { color: DATA_COLORS.wind, opacity: 0.85 },
          markLine: { silent: true, symbol: "none", lineStyle: { color: DATA_COLORS.signal, type: "dashed" }, label: { formatter: `DFR ${nf(target * 100, 0)}%`, color: DATA_COLORS.signal }, data: [{ yAxis: target * 100 }] },
        },
        best ? { name: "Optimum", type: "scatter", data: [[best.capexCr, best.dfrCheck * 100, best.lcoe, { ...best.sizes, dfr: best.dfrCheck, lcoe: best.lcoe, capexCr: best.capexCr }]], symbol: "diamond", symbolSize: 16, itemStyle: { color: DATA_COLORS.signal } } : null,
      ].filter(Boolean),
    };
  }, [opt, target]);
  const events = useMemo(() => ({
    click: (p) => {
      const q = p?.value?.[3];
      if (q) applySizes({ solarMw: q.solarMw, windMw: q.windMw, bessMw: q.bessMw, bessMwh: q.bessMwh });
    },
  }), [applySizes]);
  const same = (a) => Object.keys(VAR_META).every((k) => Math.abs(a[k] - sizes[k]) < 1e-9);

  return (
    <>
      <Section
        index="04.1"
        title="Decision variables"
        note="Locked variables are held at their value; free ones are searched within their range"
        actions={optBusy ? null : <button type="button" className="primary" onClick={runOptimizer}><Zap size={14} /> Run optimizer</button>}
      >
        <div className="table-wrap">
          <table className="rtc-vars">
            <thead><tr><th>Lock</th><th>Variable</th><th>Current</th><th>Min</th><th>Max</th><th>Step</th><th>Optimum</th></tr></thead>
            <tbody>
              {Object.entries(VAR_META).map(([k, meta]) => {
                const v = state.vars[k];
                return (
                  <tr key={k} className={v.locked ? "is-locked" : ""}>
                    <td><LockButton locked={v.locked} onToggle={() => setVar(k, { locked: !v.locked })} /></td>
                    <td><span className="rtc-dot" style={{ background: meta.color }} />{meta.label} <em className="rtc-unit">{meta.unit}</em></td>
                    <td><NumberInput value={v.value} onCommit={(val) => setVar(k, { value: val })} step={v.step} min={0} digits={1} /></td>
                    <td><NumberInput value={v.min} onCommit={(val) => setVar(k, { min: Math.min(val, v.max) })} disabled={v.locked} step={v.step} min={0} digits={1} /></td>
                    <td><NumberInput value={v.max} onCommit={(val) => setVar(k, { max: Math.max(val, v.min) })} disabled={v.locked} step={v.step} min={0} digits={1} /></td>
                    <td><NumberInput value={v.step} onCommit={(val) => setVar(k, { step: Math.max(0.5, val) })} disabled={v.locked} step={1} min={0.5} digits={1} /></td>
                    <td className="rtc-num">{opt?.best ? nf(opt.best.sizes[k], 0) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="rtc-grid rtc-grid-4" style={{ marginTop: 16 }}>
          <SelectBox label="Objective" value={state.objective} onChange={(v) => set("objective", v)} {...lockProps("objective")} options={[["lcoe", "Least levelised cost (₹/kWh)"], ["capex", "Least capital cost"]]} />
          <SelectBox label="Search depth" value={String(state.gridPoints)} onChange={(v) => set("gridPoints", Number(v))} {...lockProps("gridPoints")} options={[["7", "Fast · 7-point grid"], ["11", "Standard · 11-point grid"], ["15", "Deep · 15-point grid"]]} />
          <Field label="DFR target" pct value={state.inputs.dfrTarget} onChange={(v) => patch("inputs", { dfrTarget: v })} {...lockProps("dfrTarget")} step={0.5} min={1} max={100} />
          <SwitchBox label="Sell surplus energy" checked={state.fin.sellSurplus} onChange={(v) => patch("fin", { sellSurplus: v })} {...lockProps("fin.sellSurplus")} hint={`at ₹${nf(state.fin.surplusPrice, 2)}/kWh (Financial model)`} />
        </div>
      </Section>

      {opt && (
        <>
          <Section index="04.2" title="Solution space" note={`${nf(opt.evals)} designs evaluated in ${nf(opt.ms / 1000, 1)} s · click any point to load it · scroll to zoom`}>
            <LiveChart option={scatter} height={420} onEvents={events} />
          </Section>
          <Section index="04.3" title="Least-cost designs" note={opt.feasible ? "Ranked by objective; all meet the DFR target" : "No design reached the target inside the ranges: widen the ranges or unlock variables"}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Solar MW</th><th>Wind MW</th><th>BESS MW</th><th>BESS MWh</th><th>DFR yr 1</th><th>DFR check</th><th>LCOE ₹/kWh</th><th>Capex ₹ cr</th><th>Curtailed MU</th><th /></tr></thead>
                <tbody>
                  {(opt.alternatives.length ? opt.alternatives : [opt.best]).map((a, i) => (
                    <tr key={i} className={same(a.sizes) ? "selected" : ""}>
                      <td>{i + 1}</td>
                      <td>{nf(a.sizes.solarMw)}</td>
                      <td>{nf(a.sizes.windMw)}</td>
                      <td>{nf(a.sizes.bessMw)}</td>
                      <td>{nf(a.sizes.bessMwh)}</td>
                      <td>{pf(a.dfr, 2)}</td>
                      <td>{pf(a.dfrCheck, 2)}</td>
                      <td>{nf(a.lcoe, 3)}</td>
                      <td>{nf(a.capexCr, 0)}</td>
                      <td>{nf(a.curtailMWh / 1000, 1)}</td>
                      <td>{same(a.sizes) ? <span className="pill pass">loaded</span> : <button type="button" className="rtc-link" onClick={() => applySizes(a.sizes)}>Load</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {opt.previous && !same(opt.previous) && (
              <div className="panel-actions left-actions"><button type="button" className="secondary" onClick={() => applySizes(opt.previous)}><RotateCcw size={14} /> Restore design before the run</button></div>
            )}
          </Section>
        </>
      )}
      {!opt && (
        <Section index="04.2" title="Method">
          <ol className="rtc-method">
            <li>Grid search over solar × wind × BESS power; for each point the smallest BESS energy meeting the DFR target is found by bisection.</li>
            <li>The best six points seed a compass (pattern) search on the snapped lattice until no step improves the objective.</li>
            <li>Each design is dispatched hour by hour for 8,760 hours. With the lifetime check it is also dispatched with the worst solar, wind and BESS degradation of the PPA term.</li>
            <li>Objective: capex × CRF plus levelised O&M and augmentation, less surplus revenue, divided by delivered energy.</li>
          </ol>
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 05 dispatch

function DispatchView({ sim, inputs, sizes }) {
  const monthly = useMemo(() => {
    const h = sim.hourly;
    const acc = { solar: new Array(12).fill(0), wind: new Array(12).fill(0), bess: new Array(12).fill(0), unmet: new Array(12).fill(0), excess: new Array(12).fill(0), curtail: new Array(12).fill(0) };
    for (let t = 0; t < E.HOURS; t += 1) {
      const m = E.MONTH_OF_HOUR[t];
      acc.solar[m] += h.solar[t];
      acc.wind[m] += h.wind[t];
      acc.bess[m] += h.discharge[t];
      acc.unmet[m] += h.unmet[t];
      acc.excess[m] += h.excess[t];
      acc.curtail[m] += h.curtail[t];
    }
    return acc;
  }, [sim]);
  const gwh = (arr) => arr.map((v) => Number((v / 1000).toFixed(2)));
  const monthlyOption = useMemo(() => ({
    animation: false,
    grid: { left: 52, right: 52, top: 36, bottom: 30 },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: E.MONTHS },
    yAxis: [{ type: "value", name: "MU" }, { type: "value", name: "DFR %", min: 0, max: 100, splitLine: { show: false } }],
    series: [
      { name: "Solar", type: "bar", stack: "s", data: gwh(monthly.solar), itemStyle: { color: DATA_COLORS.solar } },
      { name: "Wind", type: "bar", stack: "s", data: gwh(monthly.wind), itemStyle: { color: DATA_COLORS.wind } },
      { name: "BESS", type: "bar", stack: "s", data: gwh(monthly.bess), itemStyle: { color: DATA_COLORS.bess } },
      { name: "Shortfall", type: "bar", stack: "s", data: gwh(monthly.unmet), itemStyle: { color: "rgba(255,107,95,0.35)", borderColor: DATA_COLORS.unmet, borderWidth: 1 } },
      {
        name: "DFR",
        type: "line",
        yAxisIndex: 1,
        data: sim.monthlyDfr.map((v) => Number((v * 100).toFixed(2))),
        lineStyle: { color: DATA_COLORS.demand, width: 2 },
        itemStyle: { color: DATA_COLORS.demand },
        showSymbol: true,
        symbolSize: 5,
        markLine: { silent: true, symbol: "none", lineStyle: { color: DATA_COLORS.signal, type: "dashed" }, label: { formatter: "target", color: DATA_COLORS.signal }, data: [{ yAxis: inputs.dfrTarget * 100 }] },
      },
    ],
  }), [monthly, sim, inputs.dfrTarget]);
  const socOption = useMemo(() => {
    const h = sim.hourly;
    const t0 = Date.UTC(2026, 0, 1);
    const soc = Array.from(h.soc, (v, i) => [t0 + i * 3600000, Number((v * 100).toFixed(1))]);
    return {
      animation: false,
      grid: { left: 52, right: 20, top: 16, bottom: 64 },
      tooltip: { trigger: "axis", valueFormatter: (v) => `${nf(v, 1)}%` },
      xAxis: { type: "time" },
      yAxis: { type: "value", min: 0, max: 100, name: "SoC %" },
      dataZoom: [{ type: "inside", start: 45, end: 47 }, { type: "slider", start: 45, end: 47, bottom: 10, height: 22 }],
      series: [{ name: "State of charge", type: "line", data: soc, sampling: "lttb", lineStyle: { color: DATA_COLORS.bess, width: 1.4 }, areaStyle: { color: "rgba(169,139,255,0.12)" } }],
    };
  }, [sim]);
  const balance = [
    ["Demand", sim.demandMWh],
    ["Delivered", sim.deliveredMWh],
    ["  Solar direct", sim.solarDirectMWh],
    ["  Wind direct", sim.windDirectMWh],
    ["  BESS discharge", sim.dischargeMWh],
    ["Shortfall", sim.unmetMWh],
    ["BESS charging", sim.chargeMWh],
    ["BESS losses", sim.chargeMWh - sim.dischargeMWh],
    ["Surplus exported", sim.excessMWh],
    ["Curtailed", sim.curtailMWh],
    ["Solar generation", sim.solarGenMWh],
    ["Wind generation", sim.windGenMWh],
  ];
  const ok = sim.dfr >= inputs.dfrTarget - 1e-6;
  return (
    <>
      <section className="rtc-stats">
        <Stat label="DFR year 1" value={pf(sim.dfr, 2)} detail={`target ${pf(inputs.dfrTarget, 0)}`} tone={ok ? "good" : "bad"} />
        <Stat label="Lowest month" value={pf(sim.minMonthlyDfr, 1)} detail={E.MONTHS[sim.monthlyDfr.indexOf(sim.minMonthlyDfr)]} tone={inputs.dfrBasis === "monthly" && sim.minMonthlyDfr < inputs.dfrTarget ? "bad" : undefined} />
        <Stat label="Delivered" value={`${nf(sim.deliveredMWh / 1000, 1)} MU`} detail={`of ${nf(sim.demandMWh / 1000, 1)} MU demand`} />
        <Stat label="Surplus + curtailed" value={`${nf((sim.excessMWh + sim.curtailMWh) / 1000, 1)} MU`} detail={`${pf((sim.excessMWh + sim.curtailMWh) / Math.max(1, sim.solarGenMWh + sim.windGenMWh), 1)} of generation`} />
        <Stat label="BESS cycles" value={nf(sim.cycles, 0)} detail={`${nf(sizes.bessMw)} MW / ${nf(sizes.bessMwh)} MWh`} />
      </section>
      <Section index="05.1" title="Hourly dispatch" note="1 day / 7 days, step with ‹ ›, lock the y axis, export PNG · Ergplan charting">
        <FlowChart hourly={sim.hourly} />
      </Section>
      <div className="rtc-grid rtc-grid-2 rtc-flush">
        <Section index="05.2" title="Monthly supply & DFR">
          <LiveChart option={monthlyOption} height={320} />
        </Section>
        <Section index="05.3" title="Energy balance · year 1" note="MU">
          <div className="table-wrap">
            <table>
              <tbody>
                {balance.map(([k, v]) => (
                  <tr key={k}><td className={k.startsWith("  ") ? "rtc-indent" : ""}>{k.trim()}</td><td className="rtc-num">{nf(v / 1000, 2)}</td><td className="rtc-num rtc-muted">{pf(v / Math.max(1, sim.demandMWh), 1)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
      <Section index="05.4" title="Battery state of charge" note="Drag the slider or scroll to zoom across the year">
        <LiveChart option={socOption} height={260} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- 06 financial model

const FIN_LINES = [
  ["Operations", null],
  ["Demand (MU)", "demandMu", 1],
  ["Delivered (MU)", "deliveredMu", 1],
  ["DFR", "dfr", "pct"],
  ["Surplus exported (MU)", "excessMu", 1],
  ["Shortfall vs target (MU)", "shortfallMu", 1],
  ["Solar output factor", "solarFactor", "pct"],
  ["BESS capacity factor", "bessFactor", "pct"],
  ["Tariff (₹/kWh)", "tariff", 3],
  ["Profit & loss (₹ cr)", null],
  ["Energy revenue", "energyRevenue", 1],
  ["Surplus revenue", "surplusRevenue", 1],
  ["Shortfall penalty", "penalty", 1, -1],
  ["Total revenue", "revenue", 1, 1, true],
  ["O&M", "om", 1, -1],
  ["Insurance", "insurance", 1, -1],
  ["Other fixed", "other", 1, -1],
  ["EBITDA", "ebitda", 1, 1, true],
  ["Book depreciation", "bookDep", 1, -1],
  ["Interest", "interest", 1, -1],
  ["Profit before tax", "pbt", 1, 1, true],
  ["Tax depreciation", "taxDep", 1],
  ["Tax", "tax", 1, -1],
  ["Profit after tax", "pat", 1, 1, true],
  ["Cash flow (₹ cr)", null],
  ["EBITDA", "ebitda", 1],
  ["Tax paid", "tax", 1, -1],
  ["Working capital change", "dWc", 1, -1],
  ["BESS augmentation", "augCapex", 1, -1],
  ["CFADS", "cfads", 1, 1, true],
  ["Debt service", "debtService", 1, -1],
  ["Free cash to equity", "fcfe", 1, 1, true],
  ["Cumulative equity cash", "cumEquity", 1],
  ["Project cash flow (unlevered)", "projectCf", 1],
  ["Debt (₹ cr)", null],
  ["Opening balance", "openingDebt", 1],
  ["Interest", "interest", 1],
  ["Principal", "principal", 1],
  ["Closing balance", "closingDebt", 1],
  ["DSCR", "dscr", 2],
];

function FinanceView({ state, patch, set, lockProps, finance, sizes }) {
  const { fin } = state;
  const rows = finance.rows;
  const years = rows.map((r) => `Y${r.year}`);
  const plOption = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 56, top: 36, bottom: 64 },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: years },
    yAxis: [{ type: "value", name: "₹ cr" }, { type: "value", name: "DSCR", splitLine: { show: false }, min: 0 }],
    dataZoom: [{ type: "inside" }, { type: "slider", bottom: 10, height: 18 }],
    series: [
      { name: "Revenue", type: "bar", data: rows.map((r) => Number(r.revenue.toFixed(1))), itemStyle: { color: "#3a3a3a" } },
      { name: "EBITDA", type: "bar", data: rows.map((r) => Number(r.ebitda.toFixed(1))), itemStyle: { color: DATA_COLORS.wind } },
      { name: "PAT", type: "bar", data: rows.map((r) => Number(r.pat.toFixed(1))), itemStyle: { color: DATA_COLORS.surplus } },
      { name: "Debt service", type: "line", data: rows.map((r) => Number(r.debtService.toFixed(1))), lineStyle: { color: DATA_COLORS.solar }, itemStyle: { color: DATA_COLORS.solar } },
      { name: "DSCR", type: "line", yAxisIndex: 1, data: rows.map((r) => (r.dscr === null ? null : Number(r.dscr.toFixed(2)))), lineStyle: { color: DATA_COLORS.demand, type: "dashed" }, itemStyle: { color: DATA_COLORS.demand } },
    ],
  }), [rows]);
  const cashOption = useMemo(() => ({
    animation: false,
    grid: { left: 60, right: 56, top: 36, bottom: 30 },
    legend: { top: 0, right: 0 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: ["Y0", ...years] },
    yAxis: [{ type: "value", name: "₹ cr" }, { type: "value", name: "DFR %", min: 0, max: 100, splitLine: { show: false } }],
    series: [
      { name: "Closing debt", type: "line", data: [finance.debt, ...rows.map((r) => r.closingDebt)].map((v) => Number(v.toFixed(1))), areaStyle: { color: "rgba(245,184,61,0.10)" }, lineStyle: { color: DATA_COLORS.solar }, itemStyle: { color: DATA_COLORS.solar } },
      { name: "Cumulative equity cash", type: "line", data: [-finance.equity, ...rows.map((r) => r.cumEquity)].map((v) => Number(v.toFixed(1))), lineStyle: { color: DATA_COLORS.surplus }, itemStyle: { color: DATA_COLORS.surplus } },
      { name: "DFR", type: "line", yAxisIndex: 1, data: [null, ...rows.map((r) => Number((r.dfr * 100).toFixed(2)))], lineStyle: { color: DATA_COLORS.demand, type: "dashed" }, itemStyle: { color: DATA_COLORS.demand } },
    ],
  }), [rows, finance.debt, finance.equity]);

  function exportCsv() {
    const head = ["Line item", "Y0", ...years];
    const lines = [head.join(",")];
    const y0 = { "Free cash to equity": -finance.equity, "Project cash flow (unlevered)": -finance.capex.total, "Closing balance": finance.debt };
    for (const [label, key] of FIN_LINES) {
      if (!key) { lines.push(`"${label}"`); continue; }
      lines.push([`"${label}"`, y0[label] ?? "", ...rows.map((r) => (r[key] === null ? "" : Number(r[key]).toFixed(4)))].join(","));
    }
    lines.push("");
    lines.push(`"Solar MW",${sizes.solarMw}`, `"Wind MW",${sizes.windMw}`, `"BESS MW",${sizes.bessMw}`, `"BESS MWh",${sizes.bessMwh}`);
    lines.push(`"Project cost cr",${finance.capex.total.toFixed(2)}`, `"Tariff Rs/kWh",${finance.tariff.toFixed(4)}`, `"Equity IRR",${finance.equityIrr.toFixed(5)}`, `"Project IRR",${finance.projectIrr.toFixed(5)}`);
    downloadText("rtc_financial_model_25y.csv", lines.join("\n"));
  }

  const fmtCell = (v, fmt, sign = 1) => {
    if (v === null || v === undefined) return "–";
    if (fmt === "pct") return pf(v, 1);
    const n = Number(v) * (sign === -1 && Number(v) !== 0 ? -1 : 1);
    return n < 0 ? `(${nf(Math.abs(n), fmt)})` : nf(n, fmt);
  };

  return (
    <>
      <section className="rtc-stats">
        <Stat label={finance.tariffLocked ? "Tariff (fixed)" : "Tariff for target IRR"} value={`₹${nf(finance.tariff, 3)}`} detail={fin.tariffEscalation ? `levelised ₹${nf(finance.levelisedTariff, 3)}` : "flat, ₹/kWh"} />
        <Stat label="LCOE" value={`₹${nf(finance.lcoe, 3)}`} detail={`@ ${pf(fin.discountRate, 1)} discount`} />
        <Stat label="Equity IRR" value={pf(finance.equityIrr, 2)} detail={`NPV @ target ₹${nf(finance.equityNpv, 0)} cr`} tone={finance.equityIrr >= fin.targetEquityIrr - 1e-4 ? "good" : "bad"} />
        <Stat label="Project IRR" value={pf(finance.projectIrr, 2)} detail="post-tax, unlevered" />
        <Stat label="DSCR min / avg" value={`${nf(finance.minDscr, 2)} / ${nf(finance.avgDscr, 2)}`} detail={`${fin.tenorYears}-yr ${fin.repayment === "annuity" ? "annuity" : "equal principal"}`} tone={finance.minDscr !== null && finance.minDscr < 1.1 ? "bad" : undefined} />
        <Stat label="Equity payback" value={finance.payback ? `Year ${finance.payback}` : "–"} detail={`equity ₹${nf(finance.equity, 0)} cr · debt ₹${nf(finance.debt, 0)} cr`} />
      </section>

      <Section index="06.1" title="Assumptions" note="Unlock the tariff to solve it for the target equity IRR; lock it to compute returns at a fixed tariff">
        <div className="rtc-subhead">Tariff & returns</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Tariff" unit="₹/kWh" value={finance.tariffLocked ? fin.tariff : finance.tariff} onChange={(v) => patch("fin", { tariff: v })} locked={state.tariffLocked} onLock={() => { if (!state.tariffLocked) patch("fin", { tariff: Number(finance.tariff.toFixed(3)) }); set("tariffLocked", !state.tariffLocked); }} disabled={!state.tariffLocked} lockDisables={false} step={0.01} min={0} hint={state.tariffLocked ? "Fixed: IRR is computed" : "Solved for the target IRR"} />
          <Field label="Target equity IRR" pct value={fin.targetEquityIrr} onChange={(v) => patch("fin", { targetEquityIrr: v })} {...lockProps("fin.targetEquityIrr")} disabled={state.tariffLocked} step={0.25} min={0} max={40} />
          <Field label="Tariff escalation" pct value={fin.tariffEscalation} onChange={(v) => patch("fin", { tariffEscalation: v })} {...lockProps("fin.tariffEscalation")} step={0.1} min={0} max={10} hint="per year" />
          <Field label="Discount rate (LCOE / NPV)" pct value={fin.discountRate} onChange={(v) => patch("fin", { discountRate: v })} {...lockProps("fin.discountRate")} step={0.25} min={0} max={30} />
          <Field label="PPA term" unit="years" value={fin.years} onChange={(v) => patch("fin", { years: Math.max(5, Math.min(35, Math.round(v))) })} {...lockProps("fin.years")} step={1} min={5} max={35} />
          <SwitchBox label="Sell surplus energy" checked={fin.sellSurplus} onChange={(v) => patch("fin", { sellSurplus: v })} {...lockProps("fin.sellSurplus")} />
          <Field label="Surplus price" unit="₹/kWh" value={fin.surplusPrice} onChange={(v) => patch("fin", { surplusPrice: v })} {...lockProps("fin.surplusPrice")} disabled={!fin.sellSurplus} step={0.05} min={0} />
          <Field label="Shortfall penalty" unit="₹/kWh" value={fin.shortfallPenalty} onChange={(v) => patch("fin", { shortfallPenalty: v })} {...lockProps("fin.shortfallPenalty")} step={0.05} min={0} hint="on energy below DFR × demand" />
        </div>
        <div className="rtc-subhead">Financing</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Debt share" pct value={fin.debtFraction} onChange={(v) => patch("fin", { debtFraction: v })} {...lockProps("fin.debtFraction")} step={1} min={0} max={95} />
          <Field label="Interest rate" pct value={fin.interestRate} onChange={(v) => patch("fin", { interestRate: v })} {...lockProps("fin.interestRate")} step={0.05} min={0} max={25} />
          <Field label="Loan tenor" unit="years" value={fin.tenorYears} onChange={(v) => patch("fin", { tenorYears: Math.max(1, Math.round(v)) })} {...lockProps("fin.tenorYears")} step={1} min={1} max={25} />
          <SelectBox label="Repayment" value={fin.repayment} onChange={(v) => patch("fin", { repayment: v })} {...lockProps("fin.repayment")} options={[["equal", "Equal principal"], ["annuity", "Annuity (level debt service)"]]} />
          <Field label="Receivable days" unit="days" value={fin.receivableDays} onChange={(v) => patch("fin", { receivableDays: v })} {...lockProps("fin.receivableDays")} step={5} min={0} max={180} />
        </div>
        <div className="rtc-subhead">Tax & depreciation</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Corporate tax" pct value={fin.taxRate} onChange={(v) => patch("fin", { taxRate: v })} {...lockProps("fin.taxRate")} step={0.01} min={0} max={50} digits={5} />
          <SelectBox label="Tax depreciation" value={fin.taxDepreciation} onChange={(v) => patch("fin", { taxDepreciation: v })} {...lockProps("fin.taxDepreciation")} options={[["wdv", "WDV"], ["slm", "Straight line (= book)"]]} />
          <Field label="WDV rate" pct value={fin.wdvRate} onChange={(v) => patch("fin", { wdvRate: v })} {...lockProps("fin.wdvRate")} disabled={fin.taxDepreciation !== "wdv"} step={1} min={0} max={100} />
          <Field label="Book life" unit="years" value={fin.bookLifeYears} onChange={(v) => patch("fin", { bookLifeYears: Math.max(1, Math.round(v)) })} {...lockProps("fin.bookLifeYears")} step={1} min={1} max={40} />
          <Field label="Salvage value" pct value={fin.salvagePct} onChange={(v) => patch("fin", { salvagePct: v })} {...lockProps("fin.salvagePct")} step={1} min={0} max={30} />
        </div>
        <div className="rtc-subhead">Operations & degradation</div>
        <div className="rtc-grid rtc-grid-4">
          <Field label="Solar O&M" unit="₹ lakh/MW/yr" value={fin.solarOmLakhPerMw} onChange={(v) => patch("fin", { solarOmLakhPerMw: v })} {...lockProps("fin.solarOmLakhPerMw")} step={0.1} min={0} />
          <Field label="Wind O&M" unit="₹ lakh/MW/yr" value={fin.windOmLakhPerMw} onChange={(v) => patch("fin", { windOmLakhPerMw: v })} {...lockProps("fin.windOmLakhPerMw")} step={0.1} min={0} />
          <Field label="BESS O&M" unit="₹ lakh/MWh/yr" value={fin.bessOmLakhPerMwh} onChange={(v) => patch("fin", { bessOmLakhPerMwh: v })} {...lockProps("fin.bessOmLakhPerMwh")} step={0.1} min={0} />
          <Field label="O&M escalation" pct value={fin.omEscalation} onChange={(v) => patch("fin", { omEscalation: v })} {...lockProps("fin.omEscalation")} step={0.25} min={0} max={15} />
          <Field label="Insurance" pct value={fin.insurancePct} onChange={(v) => patch("fin", { insurancePct: v })} {...lockProps("fin.insurancePct")} step={0.05} min={0} max={3} hint="of hard cost / yr" />
          <Field label="Other fixed cost" unit="₹ cr/yr" value={fin.otherFixedCr} onChange={(v) => patch("fin", { otherFixedCr: v })} {...lockProps("fin.otherFixedCr")} step={0.5} min={0} hint="Land lease, SLDC, overheads" />
          <Field label="Solar degradation" pct value={fin.solarDegradation} onChange={(v) => patch("fin", { solarDegradation: v })} {...lockProps("fin.solarDegradation")} step={0.05} min={0} max={3} hint="per year" />
          <Field label="Wind degradation" pct value={fin.windDegradation} onChange={(v) => patch("fin", { windDegradation: v })} {...lockProps("fin.windDegradation")} step={0.05} min={0} max={3} hint="per year" />
        </div>
      </Section>

      <div className="rtc-grid rtc-grid-2 rtc-flush">
        <Section index="06.2" title="Earnings & coverage">
          <LiveChart option={plOption} height={330} />
        </Section>
        <Section index="06.3" title="Debt, equity cash & DFR">
          <LiveChart option={cashOption} height={330} />
        </Section>
      </div>

      <Section index="06.4" title={`${fin.years}-year financial model`} note={`Project cost ₹${nf(finance.capex.total, 1)} cr (hard ₹${nf(finance.capex.hard, 1)} + pre-op ₹${nf(finance.capex.preop, 1)})`} actions={<button type="button" className="secondary" onClick={exportCsv}><Download size={14} /> Export CSV</button>}>
        <div className="table-wrap rtc-model">
          <table>
            <thead>
              <tr><th>Line item</th><th>Y0</th>{years.map((y) => <th key={y}>{y}</th>)}</tr>
            </thead>
            <tbody>
              {FIN_LINES.map(([label, key, fmt, sign, strong], i) => {
                if (!key) return <tr key={i} className="rtc-model-group"><td colSpan={years.length + 2}>{label}</td></tr>;
                const y0 = label === "Free cash to equity" ? -finance.equity : label === "Project cash flow (unlevered)" ? -finance.capex.total : label === "Closing balance" ? finance.debt : null;
                return (
                  <tr key={i} className={strong ? "rtc-model-total" : ""}>
                    <td>{label}</td>
                    <td>{y0 === null ? "" : fmtCell(y0, fmt)}</td>
                    {rows.map((r) => <td key={r.year}>{fmtCell(r[key], fmt, sign)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

