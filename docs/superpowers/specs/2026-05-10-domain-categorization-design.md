# 도메인 카테고리화 설계 (Domain Categorization)

- 작성일: 2026-05-10
- 대상 코드베이스: `mp4-summary`
- 변경 범위: 백엔드 (FastAPI / asyncpg / SQL), 프론트 (React / TypeScript), 처리 파이프라인 (`extract_and_correct.py`, `domain_detector.py`), 마이그레이션 스크립트, 프롬프트 자산

## 1. 배경과 목표

### 1.1 현재 상태

- `domain_detector.py` 가 HyQE (키워드 추출 → 임베딩 → 코사인 유사도) 로 도메인을 자동 감지한다
- `prompts/domains.json` 에는 `pharmaceutical` 만 등록되어 있고, `generic` 폴백이 존재한다
- 금융 도메인 강의는 별도 프롬프트가 없어 `generic` 으로 코렉션되고 있다
- 처리 파이프라인은 사용자 개입 없이 STT → 도메인 자동 감지 → 코렉션 → 요약을 한 번에 실행한다
- `viewer/` 의 사이드바 강의 목록은 도메인 분류 없이 일렬로 노출된다
- DB 에는 `lectures` 개념이 없고 `jobs` 한 테이블에 처리 단위가 들어 있다

### 1.2 목표

1. 도메인별로 강의를 그룹화하여 노출한다 (금융 / 제약·생의학 / 분류 보류 / 분류 안 함)
2. 도메인 자동 감지 결과를 사용자가 항상 확인하고 확정하도록 한다 (UX 측에서 잘못된 도메인으로 코렉션되는 사고 방지)
3. 도메인을 사후에 변경하면 코렉션·요약을 다시 생성한다
4. 기존에 코렉션이 끝난 강의들은 모두 `finance` 라벨로 일괄 마이그레이션한다 (재코렉션 없음)
5. 신규 도메인(`finance`)을 자산 (키워드 시그니처 + 코렉션 프롬프트 + 임베딩) 까지 포함해 추가한다

### 1.3 비목표

- 채팅·북마크·QA 추출 등 다른 기능의 변경
- 강의 단위 권한 공유 (강의는 업로드한 사용자에게만 귀속)
- 도메인 자동 학습 (사용자가 confirm 한 도메인을 통계 학습으로 활용하는 것)
- 단일 강의를 동시 여러 도메인으로 보유 (다중 라벨 없음, 1 강의 = 1 도메인)

## 2. 핵심 결정 요약

| 결정 | 값 | 근거 |
|------|-----|------|
| 컨펌 흐름 | STT 후 항상 `awaiting_domain` 으로 일시정지 | 잘못된 도메인으로 코렉션되는 사고 방지 |
| job 모델 | Multi-Job (`stt` / `correct` / `summary` 분리) | 도메인 변경 시 깔끔한 재코렉션, 단계별 retry 의미 명확 |
| 데이터 저장 | 새 `lectures` 테이블이 진실 소스 | 강의 메타와 처리 이력 분리 |
| 사이드바 UI | 도메인별 그룹 헤더 (접기·펼치기) | 그룹 간 비교/이동 자연스러움 |
| 컨펌 UI 위치 | 업로드 패널 안 job 카드 인라인 | 폴링 주기와 자연스럽게 결합 |
| 고신뢰도 처리 | 신뢰도와 무관하게 항상 사용자 confirm | 일관성, 자동 진행 사고 방지 |
| 미확정 강의 노출 | `분류 보류` 그룹으로 사이드바에 표시 | 누락 방지 |
| 기존 강의 처리 | 모두 `finance` 라벨, 재코렉션 X | 비용/시간 절감, 사용자 명시 결정 |
| `finance` 자산 | 기존 raw transcript 에서 자동 생성 후 검토 | 실제 어휘 반영 |

## 3. 데이터 모델

### 3.1 새 테이블 `lectures`

강의 1개 = `lectures` 1 row. 강의의 단일 진실 소스.

