import React, { useEffect, useState } from "react";

let sessionReviews = null;

export function saveTenderReviews(documents) {
  sessionReviews = documents;
  localStorage.setItem("fdre-tender-reviews-v1", JSON.stringify(documents.map(({ sourceUrl, ...doc }) => doc)));
}

export function restoreTenderReviews() {
  if (sessionReviews) return sessionReviews;
  try {
    return JSON.parse(localStorage.getItem("fdre-tender-reviews-v1") || "[]").map((doc) => ({ ...doc, sourceUrl: null }));
  } catch { return []; }
}

export default function TenderReview({ document, documents, onChange, onApply }) {
  const [section, setSection] = useState("all");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceView, setSourceView] = useState("text");
  const [message, setMessage] = useState("");
  const [compareBase, setCompareBase] = useState(false);
  useEffect(() => { setSelected(null); setSection("all"); setFilter("all"); setPage(1); setMessage(""); setCompareBase(false); }, [document?.parsed.document_id]);
  if (!document) return null;
  const { parsed, decisions = {}, audit = [], reviewer = "" } = document;
  const fields = parsed.review_fields || [];
  const filtered = fields.filter((field) => (section === "all" || field.section === section) && (filter === "all" || (decisions[field.id]?.status || "pending") === filter));
  const field = filtered.find((item) => item.id === selected) || filtered[0];
  const decision = field ? decisions[field.id] || { value: field.original, status: "pending", note: "" } : null;
  const base = documents.find((doc) => doc.parsed.document_id === document.baseDocumentId);
  const sourceDocument = compareBase && base ? base : document;
  const pages = sourceDocument.parsed.source_pages || [];
  const source = pages.find((item) => item.page === page);
  const approved = fields.filter((item) => decisions[item.id]?.status === "approved").length;
  const resolved = fields.filter((item) => ["approved", "rejected"].includes(decisions[item.id]?.status)).length;

  function updateDecision(patch) {
    onChange({ ...document, decisions: { ...decisions, [field.id]: { ...decision, ...patch, status: "pending" } } });
  }
  function decide(status) {
    if (!reviewer.trim()) { setMessage("Enter the reviewer name before recording a decision."); return; }
    const timestamp = new Date().toISOString();
    const entry = { ...decision, status, reviewer: reviewer.trim(), timestamp };
    onChange({ ...document, decisions: { ...decisions, [field.id]: entry }, audit: [...audit, { field: field.id, ...entry }] });
    setMessage("Decision recorded in this browser.");
  }
  function exportReview() {
    const blob = new Blob([JSON.stringify({ ...document, sourceUrl: undefined, exported_at: new Date().toISOString() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url; link.download = `${parsed.source_name}.review.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function apply() {
    const updates = {};
    for (const item of fields.filter((entry) => entry.setting_key && decisions[entry.id]?.status === "approved")) {
      const value = decisions[item.id].value;
      if (typeof item.original === "number" && (!Number.isFinite(Number(value)) || Number(value) <= 0 || (item.setting_key === "declaredCuf" && Number(value) > 100))) {
        setMessage(`Invalid value for ${item.setting_key}.`); return;
      }
      updates[item.setting_key] = typeof item.original === "number" ? Number(value) : value;
    }
    if (!Object.keys(updates).length) { setMessage("Approve fields in the Settings group to apply model inputs."); return; }
    onApply(updates);
    onChange({ ...document, audit: [...audit, { action: "apply_model_inputs", updates, reviewer, timestamp: new Date().toISOString() }] });
    setMessage("Approved mapped inputs applied to Project Configuration. Other reviewed terms remain reference information.");
  }
  return <article className="panel tender-review" aria-label="Extraction reviewer">
    <header><h2>Extraction Reviewer</h2><span>{approved} approved · {resolved} / {fields.length} resolved</span></header>
    <p className="note">{parsed.compatibility?.message}</p>
    <div className="review-toolbar">
      <label>Reviewer<input aria-label="Reviewer" value={reviewer} onChange={(event) => onChange({ ...document, reviewer: event.target.value })} placeholder="Name" /></label>
      <label>Group<select aria-label="Group" value={section} onChange={(event) => setSection(event.target.value)}><option value="all">All groups</option>{[...new Set(fields.map((item) => item.section))].map((key) => <option key={key} value={key}>{key.replaceAll("_", " ")}</option>)}</select></label>
      <label>Status<select aria-label="Status" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All statuses</option>{["pending", "approved", "rejected"].map((status) => <option key={status}>{status}</option>)}</select></label>
      <button onClick={exportReview}>Download review JSON</button>
      <button disabled={!parsed.compatibility?.can_apply} onClick={apply}>Apply approved model inputs</button>
    </div>
    {parsed.rag_status.amendment_role === "amendment" && <label>Associated base tender<select value={document.baseDocumentId || ""} onChange={(event) => { onChange({ ...document, baseDocumentId: event.target.value }); setCompareBase(false); setPage(1); }}><option value="">Select uploaded base tender</option>{documents.filter((doc) => doc.parsed.rag_status.amendment_role === "base tender").map((doc) => <option key={doc.parsed.document_id} value={doc.parsed.document_id}>{doc.parsed.source_name}</option>)}</select></label>}
    {message && <p role="status">{message}</p>}
    <p className="note">Drafts are saved in this browser. Source links are retrieval candidates, not verified citations. Editing an approved value returns it to pending review.</p>
    <div className="review-layout">
      <nav className="review-field-list" aria-label="Extracted fields">
        {filtered.map((item) => <button key={item.id} className={field?.id === item.id ? "selected" : ""} onClick={() => { setSelected(item.id); setCompareBase(false); if (item.page) setPage(item.page); }}>
          <small>{item.section.replaceAll("_", " ")} · {decisions[item.id]?.status || "pending"}</small><span>{item.label}</span>
        </button>)}
        {!filtered.length && <p>No fields match this filter.</p>}
      </nav>
      <div className="review-editor">
        {field && <>
          <h3>{field.label}</h3>
          <label>Original extraction<pre>{String(field.original ?? "Not extracted")}</pre></label>
          <label>Reviewed value{typeof field.original === "boolean" ? <select aria-label="Reviewed value" value={String(decision.value)} onChange={(event) => updateDecision({ value: event.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select> : <textarea aria-label="Reviewed value" rows={7} value={decision.value ?? ""} onChange={(event) => updateDecision({ value: event.target.value })} />}</label>
          <label>Reviewer note<textarea aria-label="Reviewer note" rows={3} value={decision.note || ""} onChange={(event) => updateDecision({ note: event.target.value })} placeholder="Correction, clause reference, or reason for rejection" /></label>
          <p className="note">{field.source || field.evidence_status}</p>
          {field.page && <button onClick={() => { setCompareBase(false); setPage(field.page); }}>View cited page {field.page}</button>}
          <div className="panel-actions"><button className="primary" onClick={() => decide("approved")}>Approve field</button><button onClick={() => decide("rejected")}>Reject field</button></div>
        </>}
      </div>
      <div className="review-source">
        <h3>Source document</h3>
        {base && <label>Compare source<select value={compareBase ? "base" : "current"} onChange={(event) => { setCompareBase(event.target.value === "base"); setPage(1); }}><option value="current">Current amendment</option><option value="base">Associated base tender</option></select></label>}
        <div className="review-toolbar">
          <label>Physical page<select value={page} onChange={(event) => setPage(Number(event.target.value))}>{pages.map((item) => <option key={item.page} value={item.page}>{item.page}</option>)}</select></label>
          <label>View<select value={sourceView} onChange={(event) => setSourceView(event.target.value)}><option value="text">Extracted text</option><option value="native">Native PDF text</option><option value="pdf" disabled={!sourceDocument.sourceUrl}>Original PDF</option></select></label>
        </div>
        <label>Find source page<input value={sourceSearch} onChange={(event) => setSourceSearch(event.target.value)} placeholder="Clause, phrase, or amount" /></label>
        {sourceSearch.trim() && <div className="review-page-hits">{pages.filter((item) => item.text.toLowerCase().includes(sourceSearch.toLowerCase())).map((item) => <button key={item.page} onClick={() => setPage(item.page)}>Page {item.page}</button>)}</div>}
        {sourceView === "pdf" && sourceDocument.sourceUrl ? <iframe title="Original tender PDF" src={`${sourceDocument.sourceUrl}#page=${page}`} /> : <pre className="review-source-text">{(sourceView === "native" ? source?.native_text || source?.text : source?.text) || "No text extracted on this page."}</pre>}
        {!sourceDocument.sourceUrl && <p className="note">Re-upload this PDF to restore its visual preview. Review decisions will be retained.</p>}
      </div>
    </div>
  </article>;
}
