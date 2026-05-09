"""
강의(lectures) API 라우터.

- GET    /api/lectures            현재 사용자의 모든 강의 (lecture_data join)
- GET    /api/lectures/{id}       단일 강의 상세
- POST   /api/lectures/{id}/domain 도메인 confirm/변경 (필요 시 correct job 큐잉)
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import require_user
from db import get_pool
from domains import is_valid_domain_id
from lecture_data import lecture_artifacts

router = APIRouter(prefix="/api/lectures", tags=["lectures"])


# ── 응답 모델 ─────────────────────────────────────────────────────────────────

class LectureCandidate(BaseModel):
    domain_id: str
    score: float


class LectureResponse(BaseModel):
    id: str
    original_name: str
    domain_id: str | None
    domain_status: str
    domain_source: str | None
    detected_domain_id: str | None
    detected_confidence: float | None
    detected_top_candidates: list[LectureCandidate] = Field(default_factory=list)
    has_corrected: bool
    has_summary: bool
    latest_job_status: str | None
    latest_job_type: str | None
    latest_job_id: str | None
    created_at: str
    updated_at: str


class DomainConfirmRequest(BaseModel):
    domain_id: str
    source: Literal["user"] = "user"


class DomainConfirmResponse(BaseModel):
    lecture_id: str
    domain_id: str
    domain_status: str
    queued_job_id: str | None = None


# ── 헬퍼 ──────────────────────────────────────────────────────────────────────

def _row_to_lecture(
    row: asyncpg.Record,
    artifacts: dict,
    latest_job: asyncpg.Record | None,
) -> LectureResponse:
    raw_candidates = row["detected_top_candidates"] or []
    if isinstance(raw_candidates, str):
        try:
            raw_candidates = json.loads(raw_candidates)
        except json.JSONDecodeError:
            raw_candidates = []
    candidates = [
        LectureCandidate(domain_id=c.get("domain_id", ""), score=float(c.get("score", 0.0)))
        for c in raw_candidates
        if isinstance(c, dict)
    ]
    return LectureResponse(
        id=row["id"],
        original_name=row["original_name"],
        domain_id=row["domain_id"],
        domain_status=row["domain_status"],
        domain_source=row["domain_source"],
        detected_domain_id=row["detected_domain_id"],
        detected_confidence=row["detected_confidence"],
        detected_top_candidates=candidates,
        has_corrected=artifacts["has_corrected"],
        has_summary=artifacts["has_summary"],
        latest_job_status=latest_job["status"] if latest_job else None,
        latest_job_type=latest_job["job_type"] if latest_job else None,
        latest_job_id=str(latest_job["id"]) if latest_job else None,
        created_at=row["created_at"].isoformat(),
        updated_at=row["updated_at"].isoformat(),
    )


async def _fetch_latest_jobs(
    conn: asyncpg.Connection, user_id: uuid.UUID, lecture_ids: list[str]
) -> dict[str, asyncpg.Record]:
    """각 lecture_id 별 최신 job 한 행씩 (DISTINCT ON)."""
    if not lecture_ids:
        return {}
    rows = await conn.fetch(
        """
        SELECT DISTINCT ON (lecture_id)
               lecture_id, id, status, job_type, created_at
        FROM jobs
        WHERE user_id = $1 AND lecture_id = ANY($2::text[])
        ORDER BY lecture_id, created_at DESC
        """,
        user_id, lecture_ids,
    )
    return {r["lecture_id"]: r for r in rows}


# ── 라우트 ────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[LectureResponse])
async def list_lectures(user: dict = Depends(require_user)) -> list[LectureResponse]:
    user_id = uuid.UUID(user["id"])
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM lectures
            WHERE user_id = $1
            ORDER BY created_at DESC
            """,
            user_id,
        )
        latest_jobs = await _fetch_latest_jobs(conn, user_id, [r["id"] for r in rows])

    return [
        _row_to_lecture(r, lecture_artifacts(r["id"]), latest_jobs.get(r["id"]))
        for r in rows
    ]


