"""
backend/db/rls.py

RLS-aware asyncpg context manager for Wafrivet Field Vet.

Every farmer-facing Supabase query (carts, sessions, farmers, vet_escalations)
MUST be executed inside ``async with rls_context(session_id) as conn:`` to
ensure the PostgreSQL RLS policies can enforce row-level isolation.

How it works:
    1. Acquire a connection from the asyncpg pool.
    2. Open a database transaction (``async with conn.transaction()``).
    3. Call PostgreSQL's ``set_config('app.session_id', value, true)`` with
       ``is_local = true``, which makes the configuration variable
       transaction-local — it expires automatically when the transaction ends.
    4. Optionally set ``app.phone`` for policies that also accept phone number
       as an access identity (carts, farmers, vet_escalations).
    5. Yield the connection to the caller, which executes its queries.
    6. On exit, the transaction commits (or rolls back on exception) and the
       connection is returned to the pool. The session variables expire with
       the transaction — they CANNOT leak across pool connections.

Why set_config() not SET LOCAL:
    asyncpg cannot bind parameters in DDL/configuration SET statements.
    ``set_config('app.session_id', $1, true)`` is a regular function call that
    asyncpg can parameterise safely, preventing injection through the session_id
    value. Always prefer this over string interpolation in SQL.

Usage:
    from backend.db.rls import rls_context

    async with rls_context(session_id, phone=phone_number) as conn:
        rows = await conn.fetch("SELECT * FROM carts")
        # RLS policy silently filters to only rows belonging to session_id
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Optional

import asyncpg

from backend.db.pool import get_pool


@asynccontextmanager
async def rls_context(
    session_id: str,
    phone: Optional[str] = None,
) -> AsyncGenerator[Any, None]:
    """
    Async context manager: yield an asyncpg connection with RLS variables set
    transaction-locally.

    The underlying transaction is committed on clean exit and rolled back if an
    exception propagates. The ``app.session_id`` config variable is reset when
    the transaction ends; it cannot leak to other requests sharing the pool.

    Args:
        session_id:
            The verified session ID extracted from the signed JWT cookie.
            May NOT be empty — callers must validate before passing here.
        phone:
            The farmer's E.164 phone number when known. Enables the secondary
            phone-based RLS policy path on carts, farmers, and vet_escalations.
            Pass None when the phone is not yet known.

    Yields:
        asyncpg.Connection with ``app.session_id`` (and optionally ``app.phone``)
        set as transaction-local PostgreSQL session variables.

    Raises:
        asyncpg.PostgresError: on any database error.
        RuntimeError: if the pool has not been initialised (startup error).
    """
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Parameterised call prevents injection through session_id / phone.
            # is_local=true (third argument) is the transaction-local scope flag.
            await conn.execute(
                "SELECT set_config('app.session_id', $1, true)",
                session_id,
            )
            if phone:
                await conn.execute(
                    "SELECT set_config('app.phone', $1, true)",
                    phone,
                )
            yield conn
