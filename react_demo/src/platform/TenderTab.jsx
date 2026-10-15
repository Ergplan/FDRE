// Tender intelligence screen: documents and the amendment chain, the evidence-linked
// requirement review, the summary, amendment impacts, tasks and the activity timeline.
// Everything shown comes from /api/v1; nothing is kept in the browser.
import React, { useEffect, useState } from "react";
import { orgApi, platformApi } from "./api";

const KIND_LABEL = { original: "Original", corrigendum: "Corrigendum", amendment: "Amendment", clarification: "Clarification", ppa: "PPA", other: "Other" };

function fmt(value, unit) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return unit ? `${value} ${unit}` : String(value);
}

function Evidence({ evidence, docs }) {
  if (!evidence || !evidence.page) return <span className="chip warn">no located evidence</span>;
  const doc = docs.find((d) => d.id === evidence.document_id);
  return (
    <span className="evidence" title={evidence.excerpt || ""}>
      <span className="chip">{doc ? doc.filename : (evidence.engine_document_id || "document")} p.{evidence.page}</span>
      {evidence.excerpt && <em>“{evidence.excerpt.slice(0, 160)}{evidence.excerpt.length > 160 ? "…" : ""}”</em>}
    </span>
  );
}

export default function TenderTab({ org, tenderId, me }) {
  const api = org ? orgApi(org.id) : null;
  const can = (p) => Boolean(org?.permissions?.includes(p));
  const [docs, setDocs] = useState([]);
  const [reqs, setReqs] = useState(null);
  const [impacts, setImpacts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [engine, setEngine] = useState(null);
  const [view, setView] = useState("requirements");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [upload, setUpload] = useState({ kind: "original", issued_on: "", effective_on: "", supersedes_document_id: "", summary_of_change: "" });
  const [filter, setFilter] = useState("all");
  const [correcting, setCorrecting] = useState(null);

  async function reload() {
    if (!api || !tenderId) return;
    const [d, r, i, t, tl] = await Promise.all([
      platformApi(`/orgs/${org.id}/tenders/${tenderId}/documents`),
      platformApi(`/orgs/${org.id}/tenders/${tenderId}/requirements`),
      platformApi(`/orgs/${org.id}/tenders/${tenderId}/amendments`),
      platformApi(`/orgs/${org.id}/tasks?tender_id=${tenderId}`),
      platformApi(`/orgs/${org.id}/tenders/${tenderId}/timeline`),
    ]);
    setDocs(d); setReqs(r); setImpacts(i); setTasks(t); setTimeline(tl);
  }
  useEffect(() => { reload().catch((e) => setMessage(e.message)); }, [org?.id, tenderId]);
  useEffect(() => { if (api) platformApi(`/orgs/${org.id}/tender-engine/health`).then(setEngine).catch(() => setEngine(null)); }, [org?.id]);

  async function uploadDocument(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy("upload");
    try {
      const form = new FormData();
      form.append("file", file);
      Object.entries(upload).forEach(([k, v]) => { if (v) form.append(k, v); });
      const res = await fetch(`/api/v1/orgs/${org.id}/tenders/${tenderId}/documents`, { method: "POST", body: form, credentials: "include" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      const changed = body.changes.filter((c) => c.kind !== "restated").length;
      setMessage(`${KIND_LABEL[body.document.kind]} stored as publication ${body.document.publication_order}; extracted by ${body.extractor}; requirement version ${body.requirement_version?.version_no} created with ${changed} change(s)${body.impact ? `; ${body.impact.summary}` : ""}`);
      await reload();
      setView(body.impact ? "amendments" : "requirements");
    } catch (err) { setMessage(err.message); } finally { setBusy(""); event.target.value = ""; }
  }

  async function review(row, decision, extra = {}) {
    setBusy(row.id);
    try {
      await platformApi(`/orgs/${org.id}/requirements/${row.id}/review`, { method: "POST", body: { decision, ...extra } });
      setCorrecting(null);
      await reload();
    } catch (err) { setMessage(err.message); } finally { setBusy(""); }
  }

  async function approve() {
    setBusy("approve");
    try {
      const out = await platformApi(`/orgs/${org.id}/requirement-versions/${reqs.version.id}/approve`, { method: "POST" });
      setMessage(`Version ${out.version.version_no} approved; rule set ${out.rule_set.version_no} ${out.rule_set.certifiable ? "certifiable" : "NOT certifiable: " + out.rule_set.blocking.join("; ")}; ${out.applied.length} scenario(s) updated automatically`);
      await reload();
    } catch (err) { setMessage(err.message); } finally { setBusy(""); }
  }

  async function completeTask(task) {
    await platformApi(`/orgs/${org.id}/tasks/${task.id}/complete`, { method: "POST", body: { status: "done" } });
    await reload();
  }

  if (!tenderId) return <section className="panel"><p className="note">Select or create a tender in the workspace bar to manage its documents and requirements.</p></section>;
  const version = reqs?.version;
  const rows = (version?.requirements || []).filter((r) => filter === "all" || (filter === "changed" ? ["added", "changed", "removed"].includes(r.change_kind) : r.review_state === filter));
  const summary = reqs?.summary;

  return (
    <section className="tender-intel">
      <div className="tender-head">
        <h2>Tender intelligence</h2>
        {engine && <span className={`chip ${engine.source === "fixture" ? "warn" : ""}`}>tender_engine: {engine.source}{engine.status ? ` · ${engine.status}` : ""}</span>}
        <nav className="subnav">
          {["requirements", "summary", "documents", "amendments", "tasks", "timeline"].map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v}{v === "tasks" && tasks.length ? ` (${tasks.length})` : ""}</button>
          ))}
        </nav>
      </div>
      {message && <div className="workspace-message">{message}</div>}

      {view === "documents" && (
        <div className="panel">
          <h3>Documents and amendment chain</h3>
          <table className="table"><thead><tr><th>#</th><th>Kind</th><th>File</th><th>Issued</th><th>Effective</th><th>Supersedes</th><th>Status</th><th>Extractor</th><th>SHA-256</th></tr></thead>
            <tbody>{docs.map((d) => (
              <tr key={d.id}><td>{d.publication_order}</td><td>{KIND_LABEL[d.kind]}</td><td><a href={`/api/v1/orgs/${org.id}/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.filename}</a></td><td>{d.issued_on || "—"}</td><td>{d.effective_on || "—"}</td><td>{docs.find((x) => x.id === d.supersedes_document_id)?.filename || "—"}</td><td>{d.status}{d.error ? ` (${d.error.slice(0, 60)})` : ""}</td><td>{d.extractor || "—"}</td><td className="mono">{d.sha256.slice(0, 12)}</td></tr>
            ))}</tbody></table>
          {can("tender.edit") && (
            <div className="upload-row">
              <select value={upload.kind} onChange={(e) => setUpload({ ...upload, kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input type="date" value={upload.issued_on} onChange={(e) => setUpload({ ...upload, issued_on: e.target.value })} title="Issued on" />
              <input type="date" value={upload.effective_on} onChange={(e) => setUpload({ ...upload, effective_on: e.target.value })} title="Effective on" />
              <select value={upload.supersedes_document_id} onChange={(e) => setUpload({ ...upload, supersedes_document_id: e.target.value })}><option value="">Supersedes…</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}</select>
              <input placeholder="Summary of change" value={upload.summary_of_change} onChange={(e) => setUpload({ ...upload, summary_of_change: e.target.value })} />
              <label className="secondary file-button">{busy === "upload" ? "Uploading…" : "Upload PDF"}<input type="file" accept="application/pdf" onChange={uploadDocument} disabled={busy === "upload"} hidden /></label>
            </div>
          )}
          <p className="note">A document is stored once (same bytes are refused), keeps its publication order, dates and supersession, and is sent to tender_engine for parsing and extraction. When tender_engine is not reachable the local regex extractor runs and every value it produces is labelled as such.</p>
        </div>
      )}

      {view === "requirements" && (
        <div className="panel">
          {!version && <p className="note">No requirements yet. Upload the tender's RfS under Documents.</p>}
          {version && (
            <>
              <div className="req-head">
                <strong>Requirement version {version.version_no}</strong> <span className={`chip ${version.status}`}>{version.status}</span>
                {reqs.approved && reqs.approved.id !== version.id && <span className="chip">approved baseline: version {reqs.approved.version_no}</span>}
                <span className="chip">{version.rules.rules.length} rules · {version.rules.unsupported_count} unsupported · {version.rules.certifiable ? "certifiable" : "not certifiable"}</span>
                <select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All</option><option value="changed">Changed in this version</option><option value="unreviewed">Unreviewed</option><option value="accepted">Accepted</option><option value="corrected">Corrected</option><option value="rejected">Rejected</option><option value="conflicted">Conflicted</option></select>
                {can("bid.approve") || can("tender.edit") ? <button className="primary" disabled={busy === "approve" || version.status === "approved"} onClick={approve}>Approve version {version.version_no}</button> : null}
              </div>
              {version.rules.blocking.length > 0 && <div className="alert">{version.rules.blocking.slice(0, 6).map((b) => <div key={b}>{b}</div>)}</div>}
              <table className="table req-table"><thead><tr><th>Requirement</th><th>Value</th><th>Change</th><th>Provenance</th><th>Evidence</th><th>Review</th><th></th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className={`change-${r.change_kind} state-${r.review_state}`}>
                    <td><strong>{r.label}</strong><br /><small className="mono">{r.field_path}</small></td>
                    <td>{fmt(r.value, r.unit)}{r.original_value !== null && r.original_value !== undefined && <small> (was {fmt(r.original_value)})</small>}{r.alternatives?.length > 0 && <small className="alt"> · earlier: {fmt(r.alternatives[r.alternatives.length - 1].value)}</small>}</td>
                    <td><span className={`chip ${r.change_kind}`}>{r.change_kind}</span></td>
                    <td>{r.provenance}{r.extractor ? <small> · {r.extractor}</small> : null}{r.confidence !== null ? <small> · {Math.round(r.confidence * 100)}%</small> : null}</td>
                    <td><Evidence evidence={r.evidence} docs={docs} /></td>
                    <td><span className={`chip ${r.review_state}`}>{r.review_state}</span>{r.review_note && <small> {r.review_note}</small>}</td>
                    <td className="actions">{can("requirement.review") && version.status !== "approved" && version.status !== "superseded" && (
                      correcting === r.id ? (
                        <CorrectForm row={r} onCancel={() => setCorrecting(null)} onSave={(payload) => review(r, "correct", payload)} />
                      ) : (
                        <>
                          <button className="secondary" disabled={busy === r.id || r.value === null} onClick={() => review(r, "accept")}>Accept</button>
                          <button className="secondary" onClick={() => setCorrecting(r.id)}>Correct</button>
                          <button className="link" onClick={() => review(r, "reject")}>Reject</button>
                        </>
                      )
                    )}</td>
                  </tr>
                ))}</tbody></table>
            </>
          )}
        </div>
      )}

      {view === "summary" && summary && (
        <div className="panel summary">
          {summary.groups.map((g) => g.items.length > 0 && (
            <div key={g.key} className="summary-group">
              <h4>{g.title}</h4>
              <ul>{g.items.map((i) => <li key={i.requirement_id}><strong>{i.label}:</strong> {fmt(i.value, i.unit)} <Evidence evidence={i.evidence} docs={docs} /> <span className={`chip ${i.review_state}`}>{i.review_state}</span></li>)}</ul>
            </div>
          ))}
          <div className="summary-group"><h4>Missing information</h4>{summary.missing_information.length ? <ul>{summary.missing_information.map((m) => <li key={m.field_path}>{m.label}</li>)}</ul> : <p className="note">Nothing required is missing.</p>}</div>
          <div className="summary-group"><h4>Contradictions</h4>{summary.contradictions.length ? <ul>{summary.contradictions.map((c) => <li key={c.field_path}>{c.label}: {c.values.map((v) => fmt(v)).join(" vs ")}</li>)}</ul> : <p className="note">None detected.</p>}</div>
          <div className="summary-group"><h4>Bid risks</h4>{summary.bid_risks.length ? <ul>{summary.bid_risks.map((r, i) => <li key={i}><span className="chip warn">{r.kind}</span> {r.label}: {r.detail}</li>)}</ul> : <p className="note">None.</p>}</div>
        </div>
      )}
      {view === "summary" && !summary && <div className="panel"><p className="note">No requirements yet.</p></div>}

      {view === "amendments" && (
        <div className="panel">
          {impacts.length === 0 && <p className="note">No amendments yet.</p>}
          {impacts.map((i) => (
            <div key={i.id} className="impact">
              <div className="req-head"><strong>{docs.find((d) => d.id === i.document_id)?.filename}</strong> <span className={`chip ${i.status}`}>{i.status}</span> <span className="chip">{i.summary}</span> <small>owner: {i.owner_user_id === me.user_id ? "you" : i.owner_user_id?.slice(0, 8)}</small></div>
              <table className="table"><thead><tr><th>Requirement</th><th>Old</th><th>New</th><th>Evidence</th><th>Affected</th><th>Review</th></tr></thead>
                <tbody>{i.changes.map((c) => (
                  <tr key={c.field_path}><td>{c.label}<br /><small className="mono">{c.field_path}</small></td><td>{fmt(c.old_value, c.unit)}</td><td>{fmt(c.new_value, c.unit)} <span className={`chip ${c.kind}`}>{c.kind}</span></td><td><Evidence evidence={c.new_evidence} docs={docs} /></td>
                    <td><small>inputs: {c.affected_inputs.join(", ") || "none"}<br />constraints: {c.affected_constraints.join(", ") || "none"}<br />runs stale: {c.affected_run_ids.length} · reports: {c.affected_report_ids.length}</small></td>
                    <td>{c.needs_review ? <span className="chip warn">needs review: {c.review_reason}</span> : <span className="chip accepted">auto-apply on approval</span>}</td></tr>
                ))}</tbody></table>
            </div>
          ))}
        </div>
      )}

      {view === "tasks" && (
        <div className="panel">
          {tasks.length === 0 && <p className="note">No open tasks.</p>}
          <ul className="tasks">{tasks.map((t) => (
            <li key={t.id}><span className="chip">{t.kind}</span> <strong>{t.title}</strong><br /><small>{t.body}</small><br /><small>assigned to {t.assignee_user_id === me.user_id ? "you" : t.assignee_user_id?.slice(0, 8)}</small> {(t.assignee_user_id === me.user_id || can("members.manage")) && <button className="link" onClick={() => completeTask(t)}>Mark done</button>}</li>
          ))}</ul>
        </div>
      )}

      {view === "timeline" && (
        <div className="panel">
          <ul className="timeline">{timeline.map((e, i) => (
            <li key={i}><span className="mono">{String(e.at).slice(0, 19).replace("T", " ")}</span> <strong>{e.actor}</strong> {e.action} <small>{e.object_type} {e.object_id?.slice(0, 8)}{e.object_version ? ` v${e.object_version}` : ""}</small></li>
          ))}</ul>
        </div>
      )}
    </section>
  );
}

function CorrectForm({ row, onCancel, onSave }) {
  const [value, setValue] = useState(row.value === null || row.value === undefined ? "" : typeof row.value === "object" ? JSON.stringify(row.value) : String(row.value));
  const [page, setPage] = useState(row.evidence?.page || "");
  const [excerpt, setExcerpt] = useState(row.evidence?.excerpt || "");
  const [note, setNote] = useState("");
  function parse(v) {
    if (row.value_type === "bool") return v === "true" || v === "yes" || v === "1";
    if (["decimal", "percent", "int"].includes(row.value_type)) return Number(v);
    if (row.value_type === "record" || row.value_type === "record_list") { try { return JSON.parse(v); } catch { return v; } }
    return v;
  }
  return (
    <div className="correct-form">
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Corrected value" />
      <input value={page} onChange={(e) => setPage(e.target.value)} placeholder="Page" style={{ width: 60 }} />
      <input value={excerpt} onChange={(e) => setExcerpt(e.target.value)} placeholder="Excerpt from the document" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" />
      <button className="primary" onClick={() => onSave({ value: parse(value), note, evidence: { ...(row.evidence || {}), document_id: row.evidence?.document_id || row.source_document_id, page: Number(page), excerpt } })}>Save correction</button>
      <button className="link" onClick={onCancel}>Cancel</button>
    </div>
  );
}
