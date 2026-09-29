// Postgres pool and migrations. Server-only.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const globalRef = globalThis;

export function pool() {
  if (!globalRef.__fdrePool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    globalRef.__fdrePool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return globalRef.__fdrePool;
}

export async function query(text, params) {
  return pool().query(text, params);
}

export async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function migrationsDir() {
  const candidates = [path.join(process.cwd(), "db", "migrations"), path.join(process.cwd(), "web", "db", "migrations")];
  return candidates.find((d) => fs.existsSync(d));
}

/** Apply every db/migrations/*.sql not yet recorded, in name order, each in a transaction. */
export async function migrate() {
  const dir = migrationsDir();
  if (!dir) throw new Error("db/migrations not found");
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(727401)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`[db] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727401)").catch(() => {});
    client.release();
  }
}
