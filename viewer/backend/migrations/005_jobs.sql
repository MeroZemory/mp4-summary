-- 005_jobs.sql: MP4 업로드 및 처리 작업 큐

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  filename         TEXT NOT NULL,
  original_name    TEXT NOT NULL,
  file_size        BIGINT,
  lecture_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'canceled')),
  stage            TEXT,
  progress_message TEXT,
  error_message    TEXT,
  worker_id        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  processing_ms    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_created
  ON jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created
  ON jobs(status, created_at)
  WHERE status IN ('queued', 'processing');
