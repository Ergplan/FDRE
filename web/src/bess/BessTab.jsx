import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BatteryCharging, ChevronLeft, FolderOpen, RotateCcw, Save, X, Zap } from "lucide-react";
import * as B from "./engine";
import { BatteryChapter, CHAPTERS, CostsChapter, FinanceChapter, RequirementsChapter, TenderChapter, chapterSummary } from "./chapters";
import { BidAnswer, CapacityTrajectory, Compliance, FinanceTable, StrategyMap, TenderInsights, TypicalDay } from "./results";
import OptimizerTheatre from "../rtc/Theatre";
import SaveDialog from "../scenarios/SaveDialog";
import { Field, Section, nf, pf } from "../rtc/ui";
import { trackEvent } from "../activity";

const STORAGE_KEY = "fdre.bess.v1";

// requirement keys a parsed tender can set
const REQ_KEYS = ["powerMw", "energyMwh", "cyclesPerDay", "annualCycles", "minRte", "availability", "availabilityBasis", "contractYears", "scodMonths",
  "ceilingTariff", "vgfLakhPerMwh", "vgfPct", "chargingBy", "maintainCapacity", "tariffBasis"];

function defaultState() {
  return {
    chapter: "tender",
    tender: null,
    req: { ...B.DEFAULT_REQ },
    reqSource: {},
    edited: {},
    tech: { ...B.DEFAULT_TECH },
    costs: { ...B.DEFAULT_COSTS },
    fin: { ...B.DEFAULT_FIN },
    strategy: { oversize: 0.1, interval: 3 },
    locks: {},
  };
}

function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const saved = JSON.parse(raw);
    const base = defaultState();
    return { ...base, ...saved, req: { ...base.req, ...saved.req }, tech: { ...base.tech, ...saved.tech }, costs: { ...base.costs, ...saved.costs }, fin: { ...base.fin, ...saved.fin } };
  } catch {
    return defaultState();
  }
}

let sessionState = null;
let sessionOpt = null;
let sessionLinked = null;

