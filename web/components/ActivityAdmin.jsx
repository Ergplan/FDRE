"use client";
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Stat } from "@/src/rtc/ui";
import { TAB_CATALOG } from "@/lib/tabs";

const PERIODS = [[1, "24 h"], [7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]];
const VIEWS = [["summary", "By user"], ["sessions", "Sign-ins"], ["events", "Event log"]];
const KINDS = [["", "All events"], ["login", "Sign-in"], ["login_failed", "Failed sign-in"], ["logout", "Sign-out"], ["tab", "Tab opened"],
  ["optimize", "Optimizer run"], ["engine", "Engine call"], ["scenario_save", "Scenario saved"], ["export", "Export"], ["profile_upload", "Profile upload"]];
const KIND_LABEL = Object.fromEntries(KINDS);
const TAB_LABEL = Object.fromEntries(TAB_CATALOG.map((t) => [t.id, t.label]));

const dur = (s) => {
  const v = Math.round(Number(s) || 0);
  if (v < 60) return v ? `${v} s` : "–";
  const h = Math.floor(v / 3600);
  const m = Math.round((v % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} m` : `${m} min`;
};
const when = (t) => (t ? new Date(t).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "–");
const ago = (t) => {
  if (!t) return "never";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 120) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const browser = (ua = "") => {
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} · ${os}` : b;
};

function describe(ev) {
  const d = ev.detail || {};
  switch (ev.kind) {
    case "tab": return TAB_LABEL[d.tab] || d.tab;
    case "optimize": {
      const parts = [d.module === "rtc" ? "Round the Clock" : d.module, d.objective && `objective ${d.objective}`];
      if (d.sizes) parts.push(`→ ${Math.round(d.sizes.solarMw)} MW solar, ${Math.round(d.sizes.windMw)} MW wind, ${Math.round(d.sizes.bessMw)} MW BESS`);
      if (Number.isFinite(d.tariff)) parts.push(`₹${d.tariff.toFixed(3)}/kWh`);
      if (d.highs?.seconds) parts.push(`HiGHS ${d.highs.seconds} s`);
      if (d.highs?.error) parts.push(`HiGHS not used (${d.highs.error})`);
      if (d.error) parts.push(`error: ${d.error}`);
      return parts.filter(Boolean).join(" · ");
    }
    case "engine": return `${d.path}${d.status && d.status !== 200 ? ` (HTTP ${d.status})` : ""}`;
    case "scenario_save": return `${d.scenario || "scenario"}${d.version ? ` v${d.version}` : ""}${d.restoredFrom ? ` (restored from v${d.restoredFrom})` : ""}`;
    case "export": return d.scenarios ? `Excel: ${d.scenarios.join(", ")}` : d.what || "";
    case "profile_upload": return `${d.kind} profile “${d.profile}”${Number.isFinite(d.cuf) ? ` · CUF ${(d.cuf * 100).toFixed(1)}%` : ""}`;
    case "login_failed": return d.reason || "";
    case "login": return browser(d.userAgent);
    default: return Object.keys(d).length ? JSON.stringify(d) : "";
  }
}

export default function ActivityAdmin({ users }) {
  const [days, setDays] = useState(30);
  const [view, setView] = useState("summary");
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ days: String(days), view });
    if (userId && view !== "summary") p.set("user", userId);
    if (kind && view === "events") p.set("kind", kind);
    return p.toString();
  }, [days, view, userId, kind]);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    fetch(`/api/activity?${qs}`, { credentials: "same-origin" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; })
      .then((j) => { if (live) setData({ view, ...j }); })
      .catch((err) => { if (live) setError(err.message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [qs, view, tick]);

  return (
    <div className="activity">
      <div className="toolbar">
        <div className="seg">
          {VIEWS.map(([v, l]) => <button key={v} type="button" className={view === v ? "active" : ""} onClick={() => setView(v)}>{l}</button>)}
        </div>
        <div className="seg">
          {PERIODS.map(([d, l]) => <button key={d} type="button" className={days === d ? "active" : ""} onClick={() => setDays(d)}>{l}</button>)}
        </div>
        {view !== "summary" && (
          <select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="User">
            <option value="">All users</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name ? `${u.name} · ${u.email}` : u.email}</option>)}
          </select>
        )}
        {view === "events" && (
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Event type">
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {busy && <Loader2 className="spin" size={14} />}
        <div className="toolbar-end">
          <button type="button" className="secondary" onClick={() => setTick((t) => t + 1)}><RefreshCw size={14} /> Refresh</button>
          <a className="secondary" href={`/api/activity?${qs}&format=csv`}><Download size={14} /> CSV</a>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {data?.view === "summary" && data.users && <Summary data={data} onPick={(id) => { setUserId(id); setView("sessions"); }} />}
      {data?.view === "sessions" && data.sessions && <Sessions rows={data.sessions} />}
      {data?.view === "events" && data.events && <Events rows={data.events} />}
      <p className="rtc-note activity-note">
        Active time counts minutes with the app open in a visible browser tab and used within the last 5 minutes; “open” is sign-in to last seen.
        Compute time is engine calls plus optimizer runs. Records are kept for 400 days.
      </p>
    </div>
  );
}

