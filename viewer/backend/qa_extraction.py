"""
Q&A 인사이트 자동 추출 — 기존 학습 노트와 비교하여 병합/추가/무시 판단
"""

import asyncio
import json
import os
import uuid

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_user
from db import get_pool

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
INSIGHT_MODEL = os.environ.get("INSIGHT_MODEL", "claude-haiku-4-5-20251001")

_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

router = APIRouter(prefix="/api/insights", tags=["insights"])

# ── Extraction prompt ──

EXTRACTION_SYSTEM = """당신은 학습 노트 큐레이터입니다.
사용자가 AI 채팅에서 질문하고 답변을 받았습니다. 이 Q&A가 학습 노트에 어떻게 반영되어야 하는지 판단하세요.

## 기존 학습 노트
{existing_notes}

## 판단 규칙

1. **skip** — 다음 중 하나라도 해당되면:
   - 단순 인사, 확인, 감사 (학습 내용 없음)
   - 기존 노트에 이미 동일한 내용이 충분히 포함됨
   - 복습 가치가 없는 일시적 대화

2. **merge** — 기존 노트 중 하나를 보강해야 할 때:
   - 같은 개념에 대한 추가 설명/예시/디테일
   - 기존 항목의 내용을 더 풍부하게 만들 수 있음
   - `merge_target_id`에 보강할 기존 노트의 ID를 지정
   - `answer_summary`에 기존 내용 + 새 내용을 통합한 정리본 작성

3. **new** — 새 항목으로 추가해야 할 때:
   - 기존 노트에 없는 새로운 개념/원리/방법론
   - 독립적인 학습 가치가 있음

## 응답 형식 (JSON)
{"action": "skip"|"merge"|"new", "merge_target_id": "기존노트ID 또는 null", "question": "정제된 질문 (1줄)", "answer_summary": "정리된 핵심 답변 (2~4문장, 한국어, 영어 전문용어 유지)", "tags": ["관련 개념 1~3개"]}

action이 skip이면 나머지 필드는 빈 값으로."""

EXTRACTION_USER = """## 새 Q&A
사용자 질문: {question}
AI 답변: {answer}"""


# ── Helper: format existing notes for context ──

async def _get_existing_notes(user_id: str, lecture_id: str) -> tuple[str, dict[str, dict]]:
    """기존 accepted 노트를 텍스트 + ID맵으로 반환"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, question, answer_summary, tags
               FROM qa_insights WHERE user_id = $1 AND lecture_id = $2 AND status = 'accepted'
               ORDER BY created_at""",
            uuid.UUID(user_id), lecture_id,
        )

    if not rows:
        return "(아직 학습 노트가 없습니다)", {}

    lines = []
    note_map = {}
    for r in rows:
        nid = str(r["id"])
        tags_str = ", ".join(r["tags"] or [])
        lines.append(f"[ID: {nid}] Q: {r['question']} | A: {r['answer_summary']} | 태그: {tags_str}")
        note_map[nid] = {"question": r["question"], "answer_summary": r["answer_summary"], "tags": list(r["tags"] or [])}

    return "\n".join(lines), note_map


# ── Extraction logic ──

