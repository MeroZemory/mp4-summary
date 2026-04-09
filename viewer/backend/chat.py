"""
채팅 API — 세션 CRUD + SSE 스트리밍 + Auto-Compact
Ultra-Codex auto-compact 패턴 기반 구현
"""

import json
import os
import uuid
from datetime import datetime, timezone

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import require_user
from db import get_pool
from lecture_data import get_lecture
from qa_extraction import extract_qa_insight

# ── Config ──

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CHAT_MODEL = os.environ.get("CHAT_MODEL", "claude-sonnet-4-6")
LECTURE_CONTEXT_THRESHOLD = 6000  # 강의 전문/요약 전환 기준

# Auto-compact config
AUTO_COMPACT_TOKEN_LIMIT = int(os.environ.get("AUTO_COMPACT_TOKEN_LIMIT", "80000"))
COMPACT_KEEP_USER_TOKENS = 20_000  # 압축 시 보존할 최근 사용자 메시지 토큰
COMPACT_MODEL = os.environ.get("COMPACT_MODEL", CHAT_MODEL)

anthropic_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

router = APIRouter(prefix="/api/chat", tags=["chat"])

# ── Compaction prompt ──

COMPACTION_SYSTEM_PROMPT = """You are performing a CONTEXT CHECKPOINT COMPACTION.

당신은 강의 학습 도우미 채팅의 대화 히스토리를 압축하는 역할입니다.
지금까지의 대화를 다음 AI가 이어받을 수 있도록 핸드오프 요약을 작성하세요.

## 반드시 포함할 내용
- 사용자가 물어본 핵심 질문들과 그에 대한 답변 요약
- 대화 중 확립된 중요한 맥락, 제약 조건, 사용자 선호
- 아직 다루지 않은 내용이나 후속 질문이 예상되는 주제
- 인용된 타임스탬프 [HH:MM:SS]는 그대로 보존

## 형식
- 한국어로 작성, 영어 전문 용어는 원문 유지
- 구조화된 마크다운 (## 섹션, - 리스트)
- 간결하되 핵심 정보 누락 없이"""

COMPACTION_USER_PROMPT = """아래는 강의 학습 채팅의 전체 대화 히스토리입니다.
이 대화를 다음 AI가 이어받을 수 있도록 핸드오프 요약을 작성해주세요.

---
{conversation}
---"""

SUMMARY_PREFIX = """[이전 대화 요약]
다른 AI가 이 대화를 분석하고 아래 요약을 생성했습니다.
이 정보를 바탕으로 사용자의 질문에 계속 답변하세요.

"""


# ── Pydantic models ──

class CreateSessionRequest(BaseModel):
    lecture_id: str
    title: str | None = None

class UpdateSessionRequest(BaseModel):
    title: str

class SendMessageRequest(BaseModel):
    content: str


# ── Token estimation ──

def _estimate_tokens(text: str) -> int:
    """한국어+영어 혼합 텍스트의 토큰 수 추정"""
    return int(len(text) * 0.7)


# ── Lecture context builder ──

def build_system_prompt(lecture_id: str) -> str:
    """강의 컨텍스트를 포함한 system prompt 생성"""
    lecture = get_lecture(lecture_id)
    if not lecture:
        return "강의 데이터를 찾을 수 없습니다."

    corrected = lecture.get("corrected", [])
    summary = lecture.get("summary", {})

    full_text = "\n".join(f"[{s['time']}] {s['text']}" for s in corrected)
    tokens = _estimate_tokens(full_text)

    if tokens <= LECTURE_CONTEXT_THRESHOLD:
        context = full_text
        context_type = "전문 녹취록"
    else:
        parts = []
        overview = summary.get("overview", {})
        if overview.get("title"):
            parts.append(f"# {overview['title']}")
        if overview.get("summary"):
            parts.append(overview["summary"])

        concepts = summary.get("key_concepts", [])
        if concepts:
            parts.append("\n## 핵심 개념")
            for c in concepts:
                parts.append(f"- **{c['term']}** [{c.get('first_mention', '')}]: {c['explanation']}")

        timeline = summary.get("timeline", [])
        if timeline:
            parts.append("\n## 타임라인")
            for t in timeline:
                parts.append(f"- [{t['time']}~{t.get('end_time', '')}] {t['title']}: {t.get('description', '')}")

        context = "\n".join(parts) if parts else full_text
        context_type = "요약"

    return f"""당신은 약학/바이오 AI 강의의 학습 도우미입니다.
아래는 현재 강의의 {context_type}입니다.

{context}

## 응답 규칙
- 답변 시 관련 타임스탬프를 [HH:MM:SS] 형식으로 인용하세요.
- 한국어로 답변하되, 영어 전문 용어는 원문 유지하세요.
- 강의 내용에 기반하여 정확하게 답변하세요.
- 강의에서 다루지 않은 내용은 그렇다고 솔직히 말해주세요."""


