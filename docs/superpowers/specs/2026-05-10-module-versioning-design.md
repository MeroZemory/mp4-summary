# 강의 시각화·정리 모듈 버저닝 + 재생성

## Goals

ShowMe(시각화)와 Notes(정리)의 4슬롯 — `show_me_gpt`, `show_me_claude`, `notes_gpt`, `notes_claude` — 을 사용자가 선택한 모델로 개별 재생성하고 버전을 누적한다. Viewer에서 최신 버전을 기본 표시하고, 드롭다운으로 이전 버전을 비교할 수 있다.

본 작업의 1차 목적은 새로 도입된 SVG 다이어그램 프롬프트의 결과를 즉시 검증할 수 있는 트리거를 마련하는 것이다.

## Non-goals

- 다른 6개 모듈(overview, key_concepts, timeline, study_guide 등)의 버저닝.
- 재생성 진행률 SSE 스트리밍 — 기존 jobs API 폴링으로 충분.
- 모델 후보의 동적 관리 UI — frontend 상수로 시작.
- 모델 비교 diff UI — 일반 드롭다운 전환만 지원.

## Architecture

### 데이터 모델 (storage)

**DB 마이그레이션 `007_module_versions.sql`** — 메타만 DB에 둔다.

```sql
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

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN ('full','stt','correct','summary','regen'));

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS regen_module     TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS regen_model_kind TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS regen_model_id   TEXT;
```

**파일 경로**: `output/versions/{lecture_stem}/{module}_{model_kind}_v{n}.md` — raw 마크다운 텍스트(SVG 코드 블록 포함). JSON wrapper 없음.

### 시드 (lazy backfill)

처음 `GET /api/lectures/{id}/versions` 호출 시 module_versions에 해당 lecture row가 0개면 `output/{stem}_summary_*.json`의 가장 최신 파일에서 4슬롯 텍스트를 추출해 v1 (`is_baseline=true`)로 자동 시드 + 파일 복사. 이후 호출은 시드 스킵.

### Worker / Job

`jobs.py`의 worker `_process` 에 `'regen'` 분기 추가:

1. corrected transcript 캐시 로드
2. `(module, model_kind, model_id)`에 맞는 LLM 호출 — `extract_and_correct.py`의 helper
3. 결과 파일 저장 + 다음 version 계산 (`MAX(version)+1`)
4. `module_versions` row insert
5. `refresh_lecture(lecture_id)` (in-memory 스토어 갱신)

### `extract_and_correct.py` 리팩터

기존 4개 함수를 `model_id` optional 인자로 받게 하고, 내부의 `_call_gpt_text`/anthropic 호출에서 model override를 사용한다. default = env (`LECTURE_GPT_MODEL`/`LECTURE_NOTES_MODEL`).

## API

```
POST /api/lectures/{id}/regenerate
  body: {module: 'show_me'|'notes', model_kind: 'gpt'|'claude', model_id?: string}
  response: {job_id: UUID}

GET /api/lectures/{id}/versions
  response: {
    show_me: {gpt: VersionMeta[], claude: VersionMeta[]},
    notes:   {gpt: VersionMeta[], claude: VersionMeta[]}
  }
  VersionMeta: {version, model_id, created_at, is_baseline, job_id}

GET /api/lectures/{id}/versions/{module}/{model_kind}/{version}
  response: {content: string, model_id, created_at, is_baseline}

GET /api/regen-models
  response: {gpt: ['gpt-5.5','gpt-5.4','gpt-5.4-mini'],
             claude: ['claude-opus-4-7','claude-sonnet-4-6','claude-haiku-4-5'],
             defaults: {gpt: 'gpt-5.5', claude: 'claude-opus-4-7'}}
```

## Viewer UX

ShowMe 패널 헤더에 추가:
- 모델 토글(기존 GPT/Opus) 우측에 `v{n} ▼` 드롭다운 — 활성 모델의 버전 리스트, 선택 시 해당 콘텐츠 표시.
- 우측 상단에 ↻ 재생성 버튼 — 클릭 시 작은 popover 열림: `[모델 선택 ▼] [재생성]`. 트리거 후 popover 닫고 헤더에 "재생성 중..." 인디케이터.
- 폴링: `GET /api/jobs/{job_id}` 2초 간격. status `completed` 시 versions 새로고침 + 최신 자동 선택.

Notes 패널도 동일 패턴.

## 동시성 / 에러

- 같은 lecture × 같은 module × 같은 model_kind 의 진행 중(`processing` 또는 `queued`) regen job 1개로 제한 (POST 시 409 반환).
- LLM 실패 시 jobs.error_message 기록 + module_versions row 미생성. 사용자는 frontend에서 toast로 확인.

## Testing

수동 E2E:
1. 운영 viewer에서 임의 강의 진입
2. ShowMe 패널 → 재생성 (gpt-5.5) → 1~2분 후 v2 dropdown에 노출, 자동 선택
3. v1과 v2 SVG 비교 (mermaid baseline ↔ 새 SVG)
4. Notes도 동일 시나리오

자동 테스트는 본 작업 범위 밖 (테스트 인프라 미정).

## 리스크

- LLM raw SVG 좌표 품질 편차 — 본 작업으로 해소되지 않음. 결과 보고 프롬프트 추가 튜닝.
- 운영 DB 마이그레이션 자동 적용 — `db.run_migrations`이 lifespan에서 실행. 첫 실행 분기에서 `_migrations` 테이블 미생성 버그가 있으나 모든 SQL이 idempotent라 실질 문제 없음 (운영은 이미 `_migrations` 보유 상태로 추정).
- baseline 시드 시 기존 summary JSON 미존재 lecture는 빈 4슬롯으로 시작 (v1 없음). 사용자가 처음 재생성 트리거하면 v1 부터 생김.
