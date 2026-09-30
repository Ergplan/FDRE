// Sign-in sessions and the activity log. Server-only. Logging never breaks a request: errors
// are written to the server log and swallowed.
import { query } from "./db";

export const RETENTION_DAYS = 400;
const MAX_PING_SECONDS = 120; // one heartbeat can add at most this much active time

/** Event kinds the browser may report (everything else is logged by the server itself). */
export const CLIENT_KINDS = new Set(["tab", "optimize", "run", "export", "download"]);

export function clientIp(req) {
  const h = req?.headers;
  return (h?.get("x-forwarded-for")?.split(",")[0].trim() || h?.get("x-real-ip") || "").slice(0, 64);
}

function trimDetail(detail) {
  if (!detail || typeof detail !== "object") return {};
  const json = JSON.stringify(detail);
  return json.length <= 2000 ? detail : { truncated: json.slice(0, 2000) };
}

export async function logEvent({ user = null, email = "", sessionId = null, kind, detail = {}, ms = null, req = null }) {
  try {
    await query(
      "INSERT INTO activity_log (user_id, email, session_id, kind, detail, ms, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [user?.id || null, String(user?.email || email || "").slice(0, 200), sessionId || user?.sid || null, String(kind).slice(0, 40),
        JSON.stringify(trimDetail(detail)), Number.isFinite(ms) ? Math.round(ms) : null, clientIp(req)],
    );
  } catch (err) {
    console.error(`[activity] ${kind}: ${err.message}`);
  }
}

export async function startSession(user, req) {
  try {
    const { rows } = await query(
      "INSERT INTO user_sessions (user_id, ip, user_agent) VALUES ($1, $2, $3) RETURNING id",
      [user.id, clientIp(req), String(req?.headers?.get("user-agent") || "").slice(0, 300)],
    );
    return rows[0].id;
  } catch (err) {
    console.error(`[activity] session: ${err.message}`);
    return null;
  }
}

/** Heartbeat from an open, in-use dashboard: extends the session and adds active time. */
export async function touchSession(user, activeSeconds) {
  if (!user?.sid) return false;
  const add = Math.max(0, Math.min(MAX_PING_SECONDS, Math.round(Number(activeSeconds) || 0)));
  const { rowCount } = await query(
    "UPDATE user_sessions SET last_seen_at = now(), active_seconds = active_seconds + $3 WHERE id = $1 AND user_id = $2 AND ended_at IS NULL",
    [user.sid, user.id, add],
  );
  return rowCount > 0;
}

export async function endSession(user) {
  if (!user?.sid) return;
  await query("UPDATE user_sessions SET ended_at = now(), last_seen_at = now() WHERE id = $1 AND user_id = $2 AND ended_at IS NULL", [user.sid, user.id]).catch(() => {});
}

export async function purgeOldActivity() {
  await query(`DELETE FROM activity_log WHERE at < now() - interval '${RETENTION_DAYS} days'`);
  await query(`DELETE FROM user_sessions WHERE started_at < now() - interval '${RETENTION_DAYS} days'`);
}

