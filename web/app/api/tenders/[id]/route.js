import { currentUserWithAccess, handler } from "@/lib/auth";
import { getTenderRead, requireTenderAccess } from "@/lib/tenders";

export const dynamic = "force-dynamic";

export const GET = handler(async (req, { params }) => {
  const user = await currentUserWithAccess();
  requireTenderAccess(user);
  const { id } = await params;
  const row = await getTenderRead(id);
  return Response.json({ tender: row });
});