```sql
CREATE TABLE lectures (
  id              TEXT PRIMARY KEY,                  -- = filename stem (기존 lecture_id 와 동일)
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  original_name   TEXT NOT NULL,
  domain_id       TEXT,                              -- NULL = 미확정. 'finance', 'pharmaceutical', 'generic' 등
  domain_status   TEXT NOT NULL DEFAULT 'pending'
                  CHECK (domain_status IN ('pending','confirmed','overridden')),
  domain_source   TEXT,                              -- 'auto' | 'user' | 'migration'
  detected_domain_id TEXT,                           -- 자동 감지 결과 (참고용, confirm 후에도 보존)
  detected_confidence REAL,
  detected_top_candidates JSONB,                     -- [{"id":"finance","score":0.78}, ...]
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lectures_user_domain ON lectures(user_id, domain_id);
```

`domain_status` 의 의미:
- `pending` — 아직 사용자 confirm 전 (또는 STT 도 아직)
- `confirmed` — 사용자가 처음 도메인을 확정함
- `overridden` — 사용자가 한 번 confirm 한 도메인을 다시 변경함

### 3.2 `jobs` 테이블 변경

기존 `jobs` 는 "강의 1개 처리" 단위였으나, 이제 "처리 단계 1개" 단위로 재정의한다.

```sql
ALTER TABLE jobs
  ADD COLUMN job_type TEXT NOT NULL DEFAULT 'full'
    CHECK (job_type IN ('full','stt','correct','summary')),
  ADD COLUMN parent_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued','processing','awaiting_domain','completed','failed','canceled'));
```

- `job_type='full'` 은 마이그레이션 호환을 위해 남기되 신규 INSERT 에서는 사용하지 않는다
- `parent_job_id` 는 stt → correct → summary 의 부모 추적에 사용
- 새 status 값 `awaiting_domain` 은 stt job 전용 종착지 (워커 슬롯은 해제됨, 사용자 액션 대기)

### 3.3 도메인 레지스트리

`prompts/domains.json` 에 `finance` 추가, `embedding_model` / `similarity_threshold` 는 그대로:

```json
{
  "domains": [
    { "id": "finance", "name": "금융", "keywords": ["..."] },
    { "id": "pharmaceutical", "name": "제약·생의학", "keywords": ["..."] }
  ],
  "embedding_model": "text-embedding-3-small",
  "similarity_threshold": 0.45
}
```

대응 자산:
- `prompts/finance/system.md`, `prompts/finance/user.md`
- `embeddings_cache/finance.json` (precompute 결과)

## 4. 처리 흐름

### 4.1 신규 업로드 정상 흐름

```
[1] User uploads MP4
     POST /api/jobs/upload
     → INSERT lectures (id=stem, domain_status='pending')
     → INSERT jobs (job_type='stt', status='queued', lecture_id=stem)

[2] Worker claims STT job
     → status='processing', stage='extracting'
     → extract_audio()
     → transcribe_audio_parallel()        # raw transcript 캐시 저장
     → detect_domain()                    # 결과를 lectures.detected_* 에 기록
     → status='awaiting_domain', stage='awaiting_user'
     → 워커 슬롯 즉시 해제, 다음 job 처리

[3] User confirms domain (UploadPanel 카드 안에서)
     POST /api/lectures/{id}/domain  { domain_id: "finance", source: "user" }
     → UPDATE lectures SET domain_id=..., domain_status='confirmed', domain_source='user'
     → UPDATE jobs SET status='completed' WHERE id=<stt job>
     → INSERT jobs (job_type='correct', status='queued', parent_job_id=<stt>)
     → notify_queue_change()

[4] Worker claims correct job
     → process_single_video(stages=["correct"], forced_domain_id=lectures.domain_id)
       (raw transcript 캐시에서 자동 로드)
     → 코렉션 결과 저장
     → status='completed'
     → 같은 트랜잭션에서 INSERT jobs (job_type='summary', status='queued', parent_job_id=<correct>)

[5] Worker claims summary job
     → process_single_video(stages=["summary"])  # corrected transcript 캐시 로드
     → 완료 → refresh_lecture(lecture_id)
```

