"""
backend/routers/farmers.py

FastAPI router: farmer identity and PIN lifecycle endpoints.

Endpoints:
    POST /farmers/register
        Upsert a farmer row by phone number. Transitions the session to
        AWAITING_PIN state. Called by the bridge when Fatima captures a phone
        number from the conversation.

    POST /farmers/pin
        Set or reset the farmer's 6-digit PIN. Requires either SMS OTP
        verification (reset flow) or first-time setup (no existing PIN).

    POST /farmers/pin/verify
        Verify a PIN submission from the PIN overlay. Transitions the session
        back to ACTIVE on success.

    POST /farmers/pin/reset/request
        Send a PIN reset OTP via Termii SMS to the farmer's registered phone.

    POST /farmers/pin/reset/verify
        Verify the OTP and, on success, call set_pin with the new PIN.

Security:
    - All phone number inputs are validated as E.164 before any service call.
    - PIN values NEVER appear in any log record or error response.
    - All endpoints require a valid wafrivet_session cookie via get_session.
    - Rate limiting on /pin/verify and /otp endpoints via the PinService and
      OtpService lockout mechanisms (Redis-backed).
    - The AWAITING_PIN state in Redis gates the WebSocket bridge to suppress
      Gemini Live output during PIN entry.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from backend.auth.dependencies import get_session
from backend.services import farmer_service, otp_service, pin_service
from backend.services.session_state_service import (
    transition_to_active,
    transition_to_awaiting_pin,
)

log = logging.getLogger("wafrivet.routers.farmers")

router = APIRouter(prefix="/farmers", tags=["farmers"])

# ── Request / response models ─────────────────────────────────────────────────

_PHONE_PATTERN = r"^\+[1-9]\d{6,14}$"
_PIN_PATTERN = r"^\d{6}$"


class RegisterRequest(BaseModel):
    phone_number: str = Field(
        ...,
        pattern=_PHONE_PATTERN,
        description="E.164 formatted phone number e.g. +2348012345678",
    )
    name: Optional[str] = Field(default=None, max_length=100)
    state: Optional[str] = Field(default=None, max_length=60)


class RegisterResponse(BaseModel):
    farmer_id: str
    phone_number: str
    pin_set: bool
    message: str


class SetPinRequest(BaseModel):
    phone_number: str = Field(..., pattern=_PHONE_PATTERN)
    pin: str = Field(..., pattern=_PIN_PATTERN, description="Exactly 6 digits.")


class SetPinResponse(BaseModel):
    ok: bool


class VerifyPinRequest(BaseModel):
    phone_number: str = Field(..., pattern=_PHONE_PATTERN)
    pin: str = Field(..., pattern=_PIN_PATTERN)


class VerifyPinResponse(BaseModel):
    verified: bool
    farmer: Optional[dict] = None
    attempt: Optional[int] = None
    lockout_seconds: Optional[int] = None
    locked: Optional[bool] = None
    message: str = ""


class OtpRequestBody(BaseModel):
    phone_number: str = Field(..., pattern=_PHONE_PATTERN)


class OtpRequestResponse(BaseModel):
    sent: bool
    message: str


class OtpVerifyRequest(BaseModel):
    phone_number: str = Field(..., pattern=_PHONE_PATTERN)
    otp: str = Field(..., min_length=6, max_length=6, pattern=r"^\d{6}$")
    new_pin: str = Field(..., pattern=_PIN_PATTERN)


class OtpVerifyResponse(BaseModel):
    ok: bool
    message: str


# ── Routes ────────────────────────────────────────────────────────────────────


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=RegisterResponse,
    summary="Register phone number — upsert farmer row and enter AWAITING_PIN",
)
async def register_farmer(
    body: RegisterRequest,
    session_id: str = Depends(get_session),
) -> dict:
    """
    Create or update a farmer row keyed on phone_number.

    Transitions the session to AWAITING_PIN so the WebSocket bridge suppresses
    Gemini Live output while the PIN overlay is active on the frontend.

    Called by the Gemini Live bridge (tool response routing for register_phone)
    or directly by the Next.js frontend when the farmer types their number.
    """
    try:
        farmer = await farmer_service.upsert_by_phone(
            phone_number=body.phone_number,
            session_id=session_id,
            name=body.name,
            state=body.state,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception:
        log.exception("farmer_register_failed", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Farmer registration failed. Please try again.",
        )

    pin_set = farmer.get("pin_set_at") is not None

    # Move session into AWAITING_PIN so Gemini is paused during PIN entry.
    await transition_to_awaiting_pin(session_id)

    log.info(
        "farmer_registered",
        extra={"session_id": session_id, "farmer_id": farmer["id"], "pin_set": pin_set},
    )
    return {
        "farmer_id": farmer["id"],
        "phone_number": farmer["phone_number"],
        "pin_set": pin_set,
        "message": "Farmer registered successfully.",
    }


@router.post(
    "/pin",
    status_code=status.HTTP_200_OK,
    response_model=SetPinResponse,
    summary="Set the farmer's 6-digit PIN (first-time setup)",
)
async def set_farmer_pin(
    body: SetPinRequest,
    session_id: str = Depends(get_session),
) -> dict:
    """
    Hash and store the PIN for *phone_number*.

    This endpoint is called from the frontend PIN overlay in first-time setup
    mode (user types their new PIN twice to confirm). The confirmation match
    is verified client-side; server-side only validates format.

    PIN value is NEVER logged. It leaves this endpoint only as a bcrypt hash.
    """
    try:
        await pin_service.set_pin(
            phone_number=body.phone_number,
            raw_pin=body.pin,
            session_id=session_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception:
        log.exception("set_pin_failed", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PIN could not be saved. Please try again.",
        )

    # PIN is now set — transition back to ACTIVE so Gemini resumes.
    await transition_to_active(session_id)
    log.info("pin_set_ok", extra={"session_id": session_id})
    return {"ok": True}


@router.post(
    "/pin/verify",
    status_code=status.HTTP_200_OK,
    response_model=VerifyPinResponse,
    summary="Verify PIN from the overlay — resume session on success",
)
async def verify_farmer_pin(
    body: VerifyPinRequest,
    session_id: str = Depends(get_session),
) -> dict:
    """
    Verify the PIN submitted from the frontend PIN overlay.

    On success:
        - Transitions the session back to ACTIVE (Gemini resumes).
        - Returns the farmer's profile dict.
    On failure:
        - Returns remaining attempts and lockout duration.
        - Attempt 7+ triggers a Termii security alert SMS.
        - Lockout transitions the session to LOCKED state.

    PIN value is NEVER logged. Only the attempt count and lockout are recorded.
    """
    try:
        result = await pin_service.verify_pin(
            phone_number=body.phone_number,
            raw_pin=body.pin,
            session_id=session_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception:
        log.exception("verify_pin_failed", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PIN verification failed. Please try again.",
        )

    if result.get("verified"):
        # Success — recover the session to full operation.
        await transition_to_active(session_id)
        return {
            "verified": True,
            "farmer": result.get("farmer"),
            "message": "PIN verified successfully.",
        }

    if result.get("locked"):
        return {
            "verified": False,
            "locked": True,
            "lockout_seconds": result.get("lockout_seconds"),
            "message": "Account temporarily locked. Please try again later.",
        }

    return {
        "verified": False,
        "attempt": result.get("attempt"),
        "lockout_seconds": result.get("lockout_seconds"),
        "message": (
            "Incorrect PIN."
            if not result.get("lockout_seconds")
            else f"Incorrect PIN. Locked for {result['lockout_seconds']} seconds."
        ),
    }


@router.post(
    "/pin/reset/request",
    status_code=status.HTTP_200_OK,
    response_model=OtpRequestResponse,
    summary="Request a PIN reset OTP SMS",
)
async def request_pin_reset(
    body: OtpRequestBody,
    session_id: str = Depends(get_session),
) -> dict:
    """
    Generate and dispatch a 6-digit OTP to the farmer's registered phone.

    The OTP is stored in Redis with a 10-minute TTL. Call /farmers/pin/reset/verify
    with the OTP and new PIN to complete the reset.
    """
    try:
        sent = await otp_service.send_reset_otp(phone_number=body.phone_number)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception:
        log.exception("otp_request_failed", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OTP could not be dispatched. Please try again.",
        )

    if not sent:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="SMS delivery failed. Please check the phone number and try again.",
        )

    log.info("otp_dispatched", extra={"session_id": session_id})
    return {"sent": True, "message": "OTP sent to your registered phone number."}


@router.post(
    "/pin/reset/verify",
    status_code=status.HTTP_200_OK,
    response_model=OtpVerifyResponse,
    summary="Verify OTP and set new PIN",
)
async def verify_otp_and_reset_pin(
    body: OtpVerifyRequest,
    session_id: str = Depends(get_session),
) -> dict:
    """
    Verify the OTP and, on success, hash and store the new PIN.

    Full reset sequence:
        1. Verify the OTP with constant-time compare (hmac.compare_digest).
        2. Delete the OTP key immediately (single-use).
        3. hash the new PIN with bcrypt (work factor ≥ 12).
        4. Clear the failed_pin_attempts counter and locked_until.
        5. Transition the session back to ACTIVE.

    The OTP value is NEVER logged. The PIN value is NEVER logged.
    """
    try:
        otp_valid = await otp_service.verify_otp(
            phone_number=body.phone_number,
            otp_guess=body.otp,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception:
        log.exception("otp_verify_error", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OTP verification failed. Please try again.",
        )

    if not otp_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired OTP.",
        )

    try:
        await pin_service.set_pin(
            phone_number=body.phone_number,
            raw_pin=body.new_pin,
            session_id=session_id,
        )
        await farmer_service.clear_pin_lock(
            phone_number=body.phone_number,
            session_id=session_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except Exception:
        log.exception("pin_reset_set_failed", extra={"session_id": session_id})
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PIN reset failed. Please try again.",
        )

    await transition_to_active(session_id)
    log.info("pin_reset_complete", extra={"session_id": session_id})
    return {"ok": True, "message": "PIN reset successfully. You are now logged in."}
