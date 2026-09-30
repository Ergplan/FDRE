// POST: heartbeat and usage events from the signed-in user's browser.
// GET (administrators): usage summary, sessions and the event log; format=csv downloads.
import { cookies } from "next/headers";
import { currentUser, handler, HttpError, requireUser } from "@/lib/auth";
import { CLIENT_KINDS, logEvent, recentEvents, recentSessions, startSession, touchSession, usageSummary } from "@/lib/activity";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const POST = handler(async (req) => {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in required.");
  const body = await req.json().catch(() => ({}));
  if (body.ping) {
    let ok = await touchSession(user, body.ping.activeSeconds);
    if (!ok) {
      // sessions signed in before activity tracking (or already signed out elsewhere): start one
      const sid = await startSession(user, req);
      if (sid) {
        (await cookies()).set(SESSION_COOKIE, await signSession(user, sid), sessionCookieOptions());
        ok = await touchSession({ ...user, sid }, body.ping.activeSeconds);
      }
    }
  }
  const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
  for (const ev of events) {
    if (!CLIENT_KINDS.has(ev?.kind)) continue;
    await logEvent({ user, kind: ev.kind, detail: ev.detail, ms: ev.ms == null ? null : Number(ev.ms), req });
  }
  return Response.json({ ok: true });
});

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");

export const GET = handler(async (req) => {
  await requireUser({ admin: true });
  const sp = new URL(req.url).searchParams;
  const days = Number(sp.get("days")) || 30;
  const userId = sp.get("user") || null;
  const kind = sp.get("kind") || null;
  const view = sp.get("view") || "summary";
  let payload;
  let cols;
  if (view === "events") {
    payload = await recentEvents({ days, userId, kind, limit: sp.get("format") === "csv" ? 5000 : 500 });
    cols = ["at", "email", "name", "kind", "detail", "ms", "ip"];
  } else if (view === "sessions") {
    payload = await recentSessions({ days, userId, limit: sp.get("format") === "csv" ? 2000 : 300 });
    cols = ["started_at", "last_seen_at", "ended_at", "active_seconds", "email", "name", "ip", "user_agent"];
  } else {
    payload = await usageSummary(days);
    cols = ["email", "name", "role", "last_login_at", "last_seen_at", "logins", "failed_logins", "sessions", "active_seconds", "open_seconds",
      "optimizer_runs", "engine_calls", "compute_ms", "scenario_saves", "exports", "profile_uploads", "tab_views", "top_tab"];
  }
  if (sp.get("format") === "csv") {
    const rows = view === "summary" ? payload.users : payload;
    return new Response(toCsv(rows, cols), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="fdre_${view}_${days}d_${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  return Response.json(view === "summary" ? payload : { [view]: payload });
});
