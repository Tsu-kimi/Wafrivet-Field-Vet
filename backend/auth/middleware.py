"""
backend/auth/middleware.py

Pure ASGI SessionMiddleware for Wafrivet Field Vet.

Implemented as a raw ASGI middleware (not BaseHTTPMiddleware) so it correctly
intercepts both HTTP requests AND WebSocket upgrade requests in a single code
path. BaseHTTPMiddleware only processes scope["type"] == "http".

Behaviour on every incoming connection:
    1. Parse the ``wafrivet_session`` cookie from the request headers.
    2. Verify the JWT with python-jose. If valid, extract the session_id.
    3. If the session has fewer than SLIDING_WINDOW_THRESHOLD_SECONDS remaining,
       renew the JWT so active farmers are never cut off mid-conversation.
    4. If no valid cookie exists, mint a new anonymous session (rate-limted by IP
       to MAX_MINTS_PER_IP_PER_MINUTE to prevent session-flooding attacks).
    5. Store session_id in scope["state"] so FastAPI exposes it as
       request.state.session_id and websocket.state.session_id.
    6. Inject the Set-Cookie header into:
           HTTP:      http.response.start ASGI message
           WebSocket: websocket.accept ASGI message (valid per RFC 6455 §4.1)

Security invariants:
    - JWT value is NEVER logged; only session_id is used in log records.
    - HttpOnly, Secure, SameSite=Strict are hardcoded — not configurable at runtime.
    - Rate limiting is per-IP, per-process (Cloud Run instance). Sufficient for
      the threat model of a single-tenant veterinary edge application.
    - Cookie attributes prevent all JavaScript access to the session token.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from http.cookies import SimpleCookie
from typing import Any, Callable, MutableMapping

import structlog

from backend.auth.session import (
    COOKIE_NAME,
    SESSION_TTL_HOURS,
    SLIDING_WINDOW_THRESHOLD_SECONDS,
    compute_device_fingerprint,
    mint_session_jwt,
    new_session_id,
    remaining_seconds,
    verify_session_jwt,
)

log = structlog.get_logger().bind(logger="wafrivet.auth.middleware")

# ── Rate limiting ─────────────────────────────────────────────────────────────

MAX_MINTS_PER_IP_PER_MINUTE: int = 10
_RATE_WINDOW_SECONDS: float = 60.0
# {ip_address: [monotonic_timestamps_of_recent_mints]}
_mint_timestamps: dict[str, list[float]] = defaultdict(list)


def _is_rate_limited(ip: str) -> bool:
    """
    Sliding-window rate limiter: return True when *ip* has made too many new
    session mints in the last 60 seconds.

    Only requests that would create a NEW session are counted. Resuming an
    existing valid session is never rate-limited.
    """
    now = time.monotonic()
    window_start = now - _RATE_WINDOW_SECONDS
    bucket = _mint_timestamps[ip]
    # Evict timestamps outside the window (bucket is sorted ascending)
    while bucket and bucket[0] < window_start:
        bucket.pop(0)
    if len(bucket) >= MAX_MINTS_PER_IP_PER_MINUTE:
        return True
    bucket.append(now)
    return False


# ── Cookie helpers ────────────────────────────────────────────────────────────

_COOKIE_MAX_AGE: int = SESSION_TTL_HOURS * 3600


def _parse_cookies(raw_headers: list[tuple[bytes, bytes]]) -> dict[str, str]:
    """Extract cookie key→value pairs from raw ASGI scope headers."""
    header_dict = {k.lower(): v for k, v in raw_headers}
    raw = header_dict.get(b"cookie", b"")
    if not raw:
        return {}
    jar = SimpleCookie()
    try:
        jar.load(raw.decode("latin-1"))
    except Exception:  # noqa: BLE001
        return {}
    return {k: m.value for k, m in jar.items()}


def _build_set_cookie(jwt_value: str, max_age: int = _COOKIE_MAX_AGE) -> bytes:
    """
    Build a Set-Cookie header value bytes with all mandatory security attributes.

    Attributes are HARDCODED — never read from environment variables or config.
    This ensures the security constraints cannot be weakened by misconfiguration.
    """
    header = (
        f"{COOKIE_NAME}={jwt_value}; "
        f"Path=/; "
        f"HttpOnly; "
        f"Secure; "
        f"SameSite=Strict; "
        f"Max-Age={max_age}"
    )
    return header.encode("latin-1")


def _get_client_ip(scope: Any) -> str:
    """
    Extract the client's real IP address from ASGI scope.

    Prefers X-Forwarded-For (set by Cloud Run's load balancer) over the raw
    TCP peer address. Takes only the leftmost address from the header to avoid
    IP spoofing via appended values.
    """
    headers_dict = {k.lower(): v.decode("ascii", errors="ignore") for k, v in scope.get("headers", [])}
    xff = headers_dict.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    client = scope.get("client")
    return client[0] if client else "unknown"


# ── Middleware class ──────────────────────────────────────────────────────────

class SessionMiddleware:
    """
    Pure ASGI middleware establishing a cryptographically-signed anonymous
    session for every HTTP request and WebSocket connection.

    Register in FastAPI/Starlette with:
        app.add_middleware(SessionMiddleware)
    """

    def __init__(self, app: Callable) -> None:
        self.app = app

    async def __call__(
        self,
        scope: MutableMapping[str, Any],
        receive: Callable,
        send: Callable,
    ) -> None:
        # Only intercept HTTP requests and WebSocket upgrades.
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        raw_headers: list[tuple[bytes, bytes]] = list(scope.get("headers", []))
        cookies = _parse_cookies(raw_headers)
        raw_jwt: str | None = cookies.get(COOKIE_NAME)

        claims = verify_session_jwt(raw_jwt) if raw_jwt else None
        session_id: str
        device_fp: str
        new_jwt: str | None = None  # None → do not set / renew cookie

        if claims is not None:
            # ── Valid existing session ───────────────────────────────────────
            session_id = str(claims["session_id"])
            device_fp = str(claims.get("device_fingerprint", ""))
            secs_remaining = remaining_seconds(claims)

            if secs_remaining < SLIDING_WINDOW_THRESHOLD_SECONDS:
                # Sliding expiry: regenerate JWT to extend the session.
                new_jwt = mint_session_jwt(session_id, device_fp)
                log.info(
                    "session_jwt_renewed",
                    session_id=session_id,
                    remaining_seconds=secs_remaining,
                )
            is_new = False
        else:
            # ── No valid session — mint a new anonymous session ──────────────
            ip = _get_client_ip(scope)
            if _is_rate_limited(ip):
                log.warning(
                    "session_mint_rate_limited",
                    ip=ip,
                    max_per_minute=MAX_MINTS_PER_IP_PER_MINUTE,
                )
                # Still assign a temporary in-memory session_id for this request
                # but do not write a cookie (rate-limited). The session will not
                # be persisted to the database.
                session_id = new_session_id()
                device_fp = ""
                new_jwt = None
                is_new = False  # Don't persist this ephemeral session
            else:
                session_id = new_session_id()
                headers_dict = {k.lower(): v for k, v in raw_headers}
                user_agent = headers_dict.get(b"user-agent", b"").decode("utf-8", errors="replace")
                accept_lang = headers_dict.get(b"accept-language", b"").decode("utf-8", errors="replace")
                device_fp = compute_device_fingerprint(user_agent, accept_lang)
                new_jwt = mint_session_jwt(session_id, device_fp)
                is_new = True
                log.info(
                    "session_minted",
                    session_id=session_id,
                )

        # ── Attach session state to scope ────────────────────────────────────
        # Accessible as request.state.session_id and websocket.state.session_id.
        if "state" not in scope:
            scope["state"] = {}
        scope["state"]["session_id"] = session_id
        scope["state"]["device_fingerprint"] = device_fp
        scope["state"]["new_session"] = is_new

        if new_jwt is None:
            # No cookie to set; pass through unchanged.
            await self.app(scope, receive, send)
            return

        # ── Wrap `send` to inject Set-Cookie ─────────────────────────────────
        cookie_bytes = _build_set_cookie(new_jwt)

        async def _send_with_cookie(message: dict[str, Any]) -> None:
            msg_type = message.get("type", "")
            if msg_type == "http.response.start":
                # Inject into HTTP response headers.
                existing: list[tuple[bytes, bytes]] = list(message.get("headers", []))
                existing.append((b"set-cookie", cookie_bytes))
                message = {**message, "headers": existing}
            elif msg_type == "websocket.accept":
                # Inject into the WebSocket 101 handshake headers.
                # RFC 6455 §4.1 permits arbitrary HTTP headers in the 101 response.
                # Browsers process Set-Cookie from 101 responses correctly.
                existing = list(message.get("headers") or [])
                existing.append((b"set-cookie", cookie_bytes))
                message = {**message, "headers": existing}
            await send(message)

        await self.app(scope, receive, _send_with_cookie)