export default function BessTab({ initialScenario = null }) {
  const fresh = initialScenario?.current?.inputs?.state;
  const [state, setState] = useState(() => (fresh ? { ...defaultState(), ...fresh } : sessionState || loadState()));
  const [opt, setOpt] = useState(() => (fresh ? initialScenario.current.results?.opt || null : sessionOpt));
  const [linked, setLinked] = useState(() => (fresh ? { id: initialScenario.scenario.id, name: initialScenario.scenario.name, version: initialScenario.current.version } : sessionLinked));
  const [message, setMessage] = useState(fresh ? `Opened “${initialScenario.scenario.name}” version ${initialScenario.current.version}.` : "");
  const [theatre, setTheatre] = useState(false);
  const [revealKey, setRevealKey] = useState(0);
  const [showSave, setShowSave] = useState(false);
  const feedRef = useRef(null);
  const answerRef = useRef(null);

  useEffect(() => {
    sessionState = state;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
  }, [state]);
  useEffect(() => { sessionOpt = opt; }, [opt]);
  useEffect(() => { sessionLinked = linked; }, [linked]);

  const set = useCallback((k, v) => setState((s) => ({ ...s, [k]: v })), []);
  const patch = useCallback((section, values) => setState((s) => ({ ...s, [section]: { ...s[section], ...values } })), []);
  const lockProps = (key) => ({ locked: Boolean(state.locks[key]), onLock: () => setState((s) => ({ ...s, locks: { ...s.locks, [key]: !s.locks[key] } })) });
  const setReq = useCallback((values, key) => setState((s) => ({ ...s, req: { ...s.req, ...values }, edited: { ...s.edited, [key]: true } })), []);

  // current strategy, fully evaluated (fast: one plan + one financial model)
  const res = useMemo(() => B.evaluate(state.req, state.tech, state.costs, state.fin, state.strategy), [state.req, state.tech, state.costs, state.fin, state.strategy]);

  function onParsed(parsed) {
    const byKey = Object.fromEntries((parsed.requirements || []).map((f) => [f.key, f]));
    setState((s) => {
      const req = { ...s.req };
      const edited = { ...s.edited };
      for (const k of REQ_KEYS) {
        const f = byKey[k];
        if (!f || s.locks[`req.${k}`]) continue;
        if (f.value === null || f.value === undefined) { if (k === "ceilingTariff") req[k] = null; continue; }
        req[k] = f.value;
        delete edited[k];
      }
      // energy not stated but duration is: energy = power × hours
      if (byKey.energyMwh?.confidence === "low" && byKey.durationH?.confidence === "high" && !s.locks["req.energyMwh"]) req.energyMwh = req.powerMw * byKey.durationH.value;
      if (!byKey.vgfPct) req.vgfPct = s.locks["req.vgfPct"] ? req.vgfPct : 0;
      if (!byKey.vgfLakhPerMwh) req.vgfLakhPerMwh = s.locks["req.vgfLakhPerMwh"] ? req.vgfLakhPerMwh : 0;
      const { requirements, ...meta } = parsed;
      return { ...s, tender: { ...meta, requirements }, req, edited, reqSource: byKey, chapter: "requirements" };
    });
    setOpt(null);
    trackEvent("run", { module: "bess", action: "parse", file: parsed.source_name, engine: parsed.extraction?.engine, found: parsed.found, total: parsed.total }, (parsed.seconds || 0) * 1000);
    setMessage(`Read “${parsed.source_name}” with ${parsed.extraction?.engine}: ${parsed.found} of ${parsed.total} requirements found. Check the Requirements chapter.`);
  }

  // ---- optimizer with the surface theatre
  function runOptimizer() {
    const started = performance.now();
    feedRef.current = {
      startedAt: started, axes: null, cells: [], tcells: [], tariffMode: false, done: false, result: null, error: null, progress: null, highs: null,
      callout: (best) => [
        `Oversize ${nf(best.sizes.oversizePct, 1)}% on day one`,
        `Augment ${best.sizes.interval ? `every ${best.sizes.interval} yr` : "only when needed"}`,
        `Charge  ₹${best.tariff.toFixed(3)} lakh/MW/mo`,
      ],
    };
    setMessage("");
    setTheatre(true);
    setTimeout(() => {
      const f = feedRef.current;
      if (!f) return;
      try {
        const o = B.optimize(state.req, state.tech, state.costs, state.fin);
        f.axes = { ...o.axes, xKey: "oversizePct", yKey: "interval", xLabel: "DAY-ONE OVERSIZE  %", yLabel: "AUGMENT EVERY  YEARS", zUnit: "₹ lakh/MW/mo", missLabel: "n/a" };
        f.cells.push(...o.cells);
        const b = o.best;
        f.result = { best: { sizes: { oversizePct: b.strategy.oversize * 100, interval: b.strategy.interval || o.axes.windGrid.at(-1) }, tariff: b.chargeLakh }, opt: o };
        f.done = true;
      } catch (err) {
        f.error = err.message;
      }
    }, 350);
  }

  function finishTheatre() {
    const f = feedRef.current;
    setTheatre(false);
    if (!f) return;
    if (f.error) { setMessage(`Optimizer: ${f.error}`); return; }
    const o = f.result?.opt;
    if (!o) return;
    const b = o.best;
    const compact = { axes: o.axes, cells: o.cells, ranked: o.ranked, evals: o.evals, ms: o.ms, log: o.log, best: { strategy: b.strategy, chargeLakh: b.chargeLakh } };
    setOpt(compact);
    set("strategy", { ...b.strategy });
    trackEvent("optimize", { module: "bess", powerMw: state.req.powerMw, energyMwh: state.req.energyMwh, years: state.req.contractYears, strategy: b.strategy, chargeLakhPerMwMonth: b.chargeLakh, strategies: o.evals }, performance.now() - f.startedAt);
    setRevealKey((k) => k + 1);
    requestAnimationFrame(() => answerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function resetAll() {
    if (!window.confirm("Reset the BESS tender workspace (tender, requirements, costs and locks)?")) return;
    setState(defaultState());
    setOpt(null);
    setLinked(null);
    setRevealKey(0);
  }

  function buildSave() {
    const { plan, rows, ...summaryRes } = res;
    return {
      inputs: { state: { ...state, chapter: "tender" } },
      results: { opt, res: { ...summaryRes, years: plan.years.map(({ byCohort, ...y }) => y), rows } },
      summary: {
        powerMw: state.req.powerMw,
        energyMwh: state.req.energyMwh,
        contractYears: state.req.contractYears,
        cyclesPerDay: state.req.cyclesPerDay,
        tender: state.tender?.source_name || null,
        day1DcMwh: plan.cohorts[0].mwh,
        oversizePct: state.strategy.oversize * 100,
        augIntervalYears: state.strategy.interval,
        augMwh: res.augMwh,
        capexCr: res.capex.total,
        vgfCr: res.capex.vgf,
        chargeLakhPerMwMonth: res.chargeLakh,
        ceilingLakhPerMwMonth: state.req.ceilingTariff ? state.req.ceilingTariff / 1e5 : null,
        lcos: res.lcos,
        equityIrr: res.equityIrr,
        projectIrr: res.projectIrr,
        minDscr: res.minDscr,
      },
    };
  }

  const chapterIndex = CHAPTERS.findIndex((c) => c.id === state.chapter);
  const chapter = CHAPTERS[Math.max(0, chapterIndex)];
  const next = CHAPTERS[chapterIndex + 1];
  const prev = CHAPTERS[chapterIndex - 1];
  const ChapterIcon = chapter.icon;
  const props = { state, set, patch, lockProps, setReq };
  const N = Math.round(state.req.contractYears);

  const buildSteps = (st) => [
    [`Requirements: ${nf(state.req.powerMw)} MW / ${nf(state.req.energyMwh)} MWh, ${state.req.cyclesPerDay} cycles/day, ${state.req.contractYears} years`, true],
    [`Pricing ${st.shown}/${st.total || "…"} strategies: day-one oversize × augmentation interval`, st.shown > 0],
    ["Each one: yearly capacity fade, augmentation blocks, full financial model, charge solved for the equity IRR", st.shown > 0],
    ["Fine search on the day-one oversize at the best interval", st.phase !== "build"],
    ["Lowest capacity charge found", st.phase === "found"],
  ];

  return (
    <div className="rtc story bess">
      <section className="story-hero">
        <div>
          <div className="eyebrow"><BatteryCharging size={13} /> BESS tender intelligence{state.tender?.metadata?.issuer ? ` · ${state.tender.metadata.issuer}` : ""}</div>
          <h1>BESS tender</h1>
          <p>Read the tender, confirm what it asks for, then let the optimizer find the battery build-out and augmentation plan with the lowest capacity charge that meets every requirement for the whole term.</p>
        </div>
        <div className="story-hero-tools">
          {linked && <span className="rtc-live">{linked.name} · v{linked.version}</span>}
          <button type="button" className="rtc-reset" onClick={() => setShowSave(true)}><Save size={13} /> Save</button>
          <a className="rtc-reset" href="/scenarios?module=bess"><FolderOpen size={13} /> Open</a>
          <button type="button" className="rtc-reset" onClick={resetAll}><RotateCcw size={13} /> Reset</button>
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
              <button key={c.id} type="button" className={`story-tab ${state.chapter === c.id ? "active" : ""} ${i < chapterIndex ? "done" : ""}`} style={{ "--chapter": c.color }} onClick={() => set("chapter", c.id)} aria-current={state.chapter === c.id ? "step" : undefined}>
                <span className="story-tab-icon"><Icon size={17} /></span>
                <span className="story-tab-text"><small>{String(i + 1).padStart(2, "0")}</small><strong>{c.title}</strong><em>{chapterSummary(c.id, state)}</em></span>
              </button>
            );
          })}
          <button type="button" className="story-tab story-tab-go" onClick={runOptimizer} disabled={theatre}>
            <span className="story-tab-icon"><Zap size={17} /></span>
            <span className="story-tab-text"><small>06</small><strong>Optimize</strong><em>lowest capacity charge</em></span>
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
            {chapter.id === "tender" && <TenderChapter {...props} onParsed={onParsed} />}
            {chapter.id === "requirements" && <RequirementsChapter {...props} />}
            {chapter.id === "battery" && <BatteryChapter {...props} />}
            {chapter.id === "costs" && <CostsChapter {...props} />}
            {chapter.id === "finance" && <FinanceChapter {...props} />}
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
          <span className="rtc-index">06</span>
          <h2>Optimize</h2>
          <p>Price every day-one oversize (0–{nf(B.SEARCH.oversizeMax * 100)}%) against every augmentation interval (1–{Math.min(B.SEARCH.maxInterval, N)} years): each strategy gets its own {N}-year capacity plan and financial model, and the capacity charge that gives {pf(state.fin.targetEquityIrr, 1)} equity IRR. The whole grid is searched, so the answer is the best strategy on it.</p>
        </div>
        <div className="optimize-bar-actions">
          <button type="button" className="primary optimize-go" onClick={runOptimizer} disabled={theatre}><Zap size={16} /> Optimize the bid</button>
        </div>
        <div className="rtc-grid rtc-grid-3 optimize-settings">
          <Field label="Day-one oversize" pct value={state.strategy.oversize} onChange={(v) => patch("strategy", { oversize: Math.max(0, v) })} {...lockProps("strategy.oversize")} hint="above the battery that just lasts through year 1" />
          <Field label="Augment every (0 = only when needed)" unit="years" value={state.strategy.interval} step={1} onChange={(v) => patch("strategy", { interval: Math.max(0, Math.round(v)) })} {...lockProps("strategy.interval")} />
          <p className="rtc-note">Edit the strategy by hand to see its capacity charge, or let the optimizer choose.</p>
        </div>
      </section>

      <div ref={answerRef} className="answer-anchor" />
      <BidAnswer state={state} res={res} optimized={Boolean(opt)} revealKey={revealKey} />
      <Compliance state={state} res={res} />
      <CapacityTrajectory state={state} res={res} />
      <TypicalDay state={state} res={res} />
      <div className="story-divider"><span>Financial model · {N} years</span></div>
      <FinanceTable state={state} res={res} />
      <StrategyMap opt={opt} current={state.strategy} onPick={(sg) => set("strategy", { oversize: sg.oversize, interval: sg.interval >= N ? 0 : sg.interval })} />
      <TenderInsights tender={state.tender} />
      {opt?.log?.length > 0 && (
        <Section index="L" title="Optimizer log" note={`${opt.evals} strategies in ${nf(opt.ms)} ms`}>
          <div className="solver-log">{opt.log.map((l, i) => <div key={i} className="log-line log-result"><span className="log-t" /><span className="log-s">result</span><span className="log-m">{l}</span></div>)}</div>
        </Section>
      )}

      {theatre && feedRef.current && (
        <OptimizerTheatre feed={feedRef} onFinish={finishTheatre} onCancel={() => { feedRef.current = null; setTheatre(false); }} title="Finding the lowest capacity charge" buildSteps={buildSteps} />
      )}
      {showSave && (
        <SaveDialog
          module="bess"
          linked={linked}
          defaultName={`BESS ${nf(state.req.powerMw)} MW / ${nf(state.req.energyMwh)} MWh${state.tender?.metadata?.issuer ? ` · ${state.tender.metadata.issuer.split(" (")[0]}` : ""}`}
          build={buildSave}
          onSaved={(saved) => { setLinked(saved); setShowSave(false); setMessage(`Saved “${saved.name}” version ${saved.version}.`); }}
          onClose={() => setShowSave(false)}
        />
      )}
    </div>
  );
}
