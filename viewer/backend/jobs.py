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
import hashlib
import json
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


_ALLOWED_EXTS = (".mp4", ".mp3")


def _sanitize_filename(name: str) -> str:
    """파일명 정화 — 경로 분리자 / 제어문자 제거. 확장자(.mp4 / .mp3)는 보존."""
    base = os.path.basename(name or "").strip()
    if not base:
        return "upload.mp4"
    base = _SAFE_NAME.sub("_", base)
    if not base.lower().endswith(_ALLOWED_EXTS):
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
    job_type: str
    parent_job_id: str | None
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
        job_type=row["job_type"],
        parent_job_id=str(row["parent_job_id"]) if row["parent_job_id"] else None,
        progress_message=row["progress_message"],
        error_message=row["error_message"],
        created_at=row["created_at"].isoformat(),
        started_at=row["started_at"].isoformat() if row["started_at"] else None,
        finished_at=row["finished_at"].isoformat() if row["finished_at"] else None,
        processing_ms=row["processing_ms"],
    )


# ── 업로드 ────────────────────────────────────────────────────────────────────

def _build_lecture_id(user_uuid: uuid.UUID, file_hash: str) -> str:
    """결정적 lecture_id — 같은 사용자 + 같은 파일이면 항상 동일.

    형식: `{user_short8}__{hash12}` (총 22자, 파일 시스템 / URL 안전).
    """
    user_short = user_uuid.hex[:8]
    return f"{user_short}__{file_hash[:12]}"


