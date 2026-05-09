# Domain Categorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 강의를 도메인(금융/제약·생의학/분류 보류/분류 안 함)별로 그룹화하고, STT 후 사용자가 도메인을 항상 컨펌하도록 흐름을 변경. 기존 강의는 모두 finance 라벨로 마이그레이션.

**Architecture:** Multi-job 모델 (`stt`/`correct`/`summary` 분리). 신규 `lectures` 테이블이 강의 진실 소스. STT 완료 후 `awaiting_domain` 상태로 워커 슬롯 해제, 사용자 confirm POST 가 `correct` job 을 새로 큐잉.

**Tech Stack:** FastAPI, asyncpg, PostgreSQL 16, React + TypeScript, Vite, OpenAI Embeddings/Chat, Pydantic.

**스펙:** `docs/superpowers/specs/2026-05-10-domain-categorization-design.md`

---

## Phase 1: 도메인 자산 부트스트랩

### Task 1: `bootstrap_finance_domain.py` 작성 + 실행

**Files:**
- Create: `scripts/bootstrap_finance_domain.py`
- Create: `prompts/finance/system.md`, `prompts/finance/user.md` (스크립트 결과 기반)

- [ ] Step 1: 스크립트 작성 — `output/` 의 raw_transcript 중 사용자가 인자로 넘긴 base name 들에 대해 키워드 빈도 집계 + finance 도메인 prompts 초안 LLM 생성
- [ ] Step 2: 운영자가 finance 후보 강의 base name 을 확인 (사용자에게 질문)
- [ ] Step 3: 스크립트 실행 → keyword 시그니처와 prompts 초안 출력
- [ ] Step 4: prompts/finance/{system,user}.md 작성 (스크립트 출력 기반)
- [ ] Step 5: prompts/domains.json 에 finance 항목 추가
- [ ] Step 6: 커밋

### Task 2: `domain_detector.py` — DomainMatch 에 candidates 필드 추가

**Files:**
- Modify: `domain_detector.py` (DomainMatch NamedTuple, detect_domain 캐시 포맷)

- [ ] Step 1: DomainMatch 에 `candidates: list[tuple[str, float]]` 추가
- [ ] Step 2: detect_domain 이 모든 도메인 점수를 계산해 candidates 반환
- [ ] Step 3: 캐시 포맷에도 candidates 저장/로드
- [ ] Step 4: `_generic_match()` 도 candidates=[] 로 반환
- [ ] Step 5: extract_and_correct.py 의 import 점검 (DomainMatch 사용처)
- [ ] Step 6: 임베딩 사전 계산 `python domain_detector.py --precompute` 실행 → `embeddings_cache/finance.json` 생성 확인
- [ ] Step 7: 커밋

### Task 3: `process_single_video` 시그니처 확장

**Files:**
- Modify: `extract_and_correct.py:process_single_video` (그리고 stages 분기 + forced_domain_id)
- Modify: `extract_and_correct.py` 반환값 — STT 단계 결과로 도메인 감지 후보를 반환

- [ ] Step 1: `forced_domain_id: str | None = None` 인자 추가
- [ ] Step 2: `stages=["stt"]` 호출 시 detect_domain 결과를 dict 로 반환 (detected_domain_id, confidence, candidates, top_candidates_json)
- [ ] Step 3: `stages=["correct"]` 에서 `forced_domain_id` 가 있으면 detect_domain 호출 안 함
- [ ] Step 4: 회귀 테스트 — 기존 `python extract_and_correct.py <video>` 호출도 동일하게 동작하는지 (full pipeline 인자 없이도 OK)
- [ ] Step 5: 커밋

## Phase 2: DB 스키마 + 백엔드 데이터 모델

### Task 4: 마이그레이션 SQL 추가

**Files:**
- Create: `viewer/backend/migrations/006_lectures.sql`

- [ ] Step 1: lectures 테이블 + 인덱스
- [ ] Step 2: jobs 확장 (job_type, parent_job_id, awaiting_domain 추가)
- [ ] Step 3: jobs → lectures 백필 (모두 finance 라벨, ON CONFLICT DO NOTHING)
- [ ] Step 4: 로컬 docker compose db 띄우고 자동 적용 검증
- [ ] Step 5: 커밋

### Task 5: 백엔드 `lectures.py` 모듈

**Files:**
- Create: `viewer/backend/lectures.py`

- [ ] Step 1: GET /api/lectures 라우트 (사용자 자기 강의만, jobs 최신 상태와 lecture_data 메모리 join)
- [ ] Step 2: GET /api/lectures/{id} 라우트
- [ ] Step 3: POST /api/lectures/{id}/domain 라우트 (도메인 화이트리스트 검증, correct job INSERT 로직)
- [ ] Step 4: server.py 에 router include
- [ ] Step 5: 커밋

### Task 6: 백엔드 `domains.py` 모듈

**Files:**
- Create: `viewer/backend/domains.py`

- [ ] Step 1: GET /api/domains 라우트 — prompts/domains.json + generic 항목 반환
- [ ] Step 2: 도메인 ID 화이트리스트 helper (lectures.py 가 import)
- [ ] Step 3: server.py 에 router include
- [ ] Step 4: 커밋

### Task 7: `jobs.py` 워커 흐름 변경 — Multi-Job 진입

**Files:**
- Modify: `viewer/backend/jobs.py:upload_mp4` (lectures INSERT + jobs job_type='stt')
- Modify: `viewer/backend/jobs.py:WorkerManager._process` (job_type 별 분기, awaiting_domain 종착)
- Modify: `viewer/backend/jobs.py:_run_pipeline` (job_type/forced_domain_id 인자 받음)

