-- 002_compaction.sql: 메시지에 compaction 지원 필드 추가

-- role에 'system' 추가 (compaction 요약 메시지용)
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_role_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_role_check
  CHECK (role IN ('user', 'assistant', 'system'));

-- compaction 메타 표시 (true면 이 메시지는 압축 요약)
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_compaction BOOLEAN DEFAULT FALSE;

-- 세션에 누적 토큰 카운터 (빠른 조회용)
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS total_tokens_used BIGINT DEFAULT 0;
