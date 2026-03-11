"""
backend/agent/tools/register_phone.py

ADK tool: register_phone

Fatima calls this the moment she captures a phone number from the farmer.
It upserts the farmers row in Supabase (keyed on phone_number), links the
current session to that farmer, transitions the session to AWAITING_PIN state,
and stores the phone in Redis for the WebSocket bridge to use.

The tool result is intercepted by the streaming bridge's _route_tool_response()
which emits a PIN_REQUIRED event to the frontend, triggering the PIN overlay.
Fatima reads the returned message aloud before the overlay appears.

Security:
    - Phone is validated as E.164 before any service call.
    - The raw phone number is never logged beyond a structured log entry.
    - auth_session_id is read from tool_context.state (signed JWT — never from
      Fatima's LLM output, which could be hallucinated).
"""
from __future__ import annotations

import logging
from typing import Optional

from google.adk.tools import ToolContext

from backend.services import farmer_service
from backend.services.redis_client import get_redis
from backend.services.session_state_service import transition_to_awaiting_pin

log = logging.getLogger("wafrivet.tools.register_phone")

# Redis key for the session-to-phone mapping used by the bridge's Redis
# pub/sub subscriber to deliver PAYMENT_CONFIRMED to the right WebSocket.
_SESSION_PHONE_PREFIX = "session_phone:"
_SESSION_PHONE_TTL = 90_000  # 25 hours — matches session state TTL


async def register_phone(
    phone_number: str,
    tool_context: ToolContext,
    name: Optional[str] = None,
    state: Optional[str] = None,
) -> dict:
    """
    Register a farmer's phone number and enter PIN verification mode.

    Call this as soon as the farmer provides a phone number. Do NOT wait for
    confirmation — call it immediately. The PIN overlay will appear on the
    farmer's screen while you speak the transition message.

    Args:
        phone_number: The farmer's phone number in E.164 format
                      (e.g. "+2348012345678"). Convert from any format the
                      farmer gives before calling.
        name:         Optional farmer name captured from the conversation.
        state:        Optional Nigerian state name captured from the conversation.
        tool_context: ADK context — provides session state.

    Returns:
        dict with keys:
            status:       "success" | "error"
            message:      Human-readable message for Fatima to narrate.
            is_returning: True if the farmer has used WafriVet before (PIN set).
            data:         {phone_number, farmer_id, pin_set}
    """
    adk_state = tool_context.state
    session_id: str = adk_state.get("auth_session_id", "")

    if not session_id:
        log.error("register_phone_no_session_id")
        return {
            "status": "error",
            "message": (
                "I wasn't able to link your identity right now. "
                "Please try again in a moment."
            ),
        }

    # Validate and normalise E.164 before any service call.
    import re
    _E164 = re.compile(r"^\+[1-9]\d{6,14}$")
    cleaned = phone_number.strip()
    if not _E164.match(cleaned):
        return {
            "status": "error",
            "message": (
                "That number doesn't look right — I need the full number including "
                "the country code, like +234 for Nigeria. "
                "Could you say it again?"
            ),
        }

    try:
        farmer = await farmer_service.upsert_by_phone(
            phone_number=cleaned,
            session_id=session_id,
            name=name,
            state=state,
        )
    except ValueError as exc:
        return {
            "status": "error",
            "message": (
                f"I couldn't register that number: {exc}. "
                "Please check and try again."
            ),
        }
    except Exception:
        log.exception("register_phone_upsert_failed", extra={"session_id": session_id})
        return {
            "status": "error",
            "message": (
                "There was a problem registering your number. "
                "Please try again in a moment."
            ),
        }

    pin_set: bool = farmer.get("pin_set_at") is not None
    is_returning: bool = pin_set

    # Update the ADK session state so other tools (e.g. get_order_history)
    # can read the phone number without re-querying the database.
    adk_state["farmer_phone"] = cleaned
    adk_state["farmer_id"] = farmer.get("id")

    # Cache the session→phone mapping in Redis so the bridge can resolve the
    # PAYMENT_CONFIRMED channel back to this farmer's WebSocket session.
    try:
        redis = get_redis()
        await redis.setex(
            f"{_SESSION_PHONE_PREFIX}{session_id}",
            _SESSION_PHONE_TTL,
            cleaned,
        )
    except Exception:
        log.warning("register_phone_redis_cache_failed", extra={"session_id": session_id})
        # Non-fatal — payment events may be delayed but core flow continues.

    # Transition session to AWAITING_PIN so the bridge suppresses Gemini
    # audio/events until the farmer completes the PIN challenge.
    try:
        await transition_to_awaiting_pin(session_id)
    except Exception:
        log.exception("register_phone_state_transition_failed", extra={"session_id": session_id})
        # Still return success — the PIN overlay will appear from the
        # PIN_REQUIRED event; state transition failure is non-fatal here.

    log.info(
        "register_phone_ok",
        extra={"session_id": session_id, "is_returning": is_returning},
    )

    if is_returning:
        message = (
            "Welcome back! I've found your account. "
            "Please enter your 6-digit PIN on the screen to continue — "
            "your previous orders will be ready once you do."
        )
    else:
        message = (
            "I've registered your number. "
            "You'll need to create a 6-digit PIN to secure your account — "
            "please enter it twice on the screen to confirm."
        )

    return {
        "status": "success",
        "message": message,
        "is_returning": is_returning,
        "data": {
            "phone_number": cleaned,
            "farmer_id": farmer.get("id"),
            "pin_set": pin_set,
        },
    }
