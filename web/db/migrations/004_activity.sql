-- Who signed in when, for how long, and what they used.
CREATE TABLE IF NOT EXISTS user_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,                    -- set on sign-out
  active_seconds integer NOT NULL DEFAULT 0,     -- time with the app open and in use
  ip             text NOT NULL DEFAULT '',
  user_agent     text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS user_sessions_user_started ON user_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS user_sessions_started ON user_sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS activity_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  email      text NOT NULL DEFAULT '',           -- kept when the user is deleted
  session_id uuid,
  kind       text NOT NULL,                      -- login, login_failed, logout, tab, optimize, engine, scenario_save, export, profile_upload
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ms         integer,                            -- compute time where it applies
  ip         text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS activity_log_at ON activity_log (at DESC);
CREATE INDEX IF NOT EXISTS activity_log_user_at ON activity_log (user_id, at DESC);
