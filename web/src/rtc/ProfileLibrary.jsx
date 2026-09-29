import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, Download, Loader2, Save, Trash2, Upload, XCircle } from "lucide-react";
import * as E from "./engine";
import { LockButton, downloadText, nf, pf } from "./ui";

const QUALITY = {
  validated: { label: "Validated", icon: CheckCircle2, cls: "q-good" },
  suspect: { label: "Use with care", icon: AlertTriangle, cls: "q-warn" },
  rejected: { label: "Rejected", icon: XCircle, cls: "q-bad" },
};

function QualityBadge({ quality }) {
  const q = QUALITY[quality] || QUALITY.validated;
  const Icon = q.icon;
  return <span className={`q-badge ${q.cls}`}><Icon size={11} /> {q.label}</span>;
}

function MonthBars({ values, color }) {
  if (!values?.length) return null;
  const max = Math.max(...values, 0.01);
  return (
    <svg viewBox="0 0 120 28" className="month-bars" aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * 26);
        return <rect key={i} x={i * 10 + 1} y={28 - h} width={8} height={h} fill={color} opacity={0.85} />;
      })}
    </svg>
  );
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: opts.body ? { "Content-Type": "application/json" } : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Choose the wind or solar profile for the case: the shared library (built-in measured
 * profiles and team uploads), the synthetic site profile, or a new upload that can be saved
 * to the library.
 */