- [ ] Step 1: upload 시 lectures INSERT (domain_status='pending') 추가
- [ ] Step 2: 신규 job 은 job_type='stt'
- [ ] Step 3: 워커가 stt job 처리 시 process_single_video(stages=["stt"]) 호출
- [ ] Step 4: STT 완료 시 lectures.detected_* 업데이트, jobs.status='awaiting_domain'
- [ ] Step 5: 워커가 correct job 처리 시 forced_domain_id 사용, 완료 시 summary job INSERT
- [ ] Step 6: 워커가 summary job 처리 시 process_single_video(stages=["summary"])
- [ ] Step 7: 커밋

### Task 8: `lecture_data.py` 보조 API

**Files:**
- Modify: `viewer/backend/lecture_data.py`

- [ ] Step 1: `lecture_summary()` 같은 helper 추가 — has_corrected/has_summary 반환 (lectures.py 가 사용)
- [ ] Step 2: 커밋

## Phase 3: 프론트엔드

### Task 9: API 타입 정의 + `useLectures` 훅

**Files:**
- Create: `viewer/frontend/src/hooks/useLectures.ts`
- Modify: `viewer/frontend/src/App.tsx` (Lecture, Domain 타입 추가)

- [ ] Step 1: Lecture / Domain 타입 정의
- [ ] Step 2: useLectures — /api/lectures 폴링 (5초, awaiting/processing 강의 있을 때만)
- [ ] Step 3: 도메인별 그루핑 함수 (분류 보류/안 함 끝쪽 정렬)
- [ ] Step 4: 커밋

### Task 10: `DomainPicker` 컴포넌트

**Files:**
- Create: `viewer/frontend/src/components/DomainPicker.tsx`

- [ ] Step 1: 추천 chip + 다른 chip + "더보기 ▾" + "분류 안 함으로 진행"
- [ ] Step 2: confirm 콜백 prop, disabled 상태
- [ ] Step 3: 커밋

### Task 11: 사이드바 강의 목록을 도메인 그룹으로 변경

**Files:**
- Modify: `viewer/frontend/src/App.tsx` (강의 사이드바 영역)

- [ ] Step 1: 기존 lectureIds 사용처를 useLectures 결과로 교체
- [ ] Step 2: 그룹 헤더 + 접기/펼치기 (localStorage)
- [ ] Step 3: ⚠️ 표시 (해당 그룹에 awaiting 강의 있을 때)
- [ ] Step 4: 커밋

### Task 12: UploadPanel 카드 인라인 컨펌

**Files:**
- Modify: `viewer/frontend/src/App.tsx:UploadPanel`

- [ ] Step 1: 5초 폴링에 lectures 도 함께 fetch
- [ ] Step 2: status==='awaiting_domain' job 카드 안에 DomainPicker 인라인
- [ ] Step 3: confirm POST 후 즉시 카드 갱신
- [ ] Step 4: 커밋

### Task 13: 강의 페이지 — 도메인 배지 + 변경

**Files:**
- Modify: `viewer/frontend/src/App.tsx` (LecturePage 영역)

- [ ] Step 1: 강의 헤더에 🏷 도메인 배지 + "변경" 버튼
- [ ] Step 2: 변경 시 경고 모달 → DomainPicker
- [ ] Step 3: 코렉션 다시 생성 중 배너 (lecture latest_job_status 폴링)
- [ ] Step 4: 커밋

## Phase 4: 마이그레이션 스크립트 + 로컬 검증

### Task 14: `migrate_existing_lectures.py`

**Files:**
- Create: `scripts/migrate_existing_lectures.py`

- [ ] Step 1: LECTURE_DATA_DIR 스캔 + 환경변수 MIGRATION_USER_EMAIL 검증
- [ ] Step 2: lectures INSERT (finance, migration source), idempotent
- [ ] Step 3: 커밋

### Task 15: 로컬 환경 기동 + 마이그레이션 검증

- [ ] Step 1: `.env` 에 DB_PASSWORD/JWT_SECRET 확인 (없으면 사용자에게 질문)
- [ ] Step 2: `docker compose -f viewer/docker-compose.yml up -d db` 로 PG 만 띄움
- [ ] Step 3: 백엔드를 로컬 venv 로 직접 기동 (DATABASE_URL 환경변수 부여)
- [ ] Step 4: 마이그레이션 자동 실행 확인 (006_lectures.sql 적용)
- [ ] Step 5: psql 로 lectures 테이블/jobs 변경 확인
- [ ] Step 6: 더미 사용자 + finance 강의 1개 데이터로 migrate_existing_lectures.py 실행 → lectures row 생성 확인
- [ ] Step 7: GET /api/lectures, GET /api/domains 호출해서 응답 정상 확인
- [ ] Step 8: 결과 보고

---

## 자체 점검 체크

- ✅ §3.1 lectures 스키마 → Task 4
- ✅ §3.2 jobs 확장 → Task 4
- ✅ §3.3 finance 자산 → Task 1
- ✅ §4 흐름 → Task 7
- ✅ §4.4 process_single_video → Task 3
- ✅ §4.5 detect_domain candidates → Task 2
- ✅ §5 API → Task 5, 6
- ✅ §6 UX → Task 9, 10, 11, 12, 13
- ✅ §7.1 SQL 마이그레이션 → Task 4
- ✅ §7.2 migrate_existing_lectures → Task 14
- ✅ §7.3 bootstrap_finance_domain → Task 1
- ✅ §10 테스트 → Task 15 (E2E 검증으로 통합)

각 task 의 구체 코드는 실행 시점에 작성한다 (사용자가 즉시 실행을 요청).
