import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, CircleDollarSign, FileSearch, Gavel, ListChecks, RotateCcw, X, Zap } from "lucide-react";
import { trackEvent } from "../activity";
import { nf } from "../rtc/ui";
import { defaultBidState, lpPayload, mergeBidState, resourceProfiles, runSizing } from "./model";
import { applyProposals } from "./tenderMap";
import TenderStep from "./TenderStep";
import RequirementsStep from "./RequirementsStep";
import SizeStep from "./SizeStep";
import FinanceStep from "./FinanceStep";

const STORAGE_KEY = "fdre.bid.v1";
const STEPS = [
  { id: "tender", title: "Tender", icon: FileSearch, color: "#d4ff3f" },
  { id: "requirements", title: "Requirements", icon: ListChecks, color: "#4fd1c5" },
  { id: "size", title: "Size", icon: Zap, color: "#f5b83d" },
  { id: "finance", title: "Financials", icon: CircleDollarSign, color: "#7ddc9a" },
];

function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? mergeBidState(JSON.parse(raw)) : defaultBidState();
  } catch {
    return defaultBidState();
  }
}

// survive switching dashboard tabs; the hour-by-hour dispatch is kept only for the session
let sessionState = null;
let sessionHourly = null;
let sessionRun = null;

/** A step is ticked when its work exists, not merely because a later step is open. */
function stepDone(id, state) {
  if (id === "tender") return Boolean(state.tender);
  if (id === "requirements") return Object.keys(state.provenance || {}).length > 0;
  if (id === "size") return Boolean(state.lp);
  return false;
}

function stepSummary(id, state) {
  switch (id) {
    case "tender": return state.tender ? state.tender.name : "Upload the RfS / RfP";
    case "requirements": return state.tender ? `${Object.keys(state.provenance || {}).length} inputs from the tender` : "No tender read";
    case "size": return state.lp ? `₹${nf(state.lp.tariff, 3)}/kWh · ${nf(state.plantMw, 0)} MW` : `${nf(state.plantMw, 0)} MW · not sized`;
    case "finance": return state.lp ? "Bid tariff and returns" : "After sizing";
    default: return "";
  }
}

/**
 * Tender to Bid: read a power-sale tender, check what it asks for, size the least-tariff
 * solar + wind + biomass + battery plant that meets its supply floors, and price the bid.
 */