### 4.2 도메인 변경 흐름

```
강의 페이지에서 "도메인 변경" 버튼
     POST /api/lectures/{id}/domain  { domain_id: "pharmaceutical", source: "user" }
     → UPDATE lectures SET domain_id='pharmaceutical', domain_status='overridden'
     → INSERT jobs (job_type='correct', status='queued')
     → 워커가 다시 코렉션 → summary job 자동 큐잉 → 결과 덮어씀
```

새 도메인이 기존과 동일하면 INSERT 안 함, lectures 만 업데이트.

### 4.3 워커 행동

기존 `WorkerManager._claim_next` 가 `status='queued'` 만 잡는다. `awaiting_domain` 은 클레임 대상이 아님. 사용자가 confirm POST 하면 새 correct job 이 queued 로 들어가 워커가 자연스럽게 잡는다.

`_recover_stale` 은 `processing → queued` 만 수행. `awaiting_domain` 은 사용자 액션을 기다리는 정상 상태이므로 손대지 않는다.

### 4.4 `process_single_video` 시그니처 변경

```python
def process_single_video(
    mp4_path: Path,
    stages: list[str] | None = None,
    forced_domain_id: str | None = None,   # confirmed lectures.domain_id
) -> dict:
    ...
    if "correct" in stages:
        if forced_domain_id is not None:
            domain = DomainMatch(forced_domain_id, 1.0, *_load_domain_prompts(forced_domain_id), candidates=[])
        elif DOMAIN_DETECTION == "auto":
            domain = detect_domain(...)
        ...
```

`stt` 단계만 호출하는 경로에서는 `detect_domain` 을 호출하고, 결과를 함수 반환값(`{"domain_id":..., "confidence":..., "candidates":[...]}`)으로 워커에 전달해 워커가 `lectures` 테이블에 기록한다.

### 4.5 `domain_detector.detect_domain` 시그니처 변경

```python
class DomainMatch(NamedTuple):
    domain_id: str
    confidence: float
    system_prompt: str
    user_prompt: str
    candidates: list[tuple[str, float]]   # (domain_id, score) 높은 순. generic 제외
```

캐시 파일에도 `candidates` 를 저장하도록 확장.

## 5. 백엔드 API

### 5.1 새 엔드포인트

```
POST /api/lectures/{lecture_id}/domain
  Body : { domain_id: string, source: "user" }
  Auth : require_user, lecture 소유자만
  동작 :
    - lectures 의 domain_id 가 바뀌었거나 처음 confirm 이면 새 correct job INSERT
    - 동일 도메인으로 재confirm 이면 lectures 만 업데이트
    - 등록되지 않은 domain_id 면 400
  응답 : { lecture_id, domain_id, domain_status, queued_job_id?: string }

GET /api/lectures
  Auth : require_user (자기 강의만)
  응답 : [{
    id, original_name,
    domain_id, domain_status, domain_source,
    detected_domain_id, detected_confidence, detected_top_candidates,
    has_corrected, has_summary,            # lecture_data 메모리 상태에서 파생
    latest_job_status, latest_job_type,    # jobs 에서 lecture_id 별 최신 행 join
    created_at, updated_at
  }]

GET /api/lectures/{lecture_id}
  Auth : require_user, lecture 소유자만
  응답 : 위와 동일한 단일 객체

GET /api/domains
  Auth : require_user
  응답 : [
    { id: "finance", name: "금융", description?: string },
    { id: "pharmaceutical", name: "제약·생의학", description?: string },
    { id: "generic", name: "분류 안 함", description: "특수 도메인 없이 일반 코렉션" }
  ]
  소스 : prompts/domains.json + generic 항목 추가
```

### 5.2 변경되는 엔드포인트

```
POST /api/jobs/upload
  변경 : lectures INSERT (pending) + jobs INSERT (job_type='stt')

GET /api/jobs
  변경 : 응답에 job_type 추가. UI는 lecture_id 로 카드 그루핑.

DELETE /api/jobs/{id}
  변경 없음. queued 일 때만 취소.
```

### 5.3 인증/권한

