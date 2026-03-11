"""
backend/agent/tools/place_order.py

ADK tool: place_order

Confirms the farmer's active cart as a placed order. This is the final step
in the commerce flow — once called, the order is committed and an SMS
confirmation is dispatched to the farmer's phone via the Termii messaging API.

Internally this tool:
  1. Loads the farmer's active cart from Supabase
  2. Validates the cart has line items and a non-zero total
  3. Generates a unique order reference in WV-XXXXXX format
  4. Sets cart status to "pending_payment", records order_reference and placed_at
  5. Sends a Termii SMS to the farmer's phone with order summary and reference
  6. Returns the order reference and estimated delivery window text for Fatima
     to read aloud

Never reveals distributor names, database internals, or system details
in the returned message — Fatima rephrases naturally.

Environment variables required:
    SUPABASE_URL              – https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY – Service-role key (read/write to carts)
    TERMII_API_KEY            – Termii API secret key
    TERMII_SENDER_ID          – Approved Termii sender ID (default: WafriVet)
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Optional

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")
_TERMII_URL  = "https://api.ng.termii.com/api/sms/send"


@lru_cache(maxsize=1)
def _get_supabase_client():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


def _generate_order_ref() -> str:
    """Generate a short, uppercase alphanumeric order reference: WV-XXXXXX."""
    token = secrets.token_hex(4).upper()   # 8 hex chars → take first 6
    return f"WV-{token[:6]}"


def _send_termii_sms(
    phone: str,
    order_ref: str,
    items: list[dict[str, Any]],
    total: float,
) -> bool:
    """
    Send an order-confirmation SMS via the Termii messaging API.

    Never logs or raises with the raw API key.

    Returns True on successful dispatch, False on error.
    """
    api_key   = os.environ.get("TERMII_API_KEY", "").strip()
    sender_id = os.environ.get("TERMII_SENDER_ID", "WafriVet").strip()

    if not api_key:
        logger.warning(
            "place_order: TERMII_API_KEY not set — SMS skipped (order reference %s)",
            order_ref,
        )
        return False

    # Format item summary (truncated to keep SMS under 160 chars)
    if len(items) == 1:
        item_line = (
            f"{items[0]['quantity']}x {items[0]['product_name'][:30]}"
        )
    else:
        item_line = f"{len(items)} items"

    sms_body = (
        f"WafriVet Order Confirmed!\n"
        f"Ref: {order_ref}\n"
        f"Items: {item_line}\n"
        f"Total: NGN {total:,.2f}\n"
        f"We will contact you to arrange delivery. Thank you!"
    )

    # Strip the leading + before E.164 number (Termii uses number without +)
    termii_phone = phone.lstrip("+")

    payload = json.dumps({
        "api_key":   api_key,
        "to":        termii_phone,
        "from":      sender_id,
        "sms":       sms_body,
        "type":      "plain",
        "channel":   "generic",
    }).encode("utf-8")

    req = urllib.request.Request(
        _TERMII_URL,
        data    = payload,
        headers = {"Content-Type": "application/json"},
        method  = "POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            code = resp.getcode()
            if 200 <= code < 300:
                logger.info(
                    "Termii SMS dispatched OK (ref=%s, status=%d)", order_ref, code
                )
                return True
            logger.warning(
                "Termii SMS non-2xx response (ref=%s, status=%d)", order_ref, code
            )
            return False
    except urllib.error.HTTPError as exc:
        logger.error(
            "Termii SMS HTTPError (ref=%s, status=%d)", order_ref, exc.code
        )
        return False
    except Exception as exc:
        logger.error(
            "Termii SMS dispatch failed (ref=%s): %s", order_ref, exc
        )
        return False


def place_order(
    phone: str,
    tool_context: ToolContext,
    delivery_address: Optional[str] = None,
) -> dict[str, Any]:
    """
    Confirm the farmer's active cart as a placed order and dispatch an SMS
    confirmation to their phone number.

    Call this ONLY when the farmer has explicitly confirmed they want to place
    the order. Always read back the cart summary (item names and total) and
    receive the farmer's explicit verbal agreement before calling this tool.

    Args:
        phone:
            Farmer's E.164 phone number. Used to load the correct cart and
            as the SMS destination. Must match the phone used for cart operations.
        delivery_address:
            Optional delivery address captured during the conversation.
            Falls back to the address already stored on the cart.

    Returns:
        A dict with:
            status  (str):  "success" or "error"
            data    (dict): {order_reference: str, total: float,
                             items: [...], sms_sent: bool,
                             estimated_delivery: str}
            message (str):  The order confirmation to read aloud. Includes the
                            reference number and estimated delivery window.
    """
    # Validate phone
    phone = (phone or "").strip()
    if not re.match(r"^\+[1-9]\d{6,14}$", phone):
        return {
            "status": "error",
            "data":   {},
            "message": "A valid phone number in E.164 format is required to place an order.",
        }

    try:
        db   = _get_supabase_client()
        resp = (
            db.table("carts")
            .select(
                "id, items_json, total_amount, status, delivery_address, "
                "order_reference"
            )
            .eq("phone", phone)
            .maybe_single()
            .execute()
        )
        cart: Any = getattr(resp, "data", None)
    except Exception as exc:
        logger.error("place_order: Supabase read failed: %s", exc)
        return {
            "status": "error",
            "data":   {},
            "message": "I could not load your cart. Please try again.",
        }

    if not cart:
        return {
            "status": "error",
            "data":   {},
            "message": (
                "I could not find an active cart for your number. "
                "Please add products to your cart first."
            ),
        }

    cart_status = cart.get("status", "active")
    if cart_status not in ("active",):
        return {
            "status": "error",
            "data":   {},
            "message": (
                f"This cart has already been submitted (status: {cart_status}). "
                "Start a new session to place another order."
            ),
        }

    items: list[dict[str, Any]] = list(cart.get("items_json") or [])
    if not items:
        return {
            "status": "error",
            "data":   {},
            "message": (
                "Your cart is empty. Please add products before placing an order."
            ),
        }

    total = float(cart.get("total_amount", 0))
    if total <= 0:
        return {
            "status": "error",
            "data":   {},
            "message": "Cart total is zero. Please add products before placing an order.",
        }

    # Use existing order_reference if the cart was already placed (idempotency)
    order_ref: str = cart.get("order_reference") or _generate_order_ref()
    placed_at  = datetime.now(timezone.utc).isoformat()

    # Resolve delivery address
    resolved_address: Optional[str] = (
        (delivery_address or "").strip()
        or cart.get("delivery_address")
        or None
    )

    try:
        update_data: dict[str, Any] = {
            "status":          "pending_payment",
            "order_reference": order_ref,
            "placed_at":       placed_at,
        }
        if resolved_address:
            update_data["delivery_address"] = resolved_address

        db.table("carts").update(update_data).eq("phone", phone).execute()
    except Exception as exc:
        logger.error("place_order: Supabase update failed: %s", exc)
        return {
            "status": "error",
            "data":   {},
            "message": "Failed to confirm your order. Please try again.",
        }

    # Dispatch Termii SMS confirmation
    sms_sent = _send_termii_sms(phone, order_ref, items, total)

    if sms_sent:
        try:
            db.table("carts").update(
                {"sms_sent_at": placed_at}
            ).eq("phone", phone).execute()
        except Exception:
            pass  # Non-critical — order is already placed

    # Update session state
    tool_context.state["last_order_reference"] = order_ref

    # Build the message Fatima reads aloud
    items_summary = ", ".join(
        f"{item.get('quantity', 1)}× {item.get('product_name', 'product')}"
        for item in items[:3]
    )
    if len(items) > 3:
        items_summary += f" and {len(items) - 3} more"

    message = (
        f"Your order has been placed! Reference number: {order_ref}. "
        f"Items: {items_summary}. "
        f"Total: ₦{total:,.2f}. "
        f"We will contact you to arrange delivery within 24–48 hours. "
        f"An SMS confirmation has been sent to your phone."
        if sms_sent
        else (
            f"Your order has been placed! Reference number: {order_ref}. "
            f"Items: {items_summary}. "
            f"Total: ₦{total:,.2f}. "
            f"We will contact you to arrange delivery within 24–48 hours. "
            f"Please keep your reference number safe."
        )
    )

    return {
        "status": "success",
        "data": {
            "order_reference":   order_ref,
            "total":             total,
            "items":             items,
            "sms_sent":          sms_sent,
            "estimated_delivery": "24–48 hours",
            "placed_at":         placed_at,
        },
        "message": message,
    }
