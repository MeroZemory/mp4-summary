-- 007_module_versions.sql: ShowMe / Notes 모듈을 (모델 종류별) 독립 버저닝

CREATE TABLE IF NOT EXISTS module_versions (
  id            BIGSERIAL PRIMARY KEY,
  lecture_id    TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module        TEXT NOT NULL CHECK (module IN ('show_me','notes')),
  model_kind    TEXT NOT NULL CHECK (model_kind IN ('gpt','claude')),
  version       INT  NOT NULL,
  model_id      TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  job_id        UUID REFERENCES jobs(id) ON DELETE SET NULL,
  is_baseline   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(lecture_id, module, model_kind, version)
);

CREATE INDEX IF NOT EXISTS idx_module_versions_lookup
  ON module_versions(lecture_id, module, model_kind, version DESC);

-- jobs: 'regen' job_type 추가 + regen 메타 컬럼
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN ('full','stt','correct','summary','regen'));

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS regen_module     TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS regen_model_kind TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS regen_model_id   TEXT;
