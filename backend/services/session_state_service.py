"""
backend/services/session_state_service.py

Per-session state machine persisted in Redis for Wafrivet Field Vet.

State values:
    ACTIVE       — normal operation; the Gemini Live stream is fully active
    AWAITING_PIN — PIN overlay is visible on the frontend; Gemini input/output
                   is suppressed — the WebSocket bridge drops tool call events
                   and does not forward Gemini audio to the browser
    LOCKED       — too many consecutive PIN failures; session is temporarily
                   suspended pending lockout expiry

State keys:
    session_state:{session_id}  TTL = SESSION_STATE_TTL_SECONDS (25 hours,
    slightly longer than the 24-hour JWT lifetime so the state survives
    until the next natural session rotation).

Thread safety:
    All operations are atomic Redis SET/GET calls. The asyncio event loop
    handles concurrency for both the WebSocket task and the HTTP route handler
    that transitions the state on successful PIN verification.
"""
from __future__ import annotations

import logging
from typing import Literal

from backend.services.redis_client import get_redis

log = logging.getLogger("wafrivet.services.session_state")

SessionStateValue = Literal["ACTIVE", "AWAITING_PIN", "LOCKED"]

_KEY_PREFIX = "session_state:"
# 25 hours — slightly beyond the 24-hour JWT lifetime.
SESSION_STATE_TTL_SECONDS: int = 90_000

_DEFAULT_STATE: SessionStateValue = "ACTIVE"


def _key(session_id: str) -> str:
    return f"{_KEY_PREFIX}{session_id}"


async def get_session_state(session_id: str) -> SessionStateValue:
    """
    Return the current state for *session_id*.

    Defaults to ACTIVE if the key is absent (new sessions start active).
    """
    redis = get_redis()
    value = await redis.get(_key(session_id))
    if value in ("ACTIVE", "AWAITING_PIN", "LOCKED"):
        return value  # type: ignore[return-value]
    return _DEFAULT_STATE


async def set_session_state(
    session_id: str,
    state: SessionStateValue,
) -> None:
    """Persist *state* for *session_id* with a sliding TTL."""
    redis = get_redis()
    await redis.setex(_key(session_id), SESSION_STATE_TTL_SECONDS, state)
    log.info(
        "session_state_changed",
        extra={"session_id": session_id, "state": state},
    )


async def is_awaiting_pin(session_id: str) -> bool:
    """Return True when the session is in AWAITING_PIN state."""
    return await get_session_state(session_id) == "AWAITING_PIN"


async def transition_to_awaiting_pin(session_id: str) -> None:
    """Transition a session to AWAITING_PIN (called when phone number is registered)."""
    await set_session_state(session_id, "AWAITING_PIN")


async def transition_to_active(session_id: str) -> None:
    """Transition a session back to ACTIVE (called on successful PIN verification)."""
    await set_session_state(session_id, "ACTIVE")


async def transition_to_locked(session_id: str) -> None:
    """Transition a session to LOCKED (called on lockout condition)."""
    await set_session_state(session_id, "LOCKED")
