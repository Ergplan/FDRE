import React, { useState } from "react";
import { Loader2, Save, X } from "lucide-react";
import { scenarioApi } from "./client";

/**
 * Save the current case. When `linked` (an already saved scenario) is given, the default is a
 * new version of it; "Save as new" creates a separate scenario.
 * build() returns { inputs, results, summary }.
 */
export default function SaveDialog({ module, linked, defaultName, build, onSaved, onClose }) {
  const [mode, setMode] = useState(linked ? "version" : "new");
  const [name, setName] = useState(linked ? `${linked.name} (copy)` : defaultName || "");
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = build();
      if (mode === "version") {
        const res = await scenarioApi.saveVersion(linked.id, { ...payload, note });
        onSaved({ id: linked.id, name: linked.name, version: res.version });
      } else {
        const res = await scenarioApi.create({ ...payload, module, name, description, note: note || "Initial save" });
        onSaved({ id: res.scenario.id, name: res.scenario.name, version: 1 });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <header>
          <h2>Save scenario</h2>
          <button type="button" className="rtc-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        {linked && (
          <div className="seg">
            <button type="button" className={mode === "version" ? "active" : ""} onClick={() => setMode("version")}>New version of “{linked.name}”</button>
            <button type="button" className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>Save as new scenario</button>
          </div>
        )}
        {mode === "new" && (
          <>
            <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
            <label>Description<textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></label>
          </>
        )}
        <label>Version note<input autoFocus={mode === "version"} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" maxLength={500} /></label>
        {error && <div className="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || (mode === "new" && !name.trim())}>
            {busy ? <Loader2 className="spin" size={14} /> : <Save size={14} />} {mode === "version" ? `Save version ${linked.version + 1}` : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
