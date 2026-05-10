# MP4 Summary

강의 영상(MP4)을 **자동 전사 → 도메인 용어 교정 → 8개 모듈 병렬 요약**까지 처리하고, 결과를 탐색하기 위한 풀스택 Viewer를 제공하는 엔드투엔드 파이프라인. 교정 프롬프트가 도메인별로 분리되어 있어 현재는 **제약·생의학 강의용**으로 튜닝되어 있지만, `CORRECTION_SYSTEM_PROMPT`를 갈아끼우면 다른 분야로 그대로 옮길 수 있다.

> 이 저장소는 **프레스티지바이오파마 IDC 바이오인포매틱스 연구원** 지원자 김지오의 포트폴리오 핵심 프로젝트다. 이력서의 "주요 프로젝트 → MP4 Summary · 강의 영상 자동 정리 (제약·생의학 도메인 튜닝)" 항목이 가리키는 바로 그 저장소다.
>
> 어필 포인트:
> - **약학·생의학 도메인 프롬프트 튜닝** + HyQE 임베딩 매칭으로 영상마다 최적 교정 프롬프트 자동 선택
> - **한·영 혼합 발화 경계 보정** — 한국어 강의 중 영어 전문 용어가 끼는 패턴을 GPT-5.4 mini로 정리
> - 멀티 모델 병행 — GPT-5.5(요약·정리)와 Claude Opus 4.7 / Sonnet 4.6(요약·SSE 채팅) 동시 활용
> - 결과 탐색 Viewer — FastAPI + React + PostgreSQL + 실시간 SSE 채팅 + 북마크 + QA Insights

## 아키텍처 개요

```
MP4 Video Files
    │
    ▼
┌──────────────────────────────────────────────┐
│         extract_and_correct.py               │
│  ┌─────────┐  ┌─────────┐  ┌──────────────┐ │
│  │ Audio   │→ │  STT    │→ │ GPT Correct  │ │
│  │ Extract │  │ (EL/W)  │  │ (5.4 mini)   │ │
│  └─────────┘  └─────────┘  └──────┬───────┘ │
│                                    ▼         │
│              ┌─────────────────────────┐     │
│              │  Summary (8 modules)    │     │
│              │  GPT-5.5 + Claude Opus  │     │
│              └────────────┬────────────┘     │
└───────────────────────────┼──────────────────┘
                            ▼
                      output/ (JSON, MD)
                            │
    ┌───────────────────────┼───────────────────────┐
    │               Viewer Web App                   │
    │  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
    │  │ FastAPI  │  │ React/TS │  │ PostgreSQL  │  │
    │  │ Backend  │  │ Frontend │  │ Database    │  │
    │  └──────────┘  └──────────┘  └─────────────┘ │
    └────────────────────────────────────────────────┘
```

---

## 1. 파이프라인 (`extract_and_correct.py`)

MP4 영상에서 강의 콘텐츠를 추출하고 AI로 교정·요약하는 4단계 파이프라인.

### 단계 구성

| 단계 | 설명 | API |
| --- | --- | --- |
| **Audio** | MP4 → MP3 변환 (16kHz 모노, 64kbps) | ffmpeg |
| **STT** | 화자 분리(speaker diarization) 포함 음성 인식 | ElevenLabs Scribe v2 / OpenAI Whisper |
| **Correct** | 도메인 전문 용어 교정, 한·영 혼합 발화 경계 보정 | GPT-5.4 mini |
| **Summary** | 8개 요약 모듈 병렬 실행 | GPT-5.5 + Claude Opus 4.7 |

### 8개 요약 모듈 (병렬 실행)

- **Overview** — 강의 제목 + 개요 요약
- **Key Concepts** — 핵심 용어 8~15개 + 첫 등장 타임스탬프
- **Timeline** — 5~10개 챕터 분기점
- **Study Guide** — 5~8쌍의 Q&A
- **ShowMe (GPT / Claude)** — Mermaid 다이어그램 기반 시각화 (두 모델 결과 병행)
- **Notes (GPT / Claude)** — 종합 강의 노트 (두 모델 결과 병행)

### 사용법

```bash
# 전체 파이프라인 실행
python extract_and_correct.py

# 특정 단계만 실행
python extract_and_correct.py --stages summary

# 요약 캐시 비우고 재생성
python extract_and_correct.py --refresh-summary
```

### 산출 파일

```
output/
├── {name}_raw_transcript_{hash}.json    # STT 원본 출력
├── {name}_corrected_{hash}.json         # 교정된 전사
├── {name}_summary_{hash}.json           # 요약 (8개 모듈)
├── {name}_transcript_md_{hash}.md       # 마크다운 전사
└── all_transcripts_{hash}.json          # 배치 메타데이터
```

### 핵심 기능

