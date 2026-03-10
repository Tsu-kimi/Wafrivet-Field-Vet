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
    gemini-2.0-flash-live-001 is used instead of the Phase 2 text model.
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
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status
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

from backend.agent.agent import root_agent  # noqa: E402
from backend.agent.session import INITIAL_STATE  # noqa: E402
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
_LIVE_MODEL = os.environ.get("WAFRIVET_LIVE_MODEL", "gemini-2.0-flash-live-001")

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
    return RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=[types.Modality.AUDIO],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
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

    _session_service = InMemorySessionService()
    live_agent = _build_live_agent()
    _runner = Runner(
        agent=live_agent,
        app_name=_APP_NAME,
        session_service=_session_service,
    )
    _run_config = _build_run_config()

    log.info("runner_ready", agent=live_agent.name, model=_LIVE_MODEL)

    yield  # ← server is live

    log.info("wafrivet_streaming_shutdown")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Wafrivet Field Vet — Live Streaming API",
    version="3.0.0",
    lifespan=_lifespan,
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
            from supabase import create_client as _mk  # local import — avoids circular
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

    # ── 2. Get or create ADK session ──────────────────────────────────────
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

        await _session_service.create_session(
            app_name=_APP_NAME,
            user_id=user_id,
            session_id=session_id,
            state=dict(INITIAL_STATE),
        )
        log.info("session_created", user_id=user_id, session_id=session_id)
    else:
        log.info("session_resumed", user_id=user_id, session_id=session_id)

    # Persist the mapping so the client can reconnect
    upsert_session_handle(user_id=user_id, session_id=session_id)

    # ── 3. Hand off to bridge ─────────────────────────────────────────────
    try:
        await run_bridge(
            websocket=websocket,
            user_id=user_id,
            session_id=session_id,
            runner=_runner,
            session_service=_session_service,
            run_config=_run_config,
        )
    except WebSocketDisconnect:
        log.info("ws_disconnected", user_id=user_id, session_id=session_id)
    except Exception as exc:
        log.error(
            "ws_unhandled_error",
            user_id=user_id,
            session_id=session_id,
            error=str(exc),
            exc_info=True,
        )
    finally:
        log.info("ws_closed", user_id=user_id, session_id=session_id)
