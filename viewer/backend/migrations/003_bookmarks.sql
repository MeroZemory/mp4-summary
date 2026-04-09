-- 003_bookmarks.sql: 강의별 북마크

CREATE TABLE IF NOT EXISTS bookmarks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  lecture_id  TEXT NOT NULL,
  time        TEXT NOT NULL,           -- "00:05:06" 형식
  segment_idx INT,                     -- 세그먼트 인덱스 (선택)
  note        TEXT DEFAULT '',         -- 사용자 메모
  color       TEXT DEFAULT 'teal',     -- 색상 태그
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user_lecture
  ON bookmarks(user_id, lecture_id, created_at);
