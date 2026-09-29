-- Library of hourly resource profiles (8760 capacity factors) for wind and solar.
CREATE TABLE IF NOT EXISTS resource_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_key    text UNIQUE,                       -- set for built-in profiles loaded from db/seed
  kind        text NOT NULL CHECK (kind IN ('wind', 'solar')),
  name        text NOT NULL,
  site        text NOT NULL DEFAULT '',
  region      text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT '',
  capacity_mw double precision,
  period_from text,
  period_to   text,
  coverage    double precision,
  cuf         double precision,
  monthly_cuf jsonb,
  quality     text NOT NULL DEFAULT 'validated' CHECK (quality IN ('validated', 'suspect', 'rejected')),
  issues      jsonb NOT NULL DEFAULT '[]'::jsonb,
  vals        jsonb,                             -- 8760 hourly capacity factors (null when rejected)
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resource_profiles_kind_idx ON resource_profiles (kind, quality, name);
