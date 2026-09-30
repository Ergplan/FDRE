import { handler, HttpError, requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/activity";
import { restoreVersion } from "@/lib/scenarios";

export const POST = handler(async (req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const { version } = await req.json().catch(() => ({}));
  if (!Number.isInteger(Number(version))) throw new HttpError(400, "version is required.");
  const saved = await restoreVersion(user, id, Number(version));
  await logEvent({ user, kind: "scenario_save", detail: { scenarioId: id, version: saved.version, restoredFrom: Number(version) }, req });
  return Response.json(saved);
});
