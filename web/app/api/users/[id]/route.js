import { query } from "@/lib/db";
import { handler, hashPassword, HttpError, requireUser, validatePassword } from "@/lib/auth";

// Admins can change anyone's name, role or password; users can change their own name and password.
export const PATCH = handler(async (req, { params }) => {
  const me = await requireUser();
  const { id } = await params;
  const isSelf = me.id === id;
  if (!isSelf && me.role !== "admin") throw new HttpError(403, "Administrator access required.");
  const { name, role, password } = await req.json().catch(() => ({}));
  const sets = [];
  const vals = [];
  if (name !== undefined) { vals.push(String(name).trim()); sets.push(`name = $${vals.length}`); }
  if (role !== undefined) {
    if (me.role !== "admin") throw new HttpError(403, "Only administrators can change roles.");
    if (!["admin", "user"].includes(role)) throw new HttpError(400, "Invalid role.");
    if (isSelf && role !== "admin") throw new HttpError(400, "You cannot remove your own administrator role.");
    vals.push(role); sets.push(`role = $${vals.length}`);
  }
  if (password !== undefined) {
    const bad = validatePassword(password);
    if (bad) throw new HttpError(400, bad);
    vals.push(await hashPassword(password)); sets.push(`password_hash = $${vals.length}`);
    // signs out other sessions of this user (the current cookie is re-issued on next login)
    if (!isSelf) sets.push("session_epoch = session_epoch + 1");
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update.");
  vals.push(id);
  const { rows } = await query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING id, email, name, role`, vals);
  if (!rows[0]) throw new HttpError(404, "User not found.");
  return Response.json({ user: rows[0] });
});

export const DELETE = handler(async (_req, { params }) => {
  const me = await requireUser({ admin: true });
  const { id } = await params;
  if (me.id === id) throw new HttpError(400, "You cannot delete your own account.");
  const { rowCount } = await query("DELETE FROM users WHERE id = $1", [id]);
  if (!rowCount) throw new HttpError(404, "User not found.");
  return Response.json({ ok: true });
});
