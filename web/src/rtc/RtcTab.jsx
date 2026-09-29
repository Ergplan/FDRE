import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowRight, ChevronLeft, FolderOpen, Loader2, RotateCcw, Save, SlidersHorizontal, X, Zap } from "lucide-react";
import * as E from "./engine";
import SaveDialog from "../scenarios/SaveDialog";
import OptimizerTheatre from "./Theatre";
import FinanceView from "./FinanceView";
import { Answer, Alternatives, AgeingImpact, DispatchStory, EnergyFlow, SolverLog, TariffMap } from "./results";
import { BessChapter, CHAPTERS, DfrChapter, EnergyChapter, ResourceChapter, TypeChapter, chapterSummary } from "./chapters";
import { Section, SelectBox, nf, pf } from "./ui";

// ---------------------------------------------------------------- state

const STORAGE_KEY = "fdre.rtc.v1";

function defaultState() {
  const { site, ...inputs } = E.DEFAULT_RTC_INPUTS;
  return {
    chapter: "energy",
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
    objective: "tariff",
    solver: "highs", // 'highs' = HiGHS LP on the engine + exact 25-year search; 'search' = search only
    gridPoints: 11,
    stateVersion: 2,
    tariffLocked: false,
    locks: { loadFactor: false },
  };
}

function mergeState(saved) {
  const base = defaultState();
  const merged = { ...base, ...saved };
  for (const k of ["inputs", "bess", "costs", "fin", "locks"]) merged[k] = { ...base[k], ...(saved[k] || {}) };
  merged.vars = Object.fromEntries(Object.keys(base.vars).map((k) => [k, { ...base.vars[k], ...(saved.vars?.[k] || {}) }]));
  if (!CHAPTERS.some((c) => c.id === merged.chapter)) merged.chapter = "energy";
  // v2: the 25-year tariff became the default objective (it was levelised cost)
  if ((saved.stateVersion || 1) < 2 && merged.objective === "lcoe") merged.objective = "tariff";
  merged.stateVersion = 2;
  return merged;
}

