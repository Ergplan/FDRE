import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/session";
import { currentUser } from "@/lib/auth";
import { endSession, logEvent } from "@/lib/activity";

export async function POST(req) {
  const user = await currentUser().catch(() => null);
  if (user) {
    await endSession(user);
    await logEvent({ user, kind: "logout", req });
  }
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
