// Resource-profile library. Server-only.
import fs from "node:fs";
import path from "node:path";
import { query } from "./db";
import { HttpError } from "./auth";

const LIST_COLS = `p.id, p.seed_key, p.kind, p.name, p.site, p.region, p.source, p.capacity_mw, p.period_from, p.period_to,
  p.coverage, p.cuf, p.monthly_cuf, p.quality, p.issues, p.created_by, p.created_at, u.name AS created_by_name, u.email AS created_by_email`;

export async function listProfiles(kind) {
  const vals = [];
  let where = "";
  if (kind) { vals.push(kind); where = "WHERE p.kind = $1"; }
  const { rows } = await query(
    `SELECT ${LIST_COLS} FROM resource_profiles p LEFT JOIN users u ON u.id = p.created_by ${where}
     ORDER BY CASE p.quality WHEN 'validated' THEN 0 WHEN 'suspect' THEN 1 ELSE 2 END, p.seed_key IS NULL, p.name`,
    vals,
  );
  return rows;
}

export async function getProfile(id) {
  const { rows } = await query(`SELECT ${LIST_COLS}, p.vals FROM resource_profiles p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Profile not found.");
  return rows[0];
}

function checkValues(values) {
  if (!Array.isArray(values) || values.length !== 8760) throw new HttpError(400, "values must be 8760 hourly capacity factors.");
  for (const v of values) if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1.3001) throw new HttpError(400, "values must be capacity factors between 0 and 1.3.");
}

export async function createProfile(user, body) {
  const { kind, name, site = "", region = "", source = "", capacityMw = null, from = null, to = null, coverage = null, quality = "validated", issues = [], values } = body || {};
  if (!["wind", "solar"].includes(kind)) throw new HttpError(400, "kind must be wind or solar.");
  if (!String(name || "").trim()) throw new HttpError(400, "Name is required.");
  if (!["validated", "suspect"].includes(quality)) throw new HttpError(400, "Rejected profiles cannot be saved.");
  checkValues(values);
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const vals = values.map(r4);
  const cuf = vals.reduce((a, b) => a + b, 0) / vals.length;
  const monthly = [];
  let t = 0;
  for (const days of [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]) {
    let s = 0;
    for (let k = 0; k < days * 24; k += 1) s += vals[t + k];
    monthly.push(r4(s / (days * 24)));
    t += days * 24;
  }
  const { rows } = await query(
    `INSERT INTO resource_profiles (kind, name, site, region, source, capacity_mw, period_from, period_to, coverage, cuf, monthly_cuf, quality, issues, vals, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [kind, String(name).trim().slice(0, 200), String(site).slice(0, 200), String(region).slice(0, 200), String(source).slice(0, 500),
      Number(capacityMw) || null, from, to, coverage, r4(cuf), JSON.stringify(monthly), quality, JSON.stringify(issues.slice(0, 10)), JSON.stringify(vals), user.id],
  );
  return getProfile(rows[0].id);
}

export async function deleteProfile(user, id) {
  const p = await getProfile(id);
  if (p.seed_key && user.role !== "admin") throw new HttpError(403, "Only administrators can remove built-in profiles.");
  if (!p.seed_key && p.created_by !== user.id && user.role !== "admin") throw new HttpError(403, "You can only remove profiles you uploaded.");
  await query("DELETE FROM resource_profiles WHERE id = $1", [id]);
}

/** Load built-in profiles from db/seed/profiles/*.json (insert new seed keys, refresh existing ones). */
export async function seedProfiles() {
  const dir = [path.join(process.cwd(), "db", "seed", "profiles"), path.join(process.cwd(), "web", "db", "seed", "profiles")].find((d) => fs.existsSync(d));
  if (!dir) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const { profiles = [] } = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const p of profiles) {
      await query(
        `INSERT INTO resource_profiles (seed_key, kind, name, site, region, source, capacity_mw, period_from, period_to, coverage, cuf, monthly_cuf, quality, issues, vals)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (seed_key) DO UPDATE SET name = EXCLUDED.name, site = EXCLUDED.site, region = EXCLUDED.region, source = EXCLUDED.source,
           capacity_mw = EXCLUDED.capacity_mw, period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to, coverage = EXCLUDED.coverage,
           cuf = EXCLUDED.cuf, monthly_cuf = EXCLUDED.monthly_cuf, quality = EXCLUDED.quality, issues = EXCLUDED.issues, vals = EXCLUDED.vals`,
        [p.seedKey, p.kind, p.name, p.site || "", p.region || "", p.source || "", p.capacityMw ?? null, p.from ?? null, p.to ?? null,
          p.coverage ?? null, p.cuf ?? null, JSON.stringify(p.monthlyCuf || null), p.quality || "validated", JSON.stringify(p.issues || []),
          p.values ? JSON.stringify(p.values) : null],
      );
      n += 1;
    }
  }
  return n;
}
