import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarDays, ChevronLeft, CircleDollarSign, FileSearch, Gavel, Layers, RotateCcw, Scale, X, Zap } from "lucide-react";
import { trackEvent } from "../activity";
import { nf } from "../rtc/ui";
import { defaultBidState, loadMarketPrices, lpPayload, mergeBidState, missingInputs, capacityIssues, plantMw, resourceProfiles, runSizing } from "./model";
import { mergeReadings, tenderDates, tenderTerms } from "./tenderMap";
import TenderStep, { getJson } from "./TenderStep";
import CapacityStep from "./CapacityStep";
import DatesStep from "./DatesStep";
import SourcesStep from "./SourcesStep";
import SizeStep from "./SizeStep";
import FinanceStep from "./FinanceStep";

const STORAGE_KEY = "fdre.bid.v4";
// the tender loaded when the tab opens: the WBSEDCL RE-RTC RfQ/RfP reading built into the app
const DEFAULT_TENDER = "wbsedcl-re-rtc-2026-01";
const STEPS = [
  { id: "tender", title: "Tender", icon: FileSearch, color: "#d4ff3f" },
  { id: "dates", title: "Key dates", icon: CalendarDays, color: "#ff8a5f" },
  { id: "capacity", title: "Bid capacity", icon: Scale, color: "#4fd1c5" },
  { id: "sources", title: "Supply sources", icon: Layers, color: "#3fa7d6" },
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

/**
 * Tender to Bid: the tender's requirements (WBSEDCL loaded ready), the capacity bid, the
 * bidder's supply sources with their parameters and costs, the least-tariff sizing that meets
 * every requirement, and the bid's financial model.
 */
export default function BidTab({ user = null }) {
  const [state, setState] = useState(() => sessionState || loadState());
  const [hourly, setHourly] = useState(() => sessionHourly);
  const [run, setRun] = useState(() => sessionRun);
  const [message, setMessage] = useState("");
  const [prices, setPrices] = useState(null);
  const [preloading, setPreloading] = useState(false);
  const abortRef = useRef(null);

  const terms = useMemo(() => tenderTerms(state.tender?.result, state.accepted || {}), [state.tender, state.accepted]);
  const missing = useMemo(() => missingInputs(state, terms), [state, terms]);

  // IEX price year for market sales (public market data, loaded once)
  useEffect(() => {
    loadMarketPrices().then(setPrices).catch(() => setPrices(null));
  }, []);

  // the WBSEDCL tender is ready when the tab opens: load its built-in reading
  useEffect(() => {
    if (state.tender) return;
    let cancelled = false;
    setPreloading(true);
    (async () => {
      try {
        const { tenders } = await getJson("/api/tenders");
        const item = (tenders || []).find((t) => t.seed_key === DEFAULT_TENDER);
        if (!item) return;
        // the latest model reading of the same tender fills the fields the rule-based reading has not
        const modelItem = (tenders || []).filter((t) => t.mode === "llm" && t.tender_number && t.tender_number === item.tender_number)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        const { tender } = await getJson(`/api/tenders/${item.id}`);
        const model = modelItem ? (await getJson(`/api/tenders/${modelItem.id}`)).tender : null;
        const result = model ? mergeReadings(tender.result, model.result) : tender.result;
        if (!cancelled) setState((s) => (s.tender ? s : { ...s, tender: { name: tender.file_name, readAt: tender.created_at, result, baseResult: tender.result, savedId: tender.id, modelId: model?.id || null, seedKey: DEFAULT_TENDER } }));
      } catch {
        /* the tender list is unavailable: the step offers reading one */
      } finally {
        if (!cancelled) setPreloading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [state.tender]);

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

  // edits on Financials re-price the same plant; Supply sources clears the sizing itself
  const patch = useCallback((section, values) => setState((s) => ({ ...s, [section]: { ...s[section], ...values } })), []);
  const set = useCallback((key, value) => setState((s) => ({ ...s, [key]: value })), []);
  const isLocked = (key) => Boolean(state.locks?.[key]);
  const lockProps = (key) => ({ locked: isLocked(key), onLock: () => setState((s) => ({ ...s, locks: { ...s.locks, [key]: !s.locks?.[key] } })) });
  const goto = (step) => {
    set("step", step);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  // a model reading of the open tender: merged into it (rule-based fields kept, the rest filled)
  function onModelRead(modelResult, modelId) {
    setState((s) => {
      const base = s.tender?.baseResult || s.tender?.result;
      return { ...s, tender: { ...s.tender, baseResult: base, result: mergeReadings(base, modelResult), modelId }, lp: null };
    });
  }

  function onRead(tender) {
    trackEvent("run", { module: "bid", action: "tender-read", mode: tender.result?.mode, type: tender.result?.tender_type });
    setState((s) => ({ ...s, tender, accepted: {}, lp: null, step: "tender" }));
    setHourly(null);
    setMessage("");
  }

  async function startSizing() {
    if (run?.active) return;
    if (missingInputs(state, terms).length) return;
    let market = null;
    if (state.market.sell && state.market.source !== "flat") {
      try {
        market = prices || (await loadMarketPrices());
      } catch (err) {
        setRun({ active: false, started: Date.now(), finished: Date.now(), log: [], error: `IEX prices could not be loaded (${err.message}); choose a flat price or try again.` });
        return;
      }
    }
    const payload = lpPayload(state, terms, resourceProfiles(state), market);
    const abort = new AbortController();
    abortRef.current = abort;
    const started = Date.now();
    setRun({ active: true, started, log: [], iteration: 0 });
    trackEvent("optimize", { module: "bid", plantMw: plantMw(state, terms) });
    try {
      const result = await runSizing(payload, {
        signal: abort.signal,
        onLog: (line) => setRun((r) => (r ? { ...r, log: [...r.log.slice(-400), line] } : r)),
        onProgress: (p) => setRun((r) => (r ? { ...r, iteration: p.iteration, tariff: p.tariff ?? r.tariff } : r)),
      });
      const { hourly: h, log, ...summary } = result;
      setHourly(h || null);
      const used = payload.ctx.surplusPrice ? state.market.source : null;
      setState((s) => ({ ...s, lp: { ...summary, market: used, flatPrice: used ? null : (payload.ctx.sellSurplus ? payload.fin.surplusPrice : null) } }));
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
    if (!window.confirm("Clear your bid capacity, sources, costs and the sizing in Tender to Bid? The tender stays loaded.")) return;
    stopSizing();
    setState((s) => ({ ...defaultBidState(), tender: s.tender }));
    setHourly(null);
    setRun(null);
    setMessage("");
  }

  const dates = tenderDates(state.tender?.result);
  const today = new Date().toISOString().slice(0, 10);
  const nextDate = dates.find((d) => d.date >= today);
  const done = {
    tender: Boolean(state.tender),
    dates: dates.length > 0,
    capacity: capacityIssues(state, terms).length === 0,
    sources: missing.length === 0,
    size: Boolean(state.lp),
    finance: false,
  };
  const total = plantMw(state, terms);
  const summary = {
    tender: state.tender ? (state.tender.result?.values?.["core.identity.tender_number"] || state.tender.name) : preloading ? "Loading" : "No tender",
    dates: nextDate ? `Next: ${nextDate.label.toLowerCase()} ${nextDate.date.split("-").reverse().join(".")}` : dates.length ? `${dates.length} dates` : "No dates",
    capacity: total ? `${nf(total, 0)} MW${state.bid.greenshoe ? " incl. greenshoe" : ""}` : "Not entered",
    sources: missing.length ? `${missing.length} input${missing.length > 1 ? "s" : ""} needed` : `${Object.values(state.sources).filter(Boolean).length} sources ready`,
    size: state.lp ? `₹${nf(state.lp.tariff, 3)}/kWh` : "Not sized",
    finance: state.lp ? "Bid tariff and returns" : "After sizing",
  };

  const index = STEPS.findIndex((s) => s.id === state.step);
  const step = STEPS[Math.max(0, index)];
  const next = STEPS[index + 1];
  const prev = STEPS[index - 1];
  const props = { state, setState, patch, set, lockProps, isLocked, goto, user, prices, terms, missing };

  return (
    <div className="rtc story bid">
      <section className="story-hero">
        <div>
          <div className="eyebrow"><Gavel size={13} /> Tender to bid · {summary.tender}</div>
          <h1>Tender to bid</h1>
          <p>What the tender requires, the capacity you bid, the sources you have with their costs, the least-tariff plant that meets every requirement, and the bid's financial model.</p>
        </div>
        <div className="story-hero-tools">
          <button type="button" className="rtc-reset" onClick={resetAll}><RotateCcw size={13} /> Reset inputs</button>
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
            <button key={s.id} type="button" className={`bid-step ${state.step === s.id ? "active" : ""} ${done[s.id] ? "done" : ""}`} style={{ "--chapter": s.color }}
              onClick={() => goto(s.id)} aria-current={state.step === s.id ? "step" : undefined} data-testid={`bid-step-${s.id}`}>
              <span className="story-tab-icon"><Icon size={16} /></span>
              <span className="story-tab-text">
                <small>{String(i + 1).padStart(2, "0")}</small>
                <strong>{s.title}</strong>
                <em>{summary[s.id]}</em>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="bid-page" style={{ "--chapter": step.color }} key={step.id}>
        {step.id === "tender" && <TenderStep {...props} onRead={onRead} onModelRead={onModelRead} preloading={preloading} />}
        {step.id === "dates" && <DatesStep {...props} />}
        {step.id === "capacity" && <CapacityStep {...props} />}
        {step.id === "sources" && <SourcesStep {...props} startSizing={startSizing} />}
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
