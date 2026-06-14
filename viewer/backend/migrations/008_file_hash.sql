-- 008_file_hash.sql: 파일 해시 기반 사용자별 캐싱
--
-- 기존: lecture_id = 파일명 stem (충돌 시 _8charhex suffix). 같은 사용자가
--   같은 파일을 두 번 업로드하면 lecture_id 가 매번 달라져 STT/코렉션/요약
--   캐시가 무효화되고, 다른 사용자도 같은 stem 으로 lecture 소유권을 빼앗
--   을 수 있었다.
--
-- 신규: lecture_id = `${user_id_short}__${file_hash_short}` 결정적 규칙.
--   - 같은 사용자 + 같은 파일 → 동일 lecture_id → 캐시 hit
--   - 다른 사용자 + 같은 파일 → 다른 lecture_id → 사용자별 격리

ALTER TABLE lectures ADD COLUMN IF NOT EXISTS file_hash TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_lectures_user_hash
  ON lectures(user_id, file_hash)
  WHERE file_hash IS NOT NULL;

-- (user_id, file_hash) 가 같으면 같은 lecture — 중복 업로드 방지.
-- 옛 lecture (file_hash NULL) 는 partial index 로 제외.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lectures_user_hash
  ON lectures(user_id, file_hash)
  WHERE file_hash IS NOT NULL;