async def extract_qa_insight(
    session_id: str,
    lecture_id: str,
    user_id: str,
    question: str,
    answer: str,
) -> dict | None:
    """
    Q&A 쌍을 기존 노트와 비교하여 skip/merge/new 판단.
    merge: 기존 노트를 업데이트 (pending 확인 후)
    new: 새 노트 생성 (pending)
    Returns insight dict for frontend notification, or None.
    """
    if not _client:
        return None

    existing_text, note_map = await _get_existing_notes(user_id, lecture_id)

    system_prompt = EXTRACTION_SYSTEM.replace("{existing_notes}", existing_text)

    try:
        def _call_llm():
            return _client.messages.create(
                model=INSIGHT_MODEL,
                system=system_prompt,
                messages=[{
                    "role": "user",
                    "content": EXTRACTION_USER.format(question=question, answer=answer)
                        + "\n\nJSON으로만 응답하세요. 마크다운 코드블록 없이 순수 JSON만.",
                }],
                max_tokens=800,
                timeout=15.0,
            )
        print(f"  [Insight] LLM 호출 시작 (model={INSIGHT_MODEL})", flush=True)
        response = await asyncio.wait_for(asyncio.to_thread(_call_llm), timeout=20.0)
        print(f"  [Insight] LLM 호출 완료", flush=True)
        raw = response.content[0].text.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]  # remove first line
            if raw.endswith("```"):
                raw = raw[:-3].strip()
        # Find JSON object in response
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            raw = raw[start:end]
        result = json.loads(raw)
        if not isinstance(result, dict):
            print(f"  [Insight] LLM이 dict가 아닌 응답 반환: {type(result).__name__} = {str(result)[:100]}", flush=True)
            return None
        print(f"  [Insight] LLM 응답: action={result.get('action')}, worthy={result.get('worthy')}", flush=True)
    except Exception as e:
        print(f"  [Insight] 추출 ���패: {e}", flush=True)
        return None

    action = result.get("action", "skip")
    # Backward compat: if LLM uses "worthy" instead of "action"
    if "worthy" in result and "action" not in result:
        action = "new" if result["worthy"] else "skip"
    if action == "skip":
        print(f"  [Insight] skip — 학습 가치 없음", flush=True)
        return None

    refined_question = result.get("question", question)
    answer_summary = result.get("answer_summary", "")
    tags = result.get("tags", [])

    pool = await get_pool()

    if action == "merge" and result.get("merge_target_id"):
        target_id = result["merge_target_id"]
        # 기존 노트가 실제로 존재하는지 확인
        if target_id not in note_map:
            action = "new"  # fallback to new

    if action == "merge" and result.get("merge_target_id"):
        target_id = result["merge_target_id"]
        # pending 상태로 병합 제안 — 사용자가 승인하면 기존 노트를 업데이트
        insight_id = uuid.uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO qa_insights (id, user_id, session_id, lecture_id, question, answer_summary, tags, status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')""",
                insight_id, uuid.UUID(user_id), uuid.UUID(session_id),
                lecture_id, refined_question, answer_summary, tags,
            )
        return {
            "id": str(insight_id),
            "action": "merge",
            "merge_target_id": target_id,
            "question": refined_question,
            "answer_summary": answer_summary,
            "tags": tags,
        }

    # action == "new"
    insight_id = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO qa_insights (id, user_id, session_id, lecture_id, question, answer_summary, tags, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')""",
            insight_id, uuid.UUID(user_id), uuid.UUID(session_id),
            lecture_id, refined_question, answer_summary, tags,
        )
    return {
        "id": str(insight_id),
        "action": "new",
        "question": refined_question,
        "answer_summary": answer_summary,
        "tags": tags,
    }


# ── API endpoints ──

class UpdateInsightRequest(BaseModel):
    status: str  # 'accepted' or 'dismissed'


class AcceptMergeRequest(BaseModel):
    """merge 수락 시: 새 insight를 accepted로 바꾸고, 기존 target을 업데이트"""
    merge_target_id: str


@router.get("")
async def list_insights(lecture_id: str, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, lecture_id, question, answer_summary, tags, status, created_at
               FROM qa_insights WHERE user_id = $1 AND lecture_id = $2 AND status = 'accepted'
               ORDER BY created_at""",
            uuid.UUID(user["id"]), lecture_id,
        )
    return [
        {"id": str(r["id"]), "lecture_id": r["lecture_id"], "question": r["question"],
         "answer_summary": r["answer_summary"], "tags": list(r["tags"] or []),
         "status": r["status"], "created_at": r["created_at"].isoformat()}
        for r in rows
    ]


@router.get("/pending")
async def list_pending(user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, lecture_id, question, answer_summary, tags, created_at
               FROM qa_insights WHERE user_id = $1 AND status = 'pending'
               ORDER BY created_at DESC LIMIT 20""",
            uuid.UUID(user["id"]),
        )
    return [
        {"id": str(r["id"]), "lecture_id": r["lecture_id"], "question": r["question"],
         "answer_summary": r["answer_summary"], "tags": list(r["tags"] or []),
         "created_at": r["created_at"].isoformat()}
        for r in rows
    ]


@router.patch("/{insight_id}")
async def update_insight(insight_id: str, body: UpdateInsightRequest, user: dict = Depends(require_user)):
    if body.status not in ("accepted", "dismissed"):
        raise HTTPException(status_code=400, detail="status는 accepted 또는 dismissed만 가능")
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE qa_insights SET status = $1 WHERE id = $2 AND user_id = $3",
            body.status, uuid.UUID(insight_id), uuid.UUID(user["id"]),
        )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404)
    return {"ok": True}


