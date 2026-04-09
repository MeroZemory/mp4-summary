-- 004_qa_insights.sql: Q&A 인사이트 자동 추출

CREATE TABLE IF NOT EXISTS qa_insights (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  lecture_id      TEXT NOT NULL,
  question        TEXT NOT NULL,
  answer_summary  TEXT NOT NULL,
  tags            TEXT[] DEFAULT '{}',
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_user_lecture
  ON qa_insights(user_id, lecture_id, status);
