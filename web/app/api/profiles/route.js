import { handler, requireUser } from "@/lib/auth";
import { createProfile, listProfiles } from "@/lib/profiles";
import { logEvent } from "@/lib/activity";

export const GET = handler(async (req) => {
  await requireUser();
  const kind = new URL(req.url).searchParams.get("kind");
  return Response.json({ profiles: await listProfiles(["wind", "solar"].includes(kind) ? kind : null) });
});

export const POST = handler(async (req) => {
  const user = await requireUser();
  const profile = await createProfile(user, await req.json());
  const { vals, ...meta } = profile;
  await logEvent({ user, kind: "profile_upload", detail: { profile: meta.name, kind: meta.kind, cuf: meta.cuf }, req });
  return Response.json({ profile: meta }, { status: 201 });
});
