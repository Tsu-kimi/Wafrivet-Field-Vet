"""
backend/routers/payments.py

FastAPI router: payment webhook endpoints.

Endpoints:
    POST /payments/webhook
        Receive webhook events from Paystack (or Flutterwave).
        Verifies the HMAC signature in the X-Paystack-Signature header,
        then schedules payment processing as a BackgroundTask so that
        HTTP 200 is returned immediately (Paystack requires < 5 s response).

Security:
    - Raw request body is read BEFORE JSON parsing so the HMAC is computed
      over the exact bytes sent by the provider (JSON library whitespace must
      be preserved).
    - HMAC comparison uses hmac.compare_digest via payment_service to prevent
      timing attacks.
    - A 400 is returned for invalid signatures; no payment state is mutated.
    - The background task updates the DB status and publishes a Redis pub/sub
      event which the WebSocket bridge relays to the browser as
      PAYMENT_CONFIRMED.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status

from backend.services import payment_service

log = logging.getLogger("wafrivet.routers.payments")

router = APIRouter(prefix="/payments", tags=["payments"])


@router.post(
    "/webhook",
    status_code=status.HTTP_200_OK,
    summary="Paystack payment webhook — verify HMAC and queue processing",
)
async def payment_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict:
    """
    Receive and process a Paystack charge.success webhook.

    Processing pipeline:
        1. Read raw bytes (preserves exact provider JSON for HMAC).
        2. Verify X-Paystack-Signature with HMAC-SHA256.
        3. Parse event JSON.
        4. Return HTTP 200 immediately (Paystack has a 5-second SLA).
        5. Schedule DB update + Redis pub/sub publish as a BackgroundTask.

    The BackgroundTask publishes to Redis channel `session:{session_id}` which
    the per-session subscriber coroutine in server.py relays to the browser
    as a PAYMENT_CONFIRMED WebSocket event.
    """
    raw_body = await request.body()

    signature = request.headers.get("x-paystack-signature", "")
    if not signature:
        log.warning("payment_webhook_missing_signature")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing webhook signature.",
        )

    is_valid = payment_service.verify_webhook_signature(
        raw_body=raw_body,
        signature_header=signature,
        provider="paystack",
    )
    if not is_valid:
        log.warning("payment_webhook_invalid_signature")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Webhook signature verification failed.",
        )

    try:
        event = json.loads(raw_body)
    except json.JSONDecodeError:
        log.warning("payment_webhook_invalid_json")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Webhook body is not valid JSON.",
        )

    event_type: str = event.get("event", "")

    if event_type == "charge.success":
        data = event.get("data", {})
        payment_reference: str = data.get("reference", "")
        amount_kobo: int = data.get("amount", 0)
        amount: float = amount_kobo / 100  # Paystack amounts are in kobo

        if payment_reference:
            background_tasks.add_task(
                payment_service.process_payment_confirmed,
                payment_reference=payment_reference,
                amount_ngn=amount,
                provider_event=event,
            )
            log.info(
                "payment_webhook_queued",
                extra={"reference": payment_reference, "amount": amount},
            )
        else:
            log.warning("payment_webhook_missing_reference", extra={"event": event_type})
    else:
        # Log and acknowledge non-charge events without processing.
        log.info("payment_webhook_ignored", extra={"event_type": event_type})

    return {"status": "received"}
