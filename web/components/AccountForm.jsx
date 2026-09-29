"use client";
import { useState } from "react";

export default function AccountForm({ user }) {
  const [name, setName] = useState(user.name || "");
  const [pw, setPw] = useState({ password: "", confirm: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function patch(body, ok) {
    setMsg("");
    setError("");
    const res = await fetch(`/api/users/${user.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setError(data.error || "Update failed.");
    else setMsg(ok);
  }

  return (
    <div className="rtc-grid rtc-grid-2">
      <form className="panel" onSubmit={(e) => { e.preventDefault(); patch({ name }, "Name updated."); }}>
        <header><h2>Profile</h2></header>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="modal-actions"><button type="submit" className="primary">Save</button></div>
      </form>
      <form className="panel" onSubmit={(e) => { e.preventDefault(); if (pw.password !== pw.confirm) { setError("Passwords do not match."); return; } patch({ password: pw.password }, "Password changed."); setPw({ password: "", confirm: "" }); }}>
        <header><h2>Change password</h2></header>
        <label>New password<input type="password" minLength={8} required value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" /></label>
        <label>Confirm<input type="password" minLength={8} required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" /></label>
        <div className="modal-actions"><button type="submit" className="primary">Change password</button></div>
      </form>
      {msg && <div className="loading span-all">{msg}</div>}
      {error && <div className="alert span-all">{error}</div>}
    </div>
  );
}
