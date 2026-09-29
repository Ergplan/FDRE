"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";

/** Sign-in and first-run administrator forms. */
export default function AuthForm({ mode = "login", next = "/" }) {
  const setup = mode === "setup";
  const [form, setForm] = useState({ email: "", name: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (setup && form.password !== form.confirm) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const res = await fetch(setup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email, name: form.name, password: form.password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sign-in failed.");
      window.location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-art">
        <div className="eyebrow">FDRE · Hybrid RE optimization</div>
        <h1>{setup ? <>Set up<br />workspace</> : <>Round<br />the clock</>}</h1>
        <p>Solar, wind and storage sizing, hourly dispatch and 25-year project finance, with every saved result kept for your team.</p>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <h2>{setup ? "Create the administrator" : "Sign in"}</h2>
        {setup && <p className="note">No users exist yet. This account can add colleagues afterwards.</p>}
        {setup && <label>Name<input value={form.name} onChange={set("name")} autoComplete="name" /></label>}
        <label>Email<input type="email" value={form.email} onChange={set("email")} required autoFocus autoComplete="username" /></label>
        <label>Password<input type="password" value={form.password} onChange={set("password")} required minLength={setup ? 8 : 1} autoComplete={setup ? "new-password" : "current-password"} /></label>
        {setup && <label>Confirm password<input type="password" value={form.confirm} onChange={set("confirm")} required minLength={8} autoComplete="new-password" /></label>}
        {error && <div className="alert">{error}</div>}
        <button type="submit" className="primary full" disabled={busy}>{busy && <Loader2 className="spin" size={14} />} {setup ? "Create and sign in" : "Sign in"}</button>
      </form>
    </div>
  );
}