- **도메인 자동 검출** — HyQE 기반 키워드 임베딩 매칭으로 영상마다 최적 교정 프롬프트 선택 (아래 절 참고)
- **병렬 처리** — `ThreadPoolExecutor` (기본 20 워커)
- **캐싱** — 설정값을 포함한 MD5 해시로 중복 API 호출 방지
- **자동 폴백** — ElevenLabs 실패 시 Whisper로 자동 전환
- **백오프 재시도** — Rate limit: 시도마다 30s, 일반: 5~10s
- **대용량 파일 처리** — API 사이즈 한도 초과 시 10분 단위 자동 분할

### 도메인 자동 검출

영상의 도메인을 자동으로 판별해 가장 적합한 교정 프롬프트를 고른다. HyQE에서 영감을 받은 접근:

1. **샘플링** — STT 원본에서 약 20개 세그먼트 선별 (앞 15개 + 중간 5개)
2. **키워드 추출** — `gpt-4.1-nano`로 도메인 식별 가능한 키워드 15~25개 추출 (호출당 $0.001 미만)
3. **임베딩 비교** — `text-embedding-3-small`로 키워드를 임베딩하고, 사전 계산된 도메인 시그니처 임베딩과 코사인 유사도 비교
4. **프롬프트 선택** — 임계값(기본 0.45) 초과 시 도메인 특화 프롬프트 사용, 그렇지 않으면 일반 프롬프트로 폴백

검출 결과는 영상 단위로 캐시되어 API 호출은 한 번만 발생한다.

**`DOMAIN_DETECTION` 환경변수로 설정:**
- `auto` (기본) — 자동 검출
- `generic` — 항상 일반 프롬프트 사용
- `pharmaceutical` — 특정 도메인 강제

**새 도메인 추가:**

1. `prompts/{domain_id}/system.md`, `user.md`에 도메인 특화 교정 지침 작성
2. `prompts/domains.json`에 `id`와 대표 키워드 30~40개 등록
3. `python domain_detector.py --precompute` 실행해 도메인 임베딩 사전 생성
4. 끝 — 파이프라인이 다음 실행부터 새 도메인을 자동 후보에 포함

---

## 2. Viewer 웹앱 (`viewer/`)

파이프라인 결과를 탐색하기 위한 풀스택 웹 애플리케이션.

### 기술 스택

| 레이어 | 기술 |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Backend | FastAPI, Uvicorn, asyncpg |
| Database | PostgreSQL 16 |
| AI Chat | Claude Sonnet 4.6 (SSE 스트리밍) |
| Infra | Docker, docker-compose |

### 기능

**Transcript Viewer (전사 뷰어)**
- 교정본 / 원본 / JSON 뷰 토글
- 세그먼트별 타임스탬프 + 텍스트
- 전사 내 검색 (⌘K)

**AI Summary Dashboard (요약 대시보드)**
- 강의 개요, 핵심 개념, 타임라인, Study Guide
- 풀스크린 줌/팬 가능한 Mermaid 다이어그램
- GPT vs Claude 결과 좌우 비교

**Audio Player (오디오 플레이어)**
- 타임스탬프 클릭 시 해당 위치로 점프
- 재생 속도 조절 (0.75x ~ 2x)

**AI Chat**
- Claude Sonnet 4.6 기반 강의 컨텍스트 Q&A
- 실시간 SSE 스트리밍
- 다중 세션 관리
- 자동 압축 (80K 토큰 초과 시 대화 압축)

**Bookmarks (북마크)**
- 세그먼트 우클릭으로 북마크 추가
- 5색 색상 태그 + 메모
- 사이드바 북마크 목록 관리

**Learning Notes (QA Insights)**
- 채팅 Q&A에서 학습 노트 자동 추출 (Claude Haiku 4.5)
- 신규 / 기존과 병합 / 스킵으로 분류
- 일괄 승인 / 편집 / 무시

**Authentication (인증)**
- JWT + bcrypt 로컬 인증
- Google OAuth 2.0

### API 엔드포인트

```
POST   /api/auth/register               # 회원가입
POST   /api/auth/login                  # 로그인
GET    /api/auth/me                     # 현재 사용자
GET    /api/auth/google                 # Google OAuth

GET    /api/chat/sessions               # 채팅 세션 목록
POST   /api/chat/sessions               # 세션 생성
POST   /api/chat/sessions/:id/messages  # 메시지 전송 (SSE)

GET    /api/bookmarks                   # 북마크 목록
POST   /api/bookmarks                   # 북마크 생성

GET    /api/insights                    # 학습 노트 목록
GET    /api/insights/pending            # 대기 중인 노트
POST   /api/insights/batch              # 일괄 처리
```

---

## 3. 시작하기

### 파이프라인 요구사항