export default function ProfileLibrary({ kind, state, set, lockProps, isLocked, color, user }) {
  const [tab, setTab] = useState("library");
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const [saveName, setSaveName] = useState("");
  const [saveSite, setSaveSite] = useState("");
  const fileRef = useRef(null);
  const lockKey = `${kind}Profile`;
  const locked = isLocked(lockKey);
  const current = state[`${kind}Upload`];
  const label = kind === "wind" ? "wind" : "solar";

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/profiles?kind=${kind}`);
      setItems(data.profiles);
    } catch (err) {
      setItems([]);
      setError(`Profile library unavailable: ${err.message}`);
    }
  }, [kind]);
  useEffect(() => { load(); }, [load]);

  function applyProfile(p) {
    set(`${kind}Upload`, p);
    set(`${kind}MonthScale`, new Array(12).fill(1));
  }

  async function useLibrary(item) {
    setBusy(item.id);
    setError("");
    try {
      const { profile } = await api(`/api/profiles/${item.id}`);
      applyProfile({
        id: profile.id,
        source: "library",
        name: profile.name,
        quality: profile.quality,
        note: `${profile.site || profile.region || "library"} · CUF ${pf(profile.cuf, 1)} · ${pf(profile.coverage ?? 1, 0)} of hours measured`,
        values: profile.vals,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function onFile(file) {
    setError("");
    setPreview(null);
    try {
      const text = await file.text();
      const parsed = E.parseAnyProfile(text, { kind: "cf", referenceMw: state[`${kind}RefMw`] || null });
      setPreview({ ...parsed, fileName: file.name });
      setSaveName(parsed.name || file.name.replace(/\.[^.]+$/, ""));
      setSaveSite("");
    } catch (err) {
      setError(`${file.name}: ${err.message}`);
    }
  }

  function usePreview() {
    applyProfile({
      source: "upload",
      name: preview.name || preview.fileName,
      quality: preview.quality,
      note: preview.note || `CUF ${pf(preview.cuf, 1)}`,
      values: Array.from(preview.values, (v) => Math.round(v * 1e5) / 1e5),
    });
  }

  async function savePreview() {
    setBusy("save");
    setError("");
    try {
      const { profile } = await api("/api/profiles", {
        method: "POST",
        body: JSON.stringify({
          kind,
          name: saveName,
          site: saveSite,
          source: `Uploaded file ${preview.fileName}${preview.capacitySource ? ` · capacity ${preview.capacitySource}` : ""}`,
          capacityMw: preview.capacityMw ?? null,
          from: preview.from ?? null,
          to: preview.to ?? null,
          coverage: preview.coverage ?? 1,
          quality: preview.quality,
          issues: preview.issues || [],
          values: Array.from(preview.values),
        }),
      });
      await load();
      applyProfile({ id: profile.id, source: "library", name: profile.name, quality: profile.quality, note: `${profile.site || "uploaded"} · CUF ${pf(profile.cuf, 1)}`, values: Array.from(preview.values, (v) => Math.round(v * 1e4) / 1e4) });
      setPreview(null);
      setTab("library");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function remove(item) {
    if (!window.confirm(`Remove “${item.name}” from the ${label} profile library for everyone?`)) return;
    setBusy(item.id);
    try {
      await api(`/api/profiles/${item.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const canDelete = (it) => user && (user.role === "admin" || (!it.seed_key && it.created_by === user.id));
  const inUse = (it) => current?.id === it.id;
  const synthetic = !current;

  return (
    <div className="profile-lib" style={{ "--chapter": color }}>
      <div className="chapter-toolbar">
        <div className="seg">
          <button type="button" className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}><Database size={12} /> Library{items ? ` (${items.filter((i) => i.quality !== "rejected").length})` : ""}</button>
          <button type="button" className={tab === "upload" ? "active" : ""} onClick={() => setTab("upload")}><Upload size={12} /> Upload file</button>
        </div>
        <div className="chapter-toolbar-end">
          <span className="rtc-note">In use: <b>{current ? current.name : `Synthetic ${E.BEED_SITE.name}`}</b>{current?.quality && current.quality !== "validated" ? " · use with care" : ""}</span>
          <LockButton locked={locked} onToggle={() => lockProps(lockKey).onLock()} title={`Lock the ${label} profile`} />
        </div>
      </div>
      {error && <div className="alert">{error}</div>}

      {tab === "library" && (
        <div className="table-wrap">
          <table className="profile-table">
            <thead>
              <tr><th>Profile</th><th>Quality</th><th className="num">CUF</th><th>Monthly CUF</th><th className="num">Measured</th><th>Period</th><th className="num">Plant MW</th><th /></tr>
            </thead>
            <tbody>
              <tr className={synthetic ? "selected" : ""}>
                <td><strong>Synthetic {E.BEED_SITE.name}</strong><small>Modelled profile tuned to the CUF you set above</small></td>
                <td><span className="q-badge q-model">Model</span></td>
                <td className="num">{pf(kind === "wind" ? state.inputs.windCuf : state.inputs.solarCuf, 1)}</td>
                <td />
                <td className="num">–</td>
                <td>–</td>
                <td className="num">–</td>
                <td className="lib-actions">{synthetic ? <span className="pill pass">in use</span> : <button type="button" className="rtc-link" disabled={locked} onClick={() => applyProfile(null)}>Use</button>}</td>
              </tr>
              {items === null && <tr><td colSpan={8}><Loader2 className="spin" size={14} /> Loading library…</td></tr>}
              {items?.map((it) => (
                <tr key={it.id} className={`${inUse(it) ? "selected" : ""} ${it.quality === "rejected" ? "row-rejected" : ""}`}>
                  <td>
                    <strong>{it.name}</strong>
                    <small>{[it.site, it.region].filter(Boolean).join(" · ")}{it.seed_key ? " · built-in" : it.created_by_name || it.created_by_email ? ` · uploaded by ${it.created_by_name || it.created_by_email}` : ""}</small>
                    {it.issues?.length > 0 && <small className={it.quality === "rejected" ? "issue-bad" : "issue-warn"}>{it.issues.join("; ")}</small>}
                  </td>
                  <td><QualityBadge quality={it.quality} /></td>
                  <td className="num">{pf(it.cuf, 1)}</td>
                  <td><MonthBars values={it.monthly_cuf} color={color} /></td>
                  <td className="num">{it.coverage != null ? pf(it.coverage, 0) : "–"}</td>
                  <td>{it.period_from ? `${it.period_from} → ${it.period_to}` : "–"}</td>
                  <td className="num">{it.capacity_mw ? nf(it.capacity_mw, 1) : "–"}</td>
                  <td className="lib-actions">
                    {inUse(it) ? <span className="pill pass">in use</span> : (
                      <button type="button" className="rtc-link" disabled={locked || it.quality === "rejected" || busy === it.id} title={it.quality === "rejected" ? "Rejected: the data failed quality checks" : undefined} onClick={() => useLibrary(it)}>
                        {busy === it.id ? <Loader2 className="spin" size={12} /> : "Use"}
                      </button>
                    )}
                    {canDelete(it) && <button type="button" className="rtc-link danger" title="Remove from library" onClick={() => remove(it)}><Trash2 size={12} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "upload" && (
        <div className="upload-pane">
          <div className="upload-drop-row">
            <button type="button" className="secondary" disabled={locked} onClick={() => fileRef.current?.click()}><Upload size={14} /> Choose CSV</button>
            <input ref={fileRef} type="file" accept=".csv,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
            <button type="button" className="secondary" onClick={() => downloadText(`rtc_${kind}_template.csv`, E.profileTemplateCsv(kind))}><Download size={14} /> 8760 template</button>
            <p className="rtc-note">
              Accepted: SCADA / meter exports with a date column (15-min or hourly, even part of a year: e.g. SLDC/RLDC blockwise “Actual Generation (MW)”), or a plain 8760 / 35040 list of capacity factors or MW.
              Plant capacity comes from the CUF column, the reference MW above, or the output peak.
            </p>
          </div>
          {preview && (
            <div className="upload-preview">
              <div className="upload-preview-head">
                <div>
                  <strong>{preview.name || preview.fileName}</strong>
                  <small>{preview.fileName}</small>
                </div>
                <QualityBadge quality={preview.quality} />
              </div>
              <div className="upload-preview-stats">
                <div><span>CUF</span><b>{pf(preview.cuf, 1)}</b></div>
                <div><span>Measured hours</span><b>{pf(preview.coverage ?? 1, 0)}</b></div>
                <div><span>Plant capacity</span><b>{preview.capacityMw ? `${nf(preview.capacityMw, 1)} MW` : "n/a"}</b><small>{preview.capacitySource || ""}</small></div>
                <div><span>Period</span><b>{preview.from ? `${preview.from} → ${preview.to}` : "8760 list"}</b></div>
                <div><span>Monthly CUF</span><MonthBars values={preview.monthlyCuf} color={color} /></div>
              </div>
              {preview.issues?.length > 0 && <ul className="upload-issues">{preview.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              {preview.negativeShare > 0 && <p className="rtc-note">{pf(preview.negativeShare, 1)} of readings were negative (auxiliary consumption) and set to zero; {preview.filledHours ? `${nf(preview.filledHours)} hours without data were filled with the same month and hour average.` : ""}</p>}
              <div className="upload-save">
                <label>Library name<input value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={200} /></label>
                <label>Site<input value={saveSite} onChange={(e) => setSaveSite(e.target.value)} placeholder="e.g. Patoda, Beed" maxLength={200} /></label>
                <button type="button" className="secondary" disabled={locked || preview.quality === "rejected"} onClick={usePreview}>Use for this case</button>
                <button type="button" className="primary" disabled={locked || preview.quality === "rejected" || !saveName.trim() || busy === "save"} onClick={savePreview}>
                  {busy === "save" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save to library & use
                </button>
              </div>
              {preview.quality === "rejected" && <p className="issue-bad">This file failed the quality checks and cannot be used. Check the capacity (reference MW) or the units and upload again.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
