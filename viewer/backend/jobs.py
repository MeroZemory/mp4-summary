"""
MP4 업로드 및 처리 작업 큐.

- POST /api/jobs/upload: 멀티파트 업로드 → downloads/ 에 저장, jobs 테이블에 queued 로우 생성
- GET /api/jobs: 현재 유저의 작업 목록
- GET /api/jobs/{id}: 단일 작업 상세
- DELETE /api/jobs/{id}: queued 상태 작업 취소

워커 매니저는 N개의 asyncio 태스크를 기동하고, 각 워커는 DB 큐에서
SELECT ... FOR UPDATE SKIP LOCKED 로 작업을 클레임 → process_single_video 실행.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from pathlib import Path

import asyncpg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from auth import require_user
from db import get_pool
from lecture_data import refresh_lecture


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


# ── 경로 설정 ─────────────────────────────────────────────────────────────────

DOWNLOADS_DIR = Path(os.environ.get("DOWNLOADS_DIR", "/app/downloads"))
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(8 * 1024 * 1024 * 1024)))  # 8GB
UPLOAD_CHUNK_SIZE = 1024 * 1024  # 1MB

_SAFE_NAME = re.compile(r"[^\w\-.]+", re.UNICODE)


def _sanitize_filename(name: str) -> str:
    """파일명 정화 — 경로 분리자 / 제어문자 제거."""
    base = os.path.basename(name or "").strip()
    if not base:
        return "upload.mp4"
    base = _SAFE_NAME.sub("_", base)
    if not base.lower().endswith(".mp4"):
        base = base + ".mp4"
    return base[:200]


def _unique_filename(original: str) -> str:
    """downloads/ 안에서 충돌하지 않는 이름 생성."""
    safe = _sanitize_filename(original)
    target = DOWNLOADS_DIR / safe
    if not target.exists():
        return safe
    stem = target.stem
    suffix = target.suffix
    short = uuid.uuid4().hex[:8]
    return f"{stem}_{short}{suffix}"


# ── 응답 모델 ─────────────────────────────────────────────────────────────────

class JobResponse(BaseModel):
    id: str
    filename: str
    original_name: str
    file_size: int | None
    lecture_id: str | None
    status: str
    stage: str | None
    progress_message: str | None
    error_message: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None
    processing_ms: int | None


def _row_to_response(row: asyncpg.Record) -> JobResponse:
    return JobResponse(
        id=str(row["id"]),
        filename=row["filename"],
        original_name=row["original_name"],
        file_size=row["file_size"],
        lecture_id=row["lecture_id"],
        status=row["status"],
        stage=row["stage"],
        progress_message=row["progress_message"],
        error_message=row["error_message"],
        created_at=row["created_at"].isoformat(),
        started_at=row["started_at"].isoformat() if row["started_at"] else None,
        finished_at=row["finished_at"].isoformat() if row["finished_at"] else None,
        processing_ms=row["processing_ms"],
    )


# ── 업로드 ────────────────────────────────────────────────────────────────────

@router.post("/upload", response_model=JobResponse)
async def upload_mp4(
    file: UploadFile = File(...),
    user: dict = Depends(require_user),
):
    if not file.filename:
        raise HTTPException(400, "파일명이 필요합니다")

    # MP4만 허용
    lower = file.filename.lower()
    if not lower.endswith(".mp4"):
        raise HTTPException(400, "MP4 파일만 업로드할 수 있습니다")

    safe_name = _unique_filename(file.filename)
    lecture_id = Path(safe_name).stem
    target_path = DOWNLOADS_DIR / safe_name

    # 스트리밍 저장 (대용량 mp4 대응)
    total = 0
    try:
        with open(target_path, "wb") as out:
            while True:
                chunk = await file.read(UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    out.close()
                    target_path.unlink(missing_ok=True)
                    raise HTTPException(413, f"파일 크기가 제한을 초과합니다 ({MAX_UPLOAD_BYTES} bytes)")
                out.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        target_path.unlink(missing_ok=True)
        raise HTTPException(500, f"업로드 저장 실패: {e}")

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO jobs (user_id, filename, original_name, file_size, lecture_id, status)
            VALUES ($1, $2, $3, $4, $5, 'queued')
            RETURNING *
            """,
            uuid.UUID(user["id"]),
            safe_name,
            file.filename,
            total,
            lecture_id,
        )

    # 아이들 워커 깨우기
    notify_queue_change()
    return _row_to_response(row)


@router.get("", response_model=list[JobResponse])
async def list_jobs(user: dict = Depends(require_user), limit: int = 50):
    limit = max(1, min(limit, 200))
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM jobs
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            uuid.UUID(user["id"]),
            limit,
        )
    return [_row_to_response(r) for r in rows]


@router.get("/{job_id}", response_model=JobResponse)
async def get_job(job_id: str, user: dict = Depends(require_user)):
    try:
        job_uuid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(400, "잘못된 job id")

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM jobs WHERE id = $1 AND user_id = $2",
            job_uuid, uuid.UUID(user["id"]),
        )
    if not row:
        raise HTTPException(404, "작업을 찾을 수 없습니다")
    return _row_to_response(row)


