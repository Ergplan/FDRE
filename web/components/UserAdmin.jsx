"use client";
import { useState } from "react";
import { KeyRound, Trash2, UserPlus } from "lucide-react";
import { when } from "./ScenarioLibrary";
import TabAccess from "./TabAccess";

async function call(path, method, body) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function UserAdmin({ me, initial, defaultTabs }) {
  const [users, setUsers] = useState(initial);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "user" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function run(fn, ok) {
    setError("");
    setMsg("");
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <form className="panel form-row" onSubmit={(e) => { e.preventDefault(); run(async () => { const { user } = await call("/api/users", "POST", form); setUsers([...users, user]); setForm({ email: "", name: "", password: "", role: "user" }); }, "User added. Share the email and temporary password with them."); }}>
        <label>Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Temporary password<input type="text" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="off" /></label>
        <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="user">User</option><option value="admin">Administrator</option></select></label>
        <button type="submit" className="primary"><UserPlus size={14} /> Add user</button>
      </form>
      {msg && <div className="loading">{msg}</div>}
      {error && <div className="alert">{error}</div>}
      <div className="table-wrap" style={{ marginTop: 18 }}>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Added</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name || "–"}{u.id === me.id && <span className="tag">you</span>}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} disabled={u.id === me.id} onChange={(e) => { const role = e.target.value; run(async () => { await call(`/api/users/${u.id}`, "PATCH", { role }); setUsers(users.map((x) => (x.id === u.id ? { ...x, role } : x))); }, "Role updated."); }}>
                    <option value="user">User</option><option value="admin">Administrator</option>
                  </select>
                </td>
                <td>{when(u.created_at)}</td>
                <td>{when(u.last_login_at)}</td>
                <td className="lib-actions">
                  <button type="button" className="rtc-link" onClick={() => { const password = window.prompt(`New temporary password for ${u.email} (8+ characters):`); if (password) run(() => call(`/api/users/${u.id}`, "PATCH", { password }), "Password reset. Their other sessions were signed out."); }}><KeyRound size={12} /> Reset password</button>
                  {u.id !== me.id && <button type="button" className="rtc-link danger" onClick={() => { if (window.confirm(`Remove ${u.email}? Their saved scenarios are kept.`)) run(async () => { await call(`/api/users/${u.id}`, "DELETE"); setUsers(users.filter((x) => x.id !== u.id)); }, "User removed."); }}><Trash2 size={12} /> Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TabAccess users={users} setUsers={setUsers} initialDefault={defaultTabs} />
    </>
  );
}
