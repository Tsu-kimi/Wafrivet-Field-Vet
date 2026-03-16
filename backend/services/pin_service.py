"""
backend/services/pin_service.py

PinService: 6-digit PIN lifecycle with bcrypt and Redis-backed lockout.

Security invariants:
    - PINs are hashed with bcrypt (work factor ≥ 12) using the pyca/bcrypt
      library. passlib is NOT used (no longer actively maintained).
    - bcrypt.checkpw() is constant-time — never use string equality for PINs.
    - The raw PIN value NEVER appears in any log record, error response, or
      structured log field. Only the session_id and phone number are logged.
    - PIN attempt counters live in Redis (fast velocity check) and are mirrored
      to the farmers.failed_pin_attempts column (durable audit trail).
    - At attempt 7+, a Termii SMS alert is sent and a 24-hour lockout begins.

Lockout schedule (exponential backoff):
    Attempts 1-3  → No lockout (just increment counter).
    Attempt 4     → 1-minute lockout.
    Attempt 5     → 5-minute lockout.
    Attempt 6     → 30-minute lockout.
    Attempt 7+    → 24-hour lockout + Termii SMS security alert.

Work factor:
    BCRYPT_WORK_FACTOR env var (default: 12). On first PIN set the cost is
    applied. Verification uses bcrypt.checkpw which auto-detects the stored cost.
"""
from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import bcrypt

from backend.db.rls import rls_context
from backend.services.redis_client import get_redis

log = logging.getLogger("wafrivet.services.pin_service")

_PHONE_E164 = re.compile(r"^\+[1-9]\d{6,14}$")
_PIN_RE = re.compile(r"^\d{6}$")
_TERMII_URL = "https://v3.api.termii.com/api/sms/send"

# Redis key template for attempt counters.
_ATTEMPTS_KEY_PREFIX = "pin_attempts:"
# TTL for the attempt counter after the maximum lockout (25 hours so it
# outlasts the 24-hour lockout and auto-expires when lockout lifts).
_COUNTER_TTL_SECONDS = 90_000

# Lockout durations per failure tier.
_LOCKOUT_SCHEDULE: dict[int, timedelta] = {
    4: timedelta(minutes=1),
    5: timedelta(minutes=5),
    6: timedelta(minutes=30),
}
_MAX_ATTEMPTS_BEFORE_DAY_LOCK = 7


def _load_work_factor() -> int:
    try:
        wf = int(os.environ.get("BCRYPT_WORK_FACTOR", "12"))
        return max(12, min(14, wf))  # Clamp between 12 and 14 for safety.
    except (ValueError, TypeError):
        return 12


def _validate_phone(phone: str) -> str:
    cleaned = phone.strip()
    if not _PHONE_E164.match(cleaned):
        raise ValueError(f"Phone must be E.164 format. Got: {cleaned!r}")
    return cleaned


def _validate_pin(pin: str) -> None:
    if not _PIN_RE.match(pin):
        raise ValueError("PIN must be exactly 6 digits (0-9).")


def _attempts_key(phone: str) -> str:
    return f"{_ATTEMPTS_KEY_PREFIX}{phone}"


