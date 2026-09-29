"use client";
import { useState } from "react";
import { Archive, ArchiveRestore, Download, ExternalLink, History, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { scenarioApi } from "@/src/scenarios/client";
import { fieldsFor, formatField } from "@/lib/summaryFields";
import { when } from "./ScenarioLibrary";

export default function ScenarioDetail({ data }) {
  const { scenario, versions, current } = data;
  const [meta, setMeta] = useState({ name: scenario.name, description: scenario.description, archived: scenario.archived });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fields = fieldsFor([current.summary]);
  const latest = versions[0]?.version;

  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <a className="primary" href={`/?open=${scenario.id}&v=${current.version}`}><ExternalLink size={14} /> Open v{current.version} in dashboard</a>
        <a className="secondary" href={scenarioApi.exportUrl([scenario.id], current.version)}><Download size={14} /> Excel</a>
        <button type="button" className="secondary" onClick={() => setEditing(!editing)}><Pencil size={14} /> Rename</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run(async () => { await scenarioApi.update(scenario.id, { archived: !meta.archived }); setMeta({ ...meta, archived: !meta.archived }); })}>
          {meta.archived ? <><ArchiveRestore size={14} /> Unarchive</> : <><Archive size={14} /> Archive</>}
        </button>
        <button type="button" className="secondary danger" disabled={busy} onClick={() => {
          if (!window.confirm(`Delete “${meta.name}” and all ${versions.length} versions? This cannot be undone.`)) return;
          run(async () => { await scenarioApi.remove(scenario.id); window.location.href = "/scenarios"; });
        }}><Trash2 size={14} /> Delete</button>
      </div>
      {error && <div className="alert">{error}</div>}
      {editing && (
        <form className="panel edit-meta" onSubmit={(e) => { e.preventDefault(); run(async () => { await scenarioApi.update(scenario.id, { name: meta.name, description: meta.description }); setEditing(false); window.location.reload(); }); }}>
          <label>Name<input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} required /></label>
          <label>Description<textarea rows={2} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></label>
          <div className="modal-actions"><button type="submit" className="primary" disabled={busy}>Save</button></div>
        </form>
      )}
      {meta.description && !editing && <p className="lead">{meta.description}</p>}

      <div className="detail-grid">
        <section className="rtc-section">
          <header><div><span className="rtc-index">v{current.version}</span><h2>Results</h2></div><span className="rtc-note">{current.version !== latest ? `Viewing an earlier version (latest is v${latest})` : "Latest version"}</span></header>
          <div className="rtc-stats flush-top">
            {fields.map((f) => (
              <div key={f.key} className="rtc-stat"><span>{f.label}</span><strong>{formatField(f, current.summary[f.key])}</strong><small>{f.unit}</small></div>
            ))}
          </div>
        </section>
        <section className="rtc-section">
          <header><div><History size={14} /><h2>Version history</h2></div><span className="rtc-note">Restoring copies an old version into a new one; nothing is overwritten.</span></header>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ver.</th><th>Saved</th><th>By</th><th>Note</th><th /></tr></thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version} className={v.version === current.version ? "selected" : ""}>
                    <td>v{v.version}</td>
                    <td>{when(v.created_at)}</td>
                    <td>{v.created_by_name || v.created_by_email || "–"}</td>
                    <td className="wrap">{v.note || "–"}</td>
                    <td className="lib-actions">
                      <a className="rtc-link" href={`/scenarios/${scenario.id}?v=${v.version}`}>View</a>
                      <a className="rtc-link" href={`/?open=${scenario.id}&v=${v.version}`}>Open</a>
                      {v.version !== latest && (
                        <button type="button" className="rtc-link" disabled={busy} onClick={() => run(async () => { const r = await scenarioApi.restore(scenario.id, v.version); window.location.href = `/scenarios/${scenario.id}?v=${r.version}`; })}>
                          <RotateCcw size={12} /> Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
