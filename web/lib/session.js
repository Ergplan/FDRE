// Signed session cookie (HS256 JWT). Safe to import from proxy.js: no database access.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "fdre_session";
export const SESSION_DAYS = 14;

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set (32+ characters)");
  return new TextEncoder().encode(secret);
}

export async function signSession(user, sid = null) {
  return new SignJWT({ email: user.email, role: user.role, epoch: user.session_epoch ?? 0, ...(sid ? { sid } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(key());
}

export async function verifySession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return { id: payload.sub, email: payload.email, role: payload.role, epoch: payload.epoch ?? 0, sid: payload.sid || null };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Plain-HTTP deployments (IP address, no certificate) need secure=false.
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
  };
}
