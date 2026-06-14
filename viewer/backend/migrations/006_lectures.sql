-- 006_lectures.sql: lectures 테이블 신설 + jobs 의 multi-job 모델 지원

-- 1) lectures 테이블 — 강의 메타와 도메인 상태의 단일 진실 소스
CREATE TABLE IF NOT EXISTS lectures (
  id                       TEXT PRIMARY KEY,                  -- = filename stem
  user_id                  UUID REFERENCES users(id) ON DELETE CASCADE,
  original_name            TEXT NOT NULL,
  domain_id                TEXT,                              -- NULL = 미확정
  domain_status            TEXT NOT NULL DEFAULT 'pending'
                           CHECK (domain_status IN ('pending','confirmed','overridden')),
  domain_source            TEXT,                              -- 'auto' | 'user' | 'migration'
  detected_domain_id       TEXT,
  detected_confidence      REAL,
  detected_top_candidates  JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lectures_user_domain
  ON lectures(user_id, domain_id);

CREATE INDEX IF NOT EXISTS idx_lectures_user_status
  ON lectures(user_id, domain_status);

-- 2) jobs 확장 — job_type, parent_job_id, awaiting_domain status 추가
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'full'
    CHECK (job_type IN ('full','stt','correct','summary'));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_lecture_created
  ON jobs(lecture_id, created_at DESC);

-- status CHECK 갱신 (DROP IF EXISTS + ADD 로 idempotent)
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued','processing','awaiting_domain','completed','failed','canceled'));

-- 3) 기존 jobs 의 lecture_id → lectures 테이블 백필
--    user_id, original_name 은 가장 최근 job 의 값을 채택. domain_id 는 모두 finance 라벨.
INSERT INTO lectures (id, user_id, original_name, domain_id, domain_status, domain_source)
SELECT DISTINCT ON (j.lecture_id)
       j.lecture_id, j.user_id, j.original_name,
       'finance', 'confirmed', 'migration'
FROM jobs j
WHERE j.lecture_id IS NOT NULL
ORDER BY j.lecture_id, j.created_at DESC
ON CONFLICT (id) DO NOTHING;
