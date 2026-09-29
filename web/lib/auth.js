// Password hashing and the current user. Server-only.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { query } from "./db";
import { SESSION_COOKIE, verifySession } from "./session";
import { getSetting } from "./settings";
import { resolveTabs } from "./tabs";

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters.";
  return null;
}

/** The signed-in user, re-checked against the database (deleted users and reset sessions are rejected). */
export async function currentUser() {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const { rows } = await query("SELECT id, email, name, role, session_epoch, tab_access FROM users WHERE id = $1", [session.id]);
  const user = rows[0];
  if (!user || user.session_epoch !== session.epoch) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role, tab_access: user.tab_access };
}

/** The signed-in user plus the dashboard tabs they may open and whom to contact for more. */
export async function currentUserWithAccess() {
  const user = await currentUser();
  if (!user) return null;
  const defaults = await getSetting("default_tabs", null);
  const admins = await query("SELECT name, email FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 3");
  const { tab_access, ...rest } = user;
  return {
    ...rest,
    allowedTabs: resolveTabs(user, defaults),
    adminContacts: admins.rows.map((a) => ({ name: a.name, email: a.email })),
  };
}

export async function userCount() {
  const { rows } = await query("SELECT count(*)::int AS n FROM users");
  return rows[0].n;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function requireUser({ admin = false } = {}) {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in required.");
  if (admin && user.role !== "admin") throw new HttpError(403, "Administrator access required.");
  return user;
}

/** Wrap a route handler: JSON errors, auth failures as 401/403. */
export function handler(fn) {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return Response.json({ error: status === 500 ? "Server error." : err.message }, { status });
    }
  };
}
