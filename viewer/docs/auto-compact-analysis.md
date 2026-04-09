# Auto-Compact 기능 분석 (Ultra-Codex 참조)

> 출처: `/Users/merozemory/projects/MeroZemory/ultra-codex/src/codex-rs/core/src/compact.rs` 외
> 작성일: 2026-04-05
> 목적: 채팅 기능에 auto-compact 적용을 위한 레퍼런스

---

## 개요

대화 컨텍스트가 토큰 한도에 도달하면, LLM이 기존 대화를 자동 요약하고 요약 + 최근 사용자 메시지만 남겨 컨텍스트를 축소하는 기능.

```
[대화가 길어짐] → [토큰 한도 도달] → [LLM이 요약 생성] → [요약 + 최근 메시지로 교체]
```

---

## 1. 트리거 조건

| 트리거 | 시점 | 조건 |
|--------|------|------|
| Post-sampling | 턴 완료 후 | `total_tokens >= limit` AND 후속 턴 필요 |
| Pre-sampling | 턴 시작 전 | `total_tokens >= limit` |
| Model switch | 모델 교체 시 | 새 모델의 컨텍스트 윈도우가 더 작고 현재 토큰 초과 |

```python
auto_compact_limit = config.get("model_auto_compact_token_limit", float("inf"))
total_usage_tokens = session.get_total_token_usage()

if total_usage_tokens >= auto_compact_limit:
    run_auto_compact(session)
```

- 누적 토큰 사용량 기준 (단일 턴이 아닌 세션 전체)
- 미설정 시 무한대 → 비활성화

---

## 2. 보존 / 제거 대상

### 보존
- **최근 사용자 메시지**: 역순으로 최대 20,000 토큰
- **LLM 생성 요약**: 압축된 히스토리 대체
- **초기 컨텍스트**: 시스템 프롬프트, 프로젝트 문서 등
- **Ghost snapshots**: undo 기능용

### 제거
- 모든 assistant 응답
- 모든 developer 메시지
- 오래된 사용자 메시지 (20K 토큰 초과분)
- 도구 호출 결과

---

## 3. 압축 알고리즘

### Step 1: 최근 사용자 메시지 선택

```
COMPACT_USER_MESSAGE_MAX_TOKENS = 20,000

역순으로 순회 (최신 → 과거):
  남은_토큰 >= 메시지_토큰 → 전체 포함, 남은_토큰 차감
  남은_토큰 < 메시지_토큰  → 잘라서 포함, 중단
결과를 시간순으로 다시 정렬
```

### Step 2: LLM에 요약 요청

전체 대화 히스토리 + compaction 프롬프트를 LLM에 전달하여 핸드오프 요약 생성.

### Step 3: 새 히스토리 조립

```
새 히스토리 = [
  초기 컨텍스트 (시스템 프롬프트, 프로젝트 문서),
  선택된 최근 사용자 메시지,
  요약 메시지 (SUMMARY_PREFIX 첨부),
  ghost snapshots (undo용),
]
→ 기존 히스토리를 대체
```

---

## 4. 프롬프트

### Compaction Prompt (요약 생성 지시)

```
You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM
seamlessly continue the work.
```

### Summary Prefix (요약 삽입 시 접두어)

```
Another language model started to solve this problem and produced
a summary of its thinking process. You also have access to the state
of the tools that were used by that language model. Use this to build
on the work that has already been done and avoid duplicating work.
Here is the summary produced by the other language model, use the
information in this summary to assist with your own analysis:
```

---

## 5. 설정 옵션

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `model_auto_compact_token_limit` | i64 (optional) | ∞ (비활성) | 토큰 한도 도달 시 자동 압축 |
| `compact_prompt` | string (optional) | 내장 프롬프트 | 커스텀 요약 프롬프트 |
| `model_context_window` | i64 (optional) | 모델 기본값 | 컨텍스트 윈도우 오버라이드 |

