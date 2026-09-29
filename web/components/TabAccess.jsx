"use client";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { ALL_TAB_IDS, TAB_CATALOG } from "@/lib/tabs";

async function call(path, method, body) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Tabs × users matrix. The first column is the deployment default (users set to
 * "Default" follow it); administrators always see every tab. Changes save immediately.
 */
export default function TabAccess({ users, setUsers, initialDefault }) {
  const [defaults, setDefaults] = useState(initialDefault);
  const [saving, setSaving] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const members = users.filter((u) => u.role !== "admin");

  async function run(key, fn) {
    setSaving(key);
    setError("");
    try {
      await fn();
      setSaved(key);
      setTimeout(() => setSaved((k) => (k === key ? "" : k)), 1400);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  const toggleDefault = (id) => {
    const next = defaults.includes(id) ? defaults.filter((t) => t !== id) : [...defaults, id];
    const ordered = ALL_TAB_IDS.filter((t) => next.includes(t));
    setDefaults(ordered);
    run("default", () => call("/api/settings/tabs", "PUT", { defaultTabs: ordered }));
  };

  const setUserTabs = (u, tabAccess) => {
    setUsers(users.map((x) => (x.id === u.id ? { ...x, tab_access: tabAccess } : x)));
    run(u.id, () => call(`/api/users/${u.id}`, "PATCH", { tabAccess }));
  };

  const effective = (u) => (Array.isArray(u.tab_access) ? u.tab_access : defaults);
  const status = (key) => (saving === key ? <Loader2 className="spin" size={12} /> : saved === key ? <Check size={12} /> : null);

  return (
    <section className="rtc-section">
      <header>
        <div><h2>Tab access</h2></div>
        <span className="rtc-note">Users only see the tabs ticked for them. Other tabs are greyed out with “Contact Administrator”. Administrators always see every tab.</span>
      </header>
      {error && <div className="alert">{error}</div>}
      <div className="table-wrap">
        <table className="access-matrix">
          <thead>
            <tr>
              <th>Tab</th>
              <th className="access-default">Default {status("default")}<small>new and “Default” users</small></th>
              {members.map((u) => (
                <th key={u.id}>
                  {u.name || u.email} {status(u.id)}
                  <small>{u.email}</small>
                  <select
                    value={Array.isArray(u.tab_access) ? "custom" : "default"}
                    onChange={(e) => setUserTabs(u, e.target.value === "default" ? null : [...defaults])}
                    aria-label={`Tab access mode for ${u.email}`}
                  >
                    <option value="default">Default</option>
                    <option value="custom">Custom</option>
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TAB_CATALOG.map((t) => (
              <tr key={t.id}>
                <td>{t.label}{t.engine ? "" : <small className="tag">browser only</small>}</td>
                <td className="access-default">
                  <input type="checkbox" checked={defaults.includes(t.id)} onChange={() => toggleDefault(t.id)} aria-label={`Default access to ${t.label}`} />
                </td>
                {members.map((u) => {
                  const custom = Array.isArray(u.tab_access);
                  const list = effective(u);
                  return (
                    <td key={u.id}>
                      <input
                        type="checkbox"
                        checked={list.includes(t.id)}
                        disabled={!custom}
                        title={custom ? undefined : "Follows the default column. Switch to Custom to change."}
                        onChange={() => setUserTabs(u, list.includes(t.id) ? list.filter((x) => x !== t.id) : ALL_TAB_IDS.filter((x) => x === t.id || list.includes(x)))}
                        aria-label={`${u.email} access to ${t.label}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!members.length && <p className="note" style={{ marginTop: 12 }}>Add a user above to give them their own tab set. Until then, the default column applies to every new user.</p>}
    </section>
  );
}
