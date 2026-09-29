import { handler, requireUser } from "@/lib/auth";
import { createScenario, listScenarios } from "@/lib/scenarios";

export const GET = handler(async (req) => {
  await requireUser();
  const sp = new URL(req.url).searchParams;
  const rows = await listScenarios({ module: sp.get("module"), q: sp.get("q"), archived: sp.get("archived") === "true" });
  return Response.json({ scenarios: rows });
});

export const POST = handler(async (req) => {
  const user = await requireUser();
  const created = await createScenario(user, await req.json());
  return Response.json({ scenario: created }, { status: 201 });
});