@router.get("/{lecture_id}", response_model=LectureResponse)
async def get_lecture(lecture_id: str, user: dict = Depends(require_user)) -> LectureResponse:
    user_id = uuid.UUID(user["id"])
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM lectures WHERE id = $1 AND user_id = $2",
            lecture_id, user_id,
        )
        if not row:
            raise HTTPException(404, "강의를 찾을 수 없습니다")
        latest_jobs = await _fetch_latest_jobs(conn, user_id, [lecture_id])

    return _row_to_lecture(
        row,
        lecture_artifacts(lecture_id),
        latest_jobs.get(lecture_id),
    )


@router.post("/{lecture_id}/domain", response_model=DomainConfirmResponse)
async def confirm_domain(
    lecture_id: str,
    body: DomainConfirmRequest,
    user: dict = Depends(require_user),
) -> DomainConfirmResponse:
    if not is_valid_domain_id(body.domain_id):
        raise HTTPException(400, f"등록되지 않은 도메인: {body.domain_id}")

    user_id = uuid.UUID(user["id"])
    pool = await get_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT * FROM lectures WHERE id = $1 AND user_id = $2 FOR UPDATE",
                lecture_id, user_id,
            )
            if not row:
                raise HTTPException(404, "강의를 찾을 수 없습니다")

            previous_domain_id = row["domain_id"]
            previous_status = row["domain_status"]
            new_status = "overridden" if previous_status != "pending" else "confirmed"

            updated = await conn.fetchrow(
                """
                UPDATE lectures
                SET domain_id    = $2,
                    domain_status= $3,
                    domain_source= $4,
                    updated_at   = now()
                WHERE id = $1
                RETURNING *
                """,
                lecture_id, body.domain_id, new_status, body.source,
            )

            queued_job_id: str | None = None

            # 최근 stt job 이 awaiting_domain 이면 그걸 완료 처리
            stt_awaiting = await conn.fetchrow(
                """
                SELECT id FROM jobs
                WHERE lecture_id = $1 AND user_id = $2
                  AND job_type = 'stt' AND status = 'awaiting_domain'
                ORDER BY created_at DESC
                LIMIT 1
                """,
                lecture_id, user_id,
            )
            if stt_awaiting is not None:
                await conn.execute(
                    """
                    UPDATE jobs
                    SET status='completed', stage='done', finished_at=now()
                    WHERE id=$1 AND status='awaiting_domain'
                    """,
                    stt_awaiting["id"],
                )

            # 도메인이 처음 confirm 됐거나 변경된 경우 correct job 큐잉
            should_queue = (
                stt_awaiting is not None
                or (previous_domain_id is not None and previous_domain_id != body.domain_id)
            )
            if should_queue:
                # 원본 mp4 파일명을 유지하기 위해 가장 최근 job 의 filename/original_name 재사용
                ref = await conn.fetchrow(
                    """
                    SELECT filename, original_name, file_size
                    FROM jobs
                    WHERE lecture_id = $1 AND user_id = $2
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    lecture_id, user_id,
                )
                if ref is None:
                    if row["domain_source"] == "migration":
                        raise HTTPException(
                            409,
                            "마이그레이션된 강의는 도메인 변경(재코렉션)을 지원하지 않습니다",
                        )
                    raise HTTPException(
                        409,
                        "이 강의의 원본 업로드 정보를 찾을 수 없어 코렉션을 큐잉할 수 없습니다",
                    )
                queued_row = await conn.fetchrow(
                    """
                    INSERT INTO jobs (
                        user_id, filename, original_name, file_size,
                        lecture_id, status, job_type,
                        parent_job_id
                    )
                    VALUES ($1, $2, $3, $4, $5, 'queued', 'correct', $6)
                    RETURNING id
                    """,
                    user_id, ref["filename"], ref["original_name"], ref["file_size"],
                    lecture_id,
                    stt_awaiting["id"] if stt_awaiting is not None else None,
                )
                queued_job_id = str(queued_row["id"])

    # 트랜잭션 밖에서 워커 깨우기
    if queued_job_id:
        from jobs import notify_queue_change  # 순환 import 방지를 위한 지연 import
        notify_queue_change()

    return DomainConfirmResponse(
        lecture_id=lecture_id,
        domain_id=updated["domain_id"],
        domain_status=updated["domain_status"],
        queued_job_id=queued_job_id,
    )