def _send_termii_security_alert(phone: str, attempts: int) -> None:
    """
    Send a Termii SMS security alert on the 7th+ failed PIN attempt.
    Never raises — failure is logged but does not block the lockout flow.
    The raw phone number is used only for delivery, not logged beyond the
    'security_alert_sent' structured log entry.
    """
    api_key = os.environ.get("TERMII_API_KEY", "").strip()
    sender_id = os.environ.get("TERMII_SENDER_ID", "N-Alert").strip() or "N-Alert"
    if not api_key:
        log.warning("termii_key_missing_for_security_alert")
        return

    body = (
        "WAFRIVET SECURITY ALERT\n"
        f"Your PIN was entered incorrectly {attempts} times. "
        "Your account has been locked for 24 hours.\n"
        "If this was not you, contact WafriVet support immediately."
    )
    termii_phone = phone.lstrip("+")
    payload = json.dumps({
        "api_key": api_key,
        "to": termii_phone,
        "from": sender_id,
        "sms": body,
        "type": "plain",
        "channel": "dnd",
    }).encode("utf-8")
    req = urllib.request.Request(
        _TERMII_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:  # noqa: S310
            code = resp.getcode()
            if 200 <= code < 300:
                log.info("security_alert_sms_sent", extra={"attempts": attempts})
            else:
                log.warning("security_alert_sms_non_2xx", extra={"status": code})
    except Exception as exc:  # noqa: BLE001
        log.error("security_alert_sms_failed", extra={"error": str(exc)})


async def set_pin(
    phone_number: str,
    raw_pin: str,
    session_id: str,
) -> None:
    """
    Hash *raw_pin* with bcrypt and persist it on the farmers row.

    Also deletes the pin_attempts Redis key for this phone so the attempt
    counter is reset after a PIN setup or reset operation.

    Args:
        phone_number: E.164 phone number.
        raw_pin: The 6-digit PIN string as typed by the farmer.
        session_id: The verified auth_session_id for RLS scope.

    Raises:
        ValueError: If phone or PIN format is invalid.
        asyncpg.PostgresError: On any database error.

    Security:
        The raw PIN is hashed and immediately discarded. It never appears
        in any log record or exception traceback.
    """
    phone = _validate_phone(phone_number)
    _validate_pin(raw_pin)

    work_factor = _load_work_factor()
    # bcrypt.hashpw expects bytes.
    pin_hash = bcrypt.hashpw(raw_pin.encode(), bcrypt.gensalt(rounds=work_factor))

    async with rls_context(session_id, phone=phone) as conn:
        await conn.execute(
            """
            UPDATE public.farmers
               SET pin_hash             = $1,
                   pin_set_at           = NOW(),
                   failed_pin_attempts  = 0,
                   locked_until         = NULL,
                   updated_at           = NOW()
             WHERE phone_number = $2
            """,
            pin_hash.decode(),  # Store as text (bcrypt output is ASCII-safe).
            phone,
        )

    # Clear the Redis attempt counter so the new PIN starts from zero.
    redis = get_redis()
    await redis.delete(_attempts_key(phone))
    # Never log pin_hash, raw_pin, or any PIN-derived value.
    log.info("pin_set", extra={"session_id": session_id})


async def verify_pin(
    phone_number: str,
    raw_pin: str,
    session_id: str,
) -> dict[str, Any]:
    """
    Verify *raw_pin* against the stored bcrypt hash for *phone_number*.

    Enforces the exponential-backoff lockout schedule. On success, returns
    the farmer's profile dict. On failure, returns a structured error with
    attempt count and lockout duration.

    Args:
        phone_number: E.164 phone number.
        raw_pin: The 6-digit PIN string as typed by the farmer.
        session_id: The verified auth_session_id for RLS scope.

    Returns:
        On success: {"verified": True, "farmer": {...}}
        On failure: {"verified": False, "attempt": int, "lockout_seconds": int | None}
        If locked: {"verified": False, "locked": True, "lockout_seconds": int}

    Raises:
        ValueError: If phone or PIN format is invalid.
        asyncpg.PostgresError: On any database error.
    """
    phone = _validate_phone(phone_number)
    _validate_pin(raw_pin)

    redis = get_redis()
    now_utc = datetime.now(timezone.utc)

    # ── Step 1: fetch farmer row to get pin_hash and lock status ──────────────
    async with rls_context(session_id, phone=phone) as conn:
        row = await conn.fetchrow(
            """
            SELECT id, phone_number, name, state,
                   pin_hash, failed_pin_attempts, locked_until,
                   pin_set_at, created_at, updated_at
              FROM public.farmers
             WHERE phone_number = $1
            """,
            phone,
        )

    if row is None:
        log.warning("verify_pin_farmer_not_found", extra={"session_id": session_id})
        return {"verified": False, "attempt": 0, "lockout_seconds": None}

    pin_hash: Optional[str] = row["pin_hash"]
    locked_until: Optional[datetime] = row["locked_until"]
    db_attempts: int = row["failed_pin_attempts"] or 0

    # ── Step 2: check if account is currently locked ───────────────────────
    if locked_until is not None:
        remaining = int((locked_until - now_utc).total_seconds())
        if remaining > 0:
            return {
                "verified": False,
                "locked": True,
                "lockout_seconds": remaining,
            }
        # Lockout expired — continue to verification.

    # ── Step 3: ensure PIN has been set ───────────────────────────────────
    if not pin_hash:
        log.warning("verify_pin_no_hash_set", extra={"session_id": session_id})
        return {"verified": False, "attempt": 0, "lockout_seconds": None, "no_pin": True}

    # ── Step 4: constant-time verification ────────────────────────────────
    try:
        is_valid = bcrypt.checkpw(raw_pin.encode(), pin_hash.encode())
    except Exception as exc:  # noqa: BLE001
        # bcrypt raises on corrupted hashes — treat as verification failure.
        log.error("bcrypt_checkpw_error", extra={"session_id": session_id, "error": str(exc)})
        is_valid = False

    if is_valid:
        # ── Success path ─────────────────────────────────────────────────
        # Reset attempt counter in both Redis and Supabase.
        await redis.delete(_attempts_key(phone))
        async with rls_context(session_id, phone=phone) as conn:
            await conn.execute(
                """
                UPDATE public.farmers
                   SET failed_pin_attempts = 0,
                       locked_until        = NULL,
                       updated_at          = NOW()
                 WHERE phone_number = $1
                """,
                phone,
            )

        # Build safe farmer profile (no pin_hash).
        farmer = {
            "id": str(row["id"]),
            "phone_number": row["phone_number"],
            "name": row["name"],
            "state": row["state"],
            "pin_set_at": row["pin_set_at"].isoformat() if row["pin_set_at"] else None,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        }
        log.info("pin_verified_success", extra={"session_id": session_id})
        return {"verified": True, "farmer": farmer}

    # ── Failure path ─────────────────────────────────────────────────────
    # Increment the Redis counter (fast path) with TTL.
    new_attempts = await redis.incr(_attempts_key(phone))
    await redis.expire(_attempts_key(phone), _COUNTER_TTL_SECONDS)

    # Determine if a lockout applies.
    lock_duration: Optional[timedelta] = None
    if new_attempts >= _MAX_ATTEMPTS_BEFORE_DAY_LOCK:
        lock_duration = timedelta(hours=24)
        _send_termii_security_alert(phone, new_attempts)
    elif new_attempts in _LOCKOUT_SCHEDULE:
        lock_duration = _LOCKOUT_SCHEDULE[new_attempts]

    # Persist attempt count + lockout timestamp to Supabase.
    locked_until_new: Optional[datetime] = None
    if lock_duration is not None:
        locked_until_new = now_utc + lock_duration

    async with rls_context(session_id, phone=phone) as conn:
        await conn.execute(
            """
            UPDATE public.farmers
               SET failed_pin_attempts = $1,
                   locked_until        = $2,
                   updated_at          = NOW()
             WHERE phone_number = $3
            """,
            new_attempts,
            locked_until_new,
            phone,
        )

    lockout_secs: Optional[int] = (
        int(lock_duration.total_seconds()) if lock_duration else None
    )
    log.warning(
        "pin_verification_failed",
        extra={
            "session_id": session_id,
            "attempt": new_attempts,
            "lockout_seconds": lockout_secs,
        },
    )
    return {
        "verified": False,
        "attempt": new_attempts,
        "lockout_seconds": lockout_secs,
    }
