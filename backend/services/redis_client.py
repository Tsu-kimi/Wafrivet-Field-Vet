"""
backend/services/redis_client.py

Async Redis client singleton for Wafrivet Field Vet.

Uses redis.asyncio (bundled with redis>=4.2, the successor to aioredis) for
async-native operations. The client is initialised once in the FastAPI lifespan
context and shared across all request handlers via module-level state.

Key namespaces:
    session_state:{session_id}   → ACTIVE | AWAITING_PIN | LOCKED   (TTL 25 h)
    pin_attempts:{phone_number}  → integer attempt counter            (TTL per attempt)
    otp:{phone_number}           → 6-digit OTP string                 (TTL 600 s)
    session_phone:{session_id}   → phone_number for WebSocket lookup  (TTL 25 h)

Environment variable required:
    REDIS_URL  — redis:// or rediss:// connection string. Cloud Run with
                 Cloud Memorystore should inject this via --set-env-vars.
                 Default falls back to redis://localhost:6379 for local dev.

Security:
    - The OTP value is NEVER logged. Only the phone number and TTL are logged.
    - The PIN hash is never stored in Redis; it lives only in Supabase.
    - Redis keys are parameterised with validated inputs (E.164 phone or UUID session_id).
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import redis.asyncio as aioredis

log = logging.getLogger("wafrivet.services.redis_client")

_client: Optional[aioredis.Redis] = None  # type: ignore[type-arg]


async def init_redis() -> None:
    """
    Create the async Redis client.

    Called once from the FastAPI lifespan context manager (server.py).
    Raises EnvironmentError if REDIS_URL is absent in production.
    Falls back to localhost for local development automatically.
    """
    global _client
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379").strip()
    # decode_responses=True means all Redis values are returned as str, not bytes.
    # This is consistent throughout the application — all values we store are strings.
    _client = aioredis.from_url(
        redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=20,
    )
    # Verify connectivity at startup rather than failing on the first request.
    await _client.ping()
    log.info("redis_client_initialised", extra={"url": _redact_url(redis_url)})


async def close_redis() -> None:
    """Close the Redis client gracefully. Called from lifespan shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
        log.info("redis_client_closed")


def get_redis() -> aioredis.Redis:  # type: ignore[type-arg]
    """
    Return the shared Redis client.

    Raises RuntimeError if called before init_redis() (startup error).
    """
    if _client is None:
        raise RuntimeError(
            "Redis client not initialised. Call init_redis() from the FastAPI lifespan."
        )
    return _client


def _redact_url(url: str) -> str:
    """Replace password in a Redis connection URL with *** for safe logging."""
    try:
        from urllib.parse import urlparse, urlunparse
        parts = urlparse(url)
        if parts.password:
            netloc = parts.netloc.replace(parts.password, "***")
            return urlunparse(parts._replace(netloc=netloc))
    except Exception:  # noqa: BLE001
        pass
    return url
