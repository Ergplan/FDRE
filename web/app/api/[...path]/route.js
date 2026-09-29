// Authenticated pass-through to the Python engine (FastAPI): /api/<anything not handled by
// Next.js> → ENGINE_URL/api/<same path>. Uses node:http so long optimizer runs are not cut
// off by fetch timeouts.
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { handler, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
const ENGINE_URL = process.env.ENGINE_URL || "http://127.0.0.1:8000";
const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS || 30 * 60 * 1000);

async function forward(req, { params }) {
  await requireUser();
  const { path } = await params;
  const incoming = new URL(req.url);
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}${incoming.search}`, ENGINE_URL);
  const body = req.method === "GET" || req.method === "HEAD" ? null : Buffer.from(await req.arrayBuffer());
  const headers = { accept: req.headers.get("accept") || "*/*" };
  if (req.headers.get("content-type")) headers["content-type"] = req.headers.get("content-type");
  if (body) headers["content-length"] = String(body.length);
  return new Promise((resolve) => {
    const lib = target.protocol === "https:" ? https : http;
    const upstream = lib.request(target, { method: req.method, headers, timeout: TIMEOUT_MS }, (res) => {
      const out = new Headers();
      for (const h of ["content-type", "content-disposition", "content-length"]) if (res.headers[h]) out.set(h, res.headers[h]);
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode || 502, headers: out }));
    });
    upstream.on("timeout", () => upstream.destroy(new Error("Engine timed out")));
    upstream.on("error", (err) => resolve(Response.json({ error: `Engine unavailable: ${err.message}` }, { status: 502 })));
    if (body) upstream.write(body);
    upstream.end();
  });
}

export const GET = handler(forward);
export const POST = handler(forward);
export const PUT = handler(forward);
export const PATCH = handler(forward);
export const DELETE = handler(forward);
