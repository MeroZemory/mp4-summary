"""
ShowMe(시각화) / Notes(정리) 모듈의 (모델 종류별) 버저닝.

- DB(`module_versions`)에는 메타만 저장하고 본문은 파일에 둔다.
- 파일 경로: {LECTURE_DATA_DIR}/versions/{lecture_id}/{module}_{model_kind}_v{n}.md
- 첫 조회 시 기존 summary JSON에서 4슬롯을 v1(baseline)으로 자동 시드한다.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_user
from db import get_pool
from lecture_data import get_lecture, refresh_lecture

router = APIRouter(prefix="/api", tags=["module_versions"])

ModuleName = Literal["show_me", "notes"]
ModelKind = Literal["gpt", "claude"]

VALID_MODULES: tuple[str, ...] = ("show_me", "notes")
VALID_MODEL_KINDS: tuple[str, ...] = ("gpt", "claude")

# 사용자에게 노출할 후보 모델 목록 (변경 시 frontend constant도 같이 갱신)
GPT_MODEL_CANDIDATES: list[str] = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]
CLAUDE_MODEL_CANDIDATES: list[str] = [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
]


def _summary_field(module: ModuleName, model_kind: ModelKind) -> str:
    """summary JSON에서의 슬롯 필드명. baseline 시드용."""
    return f"{module}_{model_kind}"


def _data_dir() -> Path:
    return Path(os.environ.get("LECTURE_DATA_DIR", "./lecture_data"))


def _versions_dir(lecture_id: str) -> Path:
    return _data_dir() / "versions" / lecture_id


def _version_file_path(lecture_id: str, module: ModuleName,
                       model_kind: ModelKind, version: int) -> Path:
    return _versions_dir(lecture_id) / f"{module}_{model_kind}_v{version}.md"


def _default_model_id(model_kind: ModelKind) -> str:
    """env 기본 모델 (baseline 시드 시 model_id 라벨로 사용)."""
    if model_kind == "gpt":
        return os.environ.get("LECTURE_GPT_MODEL", "gpt-5.5")
    return os.environ.get("LECTURE_NOTES_MODEL", "claude-opus-4-7")


def write_version_file(lecture_id: str, module: ModuleName,
                        model_kind: ModelKind, version: int, content: str) -> str:
    """버전 파일을 디스크에 쓰고 file_path(상대경로)를 반환."""
    path = _version_file_path(lecture_id, module, model_kind, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    # DB에는 LECTURE_DATA_DIR 기준 상대경로 저장
    return str(path.relative_to(_data_dir()))


def read_version_file(rel_path: str) -> str:
    return (_data_dir() / rel_path).read_text(encoding="utf-8")


async def _has_versions(conn, lecture_id: str) -> bool:
    row = await conn.fetchval(
        "SELECT 1 FROM module_versions WHERE lecture_id = $1 LIMIT 1",
        lecture_id,
    )
    return bool(row)


async def _seed_baseline_if_needed(conn, lecture_id: str, user_id: UUID) -> int:
    """기존 summary JSON에서 4슬롯을 v1(is_baseline=true)로 시드. 시드된 row 수 반환."""
    if await _has_versions(conn, lecture_id):
        return 0

    data = get_lecture(lecture_id) or {}
    summary = data.get("summary") or {}
    if not summary:
        return 0

    summary_models = summary.get("models") or {}
    seeded = 0

    for module in ("show_me", "notes"):
        for model_kind in ("gpt", "claude"):
            field = _summary_field(module, model_kind)  # show_me_gpt 등
            content = (summary.get(field) or "").strip()
            if not content:
                continue

            model_id = (
                summary_models.get("gpt_summary" if model_kind == "gpt" else "claude_summary")
                or _default_model_id(model_kind)  # type: ignore[arg-type]
            )

            rel_path = write_version_file(lecture_id, module, model_kind, 1, content)  # type: ignore[arg-type]
            await conn.execute(
                """
                INSERT INTO module_versions
                  (lecture_id, user_id, module, model_kind, version, model_id, file_path, is_baseline)
                VALUES ($1, $2, $3, $4, 1, $5, $6, TRUE)
                ON CONFLICT (lecture_id, module, model_kind, version) DO NOTHING
                """,
                lecture_id, user_id, module, model_kind, model_id, rel_path,
            )
            seeded += 1

    return seeded


async def next_version_for(conn, lecture_id: str, module: ModuleName,
                            model_kind: ModelKind) -> int:
    row = await conn.fetchval(
        """
        SELECT COALESCE(MAX(version), 0) + 1
        FROM module_versions
        WHERE lecture_id = $1 AND module = $2 AND model_kind = $3
        """,
        lecture_id, module, model_kind,
    )
    return int(row or 1)


# ── 워커가 호출하는 regen 실행기 ─────────────────────────────────────────────

def _call_llm_for_regen(module: str, model_kind: str, model_id: str,
                         transcript_text: str) -> str:
    """동기 LLM 호출 — extract_and_correct.py 의 helper 직접 사용."""
    # 컨테이너에서 /project 가 sys.path에 있어 import 가능
    from extract_and_correct import (  # type: ignore
        _generate_show_me, _generate_show_me_claude,
        _generate_notes, _generate_notes_claude,
    )

    if module == "show_me" and model_kind == "gpt":
        return _generate_show_me(transcript_text, model_id=model_id)
    if module == "show_me" and model_kind == "claude":
        return _generate_show_me_claude(transcript_text, model_id=model_id)
    if module == "notes" and model_kind == "gpt":
        return _generate_notes(transcript_text, model_id=model_id)
    if module == "notes" and model_kind == "claude":
        return _generate_notes_claude(transcript_text, model_id=model_id)
    raise RuntimeError(f"Unknown module/model_kind combo: {module}/{model_kind}")


async def execute_regen(job_id: UUID, lecture_id: str, user_id: UUID,
                         module: str, model_kind: str, model_id: str) -> int:
    """worker 가 호출. transcript 로드 → LLM(to_thread) → 파일 저장 + DB row.
    반환: 새 version 번호. 실패 시 RuntimeError 등 예외."""
    if module not in VALID_MODULES or model_kind not in VALID_MODEL_KINDS:
        raise RuntimeError(f"Invalid module/model_kind: {module}/{model_kind}")

    data = get_lecture(lecture_id) or {}
    corrected = data.get("corrected") or []
    if not corrected:
        raise RuntimeError(f"Corrected transcript missing for {lecture_id}")

    transcript_text = "\n".join(
        f"[{s.get('time','')}] {s.get('text','')}" for s in corrected
    )

    content = await asyncio.to_thread(
        _call_llm_for_regen, module, model_kind, model_id, transcript_text,
    )
    if not content or not content.strip():
        raise RuntimeError("LLM returned empty content")

    pool = await get_pool()
    async with pool.acquire() as conn:
        next_version = await next_version_for(conn, lecture_id, module, model_kind)  # type: ignore[arg-type]
        rel_path = write_version_file(
            lecture_id, module, model_kind, next_version, content,  # type: ignore[arg-type]
        )
        await conn.execute(
            """
            INSERT INTO module_versions
              (lecture_id, user_id, module, model_kind, version,
               model_id, file_path, job_id, is_baseline)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
            """,
            lecture_id, user_id, module, model_kind, next_version,
            model_id, rel_path, job_id,
        )
    return next_version


# ── API 모델 ────────────────────────────────────────────────────────────────

class VersionMeta(BaseModel):
    version: int
    model_id: str
    created_at: str
    is_baseline: bool
    job_id: str | None


class VersionsResponse(BaseModel):
    show_me: dict[str, list[VersionMeta]]
    notes: dict[str, list[VersionMeta]]


class VersionContent(BaseModel):
    content: str
    model_id: str
    created_at: str
    is_baseline: bool
    version: int


class RegenerateRequest(BaseModel):
    module: ModuleName
    model_kind: ModelKind
    model_id: str | None = None


class RegenerateResponse(BaseModel):
    job_id: str


class RegenModelsResponse(BaseModel):
    gpt: list[str]
    claude: list[str]
    defaults: dict[str, str]


# ── API 엔드포인트 ──────────────────────────────────────────────────────────

@router.get("/regen-models", response_model=RegenModelsResponse)
async def get_regen_models(_user: dict = Depends(require_user)) -> RegenModelsResponse:
    return RegenModelsResponse(
        gpt=GPT_MODEL_CANDIDATES,
        claude=CLAUDE_MODEL_CANDIDATES,
        defaults={
            "gpt": _default_model_id("gpt"),
            "claude": _default_model_id("claude"),
        },
    )


async def _ensure_lecture_owned(conn, lecture_id: str, user_id: UUID) -> None:
    row = await conn.fetchrow(
        "SELECT 1 FROM lectures WHERE id = $1 AND user_id = $2",
        lecture_id, user_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Lecture not found")


@router.get("/lectures/{lecture_id}/versions", response_model=VersionsResponse)
async def list_versions(lecture_id: str, user: dict = Depends(require_user)) -> VersionsResponse:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await _ensure_lecture_owned(conn, lecture_id, uuid.UUID(user["id"]))
        await _seed_baseline_if_needed(conn, lecture_id, uuid.UUID(user["id"]))

        rows = await conn.fetch(
            """
            SELECT module, model_kind, version, model_id, created_at, is_baseline, job_id
            FROM module_versions
            WHERE lecture_id = $1
            ORDER BY module, model_kind, version DESC
            """,
            lecture_id,
        )

    grouped: dict[str, dict[str, list[VersionMeta]]] = {
        "show_me": {"gpt": [], "claude": []},
        "notes": {"gpt": [], "claude": []},
    }
    for r in rows:
        grouped[r["module"]][r["model_kind"]].append(
            VersionMeta(
                version=r["version"],
                model_id=r["model_id"],
                created_at=r["created_at"].isoformat(),
                is_baseline=r["is_baseline"],
                job_id=str(r["job_id"]) if r["job_id"] else None,
            )
        )
    return VersionsResponse(**grouped)


@router.get(
    "/lectures/{lecture_id}/versions/{module}/{model_kind}/{version}",
    response_model=VersionContent,
)
async def get_version_content(lecture_id: str, module: str, model_kind: str,
                                version: int, user: dict = Depends(require_user)) -> VersionContent:
    if module not in VALID_MODULES or model_kind not in VALID_MODEL_KINDS:
        raise HTTPException(status_code=400, detail="Invalid module or model_kind")

    pool = await get_pool()
    async with pool.acquire() as conn:
        await _ensure_lecture_owned(conn, lecture_id, uuid.UUID(user["id"]))
        row = await conn.fetchrow(
            """
            SELECT model_id, file_path, created_at, is_baseline, version
            FROM module_versions
            WHERE lecture_id = $1 AND module = $2 AND model_kind = $3 AND version = $4
            """,
            lecture_id, module, model_kind, version,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Version not found")

    try:
        content = read_version_file(row["file_path"])
    except FileNotFoundError:
        raise HTTPException(status_code=410, detail="Version file missing on disk")

    return VersionContent(
        content=content,
        model_id=row["model_id"],
        created_at=row["created_at"].isoformat(),
        is_baseline=row["is_baseline"],
        version=row["version"],
    )


@router.post("/lectures/{lecture_id}/regenerate", response_model=RegenerateResponse)
async def regenerate(lecture_id: str, body: RegenerateRequest,
                      user: dict = Depends(require_user)) -> RegenerateResponse:
    if body.module not in VALID_MODULES or body.model_kind not in VALID_MODEL_KINDS:
        raise HTTPException(status_code=400, detail="Invalid module or model_kind")

    candidates = (
        GPT_MODEL_CANDIDATES if body.model_kind == "gpt" else CLAUDE_MODEL_CANDIDATES
    )
    model_id = body.model_id or _default_model_id(body.model_kind)
    if model_id not in candidates:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model_id '{model_id}' for {body.model_kind}",
        )

    pool = await get_pool()
    async with pool.acquire() as conn:
        await _ensure_lecture_owned(conn, lecture_id, uuid.UUID(user["id"]))

        # corrected transcript 가 없으면 재생성 불가
        data = get_lecture(lecture_id) or {}
        if not data.get("corrected"):
            raise HTTPException(
                status_code=409,
                detail="Lecture has no corrected transcript yet",
            )

        # 동일 슬롯에 진행 중인 regen job 이 있으면 차단
        existing = await conn.fetchval(
            """
            SELECT id FROM jobs
            WHERE job_type = 'regen'
              AND lecture_id = $1
              AND regen_module = $2
              AND regen_model_kind = $3
              AND status IN ('queued','processing')
            LIMIT 1
            """,
            lecture_id, body.module, body.model_kind,
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail="Regeneration already in progress for this slot",
            )

        # baseline 시드 (드물게 versions API 미선조회 상태로 재생성 트리거할 때 대비)
        await _seed_baseline_if_needed(conn, lecture_id, uuid.UUID(user["id"]))

        # original_name (jobs.original_name 은 NOT NULL)
        original_name = await conn.fetchval(
            "SELECT original_name FROM lectures WHERE id = $1", lecture_id,
        ) or lecture_id

        job_id = await conn.fetchval(
            """
            INSERT INTO jobs
              (user_id, filename, original_name, lecture_id,
               status, job_type, regen_module, regen_model_kind, regen_model_id)
            VALUES ($1, $2, $3, $4, 'queued', 'regen', $5, $6, $7)
            RETURNING id
            """,
            uuid.UUID(user["id"]), lecture_id, original_name, lecture_id,
            body.module, body.model_kind, model_id,
        )

    return RegenerateResponse(job_id=str(job_id))
