// Supply configuration workspace: one vertical isometric energy path per module, generated
// from the module's loss chain (so the picture is the calculation), with inputs attached to
// the component they belong to, gross/net energy and unit labels, provenance, validation
// and completeness indicators, and the reconciliation table that ties every stage to a
// model input. Saved into the scenario as a new input version (revision-checked).
import React, { useEffect, useMemo, useState } from "react";
import { box, iso, panelGrid, route } from "./iso";
import { orgApi, platformApi } from "./api";

const KIND_LABEL = { solar: "Solar PV", wind: "Wind", thermal: "Thermal", biomass: "Biomass", iex: "IEX purchase / sale", bess: "BESS" };
const KIND_COLOR = { solar: "#f6b13c", wind: "#5fa8d3", thermal: "#8d6e63", biomass: "#7cb342", iex: "#9575cd", bess: "#0b7a75" };

function mwh(v) { return v === undefined || v === null ? "—" : `${(v / 1000).toFixed(1)} GWh`; }
function pct(v) { return `${Number(v).toFixed(2)}%`; }

/** Components of the physical path per kind, top (resource) to bottom (POI). */
function components(module) {
  const k = module.kind;
  if (k === "solar") return [{ id: "array", label: "PV array", sub: `${module.mwp_dc} MWp DC`, boundary: "dc_terminals" }, { id: "inverter", label: "Inverters", sub: `${module.mwac} MWac · DC/AC ${(module.mwp_dc / module.mwac).toFixed(2)}`, boundary: "inverter_ac" }, { id: "plant", label: "Plant", sub: "aux + availability", boundary: "plant_boundary" }, { id: "poi", label: "POI", sub: module.node, boundary: "poi" }];
  if (k === "wind") return [{ id: "turbines", label: "Turbines", sub: `${module.installed_mw} MW`, boundary: "generator_terminals" }, { id: "plant", label: "Collection", sub: "electrical + availability", boundary: "plant_boundary" }, { id: "poi", label: "POI", sub: module.node, boundary: "poi" }];
  if (k === "thermal" || k === "biomass") return [{ id: "fuel", label: "Fuel", sub: `${module.fuel?.fuel || ""} ${module.fuel?.calorific_value_kcal_per_kg || ""} kcal/kg`, boundary: "resource" }, { id: "boiler", label: "Boiler / turbine", sub: `${module.heat_rate_kcal_per_kwh ? module.heat_rate_kcal_per_kwh + " kcal/kWh" : module.efficiency_percent + "% eff."}`, boundary: "generator_terminals" }, { id: "unit", label: "Unit", sub: `${module.capacity_mw} MW · MSG ${module.min_stable_generation_percent}%`, boundary: "generator_terminals" }, { id: "aux", label: "Auxiliaries", sub: `${module.auxiliary_consumption_percent}%`, boundary: "plant_boundary" }, { id: "poi", label: "POI", sub: module.node, boundary: "poi" }];
  if (k === "bess") return [{ id: "cells", label: "Cells", sub: `${module.energy_mwh} MWh · usable ${(module.energy_mwh * (module.soc_max_percent - module.soc_min_percent) / 100).toFixed(0)} MWh`, boundary: "dc_terminals" }, { id: "pcs", label: "PCS", sub: `${module.power_mw} MW · RTE ${(module.charge_efficiency_percent * module.discharge_efficiency_percent / 100).toFixed(1)}%`, boundary: "inverter_ac" }, { id: "aux", label: "HVAC + controls", sub: `${module.auxiliary_load_kw} kW`, boundary: "plant_boundary" }, { id: "poi", label: "POI", sub: module.node, boundary: "poi" }];
  if (k === "iex") return [{ id: "purchase", label: "Exchange purchase", sub: `${module.purchase_limit_mw} MW limit`, boundary: "resource" }, { id: "delivery", label: "Delivery", sub: `${module.delivery_loss_percent}% losses`, boundary: "poi" }, { id: "sale", label: "Exchange sale", sub: `${module.sale_limit_mw} MW limit`, boundary: "poi" }];
  return [];
}

