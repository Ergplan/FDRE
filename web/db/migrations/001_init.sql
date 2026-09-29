-- Users, saved scenarios and their version history.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  session_epoch integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  module      text NOT NULL CHECK (module IN ('rtc', 'fdre')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived    boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS scenario_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  note        text NOT NULL DEFAULT '',
  inputs      jsonb NOT NULL,
  results     jsonb,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, version)
);

CREATE INDEX IF NOT EXISTS scenarios_updated_idx ON scenarios (archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS scenario_versions_latest_idx ON scenario_versions (scenario_id, version DESC);
