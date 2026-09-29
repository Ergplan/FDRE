import { handler, HttpError, requireUser } from "@/lib/auth";
import { restoreVersion } from "@/lib/scenarios";

export const POST = handler(async (req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const { version } = await req.json().catch(() => ({}));
  if (!Number.isInteger(Number(version))) throw new HttpError(400, "version is required.");
  return Response.json(await restoreVersion(user, id, Number(version)));
});
