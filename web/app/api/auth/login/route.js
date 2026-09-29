import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { handler, HttpError, verifyPassword } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/session";

// Simple in-memory brute-force brake: 10 failures per email+IP per 15 minutes.
const failures = globalThis.__fdreLoginFailures || (globalThis.__fdreLoginFailures = new Map());
const WINDOW_MS = 15 * 60 * 1000;

export const POST = handler(async (req) => {
  const { email, password } = await req.json().catch(() => ({}));
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  const key = `${String(email).toLowerCase()}|${ip}`;
  const now = Date.now();
  const recent = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= 10) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  const { rows } = await query("SELECT id, email, name, role, password_hash, session_epoch FROM users WHERE lower(email) = lower($1)", [String(email || "").trim()]);
  const user = rows[0];
  if (!user || !(await verifyPassword(String(password || ""), user.password_hash))) {
    failures.set(key, [...recent, now]);
    throw new HttpError(401, "Email or password is incorrect.");
  }
  failures.delete(key);
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  (await cookies()).set(SESSION_COOKIE, await signSession(user), sessionCookieOptions());
  return Response.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});
