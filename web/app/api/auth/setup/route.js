import { cookies } from "next/headers";
import { query, tx } from "@/lib/db";
import { handler, hashPassword, HttpError, validatePassword } from "@/lib/auth";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/session";

// First run only: create the administrator when the users table is empty.
export const POST = handler(async (req) => {
  const { email, name, password } = await req.json().catch(() => ({}));
  if (!email || !String(email).includes("@")) throw new HttpError(400, "Enter a valid email.");
  const bad = validatePassword(password);
  if (bad) throw new HttpError(400, bad);
  const hash = await hashPassword(password);
  const user = await tx(async (c) => {
    await c.query("LOCK TABLE users IN EXCLUSIVE MODE");
    const { rows } = await c.query("SELECT count(*)::int AS n FROM users");
    if (rows[0].n > 0) throw new HttpError(409, "Setup is already complete. Sign in instead.");
    const res = await c.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id, email, name, role, session_epoch",
      [String(email).trim().toLowerCase(), String(name || "").trim(), hash],
    );
    return res.rows[0];
  });
  (await cookies()).set(SESSION_COOKIE, await signSession(user), sessionCookieOptions());
  return Response.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

export const GET = handler(async () => {
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  return Response.json({ needsSetup: rows[0].n === 0 });
});
