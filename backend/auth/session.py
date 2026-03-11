"""
backend/auth/session.py

Session JWT lifecycle: mint, verify, fingerprint computation.

JWTs are HS256-signed with SESSION_JWT_SECRET, loaded exclusively from the
environment (injected by Cloud Run from GCP Secret Manager). The JWT is placed
in an HttpOnly, Secure, SameSite=Strict cookie named ``wafrivet_session``.

Security invariants:
    - The raw JWT value is NEVER written to any log, traceback, or error response.
    - The session_id (UUID v4) is logged for diagnostics; the JWT itself is not.
    - The device_fingerprint is a one-way SHA-256 hash; it cannot reconstruct
      any identifying information from the original headers.
"""
from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import ExpiredSignatureError, JWTError, jwt

# ── Constants ─────────────────────────────────────────────────────────────────

ALGORITHM: str = "HS256"
COOKIE_NAME: str = "wafrivet_session"
SESSION_TTL_HOURS: int = 24
# Renew the JWT when fewer than this many seconds remain on the current one.
SLIDING_WINDOW_THRESHOLD_SECONDS: int = 3_600  # 1 hour

_REQUIRED_CLAIMS: frozenset[str] = frozenset({"session_id", "device_fingerprint", "iat", "exp"})
_MIN_SECRET_LEN: int = 32


# ── Internal helpers ──────────────────────────────────────────────────────────

def _load_secret() -> str:
    """
    Load SESSION_JWT_SECRET from the environment.

    Raises EnvironmentError if the variable is absent or shorter than 32 bytes.
    Called on every JWT operation so Cloud Run secret rotation is respected
    without requiring a container restart.
    """
    secret = os.environ.get("SESSION_JWT_SECRET", "").strip()
    if not secret:
        raise EnvironmentError(
            "SESSION_JWT_SECRET is not set. "
            "Add it via GCP Secret Manager and bind it in the Cloud Run --set-secrets flag."
        )
    if len(secret) < _MIN_SECRET_LEN:
        raise EnvironmentError(
            f"SESSION_JWT_SECRET must be at least {_MIN_SECRET_LEN} characters. "
            "Generate a strong secret with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    return secret


# ── Public API ────────────────────────────────────────────────────────────────

def new_session_id() -> str:
    """Generate a cryptographically random UUID v4 for a new anonymous session."""
    return str(uuid.uuid4())


def compute_device_fingerprint(user_agent: str, accept_language: str) -> str:
    """
    Compute a non-reversible device fingerprint from request headers.

    The fingerprint is used for analytics and duplicate-session detection only.
    It is NOT used in access control decisions. Inputs are length-limited before
    hashing to prevent denial-of-service via oversized header values.

    Returns:
        A 32-character hex string (16 bytes of SHA-256 output).
    """
    raw = f"{user_agent[:512]}|{accept_language[:128]}"
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:32]


def mint_session_jwt(session_id: str, device_fingerprint: str) -> str:
    """
    Create a signed HS256 JWT representing an anonymous session.

    Claims:
        session_id         — UUID v4 (the stable, logged session identifier)
        device_fingerprint — SHA-256 prefix of User-Agent + Accept-Language
        iat                — issued-at (UTC epoch seconds)
        exp                — expiry (iat + SESSION_TTL_HOURS)

    Returns:
        A compact JWT string. Never log this value.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "session_id": session_id,
        "device_fingerprint": device_fingerprint,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=SESSION_TTL_HOURS)).timestamp()),
    }
    return jwt.encode(payload, _load_secret(), algorithm=ALGORITHM)


def verify_session_jwt(token: str) -> Optional[dict]:
    """
    Verify a session JWT and return its claims dict on success.

    Returns None — never raises — on any validation failure:
        - Signature mismatch
        - Expired token
        - Missing required claims
        - Malformed token

    The caller is responsible for treating None as "session absent / invalid"
    and minting a new session.
    """
    if not token:
        return None
    try:
        claims = jwt.decode(token, _load_secret(), algorithms=[ALGORITHM])
    except (ExpiredSignatureError, JWTError):
        return None

    if not _REQUIRED_CLAIMS.issubset(claims.keys()):
        return None
    if not claims.get("session_id"):
        return None

    return claims


def remaining_seconds(claims: dict) -> int:
    """
    Return the number of seconds until the session JWT expires.

    Returns 0 if the session has already expired or if the exp claim is missing.
    """
    exp = int(claims.get("exp", 0))
    remaining = exp - int(datetime.now(timezone.utc).timestamp())
    return max(0, remaining)