모든 신규 엔드포인트는 `require_user` 사용. lecture 접근 시 `WHERE user_id = $current_user`.

## 6. 프론트 UX

### 6.1 사이드바 강의 목록

```
▼ 금융 (12)
   📘 KB 증권 분석
   📘 채권시장 동향
   ...
▼ 제약 / 생의학 (3)
   📘 Drug discovery
   ...
▶ 분류 보류 (2)  ⚠️
▶ 분류 안 함 (1)
```

- 그룹 헤더 클릭으로 접기/펼치기, 상태는 `localStorage` 저장
- 카운트 옆 `⚠️` 는 해당 그룹에 사용자 confirm 이 필요한 강의가 있을 때
- 그룹 정렬: 등록된 도메인 그룹들끼리 강의 수 내림차순 → 그 뒤에 "분류 보류" → 마지막에 "분류 안 함" (등록된 도메인의 강의 수와 무관하게 보류/generic 은 항상 끝쪽)
- 그룹 내 정렬: `created_at DESC`

매핑:
- `domain_status='pending'` → "분류 보류"
- `domain_id='generic'` → "분류 안 함"
- 그 외 → 해당 도메인 그룹

### 6.2 업로드 패널 — awaiting 카드 인라인 컨펌

```
📄 KB증권_Q4분석.mp4
   ┌─ 도메인 컨펌 필요 ─────────────────────┐
   │ 자동 감지: 금융  (신뢰도 0.78)         │
   │ [ 금융 ✓ ] [ 제약/생의학 ] [ 더보기 ▾ ] │
   │             [ 분류 안 함으로 진행 ]    │
   └────────────────────────────────────────┘
```

- 추천 도메인 chip 강조 (border + check), 클릭 시 confirm POST
- "더보기" 드롭다운 = `GET /api/domains` 의 나머지
- "분류 안 함" = `domain_id='generic'` 으로 confirm
- confirm 직후 카드 상태가 "코렉션 대기" 로 갱신, 5초 폴링으로 진행 반영
- 자동 감지 실패 (`detected_domain_id=NULL`) 시: "자동 감지 실패, 직접 선택해주세요" 안내 + 전체 도메인 목록을 그 자리에 표시

### 6.3 강의 페이지 — 도메인 배지 + 변경

```
[KB 증권 분석]   🏷 금융   [변경 ▾]
```

- "변경" 클릭 → `DomainPicker` 동일 UI
- 변경 confirm 시 경고: "도메인을 바꾸면 코렉션과 요약이 다시 생성됩니다. 진행하시겠습니까?"
- 진행 중에는 페이지 상단 배너 "코렉션 다시 생성 중..." (강의 페이지는 5초 폴링으로 lecture 상태 추적)

### 6.4 컴포넌트 분리 (App.tsx 압박 대응)

도메인 작업과 직접 닿는 부분만 추출. 전체 리팩터는 스코프 밖.
- `components/DomainPicker.tsx` — chip + 드롭다운 (UploadPanel + 강의 페이지 공용)
- `components/LectureSidebar.tsx` — 그룹화된 사이드바
- `hooks/useLectures.ts` — `/api/lectures` 폴링 + 그루핑 로직

App.tsx 본체는 import 만 늘어난다.

## 7. 마이그레이션

### 7.1 DB 마이그레이션 (`006_lectures.sql`)

서버 기동 시 자동 실행 (`db.run_migrations()`).

```sql
-- 1) lectures 테이블 신설 (정의는 §3.1 참조)
CREATE TABLE IF NOT EXISTS lectures (...);
CREATE INDEX IF NOT EXISTS idx_lectures_user_domain ON lectures(user_id, domain_id);

-- 2) jobs 확장 (정의는 §3.2 참조)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'full' CHECK (...);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (...);

-- 3) jobs 에 흔적 있는 강의를 lectures 로 백필 (모두 finance 라벨)
INSERT INTO lectures (id, user_id, original_name, domain_id, domain_status, domain_source)
SELECT DISTINCT ON (lecture_id)
       lecture_id, user_id, original_name,
       'finance', 'confirmed', 'migration'
FROM jobs
WHERE lecture_id IS NOT NULL
ORDER BY lecture_id, created_at DESC
ON CONFLICT (id) DO NOTHING;
```

