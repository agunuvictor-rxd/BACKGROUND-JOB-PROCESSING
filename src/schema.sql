CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  max_attempts    INTEGER     NOT NULL,
  last_error      TEXT,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  idempotency_key TEXT        NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON jobs (status, run_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_jobs_stuck
  ON jobs (status, started_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_jobs_dead
  ON jobs (status)
  WHERE status = 'dead';