function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? mergeState(JSON.parse(raw)) : defaultState();
  } catch {
    return defaultState();
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

// ---------------------------------------------------------------- main tab

export default function RtcTab({ initialScenario = null, user = null }) {
  // a scenario opened from the library replaces the working state once per page load
  const openKey = initialScenario ? `${initialScenario.scenario.id}@${initialScenario.current.version}` : null;
  const fresh = openKey && openKey !== openedScenarioKey;
  const [state, setState] = useState(() => (fresh ? mergeState(initialScenario.current.inputs?.state || {}) : sessionState || loadState()));
  const [opt, setOpt] = useState(() => (fresh ? initialScenario.current.results?.opt || null : sessionOpt));
  const [linked, setLinked] = useState(() => (fresh ? { id: initialScenario.scenario.id, name: initialScenario.scenario.name, version: initialScenario.current.version } : sessionLinked));
  const [showSave, setShowSave] = useState(false);
  const [message, setMessage] = useState(fresh ? `Opened “${initialScenario.scenario.name}” version ${initialScenario.current.version}.` : "");
  const [theatre, setTheatre] = useState(false);
  const [revealKey, setRevealKey] = useState(0);
  const [showOptSettings, setShowOptSettings] = useState(false);
  const workerRef = useRef(null);
  const feedRef = useRef(null);
  const answerRef = useRef(null);

  useEffect(() => { if (fresh) openedScenarioKey = openKey; }, [fresh, openKey]);
  useEffect(() => { sessionLinked = linked; }, [linked]);
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
  const setVar = useCallback((k, values) => setState((s) => ({ ...s, vars: { ...s.vars, [k]: { ...s.vars[k], ...values } } })), []);

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
    () => E.buildContext({ demand, solarCf, windCf, plantMw: inputs.plantCapacityMw, bess: d.bess, lossPct: inputs.lossPct, sellSurplus: d.fin.sellSurplus, extraExportMw: d.fin.extraExportMw }),
    [demand, solarCf, windCf, inputs.plantCapacityMw, d.bess, inputs.lossPct, d.fin.sellSurplus, d.fin.extraExportMw],
  );
  // battery energy follows the chosen discharge duration (2 h or 4 h)
  const sizes = useMemo(() => E.withDuration(Object.fromEntries(Object.entries(d.vars).map(([k, v]) => [k, v.value])), d.bess), [d.vars, d.bess]);
  const sim = useMemo(() => E.simulate(ctx, sizes, { hourly: true }), [ctx, sizes]);
  const finInput = useMemo(() => ({ ...d.fin, demandGrowth: inputs.demandGrowth }), [d.fin, inputs.demandGrowth]);
  const finance = useMemo(
    () => E.runFinancialModel(ctx, sizes, { costs: d.costs, fin: finInput, bess: d.bess, dfrTarget: inputs.dfrTarget, tariffLocked: d.tariffLocked }),
    [ctx, sizes, d.costs, finInput, d.bess, inputs.dfrTarget, d.tariffLocked],
  );
  const capex = useMemo(() => E.capexCr(sizes, d.costs), [sizes, d.costs]);
  const loadFactor = (state.inputs.annualEnergyMu * 1000) / (state.inputs.plantCapacityMw * E.HOURS);
  const peakDemand = useMemo(() => Math.max(...demand), [demand]);
  const maxDfr = sim.demandMWh > 0 ? 1 - sim.demandAboveCapMWh / sim.demandMWh : 1;
  const stale = d !== state;
  const derived = { solarCuf: E.mean(solarCf), windCuf: E.mean(windCf) };

  // ---- plant capacity, annual energy and load factor are linked through locks
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

  const applySizes = useCallback((next) => {
    setState((s) => ({
      ...s,
      vars: Object.fromEntries(Object.entries(s.vars).map(([k, v]) => [k, v.locked ? v : { ...v, value: next[k] ?? v.value }])),
    }));
  }, []);

  // ---- optimizer with the surface theatre
  function runOptimizer() {
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./optimizer.worker.js", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const id = Date.now();
    const before = sizes;
    const tariffMode = state.objective === "tariff";
    feedRef.current = {
      axes: null, cells: [], tcells: [], tariffMode, done: false, result: null, error: null, progress: null,
      highs: { active: false, lines: [], progress: null, done: false, result: null, error: null, startedAt: null },
    };
    const feed = feedRef;
    setMessage("");
    setTheatre(true);
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.id !== id || !feed.current) return;
      if (msg.type === "axes") feed.current.axes = msg.axes;
      else if (msg.type === "cells") feed.current.cells.push(...msg.cells);
      else if (msg.type === "tcells") feed.current.tcells.push(...msg.cells);
      else if (msg.type === "progress") feed.current.progress = msg.progress;
      else if (msg.type === "highs-start") Object.assign(feed.current.highs, { active: true, startedAt: performance.now() });
      else if (msg.type === "highs-log") feed.current.highs.lines.push(...msg.lines);
      else if (msg.type === "highs-progress") feed.current.highs.progress = msg.progress;
      else if (msg.type === "highs-done") Object.assign(feed.current.highs, { done: true, result: msg.result, error: msg.error, endedAt: performance.now() });
      else if (msg.type === "error") {
        feed.current.error = msg.error;
        worker.terminate();
      } else if (msg.type === "done") {
        feed.current.result = { ...msg.result, previous: before, at: new Date().toISOString() };
        feed.current.done = true;
        worker.terminate();
      }
    };
    worker.postMessage({
      id,
      ctx: { demand: ctx.demand, solarCf: ctx.solarCf, windCf: ctx.windCf, plantMw: ctx.plantMw, bess: ctx.bess, lossPct: ctx.lossPct, sellSurplus: ctx.sellSurplus, extraExportMw: ctx.extraExportMw },
      modelInput: { inputs: state.inputs, costs: state.costs, fin: state.fin, bess: state.bess, vars: state.vars, objective: state.objective, gridPoints: state.gridPoints },
      useHighs: tariffMode && state.solver !== "search",
    });
  }

  function finishTheatre() {
    const f = feedRef.current;
    setTheatre(false);
    if (!f) return;
    if (f.error) {
      setMessage(`Optimizer: ${f.error}`);
      return;
    }
    if (f.result) {
      setOpt(f.result);
      if (f.result.best) applySizes(f.result.best.sizes);
      if (!f.result.feasible) setMessage("No design reached the DFR target inside the allowed ranges. Widen the size ranges, unlock sizes, or lower the target.");
      setRevealKey((k) => k + 1);
      requestAnimationFrame(() => answerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function cancelTheatre() {
    workerRef.current?.terminate();
    feedRef.current = null;
    setTheatre(false);
  }

  function resetAll() {
    if (!window.confirm("Reset every Round-the-clock input, profile and lock to the defaults?")) return;
    setState(defaultState());
    setOpt(null);
    setLinked(null);
    setRevealKey(0);
  }

  function buildSave() {
    const { hourly, ...simSummary } = sim;
    return {
      inputs: { state: { ...state, chapter: "energy" } },
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

  const chapterIndex = CHAPTERS.findIndex((c) => c.id === state.chapter);
  const chapter = CHAPTERS[chapterIndex];
  const next = CHAPTERS[chapterIndex + 1];
  const prev = CHAPTERS[chapterIndex - 1];
  const ChapterIcon = chapter.icon;
  const chapterProps = { state, patch, set, setVar, lockProps, isLocked, sizes, sim, user };
  const sizeKeys = state.bess.durationH ? ["solarMw", "windMw", "bessMw"] : ["solarMw", "windMw", "bessMw", "bessMwh"];
  const freeVars = sizeKeys.filter((k) => !state.vars[k].locked).length;

  return (
    <div className="rtc story">
      <section className="story-hero">
        <div>
          <div className="eyebrow"><Activity size={13} /> RTC · {E.BEED_SITE.name}</div>
          <h1>Round the clock</h1>
          <p>Tell the story of the demand, then let the optimizer find the cheapest solar, wind and battery plant that keeps it supplied.</p>
        </div>
        <div className="story-hero-tools">
          {linked && <span className="rtc-live" title="Saved scenario this workspace is linked to">{linked.name} · v{linked.version}</span>}
          <button type="button" className="rtc-reset" onClick={() => setShowSave(true)} disabled={stale}><Save size={13} /> Save</button>
          <a className="rtc-reset" href="/scenarios?module=rtc"><FolderOpen size={13} /> Open</a>
          <button type="button" className="rtc-reset" onClick={resetAll}><RotateCcw size={13} /> Reset</button>
          {stale && <span className="rtc-live"><Loader2 className="spin" size={12} /> updating</span>}
        </div>
      </section>

      {message && (
        <div className="alert">
          {message}
          <button type="button" className="rtc-icon-btn" onClick={() => setMessage("")} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      <section className="story-book">
        <nav className="story-rail" aria-label="Inputs">
          {CHAPTERS.map((c, i) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                type="button"
                className={`story-tab ${state.chapter === c.id ? "active" : ""} ${i < chapterIndex ? "done" : ""}`}
                style={{ "--chapter": c.color }}
                onClick={() => set("chapter", c.id)}
                aria-current={state.chapter === c.id ? "step" : undefined}
              >
                <span className="story-tab-icon"><Icon size={17} /></span>
                <span className="story-tab-text">
                  <small>{String(i + 1).padStart(2, "0")}</small>
                  <strong>{c.title}</strong>
                  <em>{chapterSummary(c.id, state, derived)}</em>
                </span>
              </button>
            );
          })}
          <button type="button" className="story-tab story-tab-go" onClick={runOptimizer} disabled={theatre}>
            <span className="story-tab-icon"><Zap size={17} /></span>
            <span className="story-tab-text"><small>07</small><strong>Optimize</strong><em>{freeVars} of {sizeKeys.length} sizes free</em></span>
          </button>
        </nav>

        <article className="story-page" style={{ "--chapter": chapter.color }} key={chapter.id}>
          <header className="story-page-head">
            <span className="story-page-icon"><ChapterIcon size={22} /></span>
            <div>
              <small>Chapter {String(chapterIndex + 1).padStart(2, "0")} of {CHAPTERS.length}</small>
              <h2>{chapter.title}</h2>
            </div>
          </header>
          <div className="story-page-body">
            {chapter.id === "energy" && <EnergyChapter {...chapterProps} setTriplet={setTriplet} loadFactor={loadFactor} demand={demand} peakDemand={peakDemand} />}
            {chapter.id === "type" && <TypeChapter {...chapterProps} readUpload={readUpload} peakDemand={peakDemand} />}
            {chapter.id === "dfr" && <DfrChapter {...chapterProps} maxDfr={maxDfr} />}
            {chapter.id === "solar" && <ResourceChapter kind="solar" {...chapterProps} cf={solarCf} base={solarBase} readUpload={readUpload} />}
            {chapter.id === "wind" && <ResourceChapter kind="wind" {...chapterProps} cf={windCf} base={windBase} readUpload={readUpload} />}
            {chapter.id === "bess" && <BessChapter {...chapterProps} />}
          </div>
          <footer className="story-page-foot">
            {prev ? <button type="button" className="secondary" onClick={() => set("chapter", prev.id)}><ChevronLeft size={14} /> {prev.title}</button> : <span />}
            {next ? (
              <button type="button" className="primary chapter-next" onClick={() => set("chapter", next.id)} style={{ "--next": next.color }}>Next: {next.title} <ArrowRight size={14} /></button>
            ) : (
              <button type="button" className="primary chapter-next" onClick={runOptimizer} disabled={theatre}><Zap size={14} /> Optimize</button>
            )}
          </footer>
        </article>
      </section>

      <section className="optimize-bar">
        <div>
          <span className="rtc-index">07</span>
          <h2>Optimize</h2>
          <p>
            {state.objective === "tariff"
              ? <>Map the 25-year tariff over every solar and wind mix (cheapest battery at each), {state.solver !== "search" ? "solve the sizing LP with HiGHS for the global optimum, " : ""}then price the best designs with the full financial model. The DFR of {pf(inputs.dfrTarget, 0)} must hold in every year.</>
              : <>Search every solar and wind mix, size the cheapest battery that holds the DFR at {pf(inputs.dfrTarget, 0)}, then refine.</>}
            {" "}{sizeKeys.length - freeVars ? `${sizeKeys.length - freeVars} size${sizeKeys.length - freeVars > 1 ? "s are" : " is"} fixed by a lock.` : "All sizes are free."}
            {state.bess.durationH ? ` Battery: ${state.bess.durationH}-hour discharge.` : ""}
          </p>
        </div>
        <div className="optimize-bar-actions">
          <button type="button" className="rtc-reset" onClick={() => setShowOptSettings(!showOptSettings)}><SlidersHorizontal size={13} /> Settings</button>
          <button type="button" className="primary optimize-go" onClick={runOptimizer} disabled={theatre}><Zap size={16} /> {state.objective === "tariff" ? "Optimize least tariff" : "Optimize least cost"}</button>
        </div>
        {showOptSettings && (
          <div className="rtc-grid rtc-grid-3 optimize-settings">
            <SelectBox label="Objective" value={state.objective} onChange={(v) => set("objective", v)} {...lockProps("objective")} options={[["tariff", "Least 25-year tariff (target equity IRR)"], ["lcoe", "Least levelised cost (₹/kWh)"], ["capex", "Least capital cost"]]} />
            {state.objective === "tariff" && (
              <SelectBox label="Solver" value={state.solver || "highs"} onChange={(v) => set("solver", v)} {...lockProps("solver")} options={[["highs", "HiGHS LP + exact 25-year search"], ["search", "Search only (no engine call)"]]} />
            )}
            <SelectBox label="Search depth" value={String(state.gridPoints)} onChange={(v) => set("gridPoints", Number(v))} {...lockProps("gridPoints")} options={[["7", "Fast · 7 × 7 surface"], ["11", "Standard · 11 × 11 surface"], ["15", "Deep · 15 × 15 surface"]]} />
            <p className="rtc-note">Sizes and their search ranges are set in the Solar, Wind and Battery chapters. A locked size is kept as it is.</p>
          </div>
        )}
      </section>

      <div ref={answerRef} className="answer-anchor" />
      <Answer sizes={sizes} sim={sim} finance={finance} capex={capex} inputs={inputs} revealKey={revealKey} optimized={Boolean(opt)} targetIrr={state.fin.targetEquityIrr} highs={opt?.highs} />
      {maxDfr < inputs.dfrTarget && (
        <div className="alert">
          Demand above the {nf(inputs.plantCapacityMw, 0)} MW plant capacity ({nf(sim.demandAboveCapMWh / 1000, 1)} MU) cannot be served, so the highest achievable DFR is {pf(maxDfr, 1)}. Raise the plant capacity or flatten the consumption profile.
        </div>
      )}
      <DispatchStory sim={sim} inputs={inputs} sizes={sizes} />
      <Section index="E" title="Where the energy goes" note="Every MWh generated in year 1: to the customer, through the battery, sold, or curtailed">
        <EnergyFlow sim={sim} inputs={inputs} fin={d.fin} />
      </Section>
      <div className="story-divider"><span>Financial model · {state.fin.years} years</span></div>
      <FinanceView state={state} patch={patch} set={set} lockProps={lockProps} finance={finance} sizes={sizes} />
      <AgeingImpact ctx={ctx} sizes={sizes} costs={d.costs} fin={finInput} bess={d.bess} dfrTarget={inputs.dfrTarget} finance={finance} />
      <TariffMap opt={opt} sizes={sizes} applySizes={applySizes} />
      <Alternatives opt={opt} sizes={sizes} target={inputs.dfrTarget} applySizes={applySizes} />
      <SolverLog opt={opt} />

      {theatre && feedRef.current && <OptimizerTheatre feed={feedRef} onFinish={finishTheatre} onCancel={cancelTheatre} onSkipHighs={() => workerRef.current?.postMessage({ type: "skip-highs" })} />}
      {showSave && (
        <SaveDialog
          module="rtc"
          linked={linked}
          defaultName={`RTC ${nf(inputs.annualEnergyMu, 0)} MU · ${nf(inputs.plantCapacityMw, 0)} MW · DFR ${pf(inputs.dfrTarget, 0)}`}
          build={buildSave}
          onSaved={(saved) => { setLinked(saved); setShowSave(false); setMessage(`Saved “${saved.name}” version ${saved.version}.`); }}
          onClose={() => setShowSave(false)}
        />
      )}
    </div>
  );
}