@router.post("/upload", response_model=JobResponse)
async def upload_mp4(
    file: UploadFile = File(...),
    user: dict = Depends(require_user),
):
    """파일을 업로드하고 file_hash 기반으로 캐싱된 lecture 가 있으면 재사용.

    같은 (user_id, file_hash) 조합이 이미 존재하면 새 jobs / lecture 를
    만들지 않고 기존 lecture 를 가리키는 stale job row 를 반환 (frontend 가
    redirect / 안내). 새 파일이면 해시를 계산해 결정적 lecture_id 로 저장.
    """
    if not file.filename:
        raise HTTPException(400, "파일명이 필요합니다")

    lower = file.filename.lower()
    if not lower.endswith(_ALLOWED_EXTS):
        raise HTTPException(400, "MP4 또는 MP3 파일만 업로드할 수 있습니다")

    ext = ".mp3" if lower.endswith(".mp3") else ".mp4"
    user_uuid = uuid.UUID(user["id"])

    # 1) 임시 파일에 스트리밍 저장하면서 sha256 누적.
    tmp_name = f"upload_{uuid.uuid4().hex}{ext}"
    tmp_path = DOWNLOADS_DIR / tmp_name
    hasher = hashlib.sha256()
    total = 0
    try:
        with open(tmp_path, "wb") as out:
            while True:
                chunk = await file.read(UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    out.close()
                    tmp_path.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"파일 크기가 제한을 초과합니다 ({MAX_UPLOAD_BYTES} bytes)",
                    )
                hasher.update(chunk)
                out.write(chunk)
    except HTTPException:
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(500, f"업로드 저장 실패: {e}")

    file_hash = hasher.hexdigest()
    lecture_id = _build_lecture_id(user_uuid, file_hash)
    final_name = f"{lecture_id}{ext}"
    final_path = DOWNLOADS_DIR / final_name

    pool = await get_pool()
    async with pool.acquire() as conn:
        # 2) 동일 사용자 + 동일 해시의 lecture 가 이미 있는지 확인.
        existing = await conn.fetchrow(
            "SELECT id FROM lectures WHERE user_id = $1 AND file_hash = $2",
            user_uuid, file_hash,
        )

        if existing is not None:
            # 캐시 hit — 임시 파일 폐기하고 기존 lecture 의 최신 job 반환.
            tmp_path.unlink(missing_ok=True)
            cached_job = await conn.fetchrow(
                """
                SELECT * FROM jobs
                WHERE user_id = $1 AND lecture_id = $2
                ORDER BY created_at DESC
                LIMIT 1
                """,
                user_uuid, existing["id"],
            )
            if cached_job is not None:
                return _row_to_response(cached_job)
            # lectures 행은 있으나 jobs 가 비어있는 비정상 케이스 — fall through 해서 신규 처리

        # 3) 신규 — 임시 파일을 결정적 경로로 이동 (이미 있으면 그대로 사용).
        if final_path.exists():
            tmp_path.unlink(missing_ok=True)
        else:
            tmp_path.rename(final_path)

        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO lectures (id, user_id, original_name, domain_status, file_hash)
                VALUES ($1, $2, $3, 'pending', $4)
                ON CONFLICT (id) DO UPDATE
                  SET original_name = EXCLUDED.original_name,
                      file_hash = EXCLUDED.file_hash,
                      updated_at = now()
                """,
                lecture_id, user_uuid, file.filename, file_hash,
            )
            row = await conn.fetchrow(
                """
                INSERT INTO jobs (user_id, filename, original_name, file_size,
                                  lecture_id, status, job_type, file_hash)
                VALUES ($1, $2, $3, $4, $5, 'queued', 'stt', $6)
                RETURNING *
                """,
                user_uuid, final_name, file.filename, total, lecture_id, file_hash,
            )

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
        job_type = job["job_type"]
        user_id = job["user_id"]
        mp4_path = DOWNLOADS_DIR / filename

        print(f"[{worker_id}] 처리 시작 ({job_type}): {filename}")
        started = time.time()

        # full(legacy)/stt 단계는 mp4 파일이 필요. correct/summary 는 캐시 사용
        needs_mp4 = job_type in ("full", "stt")
        if needs_mp4 and not mp4_path.exists():
            await self._mark_failed(job_id, started,
                                    f"업로드 파일을 찾을 수 없습니다: {filename}")
            return

        try:
            # regen — 파이프라인을 거치지 않고 단일 모듈/모델로 바로 LLM 호출
            if job_type == "regen":
                from module_versions import execute_regen  # type: ignore
                module = job["regen_module"]
                model_kind = job["regen_model_kind"]
                model_id = job["regen_model_id"]
                if not (module and model_kind and model_id):
                    raise RuntimeError("regen job missing regen_module/model_kind/model_id")
                new_version = await execute_regen(
                    job_id, lecture_id, user_id, module, model_kind, model_id,
                )
                refresh_lecture(lecture_id)
                await self._mark_completed(job_id, started)
                print(
                    f"[{worker_id}] 완료 (regen): {lecture_id} "
                    f"{module}/{model_kind} → v{new_version}"
                    f" ({(time.time()-started):.1f}s)"
                )
                return

            # 코렉션 단계는 lectures.domain_id 가 필요
            forced_domain_id: str | None = None
            if job_type == "correct":
                pool = await get_pool()
                async with pool.acquire() as conn:
                    lec = await conn.fetchrow(
                        "SELECT domain_id FROM lectures WHERE id=$1 AND user_id=$2",
                        lecture_id, user_id,
                    )
                if lec is None or not lec["domain_id"]:
                    raise RuntimeError(
                        f"correct job 인데 lectures.domain_id 가 없습니다: {lecture_id}"
                    )
                forced_domain_id = lec["domain_id"]

            # 단계 → process_single_video stages 매핑
            stage_set: set[str] | None
            if job_type == "stt":
                stage_set = {"audio", "stt"}
            elif job_type == "correct":
                stage_set = {"correct"}
            elif job_type == "summary":
                stage_set = {"summary"}
            else:  # 'full' — 마이그레이션 호환
                stage_set = None

            result = await asyncio.to_thread(
                _run_pipeline, mp4_path, stage_set, forced_domain_id,
            )

            # 결과 반영 — 단계별 후속 처리
            if job_type == "stt":
                await self._finalize_stt(job_id, lecture_id, user_id, result, started)
            elif job_type == "correct":
                refresh_lecture(lecture_id)
                await self._finalize_correct(job_id, lecture_id, user_id, started)
            elif job_type == "summary":
                refresh_lecture(lecture_id)
                await self._mark_completed(job_id, started)
            else:  # full
                refresh_lecture(lecture_id)
                await self._mark_completed(job_id, started)

            print(f"[{worker_id}] 완료 ({job_type}): {filename}"
                  f" ({(time.time()-started):.1f}s)")
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            print(f"[{worker_id}] 실패 ({job_type}): {filename} — {err}")
            await self._mark_failed(job_id, started, err[:2000])

    async def _mark_completed(self, job_id, started: float) -> None:
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

    async def _mark_failed(self, job_id, started: float, message: str) -> None:
        elapsed_ms = int((time.time() - started) * 1000)
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE jobs
                SET status='failed', stage='error',
                    error_message=$2, finished_at=now(), processing_ms=$3
                WHERE id=$1
                """,
                job_id, message, elapsed_ms,
            )

    async def _finalize_stt(
        self,
        job_id,
        lecture_id: str,
        user_id,
        result: dict,
        started: float,
    ) -> None:
        """STT 단계 종료 — lectures.detected_* 업데이트 + jobs awaiting_domain."""
        elapsed_ms = int((time.time() - started) * 1000)
        detected = result.get("detected_domain") or {}
        detected_id = detected.get("domain_id")
        confidence = detected.get("confidence")
        candidates = detected.get("candidates") or []

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE lectures
                    SET detected_domain_id      = $2,
                        detected_confidence     = $3,
                        detected_top_candidates = $4::jsonb,
                        domain_source           = COALESCE(domain_source, 'auto'),
                        updated_at              = now()
                    WHERE id = $1
                    """,
                    lecture_id, detected_id, confidence,
                    json.dumps(candidates),
                )
                await conn.execute(
                    """
                    UPDATE jobs
                    SET status='awaiting_domain', stage='awaiting_user',
                        progress_message='도메인 컨펌 대기',
                        finished_at=now(), processing_ms=$2
                    WHERE id=$1
                    """,
                    job_id, elapsed_ms,
                )

    async def _finalize_correct(
        self,
        job_id,
        lecture_id: str,
        user_id,
        started: float,
    ) -> None:
        """correct 단계 종료 — jobs.completed + summary job 자동 큐잉."""
        elapsed_ms = int((time.time() - started) * 1000)
        pool = await get_pool()
        ref_filename: str
        ref_original: str
        ref_size: int | None
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE jobs
                    SET status='completed', stage='done',
                        progress_message='완료', finished_at=now(), processing_ms=$2
                    WHERE id=$1
                    """,
                    job_id, elapsed_ms,
                )
                ref = await conn.fetchrow(
                    "SELECT filename, original_name, file_size FROM jobs WHERE id=$1",
                    job_id,
                )
                ref_filename = ref["filename"]
                ref_original = ref["original_name"]
                ref_size = ref["file_size"]
                await conn.execute(
                    """
                    INSERT INTO jobs (
                        user_id, filename, original_name, file_size,
                        lecture_id, status, job_type, parent_job_id
                    )
                    VALUES ($1, $2, $3, $4, $5, 'queued', 'summary', $6)
                    """,
                    user_id, ref_filename, ref_original, ref_size,
                    lecture_id, job_id,
                )
        notify_queue_change()


def _run_pipeline(
    mp4_path: Path,
    stages: set[str] | None,
    forced_domain_id: str | None,
) -> dict:
    """스레드에서 실행될 동기 파이프라인 진입점."""
    # 지연 import — 서버 기동 시 불필요한 API 키 검증 회피
    from extract_and_correct import process_single_video  # type: ignore
    return process_single_video(mp4_path, stages=stages, forced_domain_id=forced_domain_id)


# ── Factory ──

def create_worker_manager() -> WorkerManager:
    count = int(os.environ.get("WORKER_POOL_SIZE", "30"))
    poll = float(os.environ.get("WORKER_POLL_INTERVAL", "5"))
    return WorkerManager(worker_count=count, poll_interval=poll)