/** The vertical isometric diagram: one box per component stacked top to bottom, flows between
 * them sized by the energy leaving each stage; loss stages drawn as side arrows at the
 * boundary they belong to. */
function IsoPath({ module, reconciliation, selected, onSelect }) {
  const comps = components(module);
  const rows = reconciliation?.rows || [];
  const width = 520;
  const stepY = 92;
  const height = comps.length * stepY + 60;
  const ox = 230;
  const gross = reconciliation?.gross_mwh || 1;
  const color = KIND_COLOR[module.kind];
  const energyAt = (boundary) => {
    const idx = rows.map((r) => r.boundary).lastIndexOf(boundary);
    return idx >= 0 ? rows[idx].energy_out_mwh : reconciliation?.gross_mwh;
  };
  return (
    <svg className="iso-path" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
      {comps.map((c, i) => {
        const oy = 40 + i * stepY;
        const b = box(0, 0, 3, 2, 1, 0, ox, oy);
        const isSel = selected === c.id;
        const e = energyAt(c.boundary);
        const flow = Math.max(2, 14 * (e || 0) / gross);
        return (
          <g key={c.id} onClick={() => onSelect(c.id)} style={{ cursor: "pointer" }}>
            {i < comps.length - 1 && <path d={route([[1.5, 1], [1.5, 1]], 0, ox, oy) + ` L ${iso(1.5, 1, 0, ox, oy + stepY)[0]} ${iso(1.5, 1, 1, ox, oy + stepY)[1]}`} stroke={color} strokeWidth={flow} fill="none" opacity="0.7" />}
            {module.kind === "solar" && c.id === "array" && panelGrid({ x: 0.15, y: 0.15, cols: 3, rows: 2, w: 0.8, d: 0.7, gap: 0.12, z: 1.02, ox, oy }).map((d, j) => <path key={j} d={d} fill="#1f3a5f" stroke="#fff" strokeWidth="0.5" />)}
            <path d={b.left} fill={isSel ? "#0b7a75" : "#c9d9d3"} />
            <path d={b.right} fill={isSel ? "#09605c" : "#a9c3bb"} />
            <path d={b.top} fill={isSel ? "#63b4ae" : color} fillOpacity={module.kind === "solar" && c.id === "array" ? 0.35 : 0.9} stroke="#15201e" strokeWidth="0.6" />
            <text x={ox + 110} y={oy + 8} className="iso-label"><tspan fontWeight="700">{c.label}</tspan> <tspan fill="#4a6660">{c.sub}</tspan></text>
            <text x={ox + 110} y={oy + 24} className="iso-energy">{mwh(e)} / year</text>
            {rows.filter((r) => r.boundary === c.boundary).map((r, j) => (
              <g key={r.key}>
                <path d={`M ${ox - 10} ${oy + 30 + j * 14} l -34 0`} stroke={r.applied ? "#c0392b" : "#9aa"} strokeWidth="2" strokeDasharray={r.applied ? "" : "3 3"} markerEnd="url(#loss-arrow)" />
                <text x={ox - 48} y={oy + 34 + j * 14} textAnchor="end" className={`iso-loss${r.applied ? "" : " muted"}`}>{r.label}: {r.kind === "fixed_mw" ? `${r.value} MW` : pct(r.value)}{r.applied ? "" : " (in profile)"}</text>
              </g>
            ))}
          </g>
        );
      })}
      <defs><marker id="loss-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#c0392b" /></marker></defs>
    </svg>
  );
}

function Field({ meta, module, onChange, provenance }) {
  const parts = meta.field.split(".");
  let value = module;
  for (const p of parts) value = value?.[p];
  const type = typeof value === "boolean" ? "checkbox" : "number";
  function set(v) {
    const next = JSON.parse(JSON.stringify(module));
    let node = next;
    for (const p of parts.slice(0, -1)) node = node[p];
    node[parts[parts.length - 1]] = v;
    onChange(next);
  }
  return (
    <label className="supply-field">
      <span>{meta.label}{meta.unit ? <small> ({meta.unit})</small> : null}</span>
      {type === "checkbox" ? <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} /> : typeof value === "string" ? <input value={value} onChange={(e) => set(e.target.value)} /> : <input type="number" step="any" value={value ?? ""} onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))} />}
      {provenance && <small className={`chip prov-${provenance}`}>{provenance}</small>}
    </label>
  );
}