export default function BidTab({ user = null }) {
  const [state, setState] = useState(() => sessionState || loadState());
  const [hourly, setHourly] = useState(() => sessionHourly);
  const [run, setRun] = useState(() => sessionRun);
  const [message, setMessage] = useState("");
  const abortRef = useRef(null);

  useEffect(() => {
    sessionState = state;
    const id = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* storage full or blocked: the tab still works for this session */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [state]);
  useEffect(() => { sessionHourly = hourly; }, [hourly]);
  useEffect(() => { sessionRun = run; }, [run]);

  const patch = useCallback((section, values) => setState((s) => ({ ...s, [section]: { ...s[section], ...values } })), []);
  const set = useCallback((key, value) => setState((s) => ({ ...s, [key]: value })), []);
  const isLocked = (key) => Boolean(state.locks?.[key]);
  const lockProps = (key) => ({ locked: isLocked(key), onLock: () => setState((s) => ({ ...s, locks: { ...s.locks, [key]: !s.locks?.[key] } })) });
  const goto = (step) => {
    set("step", step);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  function onRead(tender) {
    trackEvent("run", { module: "bid", action: "tender-read", mode: tender.result?.mode, type: tender.result?.tender_type });
    setState((s) => ({ ...s, tender, accepted: {}, step: "requirements" }));
    setMessage("");
  }

  function onApply(proposals) {
    setState((s) => {
      // a fresh start from the defaults, then the tender's values on top (model costs kept)
      const base = defaultBidState();
      const keep = { costs: s.costs, fin: { ...base.fin, ...s.fin, years: base.fin.years, sellSurplus: false }, bess: s.bess, biomass: s.biomass, inputs: s.inputs, solarUpload: s.solarUpload, windUpload: s.windUpload, solarMonthScale: s.solarMonthScale, windMonthScale: s.windMonthScale, locks: s.locks };
      const next = applyProposals({ ...base, ...keep, tender: s.tender, accepted: s.accepted, provenance: {} }, proposals, s.accepted);
      return { ...next, lp: null, step: "size" };
    });
    setHourly(null);
    setMessage("Model set from the tender. Check the inputs marked with a page chip, then size the plant.");
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  async function startSizing() {
    if (run?.active) return;
    const payload = lpPayload(state, resourceProfiles(state));
    const abort = new AbortController();
    abortRef.current = abort;
    const started = Date.now();
    setRun({ active: true, started, log: [], iteration: 0 });
    trackEvent("optimize", { module: "bid", plantMw: state.plantMw });
    try {
      const result = await runSizing(payload, {
        signal: abort.signal,
        onLog: (line) => setRun((r) => (r ? { ...r, log: [...r.log.slice(-400), line] } : r)),
        onProgress: (p) => setRun((r) => (r ? { ...r, iteration: p.iteration, tariff: p.tariff ?? r.tariff } : r)),
      });
      const { hourly: h, log, ...summary } = result;
      setHourly(h || null);
      setState((s) => ({
        ...s,
        lp: summary,
        // the optimizer's sizes become the values (locked sizes stay as they are)
        vars: Object.fromEntries(Object.entries(s.vars).map(([k, v]) => [k, v.locked || summary.sizes[k] === undefined ? v : { ...v, value: Math.round(summary.sizes[k] * 10) / 10 }])),
      }));
      setRun((r) => ({ ...r, active: false, finished: Date.now() }));
    } catch (err) {
      const msg = abort.signal.aborted ? "Stopped." : err.message;
      setRun((r) => ({ ...(r || { log: [], started }), active: false, finished: Date.now(), error: msg }));
    } finally {
      abortRef.current = null;
    }
  }

  function stopSizing() {
    abortRef.current?.abort();
  }

  function resetAll() {
    if (!window.confirm("Clear the tender, the model inputs and the sizing in Tender to Bid?")) return;
    stopSizing();
    setState(defaultBidState());
    setHourly(null);
    setRun(null);
    setMessage("");
  }

  const index = STEPS.findIndex((s) => s.id === state.step);
  const step = STEPS[index];
  const next = STEPS[index + 1];
  const prev = STEPS[index - 1];
  const props = { state, setState, patch, set, lockProps, isLocked, goto, user };

  return (
    <div className="rtc story bid">
      <section className="story-hero">
        <div>
          <div className="eyebrow"><Gavel size={13} /> Tender to bid · {state.tender ? state.tender.name : "no tender read yet"}</div>
          <h1>Tender to bid</h1>
          <p>Read the tender, check what it asks for, size the cheapest solar, wind, biomass and battery plant that meets it, then price the bid.</p>
        </div>
        <div className="story-hero-tools">
          <button type="button" className="rtc-reset" onClick={resetAll}><RotateCcw size={13} /> Reset</button>
        </div>
      </section>

      {message && (
        <div className="alert">
          {message}
          <button type="button" className="rtc-icon-btn" onClick={() => setMessage("")} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      <nav className="bid-steps" aria-label="Steps">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <button key={s.id} type="button" className={`bid-step ${state.step === s.id ? "active" : ""} ${stepDone(s.id, state) ? "done" : ""}`} style={{ "--chapter": s.color }}
              onClick={() => goto(s.id)} aria-current={state.step === s.id ? "step" : undefined} data-testid={`bid-step-${s.id}`}>
              <span className="story-tab-icon"><Icon size={16} /></span>
              <span className="story-tab-text">
                <small>{String(i + 1).padStart(2, "0")}</small>
                <strong>{s.title}</strong>
                <em>{stepSummary(s.id, state)}</em>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="bid-page" style={{ "--chapter": step.color }} key={step.id}>
        {step.id === "tender" && <TenderStep {...props} onRead={onRead} onSkip={() => goto("size")} />}
        {step.id === "requirements" && <RequirementsStep {...props} onApply={onApply} />}
        {step.id === "size" && <SizeStep {...props} run={run} startSizing={startSizing} stopSizing={stopSizing} hourly={hourly} />}
        {step.id === "finance" && <FinanceStep {...props} />}
      </div>

      <footer className="story-page-foot bid-foot">
        {prev ? <button type="button" className="secondary" onClick={() => goto(prev.id)}><ChevronLeft size={14} /> {prev.title}</button> : <span />}
        {next && <button type="button" className="primary chapter-next" onClick={() => goto(next.id)} style={{ "--next": next.color }}>Next: {next.title} <ArrowRight size={14} /></button>}
      </footer>
    </div>
  );
}
