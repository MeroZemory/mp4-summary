"""
북마크 API — 강의별 세그먼트 북마크 CRUD
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_user
from db import get_pool

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])


class CreateBookmarkRequest(BaseModel):
    lecture_id: str
    time: str
    segment_idx: int | None = None
    note: str = ""
    color: str = "teal"


class UpdateBookmarkRequest(BaseModel):
    note: str | None = None
    color: str | None = None


@router.get("")
async def list_bookmarks(lecture_id: str, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, lecture_id, time, segment_idx, note, color, created_at
               FROM bookmarks WHERE user_id = $1 AND lecture_id = $2
               ORDER BY time, created_at""",
            uuid.UUID(user["id"]), lecture_id,
        )
    return [
        {"id": str(r["id"]), "lecture_id": r["lecture_id"], "time": r["time"],
         "segment_idx": r["segment_idx"], "note": r["note"], "color": r["color"],
         "created_at": r["created_at"].isoformat()}
        for r in rows
    ]


@router.post("", status_code=201)
async def create_bookmark(body: CreateBookmarkRequest, user: dict = Depends(require_user)):
    bm_id = uuid.uuid4()
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO bookmarks (id, user_id, lecture_id, time, segment_idx, note, color)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            bm_id, uuid.UUID(user["id"]), body.lecture_id, body.time,
            body.segment_idx, body.note, body.color,
        )
    return {"id": str(bm_id), "lecture_id": body.lecture_id, "time": body.time,
            "segment_idx": body.segment_idx, "note": body.note, "color": body.color}


@router.patch("/{bookmark_id}")
async def update_bookmark(bookmark_id: str, body: UpdateBookmarkRequest, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM bookmarks WHERE id = $1 AND user_id = $2",
            uuid.UUID(bookmark_id), uuid.UUID(user["id"]),
        )
        if not existing:
            raise HTTPException(status_code=404)

        if body.note is not None:
            await conn.execute("UPDATE bookmarks SET note = $1 WHERE id = $2", body.note, uuid.UUID(bookmark_id))
        if body.color is not None:
            await conn.execute("UPDATE bookmarks SET color = $1 WHERE id = $2", body.color, uuid.UUID(bookmark_id))
    return {"ok": True}


@router.delete("/{bookmark_id}")
async def delete_bookmark(bookmark_id: str, user: dict = Depends(require_user)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM bookmarks WHERE id = $1 AND user_id = $2",
            uuid.UUID(bookmark_id), uuid.UUID(user["id"]),
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404)
    return {"ok": True}
