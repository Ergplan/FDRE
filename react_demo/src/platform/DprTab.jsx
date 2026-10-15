// Post-award: record the award from an approved (succeeded, not stale) run, then work in the
// DPR workspace generated from its frozen baseline. Traced values are read-only and name
// their run and path; narrative is versioned with a revision check; exports are stored.
import React, { useEffect, useState } from "react";
import { platformApi } from "./api";

const fmt = (v, unit) => (v === null || v === undefined ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : unit === "fraction" ? `${(v * 100).toFixed(2)} %` : typeof v === "number" ? `${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}${unit ? ` ${unit}` : ""}` : `${v}${unit ? ` ${unit}` : ""}`);

export default function DprTab({ org, tenderId }) {
  const can = (p) => Boolean(org?.permissions?.includes(p));
  const base = `/orgs/${org?.id}`;
  const [awards, setAwards] = useState([]);
  const [runs, setRuns] = useState([]);
  const [form, setForm] = useState({ run_id: "", tariff_inr_per_kwh: "", capacity_mw: "", award_date: new Date().toISOString().slice(0, 10), letter_reference: "" });
  const [ws, setWs] = useState(null);
  const [sections, setSections] = useState([]);
  const [trace, setTrace] = useState(null);
  const [versions, setVersions] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    if (!org || !tenderId) return;
    const [a, r] = await Promise.all([platformApi(`${base}/tenders/${tenderId}/awards`), platformApi(`${base}/tenders/${tenderId}/runs`)]);
    setAwards(a); setRuns(r.filter((x) => x.status === "succeeded" && !x.stale && ["bid_tariff", "fixed_tariff"].includes(x.kind)));
    const current = a.find((x) => x.status === "recorded");
    if (current) {
      const detail = await platformApi(`${base}/awards/${current.id}`);
      if (detail.dpr_workspace_id) await openWorkspace(detail.dpr_workspace_id); else setWs(null);
    } else setWs(null);
  }
  async function openWorkspace(id) {
    const w = await platformApi(`${base}/dpr/${id}`);
    setWs(w); setSections(w.version.sections);
    const [t, v, art] = await Promise.all([platformApi(`${base}/dpr/${id}/trace`), platformApi(`${base}/dpr/${id}/versions`), platformApi(`${base}/dpr/${id}/artifacts`)]);
    setTrace(t); setVersions(v); setArtifacts(art);
  }
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [org?.id, tenderId]);

  async function recordAward() {
    setMessage("");
    try {
      await platformApi(`${base}/tenders/${tenderId}/awards`, { method: "POST", body: { ...form, tariff_inr_per_kwh: Number(form.tariff_inr_per_kwh), capacity_mw: Number(form.capacity_mw) } });
      await load();
    } catch (e) { setMessage(e.message); }
  }
  async function createWorkspace(awardId) { try { const w = await platformApi(`${base}/awards/${awardId}/dpr`, { method: "POST" }); await openWorkspace(w.id); } catch (e) { setMessage(e.message); } }
  async function save() {
    setMessage("");
    try { await platformApi(`${base}/dpr/${ws.id}`, { method: "PUT", body: { expected_revision: ws.revision, sections, change_note: note } }); setNote(""); await openWorkspace(ws.id); setMessage("Saved as a new version."); } catch (e) { setMessage(e.status === 409 ? `Someone else changed the DPR (revision ${e.body?.current_revision}); reload and merge your edits.` : e.message); }
  }
  async function exportAs(fmtKind) { setMessage(`Exporting ${fmtKind}…`); try { const a = await platformApi(`${base}/dpr/${ws.id}/export?format=${fmtKind}`, { method: "POST" }); setArtifacts((p) => [a, ...p]); setMessage(`${a.filename} ready (sha256 ${a.sha256.slice(0, 10)})`); } catch (e) { setMessage(e.message); } }
  async function setStatus(status) { try { await platformApi(`${base}/dpr/${ws.id}/status`, { method: "POST", body: { expected_revision: ws.revision, status } }); await openWorkspace(ws.id); } catch (e) { setMessage(e.message); } }

  if (!tenderId) return <section className="panel"><p className="note">Select a tender.</p></section>;
  const current = awards.find((a) => a.status === "recorded");
  const editable = ws && can("dpr.edit") && ws.status !== "issued";
  return (
    <section className="dpr">
      <div className="req-head"><h2>Post-award: award record and DPR</h2>{current && <span className="chip accepted">awarded {current.awarded_capacity_mw} MW @ {current.awarded_tariff_inr_per_kwh} ₹/kWh on {current.award_date}</span>}{ws && <span className={`chip ${ws.status}`}>DPR {ws.status} · v{ws.current_version_no}</span>}</div>
      {message && <div className="alert">{message}</div>}
      {can("bid.approve") && (
        <div className="panel">
          <h3>Record an award from an approved run</h3>
          <p className="note">Only a succeeded run on the current inputs can be awarded; its inputs, result, rules and requirement versions are frozen into the award baseline.</p>
          <div className="filters">
            <select value={form.run_id} onChange={(e) => setForm({ ...form, run_id: e.target.value })}><option value="">run…</option>{runs.map((r) => <option key={r.id} value={r.id}>{r.id.slice(0, 8)} · {r.kind} · tariff {r.metrics?.tariff ?? "—"} · IRR {r.metrics?.equity_irr ? (r.metrics.equity_irr * 100).toFixed(2) + "%" : "—"}</option>)}</select>
            <input placeholder="tariff ₹/kWh" value={form.tariff_inr_per_kwh} onChange={(e) => setForm({ ...form, tariff_inr_per_kwh: e.target.value })} />
            <input placeholder="capacity MW" value={form.capacity_mw} onChange={(e) => setForm({ ...form, capacity_mw: e.target.value })} />
            <input type="date" value={form.award_date} onChange={(e) => setForm({ ...form, award_date: e.target.value })} />
            <input placeholder="letter of award ref" value={form.letter_reference} onChange={(e) => setForm({ ...form, letter_reference: e.target.value })} />
            <button className="primary" disabled={!form.run_id || !form.tariff_inr_per_kwh || !form.capacity_mw} onClick={recordAward}>Record award</button>
          </div>
        </div>
      )}
      {awards.length > 0 && <div className="panel"><h3>Awards</h3><table className="table"><thead><tr><th>Status</th><th>Run</th><th>Tariff</th><th>Capacity</th><th>Date</th><th>Letter</th><th>Inputs hash</th><th>Requirement version</th><th></th></tr></thead><tbody>{awards.map((a) => <tr key={a.id}><td><span className="chip">{a.status}</span></td><td className="mono">{a.run_id.slice(0, 8)}</td><td>{a.awarded_tariff_inr_per_kwh}</td><td>{a.awarded_capacity_mw} MW</td><td>{a.award_date}</td><td>{a.letter_reference}</td><td className="mono">{a.baseline.run.inputs_hash?.slice(0, 10)}</td><td className="mono">{a.requirement_version_id?.slice(0, 8) || "none approved"}</td><td>{a.status === "recorded" && !ws && can("dpr.edit") && <button className="secondary" onClick={() => createWorkspace(a.id)}>Open DPR workspace</button>}</td></tr>)}</tbody></table></div>}
      {ws && (
        <>
          <div className="panel">
            <div className="req-head"><h3>{ws.title}</h3>
              {trace && <span className={`chip ${trace.all_match ? "accepted" : "rejected"}`}>{trace.all_match ? "all values trace to the source run" : "values drifted from the source run"}</span>}
              {trace?.run_stale && <span className="chip warn" title="the source run is stale against the scenario's current inputs; the award baseline is frozen and unaffected">source run stale</span>}
              {editable && <><input placeholder="change note" value={note} onChange={(e) => setNote(e.target.value)} /><button className="primary" onClick={save}>Save new version</button></>}
              {ws.status === "draft" && can("dpr.edit") && <button className="secondary" onClick={() => setStatus("in_review")}>Send for review</button>}
              {ws.status === "in_review" && can("bid.approve") && <button className="secondary" onClick={() => setStatus("issued")}>Issue</button>}
              {ws.status === "issued" && can("bid.approve") && <button className="link" onClick={() => setStatus("in_review")}>Reopen</button>}
              {can("dpr.edit") && <><button className="secondary" onClick={() => exportAs("docx")}>Export DOCX</button><button className="secondary" onClick={() => exportAs("pdf")}>Export PDF</button></>}
            </div>
            {sections.map((s, i) => (
              <details key={s.key} open={i < 2} className="dpr-section">
                <summary>{s.title}</summary>
                {editable ? <textarea rows={4} value={s.body} onChange={(e) => setSections(sections.map((x) => (x.key === s.key ? { ...x, body: e.target.value } : x)))} /> : <p>{s.body}</p>}
                {s.values.length > 0 && <table className="table"><thead><tr><th>Item</th><th>Value</th><th>Source (run · path)</th><th>Trace</th></tr></thead><tbody>{s.values.map((v) => { const t = trace?.values.find((x) => x.section === s.key && x.key === v.key); return <tr key={v.key}><td>{v.label}</td><td>{fmt(v.value, v.unit)}</td><td className="mono">{v.source.run_id.slice(0, 8)} · {v.source.path}</td><td>{t ? (t.matches ? "✓" : `✗ now ${fmt(t.current, v.unit)}`) : "—"}</td></tr>; })}</tbody></table>}
              </details>
            ))}
          </div>
          <div className="panel-grid">
            <div className="panel"><h4>Versions</h4><ul>{versions.map((v) => <li key={v.id}>v{v.version_no} · {v.created_at.slice(0, 16).replace("T", " ")} · {v.change_note || "—"} {v.changed_sections.length > 0 && <small className="note">({v.changed_sections.join(", ")})</small>}</li>)}</ul></div>
            <div className="panel"><h4>Exports</h4><ul>{artifacts.map((a) => <li key={a.id}><a href={a.download}>{a.filename}</a> · v{a.version_no} · <span className="mono">{a.sha256.slice(0, 10)}</span>{a.linked_workbook_sha256 && <small className="note"> · workbook {a.linked_workbook_sha256.slice(0, 10)}</small>}</li>)}{artifacts.length === 0 && <li className="note">none yet</li>}</ul></div>
          </div>
        </>
      )}
    </section>
  );
}
