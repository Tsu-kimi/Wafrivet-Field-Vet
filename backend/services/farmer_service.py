"""
backend/services/farmer_service.py

FarmerService: phone-keyed farmer identity persistence.

Responsibilities:
    upsert_by_phone — find or create a farmers row keyed on phone_number,
                      link the current session_id to it via the sessions table,
                      and transition the session to AWAITING_PIN state.
    lookup_with_history — return a farmer's profile and paginated order
                          history from the carts table (status in placed states).

Design notes:
    - All DB operations use asyncpg with rls_context so the anon role's
      phone-keyed RLS policies are correctly enforced.
    - The upsert uses ON CONFLICT (phone_number) DO UPDATE so concurrent
      calls on the same phone number are safe.
    - Phone numbers are validated as E.164 before any DB call.
    - Order history is read-only — the service never writes to carts.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from backend.db.rls import rls_context

log = logging.getLogger("wafrivet.services.farmer_service")

_PHONE_E164 = re.compile(r"^\+[1-9]\d{6,14}$")
# Statuses that represent placed (non-abandoned) orders
_ORDER_STATUSES = (
    "pending_payment",
    "payment_received",
    "ready_for_dispatch",
    "dispatched",
    "completed",
)


def _validate_phone(phone: str) -> str:
    """
    Validate and return a stripped E.164 phone number.

    Raises ValueError on invalid format so callers can return 422 without
    touching the database.
    """
    cleaned = phone.strip()
    if not _PHONE_E164.match(cleaned):
        raise ValueError(
            f"Phone number must be in E.164 format (+country code digits). "
            f"Received: {cleaned!r}"
        )
    return cleaned


async def upsert_by_phone(
    phone_number: str,
    session_id: str,
    name: Optional[str] = None,
    state: Optional[str] = None,
) -> dict[str, Any]:
    """
    Find or create a farmers row keyed on *phone_number*.

    1. Validates the phone as E.164.
    2. Upserts the farmers row (ON CONFLICT on phone_number).
    3. Updates the sessions table to link session_id → phone_number.
    4. Returns the farmer's row as a dict (without pin_hash).

    The session_id in the farmers row is updated to the most-recent session
    so Fatima's context is always current.

    Args:
        phone_number: E.164 formatted phone number e.g. "+2348012345678".
        session_id: The verified auth_session_id from the JWT cookie.
        name: Optional farmer name captured during conversation.
        state: Optional canonical Nigerian state name.

    Returns:
        dict with keys: id, phone_number, name, state, pin_set_at,
        failed_pin_attempts, locked_until, created_at, updated_at.
        pin_hash is intentionally excluded.

    Raises:
        ValueError: if phone_number is not valid E.164.
        asyncpg.PostgresError: on any database error.
    """
    phone = _validate_phone(phone_number)

    async with rls_context(session_id, phone=phone) as conn:
        # Upsert the farmer row. On conflict on phone_number, update the
        # session_id to the current one and optionally update name/state.
        row = await conn.fetchrow(
            """
            INSERT INTO public.farmers
                (session_id, phone_number, name, state)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (phone_number) DO UPDATE
                SET session_id  = EXCLUDED.session_id,
                    name        = COALESCE(EXCLUDED.name, public.farmers.name),
                    state       = COALESCE(EXCLUDED.state, public.farmers.state),
                    updated_at  = NOW()
            RETURNING
                id,
                phone_number,
                name,
                state,
                pin_set_at,
                failed_pin_attempts,
                locked_until,
                created_at,
                updated_at
            """,
            session_id,
            phone,
            name,
            state,
        )

        # Link the session record to this phone number so it is resolvable
        # across reconnects even before a new JWT mints.
        await conn.execute(
            """
            UPDATE public.sessions
               SET phone_number = $1, last_active_at = NOW()
             WHERE session_id   = $2
            """,
            phone,
            session_id,
        )

    farmer = dict(row)
    log.info(
        "farmer_upserted",
        extra={"session_id": session_id, "farmer_id": str(farmer["id"])},
    )
    return farmer


async def lookup_with_history(
    phone_number: str,
    session_id: str,
    limit: int = 10,
    offset: int = 0,
    status_filter: Optional[str] = None,
    placed_after: Optional[datetime] = None,
    placed_before: Optional[datetime] = None,
) -> dict[str, Any]:
    """
    Return a farmer's profile plus paginated order history.

    Orders are sourced from the carts table where status indicates a placed
    order (pending_payment, payment_received, ready_for_dispatch, dispatched,
    completed). Active carts (status='active') are excluded.

    Args:
        phone_number: E.164 phone number to look up.
        session_id: auth_session_id for RLS context.
        limit: Max number of orders to return (1–50).
        offset: Pagination offset (0-based).
        status_filter: Optional filter to a single cart status string.
        placed_after: Only orders placed on or after this UTC datetime.
        placed_before: Only orders placed on or before this UTC datetime.

    Returns:
        {"farmer": {...}, "orders": [...], "total_orders": int}
        Returns {"farmer": None, "orders": [], "total_orders": 0} when the
        phone number is not found.

    Raises:
        ValueError: if phone_number is not valid E.164.
        asyncpg.PostgresError: on any database error.
    """
    phone = _validate_phone(phone_number)
    limit = max(1, min(50, limit))  # Clamp to valid range.

    async with rls_context(session_id, phone=phone) as conn:
        # Fetch farmer row (excluding pin_hash).
        farmer_row = await conn.fetchrow(
            """
            SELECT id, phone_number, name, state,
                   pin_set_at, failed_pin_attempts, locked_until,
                   created_at, updated_at
              FROM public.farmers
             WHERE phone_number = $1
            """,
            phone,
        )

        if farmer_row is None:
            return {"farmer": None, "orders": [], "total_orders": 0}

        farmer = dict(farmer_row)

        # Build dynamic WHERE clause for order filters.
        where_clauses: list[str] = ["phone = $1", "status = ANY($2::text[])"]
        params: list[Any] = [phone, list(_ORDER_STATUSES)]

        if status_filter and status_filter in _ORDER_STATUSES:
            where_clauses = ["phone = $1", "status = $2"]
            params = [phone, status_filter]

        param_idx = len(params) + 1

        if placed_after is not None:
            where_clauses.append(f"placed_at >= ${param_idx}")
            params.append(placed_after)
            param_idx += 1

        if placed_before is not None:
            where_clauses.append(f"placed_at <= ${param_idx}")
            params.append(placed_before)
            param_idx += 1

        where_sql = " AND ".join(where_clauses)

        # Count total matching orders for pagination metadata.
        count_row = await conn.fetchrow(
            f"SELECT COUNT(*) AS n FROM public.carts WHERE {where_sql}",
            *params,
        )
        total_orders = count_row["n"] if count_row else 0

        # Fetch paginated orders.
        order_rows = await conn.fetch(
            f"""
            SELECT
                id,
                order_reference,
                status,
                items_json,
                total_amount,
                payment_reference,
                delivery_address,
                placed_at,
                created_at
            FROM public.carts
            WHERE {where_sql}
            ORDER BY placed_at DESC NULLS LAST, created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """,
            *params,
            limit,
            offset,
        )

        orders = []
        for row in order_rows:
            o = dict(row)
            # Serialise datetimes to ISO-8601 strings for JSON compatibility.
            for ts_field in ("placed_at", "created_at"):
                if isinstance(o.get(ts_field), datetime):
                    o[ts_field] = o[ts_field].isoformat()
            # items_json is returned as a Python list by asyncpg (jsonb decode).
            orders.append(o)

        # Serialise farmer datetimes.
        for ts_field in ("pin_set_at", "locked_until", "created_at", "updated_at"):
            if isinstance(farmer.get(ts_field), datetime):
                farmer[ts_field] = farmer[ts_field].isoformat()
        farmer["id"] = str(farmer["id"])

    return {
        "farmer": farmer,
        "orders": orders,
        "total_orders": total_orders,
    }


async def clear_pin_lock(phone_number: str, session_id: str) -> None:
    """
    Reset failed_pin_attempts and locked_until on successful PIN reset.
    Called from PinService.set_pin() after a validated OTP reset flow.
    """
    phone = _validate_phone(phone_number)
    async with rls_context(session_id, phone=phone) as conn:
        await conn.execute(
            """
            UPDATE public.farmers
               SET failed_pin_attempts = 0,
                   locked_until        = NULL,
                   updated_at          = NOW()
             WHERE phone_number = $1
            """,
            phone,
        )
    log.info("farmer_pin_lock_cleared", extra={"session_id": session_id})
