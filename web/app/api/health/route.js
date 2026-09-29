import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const engineUrl = process.env.ENGINE_URL || "http://127.0.0.1:8000";
  const out = { web: "ok", database: "unknown", engine: "unknown" };
  try { await query("SELECT 1"); out.database = "ok"; } catch (err) { out.database = err.message; }
  try {
    const res = await fetch(`${engineUrl}/docs`, { signal: AbortSignal.timeout(3000) });
    out.engine = res.ok ? "ok" : `HTTP ${res.status}`;
  } catch (err) { out.engine = err.message; }
  const healthy = out.database === "ok";
  return Response.json(out, { status: healthy ? 200 : 503 });
}