@router.delete("/{job_id}")
async def cancel_job(job_id: str, user: dict = Depends(require_user)):
    try:
        job_uuid = uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(400, "잘못된 job id")

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE jobs
            SET status = 'canceled', finished_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'queued'
            RETURNING id
            """,
            job_uuid, uuid.UUID(user["id"]),
        )
    if not row:
        raise HTTPException(409, "queued 상태가 아닌 작업은 취소할 수 없습니다")
    return {"ok": True}


# ── 워커 매니저 ───────────────────────────────────────────────────────────────

_queue_event: asyncio.Event | None = None


def notify_queue_change() -> None:
    """새 job이 큐에 들어왔음을 워커들에게 알림."""
    global _queue_event
    if _queue_event is not None:
        _queue_event.set()


class WorkerManager:
    """N개 asyncio 워커가 DB 큐를 폴링. 각 작업은 스레드풀에서 동기 파이프라인 실행."""

    def __init__(self, worker_count: int, poll_interval: float = 5.0):
        self.worker_count = max(1, worker_count)
        self.poll_interval = poll_interval
        self._tasks: list[asyncio.Task] = []
        self._stopping = asyncio.Event()

    async def start(self) -> None:
        global _queue_event
        _queue_event = asyncio.Event()
        # 시작 시 stale 'processing' 작업을 queued로 복구
        await self._recover_stale()
        for i in range(self.worker_count):
            worker_id = f"worker-{i}"
            task = asyncio.create_task(self._run_worker(worker_id), name=worker_id)
            self._tasks.append(task)
        print(f"[워커] {self.worker_count}개 워커 시작")

    async def stop(self) -> None:
        self._stopping.set()
        if _queue_event:
            _queue_event.set()
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()
        print("[워커] 모두 종료")

    async def _recover_stale(self) -> None:
        pool = await get_pool()
        async with pool.acquire() as conn:
            n = await conn.execute(
                """
                UPDATE jobs
                SET status = 'queued', worker_id = NULL, started_at = NULL,
                    stage = NULL, progress_message = '서버 재시작 — 대기열 복귀'
                WHERE status = 'processing'
                """
            )
        if n and n != "UPDATE 0":
            print(f"[워커] stale 작업 복구: {n}")

    async def _run_worker(self, worker_id: str) -> None:
        while not self._stopping.is_set():
            try:
                job = await self._claim_next(worker_id)
            except Exception as e:
                print(f"[{worker_id}] claim 오류: {e}")
                await self._sleep_or_wake(self.poll_interval)
                continue

            if job is None:
                await self._sleep_or_wake(self.poll_interval)
                continue

            await self._process(worker_id, job)

    async def _sleep_or_wake(self, seconds: float) -> None:
        """큐 변경 신호가 오거나 타임아웃될 때까지 대기."""
        global _queue_event
        if _queue_event is None:
            await asyncio.sleep(seconds)
            return
        try:
            await asyncio.wait_for(_queue_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
        finally:
            _queue_event.clear()

    async def _claim_next(self, worker_id: str) -> asyncpg.Record | None:
        """FOR UPDATE SKIP LOCKED 로 대기열 맨 앞 작업을 클레임."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT id FROM jobs
                    WHERE status = 'queued'
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                    """
                )
                if not row:
                    return None
                full = await conn.fetchrow(
                    """
                    UPDATE jobs
                    SET status = 'processing',
                        worker_id = $2,
                        started_at = now(),
                        stage = 'starting',
                        progress_message = '처리 시작',
                        error_message = NULL
                    WHERE id = $1
                    RETURNING *
                    """,
                    row["id"], worker_id,
                )
                return full

    async def _process(self, worker_id: str, job: asyncpg.Record) -> None:
        job_id = job["id"]
        filename = job["filename"]
        lecture_id = job["lecture_id"]
        mp4_path = DOWNLOADS_DIR / filename

        print(f"[{worker_id}] 처리 시작: {filename}")
        started = time.time()

        if not mp4_path.exists():
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE jobs
                    SET status='failed', stage='error',
                        error_message=$2, finished_at=now()
                    WHERE id=$1
                    """,
                    job_id, f"업로드 파일을 찾을 수 없습니다: {filename}",
                )
            return

        try:
            # 동기 파이프라인을 스레드에서 실행 (event loop 블로킹 방지)
            await asyncio.to_thread(_run_pipeline, mp4_path)

            # 결과 JSON을 LECTURE_DATA에 반영
            refresh_lecture(lecture_id)

            elapsed_ms = int((time.time() - started) * 1000)
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE jobs
                    SET status='completed', stage='done',
                        progress_message='완료', finished_at=now(),
                        processing_ms=$2
                    WHERE id=$1
                    """,
                    job_id, elapsed_ms,
                )
            print(f"[{worker_id}] 완료: {filename} ({elapsed_ms/1000:.1f}s)")
        except Exception as e:
            elapsed_ms = int((time.time() - started) * 1000)
            err = f"{type(e).__name__}: {e}"
            print(f"[{worker_id}] 실패: {filename} — {err}")
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE jobs
                    SET status='failed', stage='error',
                        error_message=$2, finished_at=now(),
                        processing_ms=$3
                    WHERE id=$1
                    """,
                    job_id, err[:2000], elapsed_ms,
                )


def _run_pipeline(mp4_path: Path) -> None:
    """스레드에서 실행될 동기 파이프라인 진입점."""
    # 지연 import — 서버 기동 시 불필요한 API 키 검증 회피
    from extract_and_correct import process_single_video  # type: ignore
    process_single_video(mp4_path)


# ── Factory ──

def create_worker_manager() -> WorkerManager:
    count = int(os.environ.get("WORKER_POOL_SIZE", "30"))
    poll = float(os.environ.get("WORKER_POLL_INTERVAL", "5"))
    return WorkerManager(worker_count=count, poll_interval=poll)
