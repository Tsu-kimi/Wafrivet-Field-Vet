"""
backend/services/otp_service.py

OtpService: 6-digit numeric OTP for PIN reset, delivered via Termii SMS.

Security invariants:
    - OTPs are generated with secrets.randbelow(1_000_000) — guaranteed
      cryptographically secure from the Python standard library.
    - OTP values NEVER appear in any log record, error message, or response
      body. Only the phone number, TTL, and message_id are logged.
    - Storage: SETEX in Redis under otp:{phone_number} with a 600-second TTL.
    - Verification uses hmac.compare_digest for constant-time comparison to
      prevent timing oracle attacks.
    - The OTP is single-use: immediately deleted on first successful match.
    - Brute-force protection: failed verify_otp calls do NOT delete the key;
      after the 10-minute TTL the OTP expires automatically. A maximum of
      5 verification attempts is enforced via a Redis counter per phone.

OTP Redis keys:
    otp:{phone_number}          → 6-digit OTP string         TTL = 600 s
    otp_attempts:{phone_number} → integer attempt counter    TTL = 600 s
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
import secrets
import urllib.error
import urllib.request
from typing import Optional

from backend.services.redis_client import get_redis

log = logging.getLogger("wafrivet.services.otp_service")

_PHONE_E164 = re.compile(r"^\+[1-9]\d{6,14}$")
_TERMII_URL = "https://v3.api.termii.com/api/sms/send"
_OTP_TTL_SECONDS = 600  # 10 minutes
_MAX_OTP_ATTEMPTS = 5


def _termii_channels() -> list[str]:
    """
    Return ordered Termii channels to try.

    TERMII_CHANNELS can be set as a comma-separated list, e.g.
    "dnd,generic". Defaults to DND for production delivery.
    """
    configured = os.environ.get("TERMII_CHANNELS", "").strip()
    if configured:
        channels = [c.strip() for c in configured.split(",") if c.strip()]
        if channels:
            return channels
    # Default to DND to ensure delivery to DND-registered numbers.
    return ["dnd"]


def _otp_key(phone: str) -> str:
    return f"otp:{phone}"


def _otp_attempts_key(phone: str) -> str:
    return f"otp_attempts:{phone}"


def _validate_phone(phone: str) -> str:
    cleaned = phone.strip()
    if not _PHONE_E164.match(cleaned):
        raise ValueError(f"Phone must be E.164 format. Got: {cleaned!r}")
    return cleaned


def _generate_otp() -> str:
    """
    Generate a cryptographically secure 6-digit numeric OTP.

    Uses secrets.randbelow(1_000_000) which draws from os.urandom() — the
    correct source for security-sensitive values per Python docs. The result
    is zero-padded to exactly 6 digits.

    Never use random.randint() or random.randrange() for OTP generation.
    """
    return str(secrets.randbelow(1_000_000)).zfill(6)


def _send_otp_sms(phone: str, message_suffix: str = "") -> Optional[str]:
    """
    Send a Termii SMS carrying the OTP.

    The OTP body is assembled by the caller and passed as *message_suffix*
    so this function never needs to know the OTP value.
    Never logs the OTP. Returns the Termii message_id on success, None on error.
    """
    api_key = os.environ.get("TERMII_API_KEY", "").strip()
    sender_id = os.environ.get("TERMII_SENDER_ID", "N-Alert").strip() or "N-Alert"
    if not api_key:
        log.warning("termii_key_missing_for_otp")
        return None

    termii_phone = phone.lstrip("+")
    for channel in _termii_channels():
        payload = json.dumps({
            "api_key": api_key,
            "to": termii_phone,
            "from": sender_id,
            "sms": message_suffix,
            "type": "plain",
            "channel": channel,
        }).encode("utf-8")

        req = urllib.request.Request(
            _TERMII_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
                code = resp.getcode()
                if 200 <= code < 300:
                    body = resp.read().decode("utf-8", errors="replace")
                    try:
                        data = json.loads(body)
                        msg_id: str = data.get("message_id") or data.get("messageId", "")
                    except Exception:  # noqa: BLE001
                        msg_id = ""
                    log.info("otp_sms_dispatched", extra={"message_id": msg_id, "channel": channel})
                    return msg_id
                log.warning("otp_sms_non_2xx", extra={"status": code, "channel": channel})
        except urllib.error.HTTPError as exc:
            response_text = ""
            try:
                response_text = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:  # noqa: BLE001
                response_text = ""
            log.error(
                "otp_sms_http_error",
                extra={"status": exc.code, "channel": channel, "response": response_text},
            )
        except Exception as exc:  # noqa: BLE001
            log.error("otp_sms_dispatch_failed", extra={"error": str(exc), "channel": channel})

    return None


async def send_reset_otp(phone_number: str) -> bool:
    """
    Generate a 6-digit OTP, store it in Redis, and dispatch it via Termii SMS.

    Overwrites any existing OTP for this phone (allows resend). The attempt
    counter is reset when a new OTP is issued.

    Args:
        phone_number: E.164 phone number to receive the OTP SMS.

    Returns:
        True if the SMS was dispatched successfully, False on Termii error.

    Raises:
        ValueError: If phone_number is not valid E.164.
    """
    phone = _validate_phone(phone_number)
    otp = _generate_otp()

    # Store in Redis with TTL. The value is stored as a plain string.
    redis = get_redis()
    await redis.setex(_otp_key(phone), _OTP_TTL_SECONDS, otp)
    # Reset attempt counter for this new OTP window.
    await redis.delete(_otp_attempts_key(phone))

    sms_body = (
        f"Your WafriVet PIN reset code is: {otp}\n"
        "This code expires in 10 minutes.\n"
        "Do not share this code with anyone."
    )
    # NOTE: The OTP value appears only in the SMS body sent externally.
    # It is not written to any server log.
    msg_id = _send_otp_sms(phone, sms_body)
    return msg_id is not None


async def verify_otp(phone_number: str, otp_guess: str) -> bool:
    """
    Verify *otp_guess* against the stored OTP for *phone_number*.

    Uses hmac.compare_digest for constant-time comparison. Deletes the
    stored OTP immediately on a successful match (single-use). On failure,
    increments the attempt counter; after 5 failed attempts the key is
    deleted to prevent further brute forcing.

    Args:
        phone_number: E.164 phone number.
        otp_guess: The 6-digit string entered by the farmer.

    Returns:
        True on correct match, False on incorrect or expired OTP.

    Raises:
        ValueError: If phone_number is not valid E.164.
    """
    phone = _validate_phone(phone_number)
    # Normalise input to prevent trivial bypass via whitespace.
    if not otp_guess or len(otp_guess.strip()) != 6 or not otp_guess.strip().isdigit():
        return False

    redis = get_redis()
    stored: Optional[str] = await redis.get(_otp_key(phone))

    if stored is None:
        # OTP expired or never issued.
        return False

    # Constant-time comparison — hmac.compare_digest prevents timing attacks.
    # Both operands must be the same type (str here due to decode_responses=True).
    is_match = hmac.compare_digest(stored, otp_guess.strip())

    if is_match:
        # Single-use: delete immediately on correct match.
        await redis.delete(_otp_key(phone))
        await redis.delete(_otp_attempts_key(phone))
        return True

    # Failed attempt: increment counter and enforce max attempts.
    new_count = await redis.incr(_otp_attempts_key(phone))
    # Keep the counter TTL aligned with the OTP TTL.
    await redis.expire(_otp_attempts_key(phone), _OTP_TTL_SECONDS)

    if new_count >= _MAX_OTP_ATTEMPTS:
        # Too many failures — invalidate the OTP to prevent further guessing.
        await redis.delete(_otp_key(phone))
        await redis.delete(_otp_attempts_key(phone))
        log.warning("otp_max_attempts_reached", extra={"attempts": new_count})

    return False