# ═══════════════════════════════════════════════════════════
# Auto-Compact Engine
# ═══════════════════════════════════════════════════════════

def _select_recent_user_messages(messages: list[dict], max_tokens: int) -> list[dict]:
    """최근 사용자 메시지를 역순으로 max_tokens까지 선택 (codex 알고리즘)"""
    selected = []
    remaining = max_tokens

    for msg in reversed(messages):
        if msg["role"] != "user":
            continue
        msg_tokens = _estimate_tokens(msg["content"])
        if msg_tokens <= remaining:
            selected.append(msg)
            remaining -= msg_tokens
        else:
            # 부분 포함: 남은 토큰만큼 잘라서 추가
            if remaining > 100:  # 너무 짧으면 무의미
                char_limit = int(remaining / 0.7)
                selected.append({**msg, "content": msg["content"][-char_limit:]})
            break

    selected.reverse()  # 시간순 복원
    return selected


def _format_conversation_for_summary(messages: list[dict]) -> str:
    """대화 히스토리를 요약용 텍스트로 변환"""
    lines = []
    for msg in messages:
        role_label = "사용자" if msg["role"] == "user" else "AI"
        if msg.get("is_compaction"):
            role_label = "이전 요약"
        lines.append(f"[{role_label}]\n{msg['content']}\n")
    return "\n".join(lines)


async def _generate_compaction_summary(messages: list[dict]) -> str:
    """LLM을 호출하여 대화 요약 생성"""
    conversation_text = _format_conversation_for_summary(messages)

    try:
        response = anthropic_client.messages.create(
            model=COMPACT_MODEL,
            system=COMPACTION_SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": COMPACTION_USER_PROMPT.format(conversation=conversation_text),
            }],
            max_tokens=4000,
        )
        return response.content[0].text.strip()
    except Exception as e:
        print(f"  [Compact] 요약 생성 실패: {e}")
        return "(요약 생성 실패 — 이전 대화 내용을 참고하세요)"


async def run_auto_compact(session_id: str, messages: list[dict]) -> tuple[list[dict], str]:
    """
    Auto-compact 실행.
    Returns: (compacted_messages, summary_text)

    알고리즘 (Ultra-Codex 기반):
    1. 전체 대화를 LLM에 보내 핸드오프 요약 생성
    2. 최근 사용자 메시지를 역순 20K 토큰까지 선택
    3. DB에서 기존 메시지 삭제 → 요약 메시지 + 최근 메시지로 교체
    """
    print(f"  [Compact] 세션 {session_id[:8]}... 자동 압축 시작 (메시지 {len(messages)}개)")

    # 1. 요약 생성
    summary = await _generate_compaction_summary(messages)
    print(f"  [Compact] 요약 생성 완료 ({_estimate_tokens(summary)} 토큰 추정)")

    # 2. 최근 사용자 메시지 선택
    recent_user = _select_recent_user_messages(messages, COMPACT_KEEP_USER_TOKENS)
    print(f"  [Compact] 최근 사용자 메시지 {len(recent_user)}개 보존")

    # 3. DB 히스토리 교체
    pool = await get_pool()
    sid = uuid.UUID(session_id)

    async with pool.acquire() as conn:
        async with conn.transaction():
            # 기존 메시지 전부 삭제
            await conn.execute("DELETE FROM chat_messages WHERE session_id = $1", sid)

            # 요약 메시지 삽입 (is_compaction=true)
            summary_content = SUMMARY_PREFIX + summary
            await conn.execute(
                """INSERT INTO chat_messages (id, session_id, role, content, model, is_compaction)
                   VALUES ($1, $2, 'system', $3, $4, TRUE)""",
                uuid.uuid4(), sid, summary_content, COMPACT_MODEL,
            )

            # 보존할 최근 사용자 메시지 재삽입
            for msg in recent_user:
                await conn.execute(
                    "INSERT INTO chat_messages (id, session_id, role, content) VALUES ($1, $2, $3, $4)",
                    uuid.uuid4(), sid, msg["role"], msg["content"],
                )

            # 세션 토큰 카운터 리셋
            await conn.execute(
                "UPDATE chat_sessions SET total_tokens_used = 0 WHERE id = $1", sid,
            )

    # 4. 새 메시지 리스트 구성
    compacted = [
        {"role": "user", "content": summary_content},  # system→user로 변환하여 API에 전달
        *recent_user,
    ]

    print(f"  [Compact] 완료: {len(messages)}개 → {len(compacted)}개 메시지")
    return compacted, summary


