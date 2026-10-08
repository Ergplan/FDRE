import { currentUserWithAccess, handler } from "@/lib/auth";
import { listTenderReads, requireTenderAccess, saveTenderRead } from "@/lib/tenders";
import { logEvent } from "@/lib/activity";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await currentUserWithAccess();
  requireTenderAccess(user);
  return Response.json({ tenders: await listTenderReads() });
});

export const POST = handler(async (req) => {
  const user = await currentUserWithAccess();
  requireTenderAccess(user);
  const body = await req.json();
  const saved = await saveTenderRead(user, body);
  await logEvent({ user, kind: "tender_read", detail: { file: String(body?.fileName || "").slice(0, 200), mode: body?.result?.mode }, req });
  return Response.json({ tender: saved }, { status: 201 });
});
