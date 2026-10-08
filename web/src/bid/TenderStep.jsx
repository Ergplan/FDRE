import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, FileSearch, FolderOpen, Loader2, Sparkles, Upload } from "lucide-react";
import { Section, Stat, nf, pf } from "../rtc/ui";
import { ReadingBanner } from "./RequirementsStep";

const TYPE_LABEL = {
  auto: "Detect from the document",
  fdre: "FDRE / RTC (firm and dispatchable)",
  bess: "Battery storage (BESS)",
  hybrid: "Wind-solar hybrid",
  solar: "Solar",
  wind: "Wind",
  transmission: "Transmission",
  epc: "EPC",
  generation: "Generation",
  ipp: "IPP",
};

async function getJson(path, opts) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((d) => d.msg || d).join("; ") : null;
    throw new Error(data.error || detail || `Request failed (${res.status})`);
  }
  return data;
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Step 1: upload the tender and read it with the tender intelligence engine. */
export default function TenderStep({ state, onRead, onSkip, goto }) {
  const [status, setStatus] = useState(null);
  const [file, setFile] = useState(null);
  const [tenderType, setTenderType] = useState("auto");
  const [mode, setMode] = useState("auto");
  const [job, setJob] = useState(null); // { status, progress, error }
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  const inputRef = useRef(null);
  const [recent, setRecent] = useState(null);
  const [opening, setOpening] = useState("");

  async function loadRecent() {
    try {
      setRecent((await getJson("/api/tenders")).tenders || []);
    } catch {
      setRecent([]);
    }
  }
  useEffect(() => { loadRecent(); }, []);

  async function openSaved(item) {
    setOpening(item.id);
    setError("");
    try {
      const { tender } = await getJson(`/api/tenders/${item.id}`);
      onRead({ name: tender.file_name, readAt: tender.created_at, result: tender.result, savedId: tender.id });
    } catch (err) {
      setError(err.message);
    } finally {
      setOpening("");
    }
  }

  useEffect(() => {
    cancelled.current = false;
    getJson("/api/bid/tender/status").then(setStatus).catch(() => setStatus({ llm_available: false, default_mode: "rules", types: Object.keys(TYPE_LABEL).filter((t) => t !== "auto"), unavailable: true }));
    return () => { cancelled.current = true; };
  }, []);

  async function read() {
    if (!file) return;
    setError("");
    setJob({ status: "uploading", progress: { done: 0, total: 1, step: "Uploading" } });
    try {
      if (file.size > 60 * 1024 * 1024) throw new Error("The file is larger than 60 MB.");
      const content = await toBase64(file);
      const started = await getJson("/api/bid/tender/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: { name: file.name, content_base64: content }, tender_type: tenderType, mode }),
      });
      let current = { status: started.status || "queued", progress: { done: 0, total: 1, step: "Queued" } };
      setJob(current);
      const t0 = Date.now();
      while (!cancelled.current && current.status !== "done" && current.status !== "failed") {
        await sleep(1200);
        current = await getJson(`/api/bid/tender/read/${started.job_id}`);
        setJob(current);
        if (Date.now() - t0 > 30 * 60 * 1000) throw new Error("Reading the tender took longer than 30 minutes.");
      }
      if (cancelled.current) return;
      if (current.status === "failed") throw new Error(current.error || "The tender could not be read.");
      // keep the reading for the team (Recently extracted tenders); the tab works without it
      let savedId = null;
      try {
        const saved = await getJson("/api/tenders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: file.name, result: current.result }) });
        savedId = saved.tender?.id || null;
      } catch { /* saving is best effort */ }
      onRead({ name: file.name, readAt: new Date().toISOString(), result: current.result, savedId });
      setJob(null);
    } catch (err) {
      setJob(null);
      setError(err.message);
    }
  }

  const busy = Boolean(job);
  const p = job?.progress;
  const share = p?.total ? Math.min(1, (p.done || 0) / p.total) : 0;
  const last = state.tender?.result;

  return (
    <>
      <Section index="1" title="Read the tender" note="PDF, Word or text · up to 60 MB">
        <div className="bid-upload">
          <button type="button" className="bid-drop" onClick={() => inputRef.current?.click()} disabled={busy}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}>
            <Upload size={22} />
            <strong>{file ? file.name : "Choose the RfS / RfP document"}</strong>
            <small>{file ? `${nf(file.size / 1024 / 1024, 1)} MB` : "or drop it here"}</small>
          </button>
          <input ref={inputRef} type="file" accept=".pdf,.docx,.txt" hidden data-testid="bid-file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }} />
          <div className="bid-upload-options">
            <label className="rtc-field">
              <div className="rtc-field-top"><span>Tender type</span></div>
              <select value={tenderType} onChange={(e) => setTenderType(e.target.value)} disabled={busy}>
                {["auto", ...(status?.types || [])].map((t) => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
              </select>
            </label>
            <label className="rtc-field">
              <div className="rtc-field-top"><span>Reading</span></div>
              <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={busy}>
                <option value="auto">{status?.llm_available ? "Full reading (tender engine model)" : "Rule-based reading (no model key on the engine)"}</option>
                {status?.llm_available && !status?.require_llm && <option value="rules">Rule-based reading only</option>}
              </select>
              <small>
                {status?.require_llm
                  ? "This engine reads tenders only with the model; a read that cannot use it stops with an error"
                  : status?.llm_available
                    ? "Every field is read with a quote from the page; quotes are checked against the PDF"
                    : "Set ANTHROPIC_API_KEY on the engine for the tender engine's full reading; rules read only the key figures, with page quotes"}
              </small>
            </label>
            <div className="bid-upload-go">
              <button type="button" className="primary" onClick={read} disabled={!file || busy} data-testid="bid-read">
                {busy ? <Loader2 className="spin" size={15} /> : <FileSearch size={15} />} Read tender
              </button>
              <button type="button" className="secondary" onClick={onSkip} disabled={busy}>Continue without a tender</button>
            </div>
          </div>
        </div>
        {busy && (
          <div className="bid-progress" role="status">
            <div className="bid-progress-bar"><i style={{ width: `${Math.round(share * 100)}%` }} /></div>
            <span><Loader2 className="spin" size={13} /> {p?.step || job.status} {p?.total > 1 ? `· ${p.done} of ${p.total}` : ""}</span>
          </div>
        )}
        {error && <div className="alert"><AlertTriangle size={14} /> {error}</div>}
        {status?.unavailable && <p className="rtc-note">The tender engine did not answer; reading may be unavailable.</p>}
      </Section>

      <Section index="1.1" title="Recently extracted tenders" note="Read once, open again: each reading keeps its page quotes">
        {recent === null && <p className="rtc-note"><Loader2 className="spin" size={13} /> Loading</p>}
        {recent?.length === 0 && <p className="rtc-note">No tender has been read yet.</p>}
        {recent?.length > 0 && (
          <div className="bid-recent" role="table" data-testid="bid-recent">
            <div className="bid-recent-row head" role="row"><span>Tender</span><span>Issuer</span><span>Capacity</span><span>Reading</span><span>Read</span><span /></div>
            {recent.map((t) => (
              <div key={t.id} className={`bid-recent-row ${state.tender?.savedId === t.id ? "current" : ""}`} role="row" data-testid={`recent-${t.seed_key || t.id}`}>
                <span><strong>{t.tender_number || t.file_name}</strong><small>{t.title || t.file_name}</small></span>
                <span>{t.issuer || "–"}</span>
                <span>{t.capacity_mw ? `${nf(t.capacity_mw, 0)} MW` : "–"}</span>
                <span><span className={`bid-chip ${t.mode === "llm" ? "" : "warn"}`}>{t.mode === "llm" ? "Model reading" : "Rule-based"}</span><small>{t.found ?? "–"} of {t.fields ?? "–"} fields</small></span>
                <span><small>{t.seed_key ? "Built in" : (t.created_by_name || t.created_by_email || "")}</small><small>{new Date(t.created_at).toLocaleDateString()}</small></span>
                <span><button type="button" className="secondary" onClick={() => openSaved(t)} disabled={Boolean(opening) || busy}>{opening === t.id ? <Loader2 className="spin" size={13} /> : <FolderOpen size={13} />} Open</button></span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {last && !busy && (
        <Section index="1.2" title="Last tender read" note={state.tender.readAt ? new Date(state.tender.readAt).toLocaleString() : ""}>
          <div className="bid-read-summary">
            <ReadingBanner result={last} />
            <div className="bid-read-title">
              <strong>{state.tender.name}</strong>
              <span className="bid-chip"><Sparkles size={11} /> {last.mode === "llm" ? "Full reading" : "Rule-based reading"}</span>
              <span className="bid-chip">{TYPE_LABEL[last.tender_type] || last.tender_type}</span>
            </div>
            <div className="rtc-grid rtc-grid-4">
              <Stat label="Pages" value={nf(last.document?.pages)} detail={last.document?.scanned_pages?.length ? `${last.document.scanned_pages.length} without text` : "all with text"} />
              <Stat label="Fields found" value={`${nf(last.counts?.found)} of ${nf(last.counts?.fields)}`} detail={`${nf(last.counts?.located)} with a located quote`} />
              <Stat label="To review" value={nf(last.counts?.needs_review)} detail="unlocated quote or a failed check" tone={last.counts?.needs_review ? "warn" : undefined} />
              <Stat label="Reading time" value={`${nf(last.usage?.seconds, 1)} s`} detail={last.usage?.calls ? `${last.usage.calls} model calls` : "no model calls"} />
            </div>
            {last.warnings?.length > 0 && <ul className="bid-warnings">{last.warnings.map((w, i) => <li key={i}><AlertTriangle size={12} /> {w}</li>)}</ul>}
            <button type="button" className="primary" onClick={() => goto("requirements")}>Review requirements <ArrowRight size={14} /></button>
          </div>
        </Section>
      )}
      {!last && !busy && (
        <p className="rtc-note bid-hint">After reading, the next screen lists what the tender asks for (capacity, supply floors, peak hours, sources, term, guarantees) with the page and quote for each, and sets the model from it. {pf(0.8, 0)} annual supply is the default floor without a tender.</p>
      )}
    </>
  );
}
