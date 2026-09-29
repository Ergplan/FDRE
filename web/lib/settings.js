// Deployment-wide settings (app_settings table). Server-only.
import { query } from "./db";

export async function getSetting(key, fallback = null) {
  const { rows } = await query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await query(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}