/** Per-user usage over the last `days` days, plus totals. */
export async function usageSummary(days) {
  const d = Math.max(1, Math.min(RETENTION_DAYS, Math.round(Number(days) || 30)));
  const { rows } = await query(
    `WITH s AS (
       SELECT user_id, count(*)::int AS sessions, sum(active_seconds)::bigint AS active_seconds,
              sum(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at) - started_at)))::bigint AS open_seconds,
              max(last_seen_at) AS last_seen_at
         FROM user_sessions WHERE started_at >= now() - $1::int * interval '1 day' GROUP BY user_id),
     a AS (
       SELECT user_id,
              count(*) FILTER (WHERE kind = 'login')::int AS logins,
              count(*) FILTER (WHERE kind = 'login_failed')::int AS failed_logins,
              count(*) FILTER (WHERE kind = 'optimize')::int AS optimizer_runs,
              count(*) FILTER (WHERE kind = 'engine')::int AS engine_calls,
              COALESCE(sum(ms) FILTER (WHERE kind IN ('engine', 'optimize')), 0)::bigint AS compute_ms,
              count(*) FILTER (WHERE kind = 'scenario_save')::int AS scenario_saves,
              count(*) FILTER (WHERE kind IN ('export', 'download'))::int AS exports,
              count(*) FILTER (WHERE kind = 'profile_upload')::int AS profile_uploads,
              count(*) FILTER (WHERE kind = 'tab')::int AS tab_views
         FROM activity_log WHERE at >= now() - $1::int * interval '1 day' AND user_id IS NOT NULL GROUP BY user_id),
     t AS (
       SELECT DISTINCT ON (user_id) user_id, detail->>'tab' AS top_tab
         FROM (SELECT user_id, detail, count(*) OVER (PARTITION BY user_id, detail->>'tab') AS n
                 FROM activity_log WHERE kind = 'tab' AND at >= now() - $1::int * interval '1 day') x
        ORDER BY user_id, n DESC)
     SELECT u.id, u.email, u.name, u.role, u.last_login_at,
            COALESCE(s.sessions, 0) AS sessions, COALESCE(s.active_seconds, 0) AS active_seconds,
            COALESCE(s.open_seconds, 0) AS open_seconds, s.last_seen_at,
            COALESCE(a.logins, 0) AS logins, COALESCE(a.failed_logins, 0) AS failed_logins,
            COALESCE(a.optimizer_runs, 0) AS optimizer_runs, COALESCE(a.engine_calls, 0) AS engine_calls,
            COALESCE(a.compute_ms, 0) AS compute_ms, COALESCE(a.scenario_saves, 0) AS scenario_saves,
            COALESCE(a.exports, 0) AS exports, COALESCE(a.profile_uploads, 0) AS profile_uploads,
            COALESCE(a.tab_views, 0) AS tab_views, t.top_tab
       FROM users u LEFT JOIN s ON s.user_id = u.id LEFT JOIN a ON a.user_id = u.id LEFT JOIN t ON t.user_id = u.id
      ORDER BY COALESCE(s.active_seconds, 0) DESC, u.last_login_at DESC NULLS LAST`,
    [d],
  );
  const daily = await query(
    `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day, user_id, sum(active_seconds)::bigint AS active_seconds
       FROM user_sessions WHERE started_at >= now() - $1::int * interval '1 day' GROUP BY 1, 2 ORDER BY 1`,
    [d],
  );
  return { days: d, users: rows.map(numify), daily: daily.rows.map(numify) };
}

export async function recentEvents({ days = 30, userId = null, kind = null, limit = 500 }) {
  const d = Math.max(1, Math.min(RETENTION_DAYS, Math.round(Number(days) || 30)));
  const params = [d];
  let where = "l.at >= now() - $1::int * interval '1 day'";
  if (userId) { params.push(userId); where += ` AND l.user_id = $${params.length}`; }
  if (kind) { params.push(kind); where += ` AND l.kind = $${params.length}`; }
  params.push(Math.max(1, Math.min(5000, Number(limit) || 500)));
  const { rows } = await query(
    `SELECT l.id, l.at, l.kind, l.detail, l.ms, l.ip, l.email, l.user_id, u.name
       FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE ${where} ORDER BY l.at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

export async function recentSessions({ days = 30, userId = null, limit = 300 }) {
  const d = Math.max(1, Math.min(RETENTION_DAYS, Math.round(Number(days) || 30)));
  const params = [d];
  let where = "s.started_at >= now() - $1::int * interval '1 day'";
  if (userId) { params.push(userId); where += ` AND s.user_id = $${params.length}`; }
  params.push(Math.max(1, Math.min(2000, Number(limit) || 300)));
  const { rows } = await query(
    `SELECT s.id, s.started_at, s.last_seen_at, s.ended_at, s.active_seconds, s.ip, s.user_agent, u.email, u.name
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE ${where} ORDER BY s.started_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(numify);
}

function numify(r) {
  const out = { ...r };
  for (const k of Object.keys(out)) if (typeof out[k] === "string" && /seconds$|_ms$/.test(k)) out[k] = Number(out[k]);
  return out;
}
