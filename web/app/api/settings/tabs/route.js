import { handler, HttpError, requireUser } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { ALL_TAB_IDS, cleanTabList } from "@/lib/tabs";

// Default dashboard tabs for users without their own tab list.
export const GET = handler(async () => {
  await requireUser({ admin: true });
  return Response.json({ defaultTabs: cleanTabList(await getSetting("default_tabs", null)) ?? ALL_TAB_IDS });
});

export const PUT = handler(async (req) => {
  await requireUser({ admin: true });
  const { defaultTabs } = await req.json().catch(() => ({}));
  const clean = cleanTabList(defaultTabs);
  if (!clean) throw new HttpError(400, "defaultTabs must be a list of tab ids.");
  await setSetting("default_tabs", clean);
  return Response.json({ defaultTabs: clean });
});