@router.post("/{insight_id}/merge")
async def accept_merge(insight_id: str, body: AcceptMergeRequest, user: dict = Depends(require_user)):
    """merge 수락: 새 insight의 내용으로 기존 target을 업데이트, 새 insight는 삭제"""
    pool = await get_pool()
    uid = uuid.UUID(user["id"])
    iid = uuid.UUID(insight_id)
    tid = uuid.UUID(body.merge_target_id)

    async with pool.acquire() as conn:
        # 새 insight 가져오기
        new_row = await conn.fetchrow(
            "SELECT question, answer_summary, tags FROM qa_insights WHERE id = $1 AND user_id = $2",
            iid, uid,
        )
        if not new_row:
            raise HTTPException(status_code=404)

        # 기존 target 업데이트
        result = await conn.execute(
            """UPDATE qa_insights SET question = $1, answer_summary = $2, tags = $3
               WHERE id = $4 AND user_id = $5 AND status = 'accepted'""",
            new_row["question"], new_row["answer_summary"], new_row["tags"], tid, uid,
        )
        if result == "UPDATE 0":
            # target이 없으면 새 insight를 그냥 accepted로
            await conn.execute(
                "UPDATE qa_insights SET status = 'accepted' WHERE id = $1", iid,
            )
        else:
            # target 업데이트 성공 → 새 insight 삭제
            await conn.execute("DELETE FROM qa_insights WHERE id = $1", iid)

    return {"ok": True}


class BatchRequest(BaseModel):
    accept: list[str] = []
    dismiss: list[str] = []
    merges: list[dict] = []   # [{"id": "...", "merge_target_id": "..."}]
    edits: list[dict] = []    # [{"id": "...", "question": "...", "answer_summary": "...", "tags": [...]}]


@router.post("/batch")
async def batch_review(body: BatchRequest, user: dict = Depends(require_user)):
    """일괄 리뷰: 수락/거절/병합/편집을 단일 트랜잭션으로 처리"""
    uid = uuid.UUID(user["id"])
    pool = await get_pool()
    counts = {"accepted": 0, "dismissed": 0, "merged": 0, "edited": 0}

    async with pool.acquire() as conn:
        async with conn.transaction():
            # 1. Edits first (so accept/merge uses edited content)
            for edit in body.edits:
                eid = uuid.UUID(edit["id"])
                await conn.execute(
                    """UPDATE qa_insights SET question = $1, answer_summary = $2, tags = $3
                       WHERE id = $4 AND user_id = $5""",
                    edit.get("question", ""), edit.get("answer_summary", ""),
                    edit.get("tags", []), eid, uid,
                )
                counts["edited"] += 1

            # 2. Accept
            for aid in body.accept:
                result = await conn.execute(
                    "UPDATE qa_insights SET status = 'accepted' WHERE id = $1 AND user_id = $2 AND status = 'pending'",
                    uuid.UUID(aid), uid,
                )
                if result != "UPDATE 0":
                    counts["accepted"] += 1

            # 3. Dismiss
            for did in body.dismiss:
                result = await conn.execute(
                    "UPDATE qa_insights SET status = 'dismissed' WHERE id = $1 AND user_id = $2 AND status = 'pending'",
                    uuid.UUID(did), uid,
                )
                if result != "UPDATE 0":
                    counts["dismissed"] += 1

            # 4. Merges
            for m in body.merges:
                iid = uuid.UUID(m["id"])
                tid = uuid.UUID(m["merge_target_id"])
                row = await conn.fetchrow(
                    "SELECT question, answer_summary, tags FROM qa_insights WHERE id = $1 AND user_id = $2",
                    iid, uid,
                )
                if row:
                    result = await conn.execute(
                        """UPDATE qa_insights SET question = $1, answer_summary = $2, tags = $3
                           WHERE id = $4 AND user_id = $5 AND status = 'accepted'""",
                        row["question"], row["answer_summary"], row["tags"], tid, uid,
                    )
                    if result != "UPDATE 0":
                        await conn.execute("DELETE FROM qa_insights WHERE id = $1", iid)
                    else:
                        await conn.execute("UPDATE qa_insights SET status = 'accepted' WHERE id = $1", iid)
                    counts["merged"] += 1

    return {"ok": True, **counts}


@router.delete("/{insight_id}")
async def delete_insight(insight_id: str, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM qa_insights WHERE id = $1 AND user_id = $2",
            uuid.UUID(insight_id), uuid.UUID(user["id"]),
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404)
    return {"ok": True}