---

## 6. 토큰 추적 구조

```
TotalTokenUsageBreakdown:
  last_api_response_total_tokens               # 마지막 API 응답의 총 토큰
  all_history_items_model_visible_bytes         # 히스토리 전체 크기 (바이트)
  estimated_tokens_since_last_response          # 마지막 응답 이후 추가 토큰 추정
```

- 매 API 응답 후 `update_token_usage_info()`로 갱신
- `chat_messages.tokens_in / tokens_out` 컬럼으로 누적 추적 가능

---

## 7. Inline vs Remote 압축

| 방식 | 대상 | 동작 |
|------|------|------|
| **Inline** | OpenAI 외 프로바이더 | 직접 요약 프롬프트를 보내서 LLM이 요약 생성 |
| **Remote** | OpenAI | OpenAI 서버 측 compaction API 활용, 반환된 히스토리에서 developer 메시지 제거 + 초기 컨텍스트 재주입 |

---

## 8. 에러 처리

| 상황 | 처리 |
|------|------|
| 컨텍스트 초과 | 가장 오래된 히스토리부터 제거 후 재시도 |
| 요약 생성 실패 | `"(no summary available)"` 대체 |
| 사용자 메시지 없음 | 초기 컨텍스트 + 요약만으로 구성 |
| 모델 전환 중 | 이전 모델 한도로 먼저 압축 후 전환 |

---

## 9. 참조 파일

| 파일 | 내용 |
|------|------|
| `ultra-codex/.../compact.rs` (1133줄) | 인라인 압축 핵심 로직 |
| `ultra-codex/.../compact_remote.rs` (220줄) | OpenAI 원격 압축 |
| `ultra-codex/.../codex.rs` (4200-4570행) | 트리거 결정 로직 |
| `templates/compact/prompt.md` | 요약 프롬프트 |
| `templates/compact/summary_prefix.md` | 요약 접두어 |
| `tests/suite/compact.rs` | 테스트 케이스 |

---

## 10. 우리 채팅에 적용 계획

### 현재 상태
- `chat_messages` 테이블에 `tokens_in`, `tokens_out` 이미 추적 중
- Claude Sonnet 4.6 사용 (200K 컨텍스트 윈도우)
- 적응형 컨텍스트: 짧은 강의 전문, 긴 강의 요약

### 적용 방안

```python
# chat.py에 추가

AUTO_COMPACT_LIMIT = 50_000  # Sonnet 기준 보수적 한도
COMPACT_USER_MSG_MAX_TOKENS = 20_000

async def maybe_compact(session_id: str, messages: list[dict]) -> list[dict]:
    """토큰 한도 초과 시 자동 압축"""
    total = sum((m.get("tokens_in", 0) or 0) + (m.get("tokens_out", 0) or 0) for m in messages)
    if total < AUTO_COMPACT_LIMIT:
        return messages  # 압축 불필요

    # 1. 최근 사용자 메시지 선택 (역순 20K 토큰)
    recent_user = select_recent_user_messages(messages, COMPACT_USER_MSG_MAX_TOKENS)

    # 2. LLM으로 요약 생성
    summary = await generate_compaction_summary(messages)

    # 3. DB 히스토리 교체
    await replace_session_history(session_id, recent_user, summary)

    # 4. 새 메시지 리스트 반환
    return [
        {"role": "assistant", "content": f"[컨텍스트 압축됨]\n\n{summary}"},
        *recent_user,
    ]
```

### 구현 순서
1. `chat.py`에 토큰 합산 로직 추가
2. `COMPACTION_PROMPT` 한국어로 작성
3. `maybe_compact()` 함수 구현
4. `send_message` 핸들러에서 히스토리 로드 후 `maybe_compact` 호출
5. DB에 압축 이력 기록 (어떤 메시지가 압축되었는지)
6. 프론트엔드에 "컨텍스트가 압축되었습니다" 안내 표시
