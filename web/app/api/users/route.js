import { query } from "@/lib/db";
import { handler, hashPassword, HttpError, requireUser, validatePassword } from "@/lib/auth";

export const GET = handler(async () => {
  await requireUser({ admin: true });
  const { rows } = await query("SELECT id, email, name, role, tab_access, created_at, last_login_at FROM users ORDER BY created_at");
  return Response.json({ users: rows });
});

export const POST = handler(async (req) => {
  await requireUser({ admin: true });
  const { email, name, password, role = "user" } = await req.json().catch(() => ({}));
  if (!email || !String(email).includes("@")) throw new HttpError(400, "Enter a valid email.");
  const bad = validatePassword(password);
  if (bad) throw new HttpError(400, bad);
  if (!["admin", "user"].includes(role)) throw new HttpError(400, "Invalid role.");
  try {
    const { rows } = await query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role, created_at",
      [String(email).trim().toLowerCase(), String(name || "").trim(), await hashPassword(password), role],
    );
    return Response.json({ user: rows[0] }, { status: 201 });
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "A user with that email already exists.");
    throw err;
  }
});
