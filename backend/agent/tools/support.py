"""
backend/agent/tools/support.py

ADK tool: log_support_request

Called by Fatima when a farmer raises a complaint, refund request, delivery
issue, product problem, or any other support matter during a live session.

The tool writes directly to the public.support_requests table using the
Supabase service role client (no RLS scope required — this is a write-only
intake path that admin staff read via the admin panel).

Farmer identity (phone, name) is read from tool_context.state to avoid
asking the farmer to repeat themselves.

Category inference guide (Fatima decides):
    complaint  — general dissatisfaction, bad experience, quality issue
    refund     — farmer wants money back for a cancelled/wrong/damaged order
    delivery   — goods not arrived, wrong address, late delivery
    product    — wrong product sent, damaged goods, missing items
    other      — anything that does not fit the above

Priority inference guide:
    urgent     — farmer says they paid but received nothing / money gone
    high       — refund request, delivery significantly overdue
    medium     — complaint about quality, product mismatch
    low        — general feedback, minor inconvenience

Environment variables required:
    SUPABASE_URL          — Supabase REST URL
    SUPABASE_SERVICE_KEY  — service role key (bypass RLS for intake writes)
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache
from typing import Any, Optional

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger("wafrivet.tools.support")

_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")

_VALID_CATEGORIES = frozenset({"complaint", "refund", "delivery", "product", "other"})
_VALID_PRIORITIES = frozenset({"low", "medium", "high", "urgent"})


# ---------------------------------------------------------------------------
# Supabase service role client — write-only intake, no RLS needed
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_service_client():
    """
    Return a Supabase client using the service role key.
    Used only for inserting support requests — no farmer data is read.
    """
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for support tool."
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _infer_priority(category: str, description: str) -> str:
    """
    Infer a priority level from the complaint category and free-text description.
    Returns one of: low, medium, high, urgent.
    """
    text = description.lower()
    urgent_signals = [
        "paid", "payment", "money", "charged", "debited", "deducted",
        "never received", "never arrived", "nothing", "lost", "scam",
    ]
    high_signals = [
        "refund", "wrong", "damaged", "broken", "overdue", "week", "weeks",
        "month", "missing", "not delivered",
    ]
    if category == "refund":
        for sig in urgent_signals:
            if sig in text:
                return "urgent"
        return "high"
    if category == "delivery":
        for sig in urgent_signals:
            if sig in text:
                return "urgent"
        return "high"
    for sig in urgent_signals:
        if sig in text:
            return "urgent"
    for sig in high_signals:
        if sig in text:
            return "high"
    return "medium"


# ---------------------------------------------------------------------------
# Public tool function
# ---------------------------------------------------------------------------

async def log_support_request(
    category: str,
    title: str,
    description: str,
    order_reference: Optional[str] = None,
    tool_context: Optional[ToolContext] = None,
) -> dict[str, Any]:
    """
    Log a farmer support request — complaint, refund, delivery issue, or
    other concern — so that admin staff can follow up.

    Call this tool whenever the farmer:
    - Complains about a product, order, service, or experience.
    - Asks for a refund or says their money was taken without delivery.
    - Reports that an order never arrived or was delivered to the wrong address.
    - Reports a damaged, wrong, or missing product.
    - Raises any grievance that requires human follow-up.

    Args:
        category: One of "complaint", "refund", "delivery", "product", "other".
        title:    A short one-sentence summary of the issue (max 120 chars).
        description: Full details of what the farmer reported, in their own
                     words as closely as possible.
        order_reference: The order or payment reference if the farmer mentioned
                         one. Pass None if unknown.

    Returns:
        On success: {"status": "success", "ticket_id": "<uuid>",
                     "message": "...confirmation..."}
        On error:   {"status": "error", "message": "..."}
    """
    # ── Validate category ──────────────────────────────────────────────────
    category = (category or "other").strip().lower()
    if category not in _VALID_CATEGORIES:
        category = "other"

    # ── Validate title / description ───────────────────────────────────────
    title = (title or "").strip()
    description = (description or "").strip()
    if not title:
        return {
            "status": "error",
            "message": "A title is required to log the support request.",
        }
    if not description:
        return {
            "status": "error",
            "message": "A description is required to log the support request.",
        }
    if len(title) > 120:
        title = title[:117] + "..."

    # ── Read farmer identity from session state ────────────────────────────
    state: dict[str, Any] = {}
    if tool_context is not None:
        state = getattr(tool_context, "state", {}) or {}

    phone: str = state.get("farmer_phone") or ""
    farmer_name: Optional[str] = state.get("farmer_name")

    if not phone or not _PHONE_REGEX.match(phone):
        return {
            "status": "error",
            "message": (
                "I can't log this request right now because your phone number "
                "isn't available in this session. Please try again after logging in."
            ),
        }

    # ── Infer priority ─────────────────────────────────────────────────────
    priority = _infer_priority(category, description)

    # ── Normalise order_reference ──────────────────────────────────────────
    order_ref: Optional[str] = (order_reference or "").strip() or None

    # ── Insert into Supabase ───────────────────────────────────────────────
    try:
        db = _get_service_client()
        payload: dict[str, Any] = {
            "phone": phone,
            "category": category,
            "title": title,
            "description": description,
            "status": "open",
            "priority": priority,
        }
        if farmer_name:
            payload["farmer_name"] = farmer_name
        if order_ref:
            payload["order_reference"] = order_ref

        result = db.table("support_requests").insert(payload).execute()

        if not result.data:
            logger.error(
                "support_request insert returned no data phone=%s category=%s",
                phone,
                category,
            )
            return {
                "status": "error",
                "message": (
                    "Something went wrong saving your request. "
                    "Please call our support line directly."
                ),
            }

        ticket_id: str = result.data[0]["id"]
        ticket_short = ticket_id[:8].upper()

        logger.info(
            "support_request_logged ticket_id=%s phone=%s category=%s priority=%s",
            ticket_id,
            phone,
            category,
            priority,
        )

        category_labels = {
            "complaint": "complaint",
            "refund": "refund request",
            "delivery": "delivery issue",
            "product": "product issue",
            "other": "support request",
        }
        label = category_labels.get(category, "request")

        return {
            "status": "success",
            "ticket_id": ticket_id,
            "ticket_reference": ticket_short,
            "priority": priority,
            "message": (
                f"Your {label} has been logged and our team will follow up with you "
                f"on {phone}. Your reference number is {ticket_short}. "
                "Is there anything else I can help you with?"
            ),
        }

    except EnvironmentError as exc:
        logger.error("support_tool env error: %s", exc)
        return {
            "status": "error",
            "message": (
                "Support logging is temporarily unavailable. "
                "Please call our support line directly."
            ),
        }
    except Exception:
        logger.exception(
            "support_request_exception phone=%s category=%s", phone, category
        )
        return {
            "status": "error",
            "message": (
                "I couldn't save your complaint right now. "
                "Please try again or contact support directly."
            ),
        }