### 7.2 일회성 스크립트 — 기존 output/ 강의 백필

`scripts/migrate_existing_lectures.py` (새 파일, 수동 실행):

- `LECTURE_DATA_DIR` 스캔 → `*_corrected_*.json` 파일에서 base name 추출
- `jobs` 테이블에 흔적이 없는 base name 들 식별
- 환경변수 `MIGRATION_USER_EMAIL` 로 owner 사용자 lookup
  - 없으면 에러 종료 ("환경변수 MIGRATION_USER_EMAIL 설정 필요")
  - 사용자 존재 안 하면 에러 종료
- 각 base name 에 대해 `lectures` 에 INSERT (`domain_id='finance'`, `domain_status='confirmed'`, `domain_source='migration'`, `original_name=base_name`)
- `ON CONFLICT DO NOTHING` 으로 idempotent

실행 예: `docker compose exec viewer python /app/backend/scripts/migrate_existing_lectures.py`

### 7.3 일회성 스크립트 — `finance` 도메인 자산 부트스트랩

`scripts/bootstrap_finance_domain.py` (새 파일, 수동 실행):

1. `lecture_data/` 에서 `*_raw_transcript_*.json` 로드 (사용자가 인자로 base name 목록 전달)
2. 각 강의에서 sample (앞 15 + 중간 5 세그먼트) → `gpt-4.1-nano` 키워드 추출
3. 모든 강의의 키워드 합치고 빈도 정렬 → 상위 ~40개를 `finance` 시그니처로 출력
4. `prompts/finance/system.md`, `user.md` 를 LLM 으로 초안 작성 (pharmaceutical 템플릿 참고)
5. `prompts/domains.json` 에 finance 항목 추가 제안 (직접 수정은 안 함, 표준 출력으로 패치 제안만)
6. 사용자가 결과를 검토하고 `prompts/` 변경을 수동 commit

이 스크립트는 idempotent 하지 않다 — 매 실행 시 결과 출력만 함.

### 7.4 임베딩 사전 계산

`prompts/domains.json` 에 finance 가 commit 된 후:

```bash
python domain_detector.py --precompute
```

→ `embeddings_cache/finance.json` 생성

### 7.5 운영자가 따라야 할 마이그레이션 순서

1. 코드 머지 + 컨테이너 재기동 → `006_lectures.sql` 자동 실행
2. `docker compose exec viewer python /app/backend/scripts/migrate_existing_lectures.py`  (필요한 경우)
3. `python scripts/bootstrap_finance_domain.py <강의 base 이름들>`  → 결과 검토 후 `prompts/finance/*` 수동 작성/commit
4. `prompts/domains.json` 에 finance 추가 commit
5. `python domain_detector.py --precompute` 실행
6. UI 에서 사이드바 그룹 확인, 필요 시 보류 강의 confirm

## 8. 에러 처리

| 상황 | 처리 |
|------|------|
| 도메인 감지 API 실패 (OpenAI 에러) | stt job 은 `awaiting_domain` 으로 진입, `detected_domain_id=NULL`. UI 는 "자동 감지 실패, 직접 선택해주세요" 안내 |
| 등록되지 않은 `domain_id` 로 confirm | 400 응답, "등록되지 않은 도메인" |
| confirm 후 correct job 도중 실패 | jobs.failed, lecture 는 `confirmed` 유지. UI 에 "재시도" 버튼 → 새 correct job 만 큐잉 |
| 동일 도메인으로 재 confirm | correct job 큐잉 안 함, lectures 의 status/source 만 갱신 |
| `awaiting_domain` 강의 장기 방치 | 자동 처리 안 함. 사용자가 명시적으로 confirm 할 때까지 대기 |
| 워커 재시작 중 stt job 처리 도중 | `_recover_stale` 이 `processing → queued` 복구. `awaiting_domain` 은 손대지 않음 |
| 동시 confirm 충돌 | 단순 last-write-wins (단일 사용자만 접근 가능하므로 충돌 가능성 낮음) |
| lectures 행은 있는데 raw transcript 캐시가 없음 | correct job 워커가 raise → jobs.failed. 사용자에게 재처리 안내 (현재는 수동) |