async def _check_and_compact(session_id: str, messages: list[dict], total_tokens: int) -> tuple[list[dict], bool]:
    """
    Pre-sampling 체크: 토큰 한도 초과 시 자동 압축.
    Returns: (messages, was_compacted)
    """
    if total_tokens < AUTO_COMPACT_TOKEN_LIMIT:
        return messages, False

    if not anthropic_client:
        return messages, False

    compacted, _ = await run_auto_compact(session_id, messages)
    return compacted, True


# ═══════════════════════════════════════════════════════════
# Session CRUD
# ═══════════════════════════════════════════════════════════

@router.get("/sessions")
async def list_sessions(lecture_id: str | None = None, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        if lecture_id:
            rows = await conn.fetch(
                """SELECT id, lecture_id, title, total_tokens_used, created_at, updated_at
                   FROM chat_sessions WHERE user_id = $1 AND lecture_id = $2
                   ORDER BY updated_at DESC""",
                uuid.UUID(user["id"]), lecture_id,
            )
        else:
            rows = await conn.fetch(
                """SELECT id, lecture_id, title, total_tokens_used, created_at, updated_at
                   FROM chat_sessions WHERE user_id = $1
                   ORDER BY updated_at DESC LIMIT 50""",
                uuid.UUID(user["id"]),
            )
    return [
        {"id": str(r["id"]), "lecture_id": r["lecture_id"], "title": r["title"],
         "total_tokens": r["total_tokens_used"] or 0,
         "created_at": r["created_at"].isoformat(), "updated_at": r["updated_at"].isoformat()}
        for r in rows
    ]


@router.post("/sessions", status_code=201)
async def create_session(body: CreateSessionRequest, user: dict = Depends(require_user)):
    session_id = uuid.uuid4()
    title = body.title or "새 대화"
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO chat_sessions (id, user_id, lecture_id, title) VALUES ($1, $2, $3, $4)",
            session_id, uuid.UUID(user["id"]), body.lecture_id, title,
        )
    return {"id": str(session_id), "lecture_id": body.lecture_id, "title": title}


@router.patch("/sessions/{session_id}")
async def update_session(session_id: str, body: UpdateSessionRequest, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE chat_sessions SET title = $1 WHERE id = $2 AND user_id = $3",
            body.title, uuid.UUID(session_id), uuid.UUID(user["id"]),
        )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404)
    return {"ok": True}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2",
            uuid.UUID(session_id), uuid.UUID(user["id"]),
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════
# Messages + Streaming + Auto-Compact
# ═══════════════════════════════════════════════════════════

@router.get("/sessions/{session_id}/messages")
async def list_messages(session_id: str, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT user_id FROM chat_sessions WHERE id = $1", uuid.UUID(session_id),
        )
        if not owner or str(owner) != user["id"]:
            raise HTTPException(status_code=404)

        rows = await conn.fetch(
            """SELECT id, role, content, model, is_compaction, created_at
               FROM chat_messages WHERE session_id = $1 ORDER BY created_at""",
            uuid.UUID(session_id),
        )
    return [
        {"id": str(r["id"]), "role": r["role"], "content": r["content"],
         "model": r["model"], "is_compaction": r["is_compaction"] or False,
         "created_at": r["created_at"].isoformat()}
        for r in rows
    ]


