"""
도메인 레지스트리 노출 + 도메인 ID 화이트리스트 helper.

prompts/domains.json 을 메모리에 캐시하고 GET /api/domains 로 반환한다.
generic 항목은 항상 마지막에 추가.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth import require_user

router = APIRouter(prefix="/api/domains", tags=["domains"])


# ── 경로: PROJECT_ROOT 우선 (도커: /project), 없으면 backend 기준 ../../prompts (로컬 dev) ──
def _default_prompts_dir() -> Path:
    project_root = os.environ.get("PROJECT_ROOT")
    if project_root:
        return Path(project_root) / "prompts"
    return Path(__file__).resolve().parent.parent.parent / "prompts"


PROMPTS_DIR = Path(os.environ.get("PROMPTS_DIR") or _default_prompts_dir())
DOMAINS_FILE = PROMPTS_DIR / "domains.json"


class DomainInfo(BaseModel):
    id: str
    name: str
    description: str | None = None


_lock = threading.Lock()
_cache: list[DomainInfo] | None = None


def _load_from_disk() -> list[DomainInfo]:
    items: list[DomainInfo] = []
    if DOMAINS_FILE.exists():
        try:
            data = json.loads(DOMAINS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"[domains] 로드 실패 {DOMAINS_FILE}: {e}")
            data = {}
        for d in data.get("domains", []):
            domain_id = d.get("id")
            name = d.get("name") or domain_id
            if not isinstance(domain_id, str):
                continue
            items.append(DomainInfo(id=domain_id, name=name))
    items.append(
        DomainInfo(id="generic", name="분류 안 함",
                   description="특수 도메인 없이 일반 코렉션 프롬프트를 사용한다")
    )
    return items


def list_domains() -> list[DomainInfo]:
    """도메인 정보를 반환한다 (메모리 캐시)."""
    global _cache
    with _lock:
        if _cache is None:
            _cache = _load_from_disk()
        return list(_cache)


def is_valid_domain_id(domain_id: str) -> bool:
    """등록된 도메인 ID 인지 확인 (디렉토리 traversal 방지용 화이트리스트)."""
    return any(d.id == domain_id for d in list_domains())


def reload_cache() -> None:
    """테스트 또는 prompts/domains.json 변경 후 호출."""
    global _cache
    with _lock:
        _cache = None


@router.get("", response_model=list[DomainInfo])
async def get_domains(_user: dict = Depends(require_user)) -> list[DomainInfo]:
    return list_domains()