## 9. 보안 / 권한

- 모든 lecture/job/도메인 엔드포인트는 `require_user`
- lecture 조회/변경은 `WHERE user_id = $current_user` 필수
- `POST /api/lectures/{id}/domain` 의 `domain_id` 는 등록된 도메인 ID 화이트리스트 검증 (디렉토리 traversal 방지)
- 마이그레이션 스크립트는 컨테이너 안에서 admin 권한으로 직접 실행 (외부 노출 X)

## 10. 테스트 계획

### 10.1 백엔드

- `lectures` CRUD + 권한 테스트 (다른 사용자 데이터 접근 차단)
- `POST /api/lectures/{id}/domain` :
  - 처음 confirm → status='confirmed', correct job 큐잉됨
  - 동일 도메인으로 재 confirm → 큐잉 안 됨
  - 다른 도메인으로 변경 → status='overridden', correct job 큐잉됨
  - 등록 안 된 도메인 → 400
- 워커 단위 테스트 :
  - stt job 완료 후 awaiting_domain 으로 멈추는지
  - confirm 후 correct job 자동 잡는지
  - correct 완료 후 summary job 자동 INSERT 되는지
  - awaiting_domain 은 `_recover_stale` 에서 건드리지 않는지

### 10.2 처리 파이프라인

- `process_single_video(stages=["stt"])` 가 raw transcript 까지만 만들고 도메인 감지 결과를 반환하는지
- `process_single_video(stages=["correct"], forced_domain_id="finance")` 가 finance 프롬프트로 코렉션하는지
- `forced_domain_id` 가 있을 때 `detect_domain` 이 호출되지 않는지

### 10.3 프론트

- `DomainPicker` Storybook/단위 테스트
- 사이드바 그루핑 로직 (`useLectures` 훅) 단위 테스트
- E2E (Playwright) :
  - MP4 업로드 → 카드에 awaiting 인라인 출력 → 도메인 chip 클릭 → 카드가 "코렉션 대기" 로 전환 → 완료 시 사이드바 해당 도메인 그룹에 등장
  - 강의 페이지에서 도메인 변경 → 경고 → confirm → 코렉션 다시 생성 배너 → 완료

### 10.4 마이그레이션

- `006_lectures.sql` 빈 DB / 기존 jobs 가 있는 DB 두 시나리오에서 실행
- `migrate_existing_lectures.py` :
  - MIGRATION_USER_EMAIL 미설정 시 에러
  - idempotent (두 번 실행해도 중복 없음)

## 11. 스코프 외 / 후속 작업

- `App.tsx` 전반 리팩터 (지금은 도메인 관련 부분만 추출)
- 도메인 자동 학습 (사용자 confirm 패턴으로 신뢰도 임계값 자동 조정)
- 단일 강의 다중 도메인 라벨링
- 강의 단위 권한 공유
- 사용자가 새 도메인을 UI 에서 추가하는 기능 (현재는 운영자가 prompts/ 작업)

## 12. 변경되는 파일 (개략)

- 신설 : `viewer/backend/migrations/006_lectures.sql`, `viewer/backend/lectures.py`, `viewer/backend/domains.py`, `scripts/migrate_existing_lectures.py`, `scripts/bootstrap_finance_domain.py`, `prompts/finance/{system,user}.md`, `embeddings_cache/finance.json`, `viewer/frontend/src/components/DomainPicker.tsx`, `viewer/frontend/src/components/LectureSidebar.tsx`, `viewer/frontend/src/hooks/useLectures.ts`
- 변경 : `viewer/backend/server.py`, `viewer/backend/jobs.py`, `viewer/backend/lecture_data.py`, `viewer/backend/db.py`, `domain_detector.py`, `extract_and_correct.py`, `prompts/domains.json`, `viewer/frontend/src/App.tsx`
