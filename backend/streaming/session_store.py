"""
backend/streaming/session_store.py

Supabase-backed session tracking for Wafrivet Live streaming sessions.

Stores the (user_id → session_id) mapping so that a reconnecting client can
resume the same ADK session using the same session_id they originally created.

Staleness check: a session entry older than SESSION_MAX_AGE_HOURS hours is
considered stale.  get_session_handle() returns None for stale entries so the
caller creates a fresh session.

Table schema (applied via migration create_session_handles):
    user_id    TEXT PRIMARY KEY
    session_id TEXT NOT NULL
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

from supabase import create_client, Client

logger = logging.getLogger("wafrivet.streaming.session_store")

# A session entry older than this is treated as stale
SESSION_MAX_AGE_HOURS: int = 20

_client: Optional[Client] = None


def _get_client() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client


def get_session_handle(user_id: str) -> Optional[str]:
    """
    Return the session_id for *user_id* if it exists and is not stale.

    Returns None if no row exists or the row is older than SESSION_MAX_AGE_HOURS.
    """
    try:
        client = _get_client()
        resp = (
            client.table("session_handles")
            .select("session_id, updated_at")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        raw_data = getattr(resp, "data", None)
        row: dict | None = raw_data if isinstance(raw_data, dict) else None
        if row is None:
            return None

        updated_at_str: str = str(row["updated_at"])
        # Supabase returns ISO-8601 with timezone
        updated_at = datetime.fromisoformat(updated_at_str.replace("Z", "+00:00"))
        age = datetime.now(timezone.utc) - updated_at
        if age > timedelta(hours=SESSION_MAX_AGE_HOURS):
            logger.info(
                "session_handle stale",
                extra={"user_id": user_id, "age_hours": age.total_seconds() / 3600},
            )
            return None

        session_id: str = str(row["session_id"])
        logger.info(
            "session_handle found", extra={"user_id": user_id, "session_id": session_id}
        )
        return session_id

    except Exception as exc:
        logger.warning(
            "session_handle lookup failed",
            exc_info=exc,
            extra={"user_id": user_id},
        )
        return None


def upsert_session_handle(user_id: str, session_id: str) -> None:
    """
    Insert or update the session_id for *user_id*, resetting updated_at to NOW().
    """
    try:
        client = _get_client()
        client.table("session_handles").upsert(
            {
                "user_id":    user_id,
                "session_id": session_id,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="user_id",
        ).execute()
        logger.info(
            "session_handle upserted",
            extra={"user_id": user_id, "session_id": session_id},
        )
    except Exception as exc:
        # Non-fatal: session resumption degrades gracefully
        logger.warning(
            "session_handle upsert failed",
            exc_info=exc,
            extra={"user_id": user_id, "session_id": session_id},
        )
