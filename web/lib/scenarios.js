// Scenario persistence. Server-only.
import { query, tx } from "./db";
import { HttpError } from "./auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertId(id) {
  if (!UUID.test(String(id))) throw new HttpError(404, "Scenario not found.");
}

const MODULES = new Set(["rtc", "fdre", "bess"]);

export async function listScenarios({ module, q, archived = false }) {
  const vals = [archived];
  let where = "s.archived = $1";
  if (module && MODULES.has(module)) { vals.push(module); where += ` AND s.module = $${vals.length}`; }
  if (q) { vals.push(`%${q}%`); where += ` AND (s.name ILIKE $${vals.length} OR s.description ILIKE $${vals.length})`; }
  const { rows } = await query(
    `SELECT s.id, s.name, s.description, s.module, s.archived, s.created_at, s.updated_at,
            cu.name AS created_by_name, cu.email AS created_by_email,
            v.version, v.note, v.summary, v.created_at AS version_at, vu.name AS version_by_name, vu.email AS version_by_email
       FROM scenarios s
       LEFT JOIN users cu ON cu.id = s.created_by
       LEFT JOIN LATERAL (SELECT * FROM scenario_versions sv WHERE sv.scenario_id = s.id ORDER BY sv.version DESC LIMIT 1) v ON true
       LEFT JOIN users vu ON vu.id = v.created_by
      WHERE ${where}
      ORDER BY s.updated_at DESC
      LIMIT 500`,
    vals,
  );
  return rows;
}

export async function getScenario(id, version = null) {
  assertId(id);
  const s = await query(
    `SELECT s.*, u.name AS created_by_name, u.email AS created_by_email FROM scenarios s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
    [id],
  );
  if (!s.rows[0]) throw new HttpError(404, "Scenario not found.");
  const versions = await query(
    `SELECT v.version, v.note, v.summary, v.created_at, u.name AS created_by_name, u.email AS created_by_email
       FROM scenario_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.scenario_id = $1 ORDER BY v.version DESC`,
    [id],
  );
  const wanted = version ? Number(version) : versions.rows[0]?.version;
  const v = await query("SELECT version, note, inputs, results, summary, created_at FROM scenario_versions WHERE scenario_id = $1 AND version = $2", [id, wanted]);
  if (!v.rows[0]) throw new HttpError(404, "Version not found.");
  return { scenario: s.rows[0], versions: versions.rows, current: v.rows[0] };
}

function validPayload({ inputs, summary }) {
  if (!inputs || typeof inputs !== "object") throw new HttpError(400, "inputs are required.");
  if (summary !== undefined && (typeof summary !== "object" || summary === null)) throw new HttpError(400, "summary must be an object.");
}

export async function createScenario(user, { name, description = "", module, inputs, results = null, summary = {}, note = "" }) {
  if (!String(name || "").trim()) throw new HttpError(400, "Name is required.");
  if (!MODULES.has(module)) throw new HttpError(400, "Unknown module.");
  validPayload({ inputs, summary });
  return tx(async (c) => {
    const s = await c.query(
      "INSERT INTO scenarios (name, description, module, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
      [String(name).trim(), String(description), module, user.id],
    );
    await c.query(
      "INSERT INTO scenario_versions (scenario_id, version, note, inputs, results, summary, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6)",
      [s.rows[0].id, String(note || "Initial save"), inputs, results, summary, user.id],
    );
    return { ...s.rows[0], version: 1 };
  });
}

export async function addVersion(user, id, { inputs, results = null, summary = {}, note = "" }) {
  assertId(id);
  validPayload({ inputs, summary });
  return tx(async (c) => {
    const s = await c.query("SELECT id FROM scenarios WHERE id = $1 FOR UPDATE", [id]);
    if (!s.rows[0]) throw new HttpError(404, "Scenario not found.");
    const { rows } = await c.query("SELECT coalesce(max(version), 0) + 1 AS next FROM scenario_versions WHERE scenario_id = $1", [id]);
    const version = rows[0].next;
    await c.query(
      "INSERT INTO scenario_versions (scenario_id, version, note, inputs, results, summary, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, version, String(note || ""), inputs, results, summary, user.id],
    );
    await c.query("UPDATE scenarios SET updated_at = now() WHERE id = $1", [id]);
    return { id, version };
  });
}

export async function restoreVersion(user, id, version) {
  const { current } = await getScenario(id, version);
  return addVersion(user, id, {
    inputs: current.inputs,
    results: current.results,
    summary: current.summary,
    note: `Restored from version ${current.version}`,
  });
}

export async function updateScenarioMeta(id, { name, description, archived }) {
  assertId(id);
  const sets = [];
  const vals = [];
  if (name !== undefined) {
    if (!String(name).trim()) throw new HttpError(400, "Name is required.");
    vals.push(String(name).trim()); sets.push(`name = $${vals.length}`);
  }
  if (description !== undefined) { vals.push(String(description)); sets.push(`description = $${vals.length}`); }
  if (archived !== undefined) { vals.push(Boolean(archived)); sets.push(`archived = $${vals.length}`); }
  if (!sets.length) throw new HttpError(400, "Nothing to update.");
  vals.push(id);
  const { rows } = await query(`UPDATE scenarios SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
  if (!rows[0]) throw new HttpError(404, "Scenario not found.");
  return rows[0];
}

export async function deleteScenario(id) {
  assertId(id);
  const { rowCount } = await query("DELETE FROM scenarios WHERE id = $1", [id]);
  if (!rowCount) throw new HttpError(404, "Scenario not found.");
}
