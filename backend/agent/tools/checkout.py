"""
backend/agent/tools/checkout.py

ADK tool: generate_checkout_link

Generates a Paystack payment link for the farmer's cart total, persists the
authorization URL to the carts table (via asyncpg + rls_context), and returns
the URL so the Next.js frontend can render a "Pay Now" button.

Uses the Paystack test-mode API (sk_test_... key). Amount is converted from
Naira to kobo (×100). A unique reference is generated per call. The farmer's
phone is used as an email placeholder (phone@wafrivet.com) since Paystack
requires an email field but the app collects phone numbers.

Phase 4 change: removed service_role Supabase client. Cart persistence is now
done via asyncpg with rls_context(auth_session_id, phone=phone) so the
anon-role RLS policies are enforced correctly.

Never logs or exposes the raw Paystack secret key.

Environment variables required:
    SUPABASE_DB_URL     – asyncpg DSN (Supabase transaction pooler, port 6543)
    PAYSTACK_SECRET_KEY – sk_test_... or sk_live_...
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
import urllib.error
import urllib.request
from typing import Any

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

_PAYSTACK_INIT_URL = "https://api.paystack.co/transaction/initialize"
_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _phone_to_email(phone: str) -> str:
    """
    Derive a deterministic Paystack placeholder email from a phone number.

    Paystack requires an email field. We generate a stable placeholder so
    transactions can be looked up by reference without a real email address.
    """
    digits = re.sub(r"\D", "", phone)
    return f"{digits}@wafrivet.com"


def _call_paystack(
    email: str,
    amount_kobo: int,
    reference: str,
    secret_key: str,
) -> dict[str, Any]:
    """
    Call the Paystack Initialize Transaction endpoint.

    Args:
        email:        Placeholder email derived from phone.
        amount_kobo:  Amount in kobo (Naira × 100).
        reference:    Unique transaction reference.
        secret_key:   Paystack secret key (test or live).

    Returns:
        Paystack response dict containing "data.authorization_url".

    Raises:
        RuntimeError: on HTTP error or unexpected response shape.
    """
    payload = json.dumps(
        {
            "email": email,
            "amount": amount_kobo,
            "reference": reference,
            "currency": "NGN",
            "channels": ["card", "bank_transfer", "mobile_money"],
        }
    ).encode()

    req = urllib.request.Request(
        _PAYSTACK_INIT_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {secret_key}",
            "Content-Type": "application/json",
            "User-Agent": "WafriVet-FieldVet/1.0",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace") if exc.fp else ""
        raise RuntimeError(
            f"Paystack API returned HTTP {exc.code}. "
            f"Check your PAYSTACK_SECRET_KEY and test-mode credentials. "
            f"Detail: {body[:200]}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Could not reach Paystack API: {exc.reason}"
        ) from exc

    data = json.loads(raw)
    if not data.get("status"):
        raise RuntimeError(
            f"Paystack returned status=false: {data.get('message', 'unknown error')}"
        )

    return data  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Public ADK tool function
# ---------------------------------------------------------------------------

async def generate_checkout_link(
    phone: str,
    cart_total: int,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """
    Generate a Paystack payment link for the farmer's cart and save it to
    the carts table so the frontend can display a Pay Now button.

    Converts cart_total from Naira to kobo, initialises a Paystack transaction,
    saves the returned authorization_url to the carts table checkout_url column
    and to session state, and returns the URL to the agent.

    Args:
        phone:
            The farmer's E.164 phone number (e.g. "+2348012345678"). Used to
            look up the cart row and as a placeholder email for Paystack.
        cart_total:
            Cart total in whole Naira (integer). Will be converted to kobo
            internally (×100). Use the value from the most recent manage_cart
            response or session state cart_total.

    Returns:
        A dict with keys:
            status (str): "success" or "error"
            data (dict): On success, contains "checkout_url" (str) and
                "payment_reference" (str).
            message (str): Human-readable summary or error description.
    """
    # Extract RLS session identity (set by SessionMiddleware via websocket.state)
    auth_session_id: str = str(tool_context.state.get("auth_session_id") or "")

    # Validate phone
    phone = (phone or "").strip()
    if not _PHONE_REGEX.match(phone):
        return {
            "status": "error",
            "data": {},
            "message": (
                "A valid E.164 phone number is required to generate a payment link "
                "(e.g. +2348012345678)."
            ),
        }

    if not auth_session_id:
        return {
            "status": "error",
            "data": {},
            "message": "Session not established. Please reconnect.",
        }

    # Enforce delivery address AND verify cart contents before checkout.
    from backend.db.rls import rls_context
    try:
        async with rls_context(auth_session_id, phone=phone) as conn:
            addr_row = await conn.fetchrow(
                """
                SELECT unit, street, city, state, country, postal_code
                  FROM public.farmer_addresses
                 WHERE phone = $1
                   AND is_default = true
                 ORDER BY updated_at DESC
                 LIMIT 1
                """,
                phone,
            )

            if addr_row:
                addr_data = dict(addr_row)
                structured_parts = [
                    str(addr_data.get("unit") or "").strip(),
                    str(addr_data.get("street") or "").strip(),
                    str(addr_data.get("city") or "").strip(),
                    str(addr_data.get("state") or "").strip(),
                    str(addr_data.get("country") or "").strip(),
                    str(addr_data.get("postal_code") or "").strip(),
                ]
                if any(structured_parts):
                    delivery_address = ", ".join(p for p in structured_parts if p)
                else:
                    delivery_address = str(addr_data.get("delivery_address") or "").strip()
            else:
                legacy_row = await conn.fetchrow(
                    """
                    SELECT delivery_address
                      FROM public.carts
                     WHERE phone = $1
                    """,
                    phone,
                )
                delivery_address = ((legacy_row["delivery_address"] if legacy_row else "") or "").strip()

            # Read cart from DB as the canonical source of truth for total and items.
            cart_row = await conn.fetchrow(
                """
                SELECT items_json, total_amount
                  FROM public.carts
                 WHERE phone = $1
                """,
                phone,
            )
    except Exception as db_exc:
        logger.error("generate_checkout_link: failed to load cart/address: %s", db_exc)
        return {
            "status": "error",
            "data": {},
            "message": "Could not verify your cart or delivery address. Please try again.",
        }

    if len(delivery_address) < 8:
        return {
            "status": "error",
            "data": {},
            "message": (
                "Please add your delivery address before checkout. "
                "Open the location menu and fill in your full delivery address."
            ),
        }

    # Use the DB cart total as the source of truth. Fall back to the agent-supplied
    # cart_total parameter only when the DB has no cart row yet (edge case).
    import json as _json
    if cart_row:
        db_items = cart_row["items_json"]
        if isinstance(db_items, str):
            db_items = _json.loads(db_items)
        db_items = db_items if isinstance(db_items, list) else []
        db_total = float(cart_row["total_amount"] or 0)

        if not db_items or db_total <= 0:
            return {
                "status": "error",
                "data": {},
                "message": (
                    "Your cart is empty. Please ask Fatima to add at least one product "
                    "to your cart before checking out."
                ),
            }
        # DB total is the authoritative total; ignore agent-supplied cart_total.
        total_naira = int(round(db_total))
    else:
        # No cart row in DB yet — validate the agent-supplied parameter as a last resort.
        try:
            total_naira = int(cart_total)
        except (TypeError, ValueError):
            total_naira = 0
        if total_naira <= 0:
            return {
                "status": "error",
                "data": {},
                "message": (
                    "Your cart is empty. Please add at least one product before checking out."
                ),
            }

    secret_key = os.environ.get("PAYSTACK_SECRET_KEY", "").strip()
    if not secret_key:
        return {
            "status": "error",
            "data": {},
            "message": "Payment service is not configured. Please contact support.",
        }

    email = _phone_to_email(phone)
    amount_kobo = total_naira * 100
    reference = f"WAFRIVET-{uuid.uuid4().hex[:12].upper()}"

    logger.info(
        "generate_checkout_link: initialising Paystack txn for %s "
        "amount=₦%d ref=%s",
        phone,
        total_naira,
        reference,
    )

    try:
        paystack_response = _call_paystack(email, amount_kobo, reference, secret_key)
    except RuntimeError as exc:
        logger.error("generate_checkout_link: Paystack call failed: %s", exc)
        return {
            "status": "error",
            "data": {},
            "message": (
                "Payment link generation failed. Please try again or "
                "contact support if the problem persists."
            ),
        }

    checkout_url: str = paystack_response["data"]["authorization_url"]

    # Persist checkout_url and payment_reference to the carts table via asyncpg.
    # Non-fatal: we return the checkout URL even if DB persistence fails so the
    # farmer can still complete payment.
    try:
        async with rls_context(auth_session_id, phone=phone) as conn:
            await conn.execute(
                """
                INSERT INTO public.carts
                    (phone, checkout_url, payment_reference, status, session_id)
                VALUES ($1, $2, $3, 'pending_payment', $4)
                ON CONFLICT (phone) DO UPDATE
                    SET checkout_url      = EXCLUDED.checkout_url,
                        payment_reference = EXCLUDED.payment_reference,
                        status            = 'pending_payment',
                        session_id        = EXCLUDED.session_id,
                        updated_at        = NOW()
                """,
                phone,
                checkout_url,
                reference,
                auth_session_id,
            )
    except Exception as db_exc:
        logger.error(
            "generate_checkout_link: failed to persist checkout_url to carts: %s",
            db_exc,
        )

    # Write to session state
    tool_context.state["checkout_url"] = checkout_url

    logger.info(
        "generate_checkout_link: success ref=%s url=%s",
        reference,
        checkout_url,
    )

    return {
        "status": "success",
        "data": {
            "checkout_url": checkout_url,
            "payment_reference": reference,
        },
        "message": (
            f"Payment link ready. Total: ₦{total_naira:,}. "
            "Tap Pay Now to complete your order."
        ),
    }
