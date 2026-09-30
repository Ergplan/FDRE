import { handler, requireUser } from "@/lib/auth";
import { addVersion, deleteScenario, getScenario, updateScenarioMeta } from "@/lib/scenarios";
import { logEvent } from "@/lib/activity";

export const GET = handler(async (req, { params }) => {
  await requireUser();
  const { id } = await params;
  return Response.json(await getScenario(id, new URL(req.url).searchParams.get("version")));
});

// Save a new version (inputs + results); earlier versions are kept.
export const PUT = handler(async (req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const saved = await addVersion(user, id, await req.json());
  await logEvent({ user, kind: "scenario_save", detail: { scenarioId: id, version: saved.version }, req });
  return Response.json(saved);
});

// Rename, describe or archive.
export const PATCH = handler(async (req, { params }) => {
  await requireUser();
  const { id } = await params;
  return Response.json({ scenario: await updateScenarioMeta(id, await req.json()) });
});

export const DELETE = handler(async (_req, { params }) => {
  await requireUser();
  const { id } = await params;
  await deleteScenario(id);
  return Response.json({ ok: true });
});
