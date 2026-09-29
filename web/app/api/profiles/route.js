import { handler, requireUser } from "@/lib/auth";
import { createProfile, listProfiles } from "@/lib/profiles";

export const GET = handler(async (req) => {
  await requireUser();
  const kind = new URL(req.url).searchParams.get("kind");
  return Response.json({ profiles: await listProfiles(["wind", "solar"].includes(kind) ? kind : null) });
});

export const POST = handler(async (req) => {
  const user = await requireUser();
  const profile = await createProfile(user, await req.json());
  const { vals, ...meta } = profile;
  return Response.json({ profile: meta }, { status: 201 });
});
