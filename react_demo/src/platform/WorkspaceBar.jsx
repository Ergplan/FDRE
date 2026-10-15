// Organisation, tender and scenario context for the workspace. Loads a scenario's saved
// inputs into the workspace settings, saves them as a new version with the revision the user
// loaded (a 409 is shown as a conflict, never resolved silently), and launches evaluate runs
// through the durable job queue.
import React, { useEffect, useState } from "react";
import { orgApi, ApiError } from "./api";

export default function WorkspaceBar({ me, org, setOrg, settings, setSettings, project, onLogout, onRunLoaded, tenderId, setTenderId, scenario, setScenario }) {
  const api = org ? orgApi(org.id) : null;
  const [tenders, setTenders] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [runs, setRuns] = useState([]);
  const [conflict, setConflict] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [newTender, setNewTender] = useState("");
  const [newScenario, setNewScenario] = useState("");
  const can = (p) => Boolean(org?.permissions?.includes(p));

  useEffect(() => { if (api) api.tenders().then(setTenders).catch((e) => setMessage(e.message)); }, [org?.id]);
  useEffect(() => {
    setScenario(null); setScenarios([]); setRuns([]);
    if (api && tenderId) api.scenarios(tenderId).then(setScenarios).catch((e) => setMessage(e.message));
  }, [tenderId]);
  useEffect(() => {
    if (!api || !scenario) return undefined;
    let cancelled = false;
    const tick = () => api.runs(scenario.id).then((r) => { if (!cancelled) setRuns(r); }).catch(() => {});
    tick();
    const timer = window.setInterval(() => { if (runs.some((r) => ["queued", "running"].includes(r.status))) tick(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [scenario?.id, runs.some((r) => ["queued", "running"].includes(r.status))]);

  async function loadScenario(id) {
    if (!id) { setScenario(null); return; }
    const full = await api.scenario(id);
    setScenario(full);
    setConflict(null);
    const inputs = full.current_input_version?.inputs;
    if (inputs?.settings) setSettings((prev) => ({ ...prev, ...inputs.settings }));
    setMessage(`Loaded "${full.name}" revision ${full.revision} (version ${full.current_input_version?.version_no ?? 0})`);
  }

  function currentInputs() {
    return { settings, project, run_options: { years_mode: settings.yearsMode, use_wind_profile: settings.windProfile, wind_p_level: settings.windLevel } };
  }

  async function save(expectedRevision = scenario.revision) {
    setBusy("save");
    try {
      const saved = await api.saveInputs(scenario.id, expectedRevision, currentInputs());
      setScenario(saved); setConflict(null);
      setMessage(`Saved version ${saved.current_input_version.version_no} (revision ${saved.revision}): ${saved.current_input_version.changed_paths.length} field(s) changed`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(err.body);
      else setMessage(err.message);
    } finally { setBusy(""); }
  }

  async function createTender() {
    const t = await api.createTender({ name: newTender, tender_family: "fdre" });
    setTenders((prev) => [t, ...prev]); setTenderId(t.id); setNewTender("");
  }
  async function createScenario() {
    const s = await api.createScenario(tenderId, { name: newScenario, inputs: currentInputs() });
    setScenarios((prev) => [s, ...prev]); setNewScenario(""); await loadScenario(s.id);
  }
  async function launch(kind) {
    setBusy("run");
    try {
      const run = await api.launchRun(scenario.id, kind, {}, `${scenario.id}:${scenario.current_input_version?.id}:${kind}:${Date.now()}`);
      setRuns((prev) => [run, ...prev]);
      setMessage(`Run ${run.id.slice(0, 8)} queued (job ${run.job?.id.slice(0, 8)})`);
    } catch (err) { setMessage(err.message); } finally { setBusy(""); }
  }
  async function openRun(id) {
    const run = await api.run(id, true);
    if (run.result) { onRunLoaded(run); setMessage(`Showing run ${id.slice(0, 8)} (${run.status}${run.stale ? ", stale" : ""})`); }
  }

  return (
    <div className="workspace-bar">
      <div className="workspace-row">
        <span className="who">{me.email}</span>
        <select value={org?.id || ""} onChange={(e) => setOrg(me.organizations.find((o) => o.id === e.target.value))}>
          {me.organizations.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.role}</option>)}
        </select>
        <select value={tenderId} onChange={(e) => setTenderId(e.target.value)}>
          <option value="">Select tender…</option>
          {tenders.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {can("tender.create") && (
          <span className="inline-create"><input placeholder="New tender name" value={newTender} onChange={(e) => setNewTender(e.target.value)} /><button className="secondary" disabled={!newTender} onClick={createTender}>Create</button></span>
        )}
        <select value={scenario?.id || ""} onChange={(e) => loadScenario(e.target.value)} disabled={!tenderId}>
          <option value="">Select scenario…</option>
          {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name} · rev {s.revision} · {s.status}</option>)}
        </select>
        {tenderId && can("scenario.create") && (
          <span className="inline-create"><input placeholder="New scenario name" value={newScenario} onChange={(e) => setNewScenario(e.target.value)} /><button className="secondary" disabled={!newScenario} onClick={createScenario}>Create</button></span>
        )}
        {scenario && (can("scenario.edit") || can("finance.edit")) && scenario.status === "draft" && (
          <button className="primary" disabled={busy === "save"} onClick={() => save()}>Save inputs (rev {scenario.revision})</button>
        )}
        {scenario && can("run.launch") && <button className="secondary" disabled={busy === "run"} onClick={() => launch("evaluate")}>Queue evaluate run</button>}
        <button className="link" onClick={onLogout}>Sign out</button>
      </div>
      {conflict && (
        <div className="alert conflict">
          <strong>Conflict:</strong> {conflict.message}. Current revision is {conflict.current_revision}; you loaded {scenario.revision}. Your changed fields: {conflict.conflicts?.join(", ") || "none"}.
          <button className="secondary" onClick={() => loadScenario(scenario.id)}>Reload theirs (discard mine)</button>
          <button className="secondary" onClick={() => save(conflict.current_revision)}>Save mine as a new version on top</button>
        </div>
      )}
      {message && <div className="workspace-message">{message}</div>}
      {runs.length > 0 && (
        <div className="run-tray">
          {runs.slice(0, 6).map((r) => (
            <button key={r.id} className={`run-chip ${r.status}${r.stale ? " stale" : ""}`} onClick={() => openRun(r.id)} title={r.stale ? r.stale_reason : r.error || ""}>
              {r.kind} · {r.status}{r.stale ? " · stale" : ""}{r.metrics?.tariff_rs_per_kwh ? ` · Rs ${r.metrics.tariff_rs_per_kwh.toFixed(2)}/kWh` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
