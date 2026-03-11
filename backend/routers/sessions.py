"""
backend/routers/sessions.py

FastAPI router: anonymous session lifecycle endpoints.

POST /sessions
    Upsert the current session into the Supabase ``sessions`` table.
    Called once per new session immediately after the WebSocket connection
    opens. Uses the asyncpg pool with rls_context so the INSERT respects the
    ``anon_insert_own_session`` RLS policy (session_id must match
    current_setting('app.session_id', true) within the transaction).

POST /sessions/activity
    Slide the ``last_active_at`` timestamp forward for an existing session.
    Safe to call on every WebSocket reconnect without creating duplicates.

Both endpoints require a valid wafrivet_session cookie (enforced by the
get_session dependency, which reads from request.state populated by
SessionMiddleware). The session_id in the cookie is authoritative; any
session_id supplied in the request body is ignored.

Security:
    - No session data (user_id, device fingerprint, etc.) is returned in error
      responses — only generic status strings.
    - The session_id is never logged in error traces; only structured log fields
      use it (which Cloud Run routes to Cloud Logging, not public responses).
    - device_fingerprint input is length-capped to 128 characters server-side
      before persistence to prevent oversized storage attacks.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from backend.auth.dependencies import get_session
from backend.auth.session import SESSION_TTL_HOURS

log = logging.getLogger("wafrivet.routers.sessions")

router = APIRouter(prefix="/sessions", tags=["sessions"])

# ── Request/response models ───────────────────────────────────────────────────


class SessionUpsertRequest(BaseModel):
    """Body for POST /sessions."""

    device_fingerprint: str = Field(
        ...,
        min_length=1,
        max_length=128,
        description="SHA-256 prefix of User-Agent + Accept-Language, computed by SessionMiddleware.",
    )
    phone_number: Optional[str] = Field(
        default=None,
        pattern=r"^\+[1-9]\d{6,14}$",
        description=(
            "E.164 phone number when already known from a previous session. "
            "Null on first visit."
        ),
    )


class SessionUpsertResponse(BaseModel):
    """Response for POST /sessions."""

    session_id: str
    expires_at: str  # ISO-8601 UTC timestamp


class ActivityResponse(BaseModel):
    """Response for POST /sessions/activity."""

    ok: bool


# ── Route handlers ────────────────────────────────────────────────────────────


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=SessionUpsertResponse,
    summary="Upsert session on first visit",
)
async def upsert_session(
    body: SessionUpsertRequest,
    session_id: str = Depends(get_session),
) -> dict:
    """
    Write or refresh a session row in the Supabase sessions table.

    The INSERT uses ON CONFLICT DO UPDATE so this endpoint is fully idempotent —
    repeated calls for the same session_id are safe and update last_active_at.

    RLS enforcement:
        The asyncpg rls_context sets app.session_id transaction-locally.
        The anon_insert_own_session policy requires
        session_id = current_setting('app.session_id', true), so the anon
        role can only INSERT rows where session_id matches the cookie value.
    """
    from backend.db.rls import rls_context  # defer import to avoid circular at module load

    expires_at = datetime.now(timezone.utc) + timedelta(hours=SESSION_TTL_HOURS)

    try:
        async with rls_context(session_id) as conn:
            await conn.execute(
                """
                INSERT INTO public.sessions
                    (session_id, device_fingerprint, phone_number, expires_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (session_id) DO UPDATE
                    SET last_active_at = NOW(),
                        phone_number   = COALESCE(EXCLUDED.phone_number, public.sessions.phone_number)
                """,
                session_id,
                body.device_fingerprint[:128],
                body.phone_number,
                expires_at,
            )
    except Exception:  # noqa: BLE001
        log.exception("session_upsert_failed", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session could not be persisted. Please try again.",
        )

    log.info("session_upserted", extra={"session_id": session_id})
    return {"session_id": session_id, "expires_at": expires_at.isoformat()}


@router.post(
    "/activity",
    status_code=status.HTTP_200_OK,
    response_model=ActivityResponse,
    summary="Record session activity (updates last_active_at)",
)
async def record_activity(
    session_id: str = Depends(get_session),
) -> dict:
    """
    Slide the session's last_active_at timestamp forward.

    Call this on WebSocket reconnect or at regular intervals during a long
    conversation to confirm the session is active. Safe to call repeatedly.
    """
    from backend.db.rls import rls_context

    try:
        async with rls_context(session_id) as conn:
            await conn.execute(
                "UPDATE public.sessions SET last_active_at = NOW() WHERE session_id = $1",
                session_id,
            )
    except Exception:  # noqa: BLE001
        log.exception("session_activity_update_failed", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Activity update failed.",
        )

    return {"ok": True}