@router.post("/sessions/{session_id}/messages")
async def send_message(session_id: str, body: SendMessageRequest, user: dict = Depends(require_user)):
    if not anthropic_client:
        raise HTTPException(status_code=501, detail="ANTHROPIC_API_KEY가 설정되지 않았습니다")

    pool = await get_pool()
    sid = uuid.UUID(session_id)

    async with pool.acquire() as conn:
        # Verify ownership + get lecture_id + total_tokens
        row = await conn.fetchrow(
            "SELECT user_id, lecture_id, total_tokens_used FROM chat_sessions WHERE id = $1", sid,
        )
        if not row or str(row["user_id"]) != user["id"]:
            raise HTTPException(status_code=404)
        lecture_id = row["lecture_id"]
        total_tokens = row["total_tokens_used"] or 0

        # Save user message
        await conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content) VALUES ($1, $2, 'user', $3)",
            uuid.uuid4(), sid, body.content,
        )

        # Load full history
        history_rows = await conn.fetch(
            "SELECT role, content, is_compaction FROM chat_messages WHERE session_id = $1 ORDER BY created_at",
            sid,
        )

    messages_raw = [
        {"role": r["role"], "content": r["content"], "is_compaction": r["is_compaction"] or False}
        for r in history_rows
    ]

    # ── Pre-sampling auto-compact check ──
    was_compacted = False
    messages_for_api = messages_raw

    if total_tokens >= AUTO_COMPACT_TOKEN_LIMIT:
        messages_for_api, was_compacted = await _check_and_compact(
            session_id, messages_raw, total_tokens,
        )

    # Build API messages (system role → user role for Anthropic API)
    api_messages = []
    for m in messages_for_api:
        role = "user" if m["role"] == "system" else m["role"]
        api_messages.append({"role": role, "content": m["content"]})

    # Deduplicate consecutive same-role messages (Anthropic requires alternating)
    deduped = []
    for msg in api_messages:
        if deduped and deduped[-1]["role"] == msg["role"]:
            deduped[-1]["content"] += "\n\n" + msg["content"]
        else:
            deduped.append(msg)
    # Ensure first message is user
    if deduped and deduped[0]["role"] != "user":
        deduped.insert(0, {"role": "user", "content": "(대화 시작)"})

    system_prompt = build_system_prompt(lecture_id)

    async def stream():
        full_response = ""
        tokens_in = 0
        tokens_out = 0

        # Notify client if compacted
        if was_compacted:
            yield f"data: {json.dumps({'compacted': True})}\n\n"

        try:
            with anthropic_client.messages.stream(
                model=CHAT_MODEL,
                system=system_prompt,
                messages=deduped,
                max_tokens=4000,
            ) as stream_resp:
                for text in stream_resp.text_stream:
                    full_response += text
                    yield f"data: {json.dumps({'text': text})}\n\n"

                final = stream_resp.get_final_message()
                tokens_in = final.usage.input_tokens
                tokens_out = final.usage.output_tokens

        except anthropic.RateLimitError:
            yield f"data: {json.dumps({'error': 'API 요청 한도 초과. 잠시 후 다시 시도해주세요.'})}\n\n"
            return
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return

        # Save assistant message + update token counter
        total_turn = tokens_in + tokens_out
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO chat_messages (id, session_id, role, content, model, tokens_in, tokens_out)
                   VALUES ($1, $2, 'assistant', $3, $4, $5, $6)""",
                uuid.uuid4(), sid, full_response, CHAT_MODEL, tokens_in, tokens_out,
            )
            await conn.execute(
                """UPDATE chat_sessions
                   SET updated_at = $1, total_tokens_used = total_tokens_used + $2
                   WHERE id = $3""",
                datetime.now(timezone.utc), total_turn, sid,
            )

        # Q&A insight extraction (before done, so client doesn't disconnect)
        insight_data = None
        import sys
        print(f"  [Chat] full_response length: {len(full_response)}, will extract: {bool(full_response)}", flush=True)
        if full_response:
            try:
                insight_data = await extract_qa_insight(
                    session_id=session_id,
                    lecture_id=lecture_id,
                    user_id=user["id"],
                    question=body.content,
                    answer=full_response,
                )
            except Exception as e:
                import traceback; traceback.print_exc()
                print(f"  [Insight] 추출 오류 (무시): {e}", flush=True)

        done_payload: dict = {'done': True, 'tokens_in': tokens_in, 'tokens_out': tokens_out, 'total_tokens': total_tokens + total_turn}
        if insight_data:
            done_payload['insight'] = insight_data
        yield f"data: {json.dumps(done_payload)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
