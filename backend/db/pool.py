"""
backend/db/pool.py

asyncpg connection pool for Wafrivet Field Vet.

All farmer-facing Supabase queries that require Row Level Security context
(carts, sessions, farmers, vet_escalations) use this pool INSTEAD of the
Supabase PostgREST HTTP client. asyncpg allows multiple SQL statements to run
within a single database transaction, making transaction-local set_config()
effective for RLS isolation.

Connection target:
    The Supabase transaction-mode PgBouncer pooler (port 6543) is used rather
    than the direct PostgreSQL port (5432). Transaction-mode pooler allocates
    one server connection per transaction, which is correct for asyncpg's
    ``async with pool.acquire() as conn: async with conn.transaction():`` pattern.

    statement_cache_size=0 is mandatory for PgBouncer transaction-mode pooler.
    PgBouncer resets statement caches between connections; asyncpg's default
    prepared-statement cache would cause "prepared statement does not exist"
    errors without this setting.

Environment variable required:
    SUPABASE_DB_URL — PostgreSQL DSN (obtain from Supabase dashboard:
        Database → Connection string → Transaction pooler, port 6543).
        Expected format:
            postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres

The pool is initialised once in the FastAPI lifespan context manager and
closed on shutdown. Never instantiate the pool per-request.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import asyncpg

log = logging.getLogger("wafrivet.db.pool")

_pool: Optional[asyncpg.Pool] = None  # type: ignore[type-arg]

# Pool sizing: Cloud Run with --workers 1 and --concurrency 80.
# asyncpg connections are async (non-blocking), so a small pool covers all
# concurrent coroutines without exhausting Supabase connection limits.
_POOL_MIN_SIZE: int = int(os.environ.get("DB_POOL_MIN", "1"))
_POOL_MAX_SIZE: int = int(os.environ.get("DB_POOL_MAX", "10"))


async def init_pool() -> None:
    """
    Create the asyncpg connection pool.

    Called once from the FastAPI lifespan context manager (server.py).
    Raises EnvironmentError if SUPABASE_DB_URL is absent.

    SSL is always required; Supabase PostgreSQL does not accept unencrypted
    direct connections.
    """
    global _pool

    db_url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not db_url:
        raise EnvironmentError(
            "SUPABASE_DB_URL is not set. "
            "Obtain the Transaction pooler connection string from the Supabase dashboard "
            "(Database → Connection string → Transaction pooler, port 6543) and store it "
            "as a GCP Secret Manager secret named SUPABASE_DB_URL. "
            "Format: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
        )

    _pool = await asyncpg.create_pool(
        db_url,
        ssl="require",
        min_size=_POOL_MIN_SIZE,
        max_size=_POOL_MAX_SIZE,
        # MANDATORY for PgBouncer transaction-mode pooler.
        # Prevents "prepared statement does not exist" errors caused by
        # PgBouncer resetting per-connection statement caches between acquisitions.
        statement_cache_size=0,
    )
    log.info(
        "asyncpg_pool_initialised",
        extra={"min_size": _POOL_MIN_SIZE, "max_size": _POOL_MAX_SIZE},
    )


async def close_pool() -> None:
    """
    Close the asyncpg connection pool gracefully.

    Called from the FastAPI lifespan context manager shutdown path.
    Safe to call if init_pool() was never called (no-op).
    """
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        log.info("asyncpg_pool_closed")


def get_pool() -> asyncpg.Pool:  # type: ignore[type-arg]
    """
    Return the active asyncpg pool.

    Raises:
        RuntimeError: if called before init_pool(). This signals a programming
            error in the startup sequence and should never occur in production.
    """
    if _pool is None:
        raise RuntimeError(
            "asyncpg pool is not initialised. "
            "Ensure init_pool() was called during the FastAPI lifespan startup."
        )
    return _pool