- Python 3.10+
- ffmpeg, ffprobe
- API 키: OpenAI (필수), ElevenLabs (선택), Anthropic (선택)

```bash
# .env 설정
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=sk_...        # 선택 (STT_PROVIDER=whisper면 불필요)
ANTHROPIC_API_KEY=sk-ant-...     # 선택 (Claude 요약/노트용)
STT_PROVIDER=elevenlabs          # elevenlabs 또는 whisper
CORRECTION_MODEL=gpt-5.4-mini
LECTURE_GPT_MODEL=gpt-5.5
LECTURE_NOTES_MODEL=claude-opus-4-7
MAX_WORKERS=20
```

### Viewer (Docker)

```bash
cd viewer

# viewer/.env 설정
DB_PASSWORD=<secure-password>
JWT_SECRET=<secure-secret>
ANTHROPIC_API_KEY=sk-ant-...
CHAT_MODEL=claude-sonnet-4-6

# 빌드 및 실행
docker compose up --build -d
```

기본 진입점은 `http://localhost:8000`.

### Viewer (로컬 개발)

```bash
# Backend
cd viewer/backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8000

# Frontend
cd viewer/frontend
npm install
npm run dev
```

---

## 4. 데이터베이스 스키마

```
users              # 사용자 (이메일/비밀번호 + OAuth)
chat_sessions      # 강의별 채팅 세션
chat_messages      # 메시지 히스토리 (토큰 추적, 압축 지원)
bookmarks          # 타임스탬프 북마크 (색상 태그)
qa_insights        # 학습 노트 (pending/accepted/dismissed)
```

---

## 5. 프로젝트 구조

```
mp4-summary/
├── extract_and_correct.py    # 메인 파이프라인 스크립트
├── domain_detector.py        # HyQE 기반 도메인 검출
├── prompts/                  # 교정 프롬프트 레지스트리
│   ├── domains.json          # 도메인 정의 + 키워드
│   ├── generic/              # 폴백 프롬프트
│   └── pharmaceutical/       # 도메인 특화 프롬프트
├── output/                   # 파이프라인 산출물 (JSON, MD, MP3)
└── viewer/                   # 웹 뷰어
    ├── Dockerfile
    ├── docker-compose.yml
    ├── backend/
    │   ├── server.py         # FastAPI 진입점
    │   ├── auth.py           # JWT + OAuth 인증
    │   ├── chat.py           # AI 채팅 (SSE + 자동 압축)
    │   ├── bookmarks.py      # 북마크 CRUD
    │   ├── qa_extraction.py  # 학습 노트 추출
    │   ├── lecture_data.py   # 강의 데이터 로더
    │   ├── db.py             # DB 커넥션 풀
    │   └── migrations/       # PostgreSQL 마이그레이션
    └── frontend/
        ├── src/App.tsx       # 메인 SPA 컴포넌트
        ├── package.json
        └── vite.config.ts
```

---

## 6. 도메인 적용 가능성 (바이오인포매틱스 관점)

이 파이프라인은 약학·생의학 강의를 처리하기 위해 튜닝되어 있지만, 같은 패턴은 사내 R&D 콘텐츠 전반으로 그대로 옮길 수 있다.

- **도메인 자동 검출 + 프롬프트 레지스트리** — `prompts/{domain}/`에 항체·임상·기전·CMC 등 도메인별 프롬프트를 추가하면 같은 영상 입력에서 도메인별 교정·요약이 분기된다.
- **8개 요약 모듈** — Overview · Key Concepts · Timeline · Study Guide · ShowMe · Notes 구성은 **논문 / 특허 / 임상 보고서 구조화 추출**에도 그대로 매핑된다.
- **Viewer의 SSE 채팅 + 북마크 + QA Insights** — 강의 자산을 단발성 요약으로 끝내지 않고 **연구자가 다시 들어와 질의·메모하는 살아 있는 코퍼스**로 만든다.

지원자의 다른 프로젝트 — Foundry-style 7단계 온톨로지 파이프라인(LinkML → SHACL · Neo4j · OpenLineage), PlayDex Neuro-Symbolic RAG(FAISS + BM25 + BGE-M3 Reranking · HyQE · Function Calling + Graph DB) — 와 결합하면, 이 Viewer는 사내 연구 자산 탐색 시스템의 **프런트엔드 + 검색·대화 레이어**가 된다.

---

## 7. 라이선스 / 연락

- 개인 포트폴리오 프로젝트 (라이선스 명시 전, 별도 합의 없는 재배포 금지).
- 작성자: 김지오 — `merozemory@gmail.com` · [github.com/MeroZemory](https://github.com/MeroZemory) · [linkedin.com/in/jio-kim](https://www.linkedin.com/in/jio-kim-a63389321)