export default function SupplyTab({ org, scenarioId, scenarioRevision, onSaved }) {
  const api = org ? orgApi(org.id) : null;
  const can = (p) => Boolean(org?.permissions?.includes(p));
  const [schema, setSchema] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [config, setConfig] = useState({ nodes: [{ name: "POI", interconnection_limit_mw: 300 }], modules: [], time_resolution_minutes: 60 });
  const [revision, setRevision] = useState(scenarioRevision);
  const [validation, setValidation] = useState(null);
  const [selected, setSelected] = useState({ module: null, component: null });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [profileForm, setProfileForm] = useState({ name: "", technology: "solar", capacity_basis: "mwac", capacity_mw: "", measured_at: "inverter_ac", timezone: "Asia/Kolkata", p_level: "P50", source: "" });

  useEffect(() => {
    if (!api) return;
    platformApi(`/orgs/${org.id}/supply/schema`).then(setSchema).catch((e) => setMessage(e.message));
    platformApi(`/orgs/${org.id}/profiles`).then(setProfiles).catch(() => {});
  }, [org?.id]);
  useEffect(() => {
    if (!api || !scenarioId) return;
    platformApi(`/orgs/${org.id}/scenarios/${scenarioId}/supply`).then((r) => { setRevision(r.revision); if (r.supply) { setConfig(r.supply); setValidation(r.validation); } }).catch((e) => setMessage(e.message));
  }, [org?.id, scenarioId]);

  async function validate(next = config) {
    setBusy("validate");
    try { const v = await platformApi(`/orgs/${org.id}/supply/validate`, { method: "POST", body: { supply: next } }); setValidation(v); return v; } catch (err) { setMessage(err.message); return null; } finally { setBusy(""); }
  }
  async function addModule(kind) {
    const id = `${kind}_${Date.now().toString(36)}`;
    const tpl = await platformApi(`/orgs/${org.id}/supply/template/${kind}?name=${encodeURIComponent(KIND_LABEL[kind] + " " + (config.modules.filter((m) => m.kind === kind).length + 1))}&module_id=${id}`);
    const next = { ...config, modules: [...config.modules, tpl] };
    setConfig(next); setSelected({ module: id, component: null }); await validate(next);
  }
  function updateModule(mod) {
    const next = { ...config, modules: config.modules.map((m) => (m.id === mod.id ? mod : m)) };
    setConfig(next);
  }
  function removeModule(id) { const next = { ...config, modules: config.modules.filter((m) => m.id !== id) }; setConfig(next); validate(next); }
  async function save() {
    setBusy("save");
    try {
      const out = await platformApi(`/orgs/${org.id}/scenarios/${scenarioId}/supply`, { method: "PUT", body: { expected_revision: revision, supply: config, note: "supply configuration" } });
      setRevision(out.scenario.revision); setValidation(out.validation);
      setMessage(`Saved as input version (revision ${out.scenario.revision}); ${out.validation.unsupported.length} module(s) wait for the MILP formulation`);
      onSaved?.(out.scenario);
    } catch (err) { setMessage(err.status === 409 ? `Conflict: the scenario is at revision ${err.body?.current_revision}; reload before saving` : err.message); } finally { setBusy(""); }
  }
  async function uploadProfile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy("profile");
    try {
      const form = new FormData();
      form.append("file", file);
      Object.entries(profileForm).forEach(([k, v]) => { if (v !== "" && v !== null) form.append(k, v); });
      if (!profileForm.name) form.append("name", file.name);
      const res = await fetch(`/api/v1/orgs/${org.id}/profiles`, { method: "POST", body: form, credentials: "include" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      setProfiles((prev) => [body.profile, ...prev.filter((p) => p.id !== body.profile.id)]);
      setMessage(`Profile ${body.profile.name}: CUF ${(body.profile.stats.cuf * 100).toFixed(2)}% on ${body.profile.capacity_mw || "?"} MW (${body.profile.capacity_basis || "cf"}), ${body.profile.resolution_minutes}-min, ${body.profile.timezone}; hash ${body.profile.sha256.slice(0, 10)}${body.report.warnings?.length ? "; warnings: " + body.report.warnings.join("; ") : ""}`);
    } catch (err) { setMessage(err.message); } finally { setBusy(""); event.target.value = ""; }
  }

  const recs = useMemo(() => Object.fromEntries((validation?.reconciliations || []).map((r) => [r.module_id, r])), [validation]);
  const current = config.modules.find((m) => m.id === selected.module) || config.modules[0];
  const meta = schema?.fields?.[current?.kind] || [];
  const comp = selected.component;
  const compMeta = comp ? meta.filter((f) => f.component === comp) : meta;
  const rec = current ? recs[current.id] : null;
  const completeness = validation?.completeness?.[current?.id];
  const totals = (validation?.reconciliations || []).reduce((a, r) => ({ gross: a.gross + r.gross_mwh, net: a.net + r.net_mwh }), { gross: 0, net: 0 });

  if (!scenarioId) return <section className="panel"><p className="note">Select a scenario in the workspace bar; supply modules are saved into it as input versions.</p></section>;
  return (
    <section className="supply">
      <div className="supply-head">
        <h2>Supply configuration</h2>
        <span className="chip">scenario revision {revision}</span>
        {validation && <span className={`chip ${validation.ok ? "accepted" : "warn"}`}>{validation.ok ? "valid" : `${validation.errors.length + validation.schema_errors.length} issue(s)`}</span>}
        {validation && <span className="chip">gross {mwh(totals.gross)} → net {mwh(totals.net)}</span>}
        <div className="spacer" />
        {Object.keys(KIND_LABEL).map((k) => <button key={k} className="secondary" onClick={() => addModule(k)} disabled={!can("scenario.edit")}>+ {KIND_LABEL[k]}</button>)}
        <button className="secondary" onClick={() => validate()} disabled={busy === "validate"}>Validate</button>
        <button className="primary" onClick={save} disabled={busy === "save" || !can("scenario.edit") || (validation && !validation.ok)}>Save as input version</button>
      </div>
      {message && <div className="workspace-message">{message}</div>}
      {validation && (validation.errors.length > 0 || validation.schema_errors.length > 0) && <div className="alert">{[...validation.schema_errors, ...validation.errors].map((e, i) => <div key={i}>{e}</div>)}</div>}
      <div className="supply-grid">
        <aside className="module-list">
          {config.modules.map((m) => {
            const c = validation?.completeness?.[m.id];
            const r = recs[m.id];
            return (
              <button key={m.id} className={`module-card${current?.id === m.id ? " active" : ""}`} onClick={() => setSelected({ module: m.id, component: null })} style={{ borderLeftColor: KIND_COLOR[m.kind] }}>
                <strong>{m.name}</strong> <small>{KIND_LABEL[m.kind]}</small>
                <div className="indicators">
                  {c && <span className={`chip ${c.score >= 1 ? "accepted" : "warn"}`} title={`missing: ${c.missing.join(", ") || "none"}`}>complete {Math.round(c.score * 100)}%</span>}
                  {c && c.defaulted_losses.length > 0 && <span className="chip warn" title={c.defaulted_losses.join(", ")}>{c.defaulted_losses.length} defaulted</span>}
                  {r && <span className={`chip ${r.errors.length ? "rejected" : "accepted"}`}>{r.errors.length ? "invalid" : r.closes ? "reconciles" : "gap"}</span>}
                  {c && <span className="chip">{c.profile}</span>}
                </div>
              </button>
            );
          })}
          {config.modules.length === 0 && <p className="note">Add a module to begin.</p>}
          <div className="profile-upload">
            <h4>Profiles</h4>
            <ul>{profiles.slice(0, 8).map((p) => <li key={p.id}><strong>{p.name}</strong> <small>{p.technology} · CUF {(p.stats.cuf * 100).toFixed(1)}% on {p.capacity_mw ?? "?"} {p.capacity_basis} · {p.resolution_minutes} min · {p.timezone} · {p.p_level || ""}</small></li>)}</ul>
            <div className="profile-form">
              <select value={profileForm.technology} onChange={(e) => setProfileForm({ ...profileForm, technology: e.target.value })}><option value="solar">solar</option><option value="wind">wind</option></select>
              <select value={profileForm.capacity_basis} onChange={(e) => setProfileForm({ ...profileForm, capacity_basis: e.target.value })}><option value="mwac">MWac</option><option value="mwp_dc">MWp DC</option><option value="installed_mw">installed MW</option></select>
              <input placeholder="capacity MW" value={profileForm.capacity_mw} onChange={(e) => setProfileForm({ ...profileForm, capacity_mw: e.target.value })} />
              <select value={profileForm.measured_at} onChange={(e) => setProfileForm({ ...profileForm, measured_at: e.target.value })}><option value="dc_terminals">DC terminals</option><option value="generator_terminals">generator terminals</option><option value="inverter_ac">inverter AC</option><option value="plant_boundary">plant boundary</option><option value="poi">POI</option></select>
              <input placeholder="timezone" value={profileForm.timezone} onChange={(e) => setProfileForm({ ...profileForm, timezone: e.target.value })} />
              <select value={profileForm.p_level} onChange={(e) => setProfileForm({ ...profileForm, p_level: e.target.value })}>{["P50", "P75", "P90", "P99"].map((p) => <option key={p}>{p}</option>)}</select>
              <input placeholder="source (report, vendor)" value={profileForm.source} onChange={(e) => setProfileForm({ ...profileForm, source: e.target.value })} />
              <label className="secondary file-button">{busy === "profile" ? "Uploading…" : "Upload CSV"}<input type="file" accept=".csv,text/csv" onChange={uploadProfile} hidden /></label>
            </div>
          </div>
        </aside>
        {current && (
          <div className="module-detail">
            <div className="module-title">
              <h3>{current.name} <small>{KIND_LABEL[current.kind]}</small></h3>
              <input value={current.name} onChange={(e) => updateModule({ ...current, name: e.target.value })} />
              <select value={current.node} onChange={(e) => updateModule({ ...current, node: e.target.value })}>{config.nodes.map((n) => <option key={n.name}>{n.name}</option>)}</select>
              <button className="link" onClick={() => removeModule(current.id)}>Remove</button>
            </div>
            <div className="module-body">
              <IsoPath module={current} reconciliation={rec} selected={comp} onSelect={(c) => setSelected({ module: current.id, component: c })} />
              <div className="module-inputs">
                <h4>{comp ? `Inputs on ${comp}` : "All inputs"} {comp && <button className="link" onClick={() => setSelected({ module: current.id, component: null })}>show all</button>}</h4>
                {compMeta.map((f) => <Field key={f.field} meta={f} module={current} onChange={updateModule} provenance={current.provenance?.kind} />)}
                {(current.kind === "solar" || current.kind === "wind") && (!comp || comp === "array" || comp === "turbines") && (
                  <div className="profile-pick">
                    <label>Profile<select value={current.profile?.profile_id || ""} onChange={(e) => { const p = profiles.find((x) => x.id === e.target.value); updateModule({ ...current, profile: { ...current.profile, profile_id: p ? p.id : null, capacity_basis: p ? p.capacity_basis : current.profile.capacity_basis, capacity_mw: p ? p.capacity_mw : current.profile.capacity_mw, measured_at: p ? p.measured_at || current.profile.measured_at : current.profile.measured_at, synthetic_cuf_percent: p ? null : (current.profile.synthetic_cuf_percent ?? 24), provenance: p ? { kind: "measured", source: p.provenance?.source || p.name } : { kind: "defaulted", source: "synthetic profile" } } }); }}>
                      <option value="">Synthetic from CUF</option>{profiles.filter((p) => p.technology === current.kind).map((p) => <option key={p.id} value={p.id}>{p.name} (CUF {(p.stats.cuf * 100).toFixed(1)}% on {p.capacity_mw} {p.capacity_basis})</option>)}
                    </select></label>
                    {!current.profile?.profile_id && <label>Synthetic CUF (% on {current.profile?.capacity_basis})<input type="number" step="0.1" value={current.profile?.synthetic_cuf_percent ?? ""} onChange={(e) => updateModule({ ...current, profile: { ...current.profile, synthetic_cuf_percent: Number(e.target.value) } })} /></label>}
                    <small className="chip">CUF basis: {current.profile?.capacity_basis} {current.profile?.capacity_mw ?? ""} MW, measured at {current.profile?.measured_at}</small>
                  </div>
                )}
                <h4>Loss chain</h4>
                <table className="table loss-table"><thead><tr><th>Stage</th><th>Value</th><th>Boundary</th><th>Basis</th><th>In profile</th><th>Model input</th><th>Provenance</th></tr></thead>
                  <tbody>{current.losses.map((s, i) => (
                    <tr key={s.key} className={comp && components(current).find((c) => c.id === comp)?.boundary === s.boundary ? "highlight" : ""}>
                      <td>{s.label}<br /><small className="mono">{s.key}</small></td>
                      <td><input type="number" step="any" value={s.value} onChange={(e) => { const losses = current.losses.map((x, j) => (j === i ? { ...x, value: Number(e.target.value), provenance: { ...x.provenance, kind: "user_entered" } } : x)); updateModule({ ...current, losses }); }} /> {s.unit === "MW" ? "MW" : "%"}</td>
                      <td>{s.boundary}</td><td>{s.time_basis}</td>
                      <td><input type="checkbox" checked={Boolean(s.included_in_profile)} onChange={(e) => { const losses = current.losses.map((x, j) => (j === i ? { ...x, included_in_profile: e.target.checked } : x)); updateModule({ ...current, losses }); }} /></td>
                      <td className="mono">{s.model_input}</td>
                      <td><span className={`chip prov-${s.provenance?.kind}`}>{s.provenance?.kind}</span> <small>{s.provenance?.source}</small></td>
                    </tr>
                  ))}</tbody></table>
                {rec && (
                  <>
                    <h4>Energy reconciliation ({rec.capacity_mw} MW on {rec.capacity_basis}; CUF gross {(rec.cuf_gross * 100).toFixed(2)}% → net {(rec.cuf_net_on_basis * 100).toFixed(2)}%)</h4>
                    <table className="table"><thead><tr><th>Stage</th><th>In (MWh)</th><th>Loss (MWh)</th><th>Out (MWh)</th><th>Applied</th></tr></thead>
                      <tbody>
                        <tr><td>Gross at {rec.capacity_basis}</td><td></td><td></td><td>{rec.gross_mwh.toFixed(0)}</td><td></td></tr>
                        {rec.rows.map((r) => <tr key={r.key}><td>{r.label}</td><td>{r.energy_in_mwh.toFixed(0)}</td><td>{r.loss_mwh.toFixed(0)}</td><td>{r.energy_out_mwh.toFixed(0)}</td><td>{r.applied ? "yes" : r.reason}</td></tr>)}
                        <tr><td><strong>Net at POI</strong></td><td></td><td>{(rec.gross_mwh - rec.net_mwh).toFixed(0)}</td><td><strong>{rec.net_mwh.toFixed(0)}</strong></td><td>{rec.closes ? "closes" : "does not close"}</td></tr>
                      </tbody></table>
                  </>
                )}
                {validation?.unsupported?.some((u) => u.module_id === current.id) && <div className="alert">{validation.unsupported.find((u) => u.module_id === current.id).reason}</div>}
                {completeness && completeness.missing.length > 0 && <p className="note">Missing: {completeness.missing.join(", ")}</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
