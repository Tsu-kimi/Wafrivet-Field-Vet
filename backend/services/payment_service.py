"""
backend/services/payment_service.py

PaymentService: webhook HMAC verification and payment confirmation.

Responsibilities:
    verify_webhook_signature — constant-time HMAC-SHA256 verification of
                               inbound payment provider webhooks.
    process_payment_confirmed — update the cart status to payment_received
                                in Supabase and publish PAYMENT_CONFIRMED
                                to the Redis pub/sub channel for the session
                                so the WebSocket bridge can relay it to the
                                frontend in real time.

Security invariants:
    - The raw request body is verified BEFORE any JSON parsing. This is
      critical because signature verification operates on the raw bytes as
      the provider signed them. Parsing first would allow body manipulation.
    - hmac.compare_digest is used for all signature comparisons — never raw
      equality (==) which is susceptible to timing oracle attacks.
    - The webhook secret is loaded exclusively from the environment; it never
      appears in source code, logs, or error responses.
    - The Supabase query uses the service-role asyncpg connection (via a
      service_role bypass) because the payment webhook arrives without a
      farmer session_id — we look up the order by payment_reference alone.

Redis channel:
    session:{session_id}  — PAYMENT_CONFIRMED event published here so the
                            WebSocket bridge for that session can relay it
                            to the connected browser.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

from backend.db.pool import get_pool
from backend.services.redis_client import get_redis

log = logging.getLogger("wafrivet.services.payment_service")

_PAYMENT_REFERENCE_RE = re.compile(r"^[A-Za-z0-9_\-]{4,64}$")


def verify_webhook_signature(
    raw_body: bytes,
    signature_header: str,
    provider: str = "paystack",
) -> bool:
    """
    Verify the HMAC-SHA256 signature on an inbound payment webhook.

    Supports Paystack (X-Paystack-Signature header) and Flutterwave
    (verif-hash header) signature schemes.

    Args:
        raw_body: The unmodified request body bytes (read BEFORE JSON parsing).
        signature_header: The value of the signature header sent by the provider.
        provider: "paystack" (default) or "flutterwave".

    Returns:
        True if the signature is valid, False otherwise.

    Security:
        - hmac.compare_digest ensures constant-time comparison.
        - The webhook secret is loaded from the environment on every call
          so Cloud Run secret rotation takes effect without restart.
        - Returns False (not raises) on any error to avoid information leakage.
    """
    if not signature_header:
        log.warning("webhook_missing_signature_header", extra={"provider": provider})
        return False

    secret_env_key = (
        "PAYSTACK_WEBHOOK_SECRET"
        if provider == "paystack"
        else "FLUTTERWAVE_WEBHOOK_SECRET"
    )
    secret = os.environ.get(secret_env_key, "").strip()
    if not secret:
        log.error(
            "webhook_secret_not_configured",
            extra={"env_key": secret_env_key},
        )
        return False

    try:
        expected = hmac.new(
            secret.encode("utf-8"),
            raw_body,
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, signature_header.strip())
    except Exception as exc:  # noqa: BLE001
        log.error("webhook_signature_error", extra={"error": str(exc)})
        return False


async def process_payment_confirmed(
    payment_reference: str,
    amount_ngn: float,
    provider_event: dict[str, Any],
) -> bool:
    """
    Mark an order as payment_received and publish PAYMENT_CONFIRMED to Redis.

    Designed to be called as a FastAPI BackgroundTask so the webhook endpoint
    returns HTTP 200 immediately — before the database update completes — to
    prevent payment provider retry storms on slow Cloud SQL responses.

    Args:
        payment_reference: The payment reference identifier from the webhook body.
        amount_ngn: The confirmed amount in NGN (kobo/100 for Paystack).
        provider_event: The full parsed webhook JSON for audit logging.

    Returns:
        True if the order was found, updated, and event published.
        False if the order was not found or an error occurred.
    """
    # Sanitise the payment reference: only allow safe characters.
    ref = payment_reference.strip() if payment_reference else ""
    if not ref or not _PAYMENT_REFERENCE_RE.match(ref):
        log.error("invalid_payment_reference", extra={"ref": ref[:64]})
        return False

    pool = get_pool()
    now_utc = datetime.now(timezone.utc)

    # Use raw asyncpg (no RLS scope) for the service-role lookup because
    # payment webhooks arrive without a farmer session context.
    async with pool.acquire() as conn:
        # Find the cart by payment_reference using the service_role pool
        # (pool connects with the service-role DSN set in SUPABASE_DB_URL).
        row = await conn.fetchrow(
            """
            SELECT id, session_id, phone, status
              FROM public.carts
             WHERE payment_reference = $1
            """,
            ref,
        )

        if row is None:
            log.warning("payment_ref_not_found", extra={"ref": ref})
            return False

        cart_id = str(row["id"])
        session_id: Optional[str] = row["session_id"]
        current_status: str = row["status"]

        # Idempotency: skip if already marked paid.
        if current_status in ("payment_received", "ready_for_dispatch", "dispatched", "completed"):
            log.info(
                "payment_already_processed",
                extra={"cart_id": cart_id, "status": current_status},
            )
            _publish_payment_event(session_id, ref)
            return True

        # Update to payment_received.
        await conn.execute(
            """
            UPDATE public.carts
               SET status     = 'payment_received',
                   updated_at = $1
             WHERE id = $2
            """,
            now_utc,
            row["id"],
        )

    log.info(
        "cart_payment_confirmed",
        extra={
            "cart_id": cart_id,
            "payment_reference": ref,
            "amount_ngn": amount_ngn,
            "session_id": session_id,
        },
    )

    # Publish the PAYMENT_CONFIRMED event to Redis so the WebSocket bridge
    # can deliver it to the farmer's active session.
    _publish_payment_event(session_id, ref)
    return True


def _publish_payment_event(session_id: Optional[str], payment_reference: str) -> None:
    """
    Publish a PAYMENT_CONFIRMED JSON message to Redis pub/sub.

    The channel name is session:{session_id}. The WebSocket bridge subscribes
    to this channel per session and forwards the message to the browser.

    Non-async: uses the Redis client's synchronous publish in a fire-and-forget
    pattern. The BackgroundTask caller does not need to await the result.
    """
    if not session_id:
        log.warning("payment_event_no_session_id", extra={"ref": payment_reference})
        return

    try:
        import asyncio

        async def _pub() -> None:
            redis = get_redis()
            channel = f"session:{session_id}"
            message = json.dumps({
                "type": "PAYMENT_CONFIRMED",
                "payment_reference": payment_reference,
            })
            await redis.publish(channel, message)
            log.info(
                "payment_confirmed_published",
                extra={"session_id": session_id, "ref": payment_reference},
            )

        # The publish is fire-and-forget within the BackgroundTask coroutine.
        # create_task schedules it on the running event loop without blocking.
        loop = asyncio.get_event_loop()
        loop.create_task(_pub())
    except Exception as exc:  # noqa: BLE001
        log.error("redis_publish_failed", extra={"error": str(exc)})
