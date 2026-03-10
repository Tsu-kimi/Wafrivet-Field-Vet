"""
backend/agent/tools/checkout.py

ADK tool: generate_checkout_link

Generates a Paystack payment link for the farmer's cart total, saves the
authorization URL to the carts table and session state, and returns the URL
so the Next.js frontend can render a "Pay Now" button.

Uses the Paystack test-mode API (sk_test_... key). Amount is converted from
Naira to kobo (×100). A unique reference is generated per call. The farmer's
phone is used as an email placeholder (phone@wafrivet.placeholder) since
Paystack requires an email field but the app collects phone numbers.

Never logs or exposes the raw Paystack secret key.

Environment variables required:
    SUPABASE_URL              – https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY – Service-role key (write access to carts)
    PAYSTACK_SECRET_KEY       – sk_test_... or sk_live_...
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
import urllib.error
import urllib.request
from functools import lru_cache
from typing import Any

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

_PAYSTACK_INIT_URL = "https://api.paystack.co/transaction/initialize"
_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")


# ---------------------------------------------------------------------------
# Lazy singleton client
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_supabase_client():
    """Return a cached Supabase client initialised from environment variables."""
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


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
    return f"{digits}@wafrivet.placeholder"


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

def generate_checkout_link(
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

    # Validate cart_total
    try:
        total_naira = int(cart_total)
    except (TypeError, ValueError):
        return {
            "status": "error",
            "data": {},
            "message": "cart_total must be a whole number in Naira.",
        }

    if total_naira <= 0:
        return {
            "status": "error",
            "data": {},
            "message": (
                "The cart is empty or the total is zero. "
                "Please add at least one product before checking out."
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

    # Persist checkout_url and payment_reference to the carts table
    try:
        db = _get_supabase_client()
        db.table("carts").upsert(
            {
                "phone": phone,
                "checkout_url": checkout_url,
                "payment_reference": reference,
                "status": "pending_payment",
            },
            on_conflict="phone",
        ).execute()
    except Exception as db_exc:
        # Non-fatal: log the failure but still return the checkout URL to the
        # farmer so they can proceed with payment.
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
