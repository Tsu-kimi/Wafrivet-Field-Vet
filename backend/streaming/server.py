"""
backend/streaming/server.py

Wafrivet Field Vet — Phase 3 FastAPI application with Gemini Live streaming.

WebSocket endpoint:
    ws://<host>/ws/{user_id}/{session_id}

Message protocol (browser → server):
    Binary frame  — raw 16-bit PCM audio at 16 kHz (mono)
    Text frame    — JSON object with one of:
                    {"type": "IMAGE", "data": "<base64-JPEG>"}
                    {"type": "TEXT",  "text": "<message>"}

Message protocol (server → browser):
    Binary frame  — raw PCM audio bytes from Gemini (24 kHz output)
    Text frame    — JSON event object with "type" key (see streaming/events.py)

Session lifecycle:
    1. Validate user_id and session_id as safe identifiers (alphanumeric + hyphen/-)
    2. Call session_service.get_session() → resume existing ADK session
    3. If not found, call session_service.create_session() → new session + persist
    4. Run bridge.run_bridge() which manages upstream + downstream tasks
    5. On disconnect, upsert the session handle so the client can reconnect

Startup / lifespan:
    Runner and InMemorySessionService are created once per process in the
    FastAPI lifespan context manager (not per request).  The live model
    gemini-live-2.5-flash-native-audio is used instead of the Phase 2 text model.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import structlog
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.adk.agents import LlmAgent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# Ensure repo root is on path (supports both `python backend/main.py` and uvicorn invocation)
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.agent.agent import root_agent, reflect_and_retry_plugin  # noqa: E402
from backend.agent.session import INITIAL_STATE  # noqa: E402
from backend.auth.middleware import SessionMiddleware  # noqa: E402
from backend.db import pool as db_pool  # noqa: E402
from backend.routers.farmers import router as farmers_router  # noqa: E402
from backend.routers.payments import router as payments_router  # noqa: E402
from backend.routers.sessions import router as sessions_router  # noqa: E402
from backend.services.redis_client import init_redis, close_redis  # noqa: E402
from backend.streaming.bridge import run_bridge  # noqa: E402
from backend.streaming.session_store import (  # noqa: E402
    get_session_handle,
    upsert_session_handle,
)

# ---------------------------------------------------------------------------
# Structured logging via structlog
# ---------------------------------------------------------------------------

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.dict_tracebacks,
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger().bind(logger="wafrivet.streaming.server")

# ---------------------------------------------------------------------------
# Identifier validation
# ---------------------------------------------------------------------------

# Accepted: alphanumeric, hyphens, underscores (UUID-safe + simple IDs)
_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,128}$")


def _is_safe_id(value: str) -> bool:
    return bool(_SAFE_ID_RE.match(value))


# ---------------------------------------------------------------------------
# Gemini Live model + RunConfig
# ---------------------------------------------------------------------------

# Phase 3 uses the Gemini 2.0 Flash Live model for native audio streaming.
# The root_agent is defined with gemini-2.0-flash (Phase 2 text model);
# we create a live_agent that clones its config with the live-model override.
_LIVE_MODEL = os.environ.get("WAFRIVET_LIVE_MODEL", "gemini-live-2.5-flash-native-audio")

_APP_NAME = "wafrivet"


def _build_live_agent() -> LlmAgent:
    """Clone root_agent with the Gemini Live model."""
    return LlmAgent(
        name=root_agent.name,
        model=_LIVE_MODEL,
        instruction=root_agent.instruction,
        tools=list(root_agent.tools),
    )


def _build_run_config() -> RunConfig:
    """
    Build RunConfig for Gemini Live sessions.

    - enable_affective_dialog: model auto-adjusts pace/warmth to the user's
      emotional register without any application logic.
    - speech_config / voice_name="Kore": warm, nurturing voice suited to
      distressed or uncertain users across all three user types.
    - System instruction is carried by the agent's instruction field
      (FATIMA_SYSTEM_PROMPT), not re-sent here.
    """
    return RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],  # plain string – avoids Pydantic StrEnum serialization warning
        enable_affective_dialog=True,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Kore"
                )
            )
        ),
    )


# ---------------------------------------------------------------------------
# Lifespan: create Runner + SessionService singletons
# ---------------------------------------------------------------------------

_runner: Runner | None = None
_session_service: InMemorySessionService | None = None
_run_config: RunConfig | None = None


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncGenerator:
    global _runner, _session_service, _run_config

    log.info("wafrivet_streaming_startup", live_model=_LIVE_MODEL)

    # ── Phase 4: initialise asyncpg connection pool ───────────────────────
    # The pool targets the Supabase transaction-mode PgBouncer pooler so that
    # set_config('app.session_id', ..., true) works within transactions.
    await db_pool.init_pool()

    # ── Phase 5: initialise Redis client (PIN state, pub/sub) ────────────
    await init_redis()

    _session_service = InMemorySessionService()
    live_agent = _build_live_agent()
    _runner = Runner(
        agent=live_agent,
        app_name=_APP_NAME,
        session_service=_session_service,
        plugins=[reflect_and_retry_plugin],
    )
    _run_config = _build_run_config()

    log.info("runner_ready", agent=live_agent.name, model=_LIVE_MODEL)

    yield  # ← server is live

    # ── Phase 4: close asyncpg pool on shutdown ───────────────────────────
    await db_pool.close_pool()

    # ── Phase 5: close Redis client on shutdown ───────────────────────────
    await close_redis()
    log.info("wafrivet_streaming_shutdown")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Wafrivet Field Vet — Live Streaming API",
    version="4.0.0",
    lifespan=_lifespan,
)

# ── Phase 4: CORS ─────────────────────────────────────────────────────────────
# Restrict origins to the known Vercel frontend domain and local dev.
# Credentials=True is required so the browser sends the HttpOnly session cookie.
# Hardcoded allowlist to avoid production failures caused by missing/mis-set env vars.
_allowed_origins: list[str] = [
    "https://wafrivet-field-vet.vercel.app",
    "http://localhost:3000",
    # LAN dev (mobile testing) — set to the host machine's Wi‑Fi IP
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,  # Required for HttpOnly cookie to be sent cross-origin
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# ── Phase 4: Session Middleware ────────────────────────────────────────────────
# SessionMiddleware must be added BEFORE CORS so that every response — including
# CORS preflight 200s — receives the Set-Cookie header.
# It is added after CORS in Starlette's middleware stack, which means it executes
# FIRST (middleware stack is LIFO). add_middleware() prepends, so the last
# add_middleware call wraps the outermost layer.
app.add_middleware(SessionMiddleware)

# ── Phase 4: Sessions router ──────────────────────────────────────────────────
app.include_router(sessions_router)

# ── Phase 5: Farmers + Payments routers ───────────────────────────────────────
app.include_router(farmers_router)
app.include_router(payments_router)


@app.exception_handler(RequestValidationError)
async def _request_validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """Log full 422 validation details with request context for debugging."""
    errors = exc.errors()
    body_preview = ""
    try:
        raw = await request.body()
        body_preview = raw.decode("utf-8", errors="replace")[:1000]
    except Exception:
        body_preview = "<unavailable>"

    log.warning(
        "request_validation_failed",
        method=request.method,
        path=request.url.path,
        query=str(request.url.query),
        client_ip=(request.client.host if request.client else None),
        error_count=len(errors),
        errors=errors,
        body_preview=body_preview,
    )

    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": errors,
            "message": (
                "Request validation failed. Check required fields, value lengths, "
                "and payload shape."
            ),
        },
    )


@app.get("/health")
async def health_check() -> JSONResponse:
    """
    Startup probe + liveness probe target for Cloud Run health checks.

    Verifies:
      - Supabase is reachable (products count, 2-second timeout)
      - Gemini credentials are present in the environment

    Returns HTTP 200 + {"status":"ok"} when all checks pass.
    Returns HTTP 503 + {"status":"degraded"} when any check fails.
    Designed to complete within 200 ms on a warm instance (Supabase check is
    the longest leg; it is hardware-bounded by the 2-second asyncio timeout).
    """
    checks: dict[str, str] = {}
    overall_ok = True

    # ── Check 1: Supabase reachability ─────────────────────────────────────
    try:
        supabase_url = os.environ["SUPABASE_URL"]
        supabase_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

        def _supabase_ping() -> None:
            from supabase import create_client as _mk  # type: ignore[attr-defined]  # local import
            _mk(supabase_url, supabase_key).table("products").select("id").limit(1).execute()

        await asyncio.wait_for(asyncio.to_thread(_supabase_ping), timeout=2.0)
        checks["supabase"] = "ok"
    except Exception as exc:  # noqa: BLE001
        log.warning("health_supabase_fail", error=str(exc))
        checks["supabase"] = "error"
        overall_ok = False

    # ── Check 2: Gemini / ADK credentials present ──────────────────────────
    try:
        if not (
            os.environ.get("GOOGLE_API_KEY")
            or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        ):
            raise ValueError("Neither GOOGLE_API_KEY nor GOOGLE_APPLICATION_CREDENTIALS is set")
        checks["auth"] = "ok"
    except Exception as exc:  # noqa: BLE001
        log.warning("health_auth_fail", error=str(exc))
        checks["auth"] = "error"
        overall_ok = False

    http_code = 200 if overall_ok else 503
    return JSONResponse(
        {
            "status": "ok" if overall_ok else "degraded",
            "checks": checks,
            "model": _LIVE_MODEL,
        },
        status_code=http_code,
    )


@app.get("/healthz", include_in_schema=False)
async def health_alias() -> JSONResponse:
    """Lightweight keepalive alias — delegates to /health."""
    return await health_check()


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
) -> None:
    # ── 1. Validate identifiers ───────────────────────────────────────────
    if not _is_safe_id(user_id) or not _is_safe_id(session_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        log.warning("invalid_identifiers", user_id=user_id, session_id=session_id)
        return

    await websocket.accept()
    log.info("ws_connected", user_id=user_id, session_id=session_id)

    # ── 2. Extract auth session_id from SessionMiddleware cookie state ────
    # SessionMiddleware (Phase 4) runs over WebSocket upgrade requests and
    # stores the verified JWT session_id in scope["state"]["session_id"].
    # websocket.state reads from the same scope dict.
    auth_session_id: str = getattr(websocket.state, "session_id", session_id)
    is_new_auth_session: bool = getattr(websocket.state, "new_session", False)
    device_fingerprint: str = getattr(websocket.state, "device_fingerprint", "")

    # ── 3. Persist new sessions to Supabase via asyncpg ──────────────────
    if is_new_auth_session:
        from backend.db.rls import rls_context
        from datetime import datetime, timedelta, timezone
        from backend.auth.session import SESSION_TTL_HOURS
        expires_at = datetime.now(timezone.utc) + timedelta(hours=SESSION_TTL_HOURS)
        try:
            async with rls_context(auth_session_id) as conn:
                await conn.execute(
                    """
                    INSERT INTO public.sessions
                        (session_id, device_fingerprint, expires_at)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (session_id) DO UPDATE
                        SET last_active_at = NOW()
                    """,
                    auth_session_id,
                    device_fingerprint[:128],
                    expires_at,
                )
            log.info("auth_session_persisted", auth_session_id=auth_session_id)
        except Exception as _exc:
            log.warning(
                "auth_session_persist_failed",
                auth_session_id=auth_session_id,
                error=str(_exc),
            )
            # Non-fatal: continue — session may not be persisted but the
            # WS conversation can still proceed.

    # ── 4. Get or create ADK session ─────────────────────────────────────
    assert _session_service is not None, "session_service not initialised"
    assert _runner is not None, "runner not initialised"
    assert _run_config is not None, "run_config not initialised"

    existing = await _session_service.get_session(
        app_name=_APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )

    if existing is None:
        # Check Supabase for a known session_id for this user
        known_session_id = get_session_handle(user_id)
        if known_session_id and known_session_id == session_id:
            # Client reconnecting with same session_id — recreate it in memory
            # (InMemorySessionService does not persist across restarts)
            pass  # Will be created below with the same session_id

        # Include auth_session_id in state so ADK tools can use it for
        # RLS-scoped Supabase queries via rls_context(auth_session_id).
        initial_state = dict(INITIAL_STATE)
        initial_state["auth_session_id"] = auth_session_id

        # If the farmer has already logged in, the sessions row will have
        # phone_number set by POST /farmers/login. Populate farmer identity
        # fields in ADK state so tools like get_order_history can run without
        # re-auth prompts.
        try:
            from backend.db.rls import rls_context as _rls
            async with _rls(auth_session_id) as _conn:
                _row = await _conn.fetchrow(
                    """
                    SELECT s.phone_number, f.name
                      FROM public.sessions s
                      LEFT JOIN public.farmers f ON f.phone_number = s.phone_number
                     WHERE s.session_id = $1
                    """,
                    auth_session_id,
                )
            if _row and _row["phone_number"]:
                initial_state["farmer_phone"] = _row["phone_number"]
                initial_state["farmer_phone_verified"] = True
                if _row["name"]:
                    initial_state["farmer_name"] = _row["name"]
        except Exception as _exc:
            log.warning("session_phone_lookup_failed", auth_session_id=auth_session_id, error=str(_exc))

        await _session_service.create_session(
            app_name=_APP_NAME,
            user_id=user_id,
            session_id=session_id,
            state=initial_state,
        )
        log.info("session_created", user_id=user_id, session_id=session_id, auth_session_id=auth_session_id)
    else:
        # Ensure auth_session_id is always up to date in existing session state.
        if existing.state.get("auth_session_id") != auth_session_id:
            existing.state["auth_session_id"] = auth_session_id

        # Refresh farmer identity on every websocket resume. This covers the
        # common path where login happened after the ADK session was created.
        try:
            from backend.db.rls import rls_context as _rls
            async with _rls(auth_session_id) as _conn:
                _row = await _conn.fetchrow(
                    """
                    SELECT s.phone_number, f.name
                      FROM public.sessions s
                      LEFT JOIN public.farmers f ON f.phone_number = s.phone_number
                     WHERE s.session_id = $1
                    """,
                    auth_session_id,
                )
            if _row and _row["phone_number"]:
                existing.state["farmer_phone"] = _row["phone_number"]
                existing.state["farmer_phone_verified"] = True
                if _row["name"]:
                    existing.state["farmer_name"] = _row["name"]
        except Exception as _exc:
            log.warning("session_phone_refresh_failed", auth_session_id=auth_session_id, error=str(_exc))

        log.info("session_resumed", user_id=user_id, session_id=session_id, auth_session_id=auth_session_id)

    # Structured session_open log — visible in Cloud Run log stream during demo.
    import json as _json, logging as _logging
    _logging.getLogger("wafrivet.streaming.server").info(
        _json.dumps({
            "event": "session_open",
            "session_id": session_id,
            "user_id": user_id,
            "user_type_detected": None,
            "model": _LIVE_MODEL,
        })
    )

    # Persist the mapping so the client can reconnect
    upsert_session_handle(user_id=user_id, session_id=session_id)

    # ── 5. Hand off to bridge ─────────────────────────────────────────────
    try:
        await run_bridge(
            websocket=websocket,
            user_id=user_id,
            session_id=session_id,
            runner=_runner,
            session_service=_session_service,
            run_config=_run_config,
            auth_session_id=auth_session_id,
        )
    except WebSocketDisconnect:
        log.info("ws_disconnected", user_id=user_id, session_id=session_id)
    except Exception as exc:
        log.error(
            "ws_unhandled_error",
            user_id=user_id,
            session_id=session_id,
            error=str(exc),
        )
    finally:
        import json as _json, logging as _logging
        _logging.getLogger("wafrivet.streaming.server").info(
            _json.dumps({
                "event": "session_close",
                "session_id": session_id,
                "user_id": user_id,
            })
        )
        log.info("ws_closed", user_id=user_id, session_id=session_id)
