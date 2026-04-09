# 강의 뷰어 — 채팅 기능 + 계정 시스템 + DB 구축 계획

## Context

현재 강의 녹취록 뷰어는 하드코딩된 비밀번호(329971)로 보호되며, 정적 JSON 데이터만 서빙한다. 유튜브 서머리/NotebookLM처럼 강의 내용에 대해 대화할 수 있는 채팅 기능을 추가하려 한다.

이를 위해 필요한 인프라 변경:
1. 하드코딩 비밀번호 → **계정 기반 인증** (ID/PW + OAuth)
2. **PostgreSQL** 도입 (Docker Compose 내)
3. **채팅 API** (SSE 스트리밍, 적응형 컨텍스트)

**강의는 공유, 채팅은 사용자별 독립** 관리.

---

## Phase 1: PostgreSQL + Docker 인프라

### docker-compose.yml 변경

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: viewer
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: viewer
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432"       # 내부만 노출
    healthcheck:
      test: pg_isready -U viewer
      interval: 5s

  viewer:
    build:
      context: ..
      dockerfile: viewer/Dockerfile
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgresql://viewer:${DB_PASSWORD}@db:5432/viewer
    ports:
      - "8000:8000"
    restart: unless-stopped

volumes:
  pgdata:
```

### DB 스키마 (`migrations/001_init.sql`)

```sql
-- 사용자
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,              -- NULL이면 OAuth 전용 사용자
  display_name  TEXT,
  oauth_provider TEXT,             -- 'google', 'github', NULL
  oauth_id      TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_oauth ON users(oauth_provider, oauth_id)
  WHERE oauth_provider IS NOT NULL;

-- 채팅 세션 (사용자 × 강의)
CREATE TABLE chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  lecture_id  TEXT NOT NULL,       -- TranscriptEntry.id (강의 base name)
  title       TEXT,                -- 자동 생성 or 사용자 설정
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_sessions_user ON chat_sessions(user_id, updated_at DESC);

-- 메시지
CREATE TABLE chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  model       TEXT,               -- 'claude-sonnet-4-6' 등
  tokens_in   INT,
  tokens_out  INT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_messages_session ON chat_messages(session_id, created_at);
```

### DB 접근 방식

`asyncpg` + raw SQL — 테이블 3개에 ORM은 과잉.
마이그레이션은 `migrations/` 폴더에 SQL 파일로 관리, 서버 시작 시 자동 적용.

---

## Phase 2: 계정 시스템 (ID/PW + OAuth)

### 인증 아키텍처

```
┌─ Frontend ─────────────────────────────────────┐
│ 로그인 폼 (email/pw) │ Google 버튼 │ GitHub 버튼 │
└──────────────┬────────┬──────────┬─────────────┘
               │        │          │
       POST /api/auth/login  GET /api/auth/google  GET /api/auth/github
               │        │          │
┌─ Backend ────┴────────┴──────────┴─────────────┐
│  bcrypt 검증   │  OAuth flow  │  OAuth flow     │
│          └──── JWT 발급 (httponly cookie) ──────│
└────────────────────────────────────────────────┘
```

### 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/auth/register` | 회원가입 (email, password, display_name) |
| POST | `/api/auth/login` | 로그인 → JWT cookie 발급 |
| POST | `/api/auth/logout` | 쿠키 삭제 |
| GET | `/api/auth/me` | 현재 사용자 정보 |
| GET | `/api/auth/google` | Google OAuth 시작 |
| GET | `/api/auth/google/callback` | Google OAuth 콜백 |
| GET | `/api/auth/github` | GitHub OAuth 시작 |
| GET | `/api/auth/github/callback` | GitHub OAuth 콜백 |

### 기술 선택

- **비밀번호 해싱**: `bcrypt` (passlib)
- **JWT**: `python-jose` — httponly, samesite=strict 쿠키로 전달
- **OAuth**: `authlib` — Google/GitHub OIDC 지원
- **기존 하드코딩 비밀번호**: 마이그레이션 기간 동안 병행, 최종 제거

---

## Phase 3: 채팅 기능

### 백엔드 API

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/chat/sessions?lecture_id=X` | 내 세션 목록 |
| POST | `/api/chat/sessions` | 새 세션 생성 |
| DELETE | `/api/chat/sessions/{id}` | 세션 삭제 |
| GET | `/api/chat/sessions/{id}/messages` | 메시지 히스토리 |
| POST | `/api/chat/sessions/{id}/messages` | 메시지 전송 → SSE 스트리밍 응답 |

### 적응형 컨텍스트 전략

```
트랜스크립트 토큰 ≤ 6000 → 전문을 system prompt에
트랜스크립트 토큰 > 6000 → 요약(overview + key_concepts + timeline)만
```

### 프론트엔드 채팅 UI

- 우측 슬라이드 패널 (토글 가능)
- 메시지에서 `[HH:MM:SS]` → 클릭 가능한 타임스탬프 링크
- 응답 마크다운 렌더링 (react-markdown 재사용)
- SSE 스트리밍 + 타이핑 인디케이터
- 모바일: 전체 화면 오버레이

### 비용 관리

- 기본 모델: Claude Sonnet 4.6 (~$3/M input, ~$15/M output)
- rate limit: 사용자당 분당 5회, 일당 100회
- 토큰 사용량 chat_messages에 기록

---

## 구현 순서

| 단계 | 작업 | 의존성 |
|------|------|--------|
| **1** | Docker Compose에 PostgreSQL 추가, 스키마 생성, DB 모듈 | 없음 |
| **2** | 계정 시스템 (register/login/logout/me) | 1 |
| **3** | OAuth (Google, GitHub) | 2 |
| **4** | 프론트엔드 로그인/회원가입 UI | 2 |
| **5** | 백엔드 강의 데이터 로더 | 없음 |
| **6** | 채팅 API (세션 CRUD + 메시지 SSE) | 1, 2, 5 |
| **7** | 프론트엔드 채팅 UI | 4, 6 |
| **8** | 서버 배포 | 전체 |

---

## 주요 파일 경로

| 파일 | 유형 |
|------|------|
| `viewer/docker-compose.yml` | 수정 |
| `viewer/.env` | 신규 — DB_PASSWORD, JWT_SECRET 등 |
| `viewer/backend/server.py` | 대폭 수정 |
| `viewer/backend/db.py` | 신규 — asyncpg 연결 + 쿼리 |
| `viewer/backend/auth.py` | 신규 — 인증 로직 |
| `viewer/backend/chat.py` | 신규 — 채팅 API |
| `viewer/backend/lecture_data.py` | 신규 — 강의 데이터 로더 |
| `viewer/backend/migrations/001_init.sql` | 신규 — 스키마 |
| `viewer/backend/requirements.txt` | 수정 |
| `viewer/frontend/src/App.tsx` | 수정 — 인증 UI, 채팅 패널 |
| `viewer/Dockerfile` | 수정 — lecture_data 복사 |
