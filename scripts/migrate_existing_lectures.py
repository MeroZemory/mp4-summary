"""
기존 코렉션이 끝난 강의(jobs 테이블에 흔적이 없는 것들)를 lectures 테이블로
백필한다. 모두 finance 라벨로 일괄 마이그레이션 (재코렉션 없음).

사용법:
    DATABASE_URL=postgresql://... \\
    LECTURE_DATA_DIR=/project/output \\
    MIGRATION_USER_EMAIL=user@example.com \\
        python scripts/migrate_existing_lectures.py

idempotent: 두 번 실행해도 중복 INSERT 없음 (ON CONFLICT DO NOTHING).
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

import asyncpg


def _resolve_data_dir() -> Path:
    raw = os.environ.get("LECTURE_DATA_DIR")
    if raw:
        return Path(raw)
    # 도커: /project/output, 로컬: <repo>/output
    return Path(__file__).resolve().parent.parent / "output"


def _extract_base(filename: str) -> str:
    name = filename.removesuffix(".json")
    name = re.sub(r"_[a-f0-9]{6,}$", "", name)
    name = re.sub(r"_(corrected|raw_transcript|summary)$", "", name)
    return name


async def _run() -> int:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("환경변수 DATABASE_URL 이 필요합니다.", file=sys.stderr)
        return 2

    email = os.environ.get("MIGRATION_USER_EMAIL", "").strip()
    if not email:
        print("환경변수 MIGRATION_USER_EMAIL 이 필요합니다.", file=sys.stderr)
        return 2

    data_dir = _resolve_data_dir()
    if not data_dir.is_dir():
        print(f"LECTURE_DATA_DIR 가 디렉토리가 아닙니다: {data_dir}", file=sys.stderr)
        return 2

    # output/ 의 _corrected_*.json 으로부터 base name 수집
    bases: set[str] = set()
    original_name_by_base: dict[str, str] = {}
    for p in data_dir.glob("*_corrected_*.json"):
        base = _extract_base(p.name)
        bases.add(base)
        original_name_by_base.setdefault(base, base + ".mp4")

    if not bases:
        print(f"코렉션 결과가 없습니다 ({data_dir}). 마이그레이션 대상 없음.")
        return 0

    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
    inserted = 0
    skipped_existing = 0
    try:
        async with pool.acquire() as conn:
            user_row = await conn.fetchrow(
                "SELECT id FROM users WHERE email = $1", email,
            )
            if user_row is None:
                print(
                    f"사용자가 존재하지 않습니다 (email={email}). "
                    f"먼저 회원가입을 진행하세요.",
                    file=sys.stderr,
                )
                return 3
            user_id = user_row["id"]

            for base in sorted(bases):
                # 이미 lectures 에 있으면 건너뜀
                existing = await conn.fetchval(
                    "SELECT 1 FROM lectures WHERE id = $1", base,
                )
                if existing:
                    skipped_existing += 1
                    continue
                await conn.execute(
                    """
                    INSERT INTO lectures (
                        id, user_id, original_name,
                        domain_id, domain_status, domain_source
                    )
                    VALUES ($1, $2, $3, 'finance', 'confirmed', 'migration')
                    ON CONFLICT (id) DO NOTHING
                    """,
                    base, user_id, original_name_by_base[base],
                )
                inserted += 1
    finally:
        await pool.close()

    total = len(bases)
    print(
        f"마이그레이션 완료: 신규 INSERT={inserted}, "
        f"기존 유지={skipped_existing}, 전체 후보={total}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_run()))
