"use client";
import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Columns3, Download, ExternalLink, Loader2, Search } from "lucide-react";
import { scenarioApi } from "@/src/scenarios/client";
import { formatField, MODULE_LABEL, SUMMARY_FIELDS } from "@/lib/summaryFields";

const COLS = ["solarMw", "windMw", "bessMw", "bessMwh", "capexCr", "tariff", "equityIrr", "dfr"].map((k) => SUMMARY_FIELDS.find((f) => f.key === k));

export function when(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ScenarioLibrary({ initial, initialModule }) {
  const [rows, setRows] = useState(initial);
  const [module, setModule] = useState(initialModule);
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = setTimeout(async () => {
      setBusy(true);
      try {
        const data = await scenarioApi.list({ module, q, archived: archived ? "true" : "" });
        setRows(data.scenarios);
        setError("");
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [module, q, archived]);

  const visible = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const sel = selected.filter((id) => visible.has(id));
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function setArchivedFor(id, value) {
    try {
      await scenarioApi.update(id, { archived: value });
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="seg">
          {[["", "All"], ["rtc", "Round the Clock"], ["fdre", "FDRE"]].map(([v, l]) => (
            <button key={v} type="button" className={module === v ? "active" : ""} onClick={() => setModule(v)}>{l}</button>
          ))}
        </div>
        <label className="search"><Search size={14} /><input placeholder="Search name or description" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="toggle-inline"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived</label>
        {busy && <Loader2 className="spin" size={14} />}
        <div className="toolbar-end">
          <span className="rtc-note">{sel.length} selected</span>
          <a className={`secondary ${sel.length < 2 ? "is-disabled" : ""}`} href={sel.length >= 2 ? `/scenarios/compare?ids=${sel.join(",")}` : undefined} aria-disabled={sel.length < 2}><Columns3 size={14} /> Compare</a>
          <a className={`secondary ${!sel.length ? "is-disabled" : ""}`} href={sel.length ? scenarioApi.exportUrl(sel) : undefined} aria-disabled={!sel.length}><Download size={14} /> Excel</a>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {!rows.length ? (
        <div className="empty-state">
          <h2>{archived ? "No archived scenarios" : "No saved scenarios yet"}</h2>
          <p className="note">Open the dashboard, run a case and press <strong>Save</strong>. Round the Clock has it in the tab bar; FDRE results are saved from the sidebar.</p>
          <a className="primary" href="/">Go to dashboard</a>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="lib">
            <thead>
              <tr>
                <th />
                <th>Scenario</th>
                <th>Module</th>
                <th>Ver.</th>
                {COLS.map((f) => <th key={f.key} className="num">{f.label}<small>{f.unit}</small></th>)}
                <th>Last saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={sel.includes(r.id) ? "selected" : ""}>
                  <td><input type="checkbox" checked={sel.includes(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} /></td>
                  <td className="lib-name">
                    <a href={`/scenarios/${r.id}`}>{r.name}</a>
                    {r.description && <small>{r.description}</small>}
                  </td>
                  <td><span className={`tag tag-${r.module}`}>{MODULE_LABEL[r.module]}</span></td>
                  <td>v{r.version}</td>
                  {COLS.map((f) => <td key={f.key} className="num">{formatField(f, r.summary?.[f.key])}</td>)}
                  <td className="lib-when">{when(r.version_at)}<small>{r.version_by_name || r.version_by_email || ""}</small></td>
                  <td className="lib-actions">
                    <a className="rtc-link" href={`/?open=${r.id}`}><ExternalLink size={12} /> Open</a>
                    <button type="button" className="rtc-link" onClick={() => setArchivedFor(r.id, !archived)} title={archived ? "Restore to the library" : "Archive"}>
                      {archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
