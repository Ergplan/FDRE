import { handler, HttpError, requireUser } from "@/lib/auth";
import { deleteProfile, getProfile } from "@/lib/profiles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = handler(async (_req, { params }) => {
  await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) throw new HttpError(404, "Profile not found.");
  return Response.json({ profile: await getProfile(id) });
});

export const DELETE = handler(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) throw new HttpError(404, "Profile not found.");
  await deleteProfile(user, id);
  return Response.json({ ok: true });
});
