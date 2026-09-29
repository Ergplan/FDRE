import { handler, requireUser } from "@/lib/auth";

export const GET = handler(async () => Response.json({ user: await requireUser() }));
