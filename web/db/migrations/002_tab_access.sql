-- Per-user dashboard tab access (NULL = use the deployment default) and deployment settings.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tab_access jsonb;

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