function Summary({ data, onPick }) {
  const u = data.users;
  const sum = (k) => u.reduce((s, r) => s + Number(r[k] || 0), 0);
  const activeUsers = u.filter((r) => r.sessions > 0 || r.logins > 0).length;
  const byDay = useMemo(() => {
    const m = new Map();
    for (const r of data.daily) m.set(r.day, (m.get(r.day) || 0) + Number(r.active_seconds));
    const out = [];
    const n = Math.min(data.days, 90);
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push([d, m.get(d) || 0]);
    }
    return out;
  }, [data]);
  const peak = Math.max(1, ...byDay.map(([, v]) => v));
  return (
    <>
      <div className="rtc-stats flush-top">
        <Stat label="Active users" value={`${activeUsers} / ${u.length}`} detail={`in the last ${data.days === 1 ? "24 hours" : `${data.days} days`}`} />
        <Stat label="Sign-ins" value={sum("logins")} detail={`${sum("failed_logins")} failed`} tone={sum("failed_logins") > 10 ? "bad" : undefined} />
        <Stat label="Active time" value={dur(sum("active_seconds"))} detail={`${sum("sessions")} sessions`} />
        <Stat label="Optimizer runs" value={sum("optimizer_runs")} detail={`${sum("engine_calls")} engine calls`} />
        <Stat label="Compute time" value={dur(sum("compute_ms") / 1000)} detail={`${sum("scenario_saves")} saves · ${sum("exports")} exports`} />
      </div>
      {data.days > 1 && (
        <div className="activity-days" aria-label="Active time per day">
          {byDay.map(([d, v]) => (
            <div key={d} className="activity-day" title={`${d}: ${dur(v)}`}>
              <i style={{ height: `${Math.max(v ? 4 : 0, (v / peak) * 100)}%` }} />
            </div>
          ))}
          <span className="activity-days-label">Active time per day · peak {dur(peak)}</span>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th><th>Last sign-in</th><th>Last seen</th><th className="num">Sign-ins</th><th className="num">Active time</th><th className="num">Open time</th>
              <th className="num">Optimizer runs</th><th className="num">Engine calls</th><th className="num">Compute</th><th className="num">Saves</th><th className="num">Exports</th><th>Most used tab</th><th />
            </tr>
          </thead>
          <tbody>
            {u.map((r) => (
              <tr key={r.id} className={r.sessions || r.logins ? "" : "row-idle"}>
                <td><strong>{r.name || r.email}</strong><small>{r.name ? r.email : ""}{r.role === "admin" ? " · admin" : ""}</small></td>
                <td>{when(r.last_login_at)}</td>
                <td>{ago(r.last_seen_at)}</td>
                <td className="num">{r.logins}{r.failed_logins ? <small className="issue-bad"> +{r.failed_logins} failed</small> : null}</td>
                <td className="num"><b>{dur(r.active_seconds)}</b></td>
                <td className="num">{dur(r.open_seconds)}</td>
                <td className="num">{r.optimizer_runs || "–"}</td>
                <td className="num">{r.engine_calls || "–"}</td>
                <td className="num">{dur(Number(r.compute_ms) / 1000)}</td>
                <td className="num">{r.scenario_saves || "–"}</td>
                <td className="num">{r.exports || "–"}</td>
                <td>{TAB_LABEL[r.top_tab] || r.top_tab || "–"}</td>
                <td className="lib-actions"><button type="button" className="rtc-link" onClick={() => onPick(r.id)}>Sign-ins</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Sessions({ rows }) {
  if (!rows.length) return <div className="empty-state">No sign-ins in this period.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>User</th><th>Signed in</th><th>Last seen</th><th>Signed out</th><th className="num">Active time</th><th className="num">Open time</th><th>Device</th><th>IP</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.name || s.email}</strong><small>{s.name ? s.email : ""}</small></td>
              <td>{when(s.started_at)}</td>
              <td>{ago(s.last_seen_at)}</td>
              <td>{s.ended_at ? when(s.ended_at) : <span className="muted">{Date.now() - new Date(s.last_seen_at).getTime() < 3 * 60000 ? "online" : "–"}</span>}</td>
              <td className="num"><b>{dur(s.active_seconds)}</b></td>
              <td className="num">{dur((new Date(s.ended_at || s.last_seen_at) - new Date(s.started_at)) / 1000)}</td>
              <td>{browser(s.user_agent)}</td>
              <td className="mono">{s.ip || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Events({ rows }) {
  if (!rows.length) return <div className="empty-state">No events in this period.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th><th>User</th><th>Event</th><th>Details</th><th className="num">Time</th><th>IP</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={e.kind === "login_failed" ? "row-warn" : ""}>
              <td>{when(e.at)}</td>
              <td><strong>{e.name || e.email || "–"}</strong>{e.name && <small>{e.email}</small>}</td>
              <td><span className={`tag tag-${e.kind}`}>{KIND_LABEL[e.kind] || e.kind}</span></td>
              <td className="activity-detail">{describe(e)}</td>
              <td className="num">{e.ms != null ? dur(e.ms / 1000) : ""}</td>
              <td className="mono">{e.ip || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
