import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BookOpen, ChevronLeft, CircleDollarSign, Factory, FileSearch, Gauge, RotateCcw, Scale, Wallet } from "lucide-react";
import { trackEvent } from "../activity";
import { nf } from "../rtc/ui";
import { loadMarketPrices } from "../bid/model.js";
import { STORAGE_KEY, defaultCfdState, mergeCfdState, missingInputs, optimiseOwnRe, runModel } from "./model.js";
import VisualModel from "./VisualModel.jsx";
import TermsStep from "./TermsStep.jsx";
import { CostsStep, PlantStep } from "./InputsStep.jsx";
import OperationsStep from "./OperationsStep.jsx";
import FinanceStep from "./FinanceStep.jsx";

const STEPS = [
  { id: "model", title: "How it works", icon: BookOpen, color: "#d4ff3f" },
  { id: "terms", title: "Tender terms", icon: FileSearch, color: "#ff8a5f" },
  { id: "plant", title: "Plant and sourcing", icon: Factory, color: "#4fd1c5" },
  { id: "costs", title: "Costs and finance", icon: Wallet, color: "#3fa7d6" },
  { id: "operations", title: "Operations", icon: Gauge, color: "#f5b83d" },
  { id: "finance", title: "Bid and financials", icon: CircleDollarSign, color: "#7ddc9a" },
];

function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? mergeCfdState(JSON.parse(raw)) : defaultCfdState();
  } catch {
    return defaultCfdState();
  }
}

let sessionState = null; // survives switching dashboard tabs

/**
 * SECI CfD-I: assured peak supply under a Contract for Difference. The tender as a picture, its
 * terms with quotes, the bidder's plant and sourcing, the day-by-day operation over the term, and
 * the strike price that earns the bidder's target equity IRR.
 */
export default function CfdTab() {
  const [state, setState] = useState(() => sessionState || loadState());
  const [prices, setPrices] = useState(null);
  const [priceError, setPriceError] = useState("");
  const [optimising, setOptimising] = useState(null);
  const [message, setMessage] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    loadMarketPrices().then(setPrices).catch((err) => setPriceError(err.message));
  }, []);
  useEffect(() => {
    sessionState = state;
    const id = setTimeout(() => { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage blocked */ } }, 400);
    return () => clearTimeout(id);
  }, [state]);
  useEffect(() => {
    const flush = () => { try { if (sessionState) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionState)); } catch { /* storage blocked */ } };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const setInput = useCallback((key, value) => setState((s) => {
    const filled = { ...s.filled };
    delete filled[key];
    return { ...s, inputs: { ...s.inputs, [key]: value }, filled };
  }), []);
  const goto = useCallback((id) => setState((s) => ({ ...s, step: id })), []);
  const missing = missingInputs(state);
  const model = useMemo(() => (missing.length || !prices ? null : runModel(state, prices)), [state.inputs, prices]); // eslint-disable-line react-hooks/exhaustive-deps

  async function optimise() {
    if (!prices || optimising) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setOptimising({ done: 0, total: 1 });
    setMessage(null);
    try {
      const best = await optimiseOwnRe(state, prices, { signal: abort.signal, onProgress: (done, total) => setOptimising({ done, total }) });
      trackEvent("optimize", { module: "cfd", contractedMw: state.inputs.contractedMw });
      setState((s) => {
        const filled = { ...s.filled };
        delete filled.solarMw;
        delete filled.windMw;
        return { ...s, inputs: { ...s.inputs, solarMw: best.solarMw, windMw: best.windMw }, filled };
      });
      setMessage(best.ok
        ? { ok: true, text: `Own RE optimised: solar ${nf(best.solarMw)} MWac${best.windMw ? `, wind ${nf(best.windMw)} MW` : ""} gives the lowest strike price, ₹${best.sp.toFixed(4)}/kWh, with every day's supply met.` }
        : { ok: false, text: `No own-RE size up to 3 × the contracted capacity meets every day's supply within the sourcing limits; the closest is solar ${nf(best.solarMw)} MWac. Allow group-company RE or more wind.` });
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setOptimising(null);
      abortRef.current = null;
    }
  }

  function resetAll() {
    if (!window.confirm("Clear your CfD inputs?")) return;
    setState(defaultCfdState());
    setMessage(null);
  }

  const summary = {
    model: "The tender as a picture",
    terms: "From the CfDA and amendments",
    plant: missing.length ? `${missing.length} input${missing.length > 1 ? "s" : ""} needed` : `${nf(state.inputs.contractedMw)} MW · ${nf(state.inputs.solarMw)} MW solar`,
    costs: missing.length ? "Costs and financing" : "Ready",
    operations: model ? `${model.sim.years.length} Contract Years` : "After the inputs",
    finance: model?.bid ? `₹${model.bid.toFixed(2)}/kWh` : "After the inputs",
  };
  const index = Math.max(0, STEPS.findIndex((s) => s.id === state.step));
  const step = STEPS[index];
  const next = STEPS[index + 1];
  const prev = STEPS[index - 1];

  return (
    <div className="rtc story bid cfd">
      <section className="story-hero">
        <div>
          <div className="eyebrow"><Scale size={13} /> SECI CfD-I · assured peak supply under a Contract for Difference</div>
          <h1>CfD bid</h1>
          <p>What the tender asks you to build and do, the terms behind it, your plant and where its energy comes from, how it runs every day of the 15-year term, and the strike price that earns your target return.</p>
        </div>
        <div className="story-hero-tools">
          <button type="button" className="rtc-reset" onClick={resetAll}><RotateCcw size={13} /> Reset inputs</button>
        </div>
      </section>
      {priceError && <div className="alert">IEX prices could not be loaded ({priceError}); the operations and the bid need them.</div>}
      {message && <div className={message.ok ? "bid-mode" : "alert"} data-testid="cfd-message">{message.text}</div>}
      <nav className="bid-steps cfd-steps" aria-label="Steps">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <button key={s.id} type="button" className={`bid-step ${state.step === s.id ? "active" : ""}`} style={{ "--chapter": s.color }}
              onClick={() => goto(s.id)} aria-current={state.step === s.id ? "step" : undefined} data-testid={`cfd-step-${s.id}`}>
              <span className="story-tab-icon"><Icon size={16} /></span>
              <span className="story-tab-text"><small>{String(i + 1).padStart(2, "0")}</small><strong>{s.title}</strong><em>{summary[s.id]}</em></span>
            </button>
          );
        })}
      </nav>
      <div className="bid-page" style={{ "--chapter": step.color }} key={step.id}>
        {step.id === "model" && <VisualModel state={state} prices={prices} />}
        {step.id === "terms" && <TermsStep />}
        {step.id === "plant" && <PlantStep state={state} setState={setState} setInput={setInput} optimise={optimise} optimising={optimising} stopOptimise={() => abortRef.current?.abort()} />}
        {step.id === "costs" && <CostsStep state={state} setState={setState} setInput={setInput} />}
        {step.id === "operations" && <OperationsStep model={model} />}
        {step.id === "finance" && <FinanceStep state={state} model={model} />}
      </div>
      <footer className="story-page-foot bid-foot">
        {prev ? <button type="button" className="secondary" onClick={() => goto(prev.id)}><ChevronLeft size={14} /> {prev.title}</button> : <span />}
        {next && <button type="button" className="primary chapter-next" onClick={() => goto(next.id)} style={{ "--next": next.color }} data-testid="cfd-next">Next: {next.title} <ArrowRight size={14} /></button>}
      </footer>
    </div>
  );
}
