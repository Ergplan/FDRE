import React, { useState } from "react";
import { Zap } from "lucide-react";
import { auth } from "./api";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { me } = await auth.login(email, password);
      onLogin(me);
    } catch (err) {
      setError(err.message || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><span><Zap size={22} /></span><div><strong>FDRE Platform</strong><small>Enterprise pilot</small></div></div>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="alert">{error}</div>}
        <button className="primary full" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="note">Accounts are created by an administrator. Every change you make is recorded against your identity.</p>
      </form>
    </div>
  );
}
