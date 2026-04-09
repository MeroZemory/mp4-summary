"""
Database connection and migration management.
Uses asyncpg for async PostgreSQL access.
"""

import os
from pathlib import Path

import asyncpg

_pool: asyncpg.Pool | None = None

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        database_url = os.environ.get("DATABASE_URL", "")
        if not database_url:
            raise RuntimeError("DATABASE_URL 환경변수가 설정되지 않았습니다.")
        _pool = await asyncpg.create_pool(database_url, min_size=2, max_size=10)
    return _pool


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def run_migrations():
    """migrations/ 폴더의 SQL 파일을 순서대로 실행 (이미 적용된 것은 건너뜀)"""
    pool = await get_pool()

    async with pool.acquire() as conn:
        # _migrations 테이블이 없으면 첫 실행 — 모든 SQL을 실행
        has_table = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_migrations')"
        )

        sql_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        if not sql_files:
            return

        if not has_table:
            # 첫 실행: 모든 마이그레이션 적용
            for sql_file in sql_files:
                sql = sql_file.read_text(encoding="utf-8")
                await conn.execute(sql)
                print(f"  [DB] 마이그레이션 적용: {sql_file.name}")
            return

        # 이미 적용된 마이그레이션 확인
        applied = {
            row["name"]
            for row in await conn.fetch("SELECT name FROM _migrations")
        }

        for sql_file in sql_files:
            if sql_file.name in applied:
                continue
            sql = sql_file.read_text(encoding="utf-8")
            await conn.execute(sql)
            await conn.execute(
                "INSERT INTO _migrations (name) VALUES ($1)", sql_file.name
            )
            print(f"  [DB] 마이그레이션 적용: {sql_file.name}")
