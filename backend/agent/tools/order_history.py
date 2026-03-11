"""
backend/agent/tools/order_history.py

ADK tool: get_order_history

Fatima calls this tool when a verified farmer asks to review past orders.
The tool queries the database for orders linked to the farmer's phone number
and returns a structured list that Fatima narrates aloud. No UI card is emitted
for this tool — Fatima reads the summary in plain language.

Security:
    - Phone number is read from tool_context.state (never from Fatima's text).
    - The call is only routed to this tool AFTER PIN verification has set
      farmer_phone_verified=True in the session state.
    - Optional date-range and status filters are passed as ADK tool parameters
      so Fatima can answer questions like "what did I order last month?" or
      "show my pending orders".
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from google.adk.tools import ToolContext  # type: ignore[import-untyped]

from backend.services import farmer_service

log = logging.getLogger("wafrivet.tools.order_history")


async def get_order_history(
    limit: int,
    offset: int,
    tool_context: ToolContext,
    status_filter: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> dict:
    """
    Return paginated order history for the authenticated farmer.

    This tool reads the phone number from the verified session state.
    If the session is not yet phone-verified, it returns an error dict
    that Fatima can narrate as a prompt to complete verification first.

    Args:
        limit:         Max orders to return (1–20, clamped server-side).
        offset:        Pagination offset (0-indexed).
        status_filter: Optional comma-separated order statuses to filter by.
                       Valid values: pending_payment, payment_received,
                       ready_for_dispatch, dispatched, completed.
        date_from:     Optional ISO-8601 date string "YYYY-MM-DD" (inclusive).
        date_to:       Optional ISO-8601 date string "YYYY-MM-DD" (inclusive).
        tool_context:  ADK context — provides session state access.

    Returns:
        dict with keys:
            - farmer: {name, phone_number, state}
            - orders: list of order dicts
            - total_orders: int
            - error: str (only present on failure)
    """
    state = tool_context.state

    # Guard: farmer must be phone-verified before order history is accessible.
    farmer_phone_verified: bool = state.get("farmer_phone_verified", False)
    if not farmer_phone_verified:
        log.warning(
            "order_history_unverified_attempt",
            extra={"session_id": state.get("auth_session_id")},
        )
        return {
            "error": "identity_not_verified",
            "message": (
                "The farmer has not completed phone and PIN verification yet. "
                "Please complete identity verification before accessing order history."
            ),
        }

    farmer_phone: Optional[str] = state.get("farmer_phone")
    if not farmer_phone:
        log.error(
            "order_history_missing_phone",
            extra={"session_id": state.get("auth_session_id")},
        )
        return {
            "error": "phone_not_in_session",
            "message": "No phone number found in the session. Please register your number first.",
        }

    # Clamp limit to a safe range.
    safe_limit = max(1, min(limit, 20))
    safe_offset = max(0, offset)

    # Parse optional status — service accepts a single status string.
    parsed_status: Optional[str] = None
    if status_filter:
        valid_statuses = {
            "pending_payment",
            "payment_received",
            "ready_for_dispatch",
            "dispatched",
            "completed",
        }
        first_valid = next(
            (s.strip() for s in status_filter.split(",") if s.strip() in valid_statuses),
            None,
        )
        parsed_status = first_valid

    # Parse optional ISO-8601 date strings to UTC-aware datetime objects.
    def _parse_date(s: Optional[str]) -> Optional[datetime]:
        if not s:
            return None
        try:
            return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        except ValueError:
            return None

    try:
        result = await farmer_service.lookup_with_history(
            phone_number=farmer_phone,
            session_id=state.get("auth_session_id", ""),
            limit=safe_limit,
            offset=safe_offset,
            status_filter=parsed_status,
            placed_after=_parse_date(date_from),
            placed_before=_parse_date(date_to),
        )
    except Exception:
        log.exception(
            "order_history_fetch_failed",
            extra={"session_id": state.get("auth_session_id")},
        )
        return {
            "error": "fetch_failed",
            "message": "Could not retrieve order history at this time. Please try again.",
        }

    farmer_row = result.get("farmer", {})
    orders = result.get("orders", [])
    total = result.get("total_orders", 0)

    log.info(
        "order_history_fetched",
        extra={
            "session_id": state.get("auth_session_id"),
            "total_orders": total,
            "returned": len(orders),
        },
    )

    return {
        "farmer": {
            "name": farmer_row.get("name"),
            "phone_number": farmer_row.get("phone_number"),
            "state": farmer_row.get("state"),
        },
        "orders": orders,
        "total_orders": total,
        "page": {"limit": safe_limit, "offset": safe_offset},
        "message": (
            f"Found {total} order(s). Showing {len(orders)} starting from offset {safe_offset}."
            if orders
            else "No orders found matching the given filters."
        ),
    }
