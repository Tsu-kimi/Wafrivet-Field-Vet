"""
backend/streaming/bridge.py

Bidirectional streaming bridge: WebSocket ↔ ADK run_live() ↔ Gemini Live API.

Architecture
────────────
Each connected WebSocket spawns two concurrent tasks:

  upstream_task   — reads messages from the browser and forwards them into the
                    LiveRequestQueue. Binary frames are treated as 16-bit PCM
                    audio at 16 kHz. Text frames are parsed as JSON and may
                    carry a base64-encoded JPEG frame or a raw text message.

  downstream_task — iterates the run_live() async generator, applies the
                    is_interrupted state machine, and sends structured JSON
                    events (plus raw binary audio) back to the browser.

Interruption state machine
──────────────────────────
  is_interrupted is set to True when event.interrupted is received.
  While True:
    - Audio inline_data events are discarded (do not forward stale audio)
    - AUDIO_FLUSH is sent to the browser immediately on first interrupt
  is_interrupted is reset to False when event.turn_complete is received.

Tool-response routing
─────────────────────
ADK executes all five tools automatically.  The downstream task intercepts
function_response events and maps each tool to the appropriate frontend event:

  search_disease_matches  → no UI event (agent narrates results in audio)
  recommend_products      → PRODUCTS_RECOMMENDED
  manage_cart             → CART_UPDATED
  generate_checkout_link  → CHECKOUT_LINK
  update_location         → LOCATION_CONFIRMED

Logger contract
───────────────
Every log record carries: session_id, user_id, event_type.
The elapsed_ms field is the milliseconds since run_bridge() was called.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
import traceback as _traceback
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from backend.streaming.events import (
    audio_flush_event,
    cart_updated_event,
    checkout_link_event,
    clinics_found_event,
    identity_verified_event,
    location_confirmed_event,
    order_confirmed_event,
    payment_confirmed_event,
    pin_required_event,
    products_recommended_event,
    scanning_product_event,
    tool_error_event,
    turn_complete_event,
)

logger = logging.getLogger("wafrivet.streaming.bridge")

# MIME type expected by Gemini Live for raw PCM audio from the browser
_AUDIO_MIME = "audio/pcm;rate=16000"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def run_bridge(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
    runner: Runner,
    session_service: InMemorySessionService,
    run_config: Any,
    auth_session_id: str = "",
) -> None:
    """
    Manage the full lifetime of one WebSocket streaming session.

    auth_session_id is the JWT-verified session ID (from the HttpOnly cookie).
    It differs from session_id (the Gemini/ADK session URL parameter) and is
    used as the Redis key for AWAITING_PIN state checks and pub/sub channels.

    Raises nothing — all exceptions are caught internally; the WebSocket is
    closed in the finally block.
    """
    start_ns = time.monotonic_ns()
    live_request_queue: LiveRequestQueue = LiveRequestQueue()
    log_ctx = {"user_id": user_id, "session_id": session_id}

    def _log(level: str, msg: str, event_type: str = "-", **kw: Any) -> None:
        elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
        # Passing exc_info=True alongside extra= causes KeyError in Python's
        # LogRecord when exc_info is already set as a record attribute.
        # Callers should pass traceback text via kw["tb"] as a plain string.
        kw.pop("exc_info", None)
        getattr(logger, level)(
            msg,
            extra={**log_ctx, "event_type": event_type, "elapsed_ms": elapsed_ms, **kw},
        )

    _log("info", "bridge started")

    # Lightweight session-level flags tracked inside the bridge lifetime.
    # is_ai_speaking mirrors whether Gemini is currently producing audio so
    # barge-in handling can discard in-flight chunks immediately.
    session_state: dict = {"is_ai_speaking": False}

    # Resolve the auth_session_id for Redis state checks.
    # Falls back to session_id if not explicitly provided (Phase 3 compat).
    _auth_sid: str = auth_session_id or session_id

    # ------------------------------------------------------------------
    # Proactive greeting — Fatima speaks first on every session open.
    # Enqueue the trigger message BEFORE starting the tasks so it arrives
    # as the very first input the run_live() loop processes.
    # ------------------------------------------------------------------
    live_request_queue.send_content(
        types.Content(
            role="user",
            parts=[types.Part(text=(
                "The session has just started. Greet the user warmly as Fatima "
                "and ask what is wrong with their animal or what you can help with today."
            ))],
        )
    )
    _log("info", "proactive greeting enqueued", "GREETING")

    # ------------------------------------------------------------------
    # Upstream: WebSocket → LiveRequestQueue
    # ------------------------------------------------------------------
    async def upstream_task() -> None:
        try:
            while True:
                message = await websocket.receive()

                if message["type"] == "websocket.disconnect":
                    _log("info", "client disconnected (upstream)", "DISCONNECT")
                    break

                # ── AWAITING_PIN suppression ────────────────────────────────
                # When a PIN overlay is active, suppress all messages flowing
                # to Gemini (except PIN_VERIFIED which is handled below).
                # Binary audio is also dropped to prevent Gemini from processing
                # the farmer's speech and generating a response during PIN entry.
                if "text" in message and message["text"] is not None:
                    try:
                        _pre_payload: dict = json.loads(message["text"])
                    except (json.JSONDecodeError, Exception):
                        _pre_payload = {}

                    _msg_type = _pre_payload.get("type", "")

                    # ── PIN_VERIFIED: client signals successful PIN check ────
                    if _msg_type == "PIN_VERIFIED":
                        farmer_name: str = _pre_payload.get("farmer_name", "")
                        # Update the ADK session state to mark identity verified.
                        try:
                            _session = await session_service.get_session(
                                app_name=runner.app_name,
                                user_id=user_id,
                                session_id=session_id,
                            )
                            if _session:
                                _session.state["farmer_phone_verified"] = True
                                if farmer_name:
                                    _session.state["farmer_name"] = farmer_name
                        except Exception as _exc:
                            _log("warning", f"Failed to update verified state: {_exc}", "PIN_VERIFIED_ERR")

                        # Session state is now ACTIVE (set by /farmers/pin/verify).
                        # Inject a Gemini content so Fatima resumes naturally.
                        _resume_text = (
                            f"The farmer's identity has been verified successfully. "
                            f"{f'Their name is {farmer_name}. ' if farmer_name else ''}"
                            "Please greet them warmly and continue helping with their request."
                        )
                        live_request_queue.send_content(
                            types.Content(
                                role="user",
                                parts=[types.Part(text=_resume_text)],
                            )
                        )
                        await websocket.send_json(
                            identity_verified_event(
                                farmer_name=farmer_name or None,
                                message="Identity verified. Fatima is resuming.",
                            )
                        )
                        _log("info", f"PIN verified, session resumed for {farmer_name!r}", "PIN_VERIFIED")
                        continue

                # Check whether the session is in AWAITING_PIN state.
                # Done per-message (after PIN_VERIFIED handled above) — Redis GET
                # is O(1) and takes ~1 ms per call, acceptable at WS message rates.
                try:
                    from backend.services.session_state_service import is_awaiting_pin
                    _in_pin_mode = await is_awaiting_pin(_auth_sid)
                except Exception:
                    _in_pin_mode = False

                if _in_pin_mode:
                    # Silently drop all messages (audio + text) during PIN entry.
                    _log("debug", "upstream message dropped — AWAITING_PIN", "PIN_SUPPRESS")
                    continue

                if "bytes" in message and message["bytes"] is not None:
                    # Binary frame → raw PCM audio chunk
                    audio_bytes: bytes = message["bytes"]
                    blob = types.Blob(mime_type=_AUDIO_MIME, data=audio_bytes)
                    live_request_queue.send_realtime(blob)
                    _log("debug", "sent audio chunk", "AUDIO_IN", bytes=len(audio_bytes))

                elif "text" in message and message["text"] is not None:
                    # Text frame → JSON envelope
                    try:
                        payload: dict = json.loads(message["text"])
                    except json.JSONDecodeError as exc:
                        _log("warning", f"invalid JSON from client: {exc}", "BAD_JSON")
                        continue

                    msg_type = payload.get("type", "")

                    if msg_type == "IMAGE":
                        # base64-encoded JPEG video frame
                        raw_b64: str = payload.get("data", "")
                        if raw_b64:
                            image_bytes = base64.b64decode(raw_b64)
                            blob = types.Blob(mime_type="image/jpeg", data=image_bytes)
                            live_request_queue.send_realtime(blob)
                            _log("debug", "sent image frame", "IMAGE_IN")

                    elif msg_type == "TEXT":
                        # Text message (fallback for non-audio clients)
                        text_body: str = payload.get("text", "").strip()
                        if text_body:
                            content = types.Content(
                                parts=[types.Part(text=text_body)],
                                role="user",
                            )
                            live_request_queue.send_content(content)
                            _log("debug", "sent text message", "TEXT_IN")

                    elif msg_type == "INTERRUPT":
                        # User tapped the stop button. Send 100 ms of silence so
                        # Gemini's VAD detects end-of-speech and fires event.interrupted,
                        # which the downstream state machine converts to AUDIO_FLUSH.
                        silence_100ms = bytes(3200)  # 16kHz × 1ch × 2B × 0.1 s
                        live_request_queue.send_realtime(
                            types.Blob(mime_type=_AUDIO_MIME, data=silence_100ms)
                        )
                        _log("info", "user interrupt – silence barge-in sent", "INTERRUPT")

                    elif msg_type == "LOCATION_DATA":
                        # Browser sends GPS coordinates once geolocation resolves.
                        # Write them into the ADK in-memory session state so the
                        # find_nearest_vet_clinic tool can read them via tool_context.state.
                        lat = payload.get("lat")
                        lon = payload.get("lon")
                        if lat is not None and lon is not None:
                            try:
                                session = await session_service.get_session(
                                    app_name=runner.app_name,
                                    user_id=user_id,
                                    session_id=session_id,
                                )
                                if session:
                                    session.state["farmer_lat"] = float(lat)
                                    session.state["farmer_lon"] = float(lon)
                                    lga_val = payload.get("lga")
                                    if lga_val:
                                        session.state["farmer_lga"] = str(lga_val)
                                    state_val = payload.get("state")
                                    if state_val and not session.state.get("farmer_state"):
                                        session.state["farmer_state"] = str(state_val)
                                    _log("info", f"GPS stored: lat={lat}, lon={lon}", "LOCATION_DATA")
                            except Exception as exc:
                                _log("warning", f"Failed to store GPS in session: {exc}", "LOCATION_DATA_ERR")

                    else:
                        _log("warning", f"unknown message type: {msg_type!r}", "UNKNOWN_MSG")

        except WebSocketDisconnect:
            _log("info", "WebSocket disconnected during upstream", "DISCONNECT")
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            _log("error", f"upstream error: {exc}", "UPSTREAM_ERR")
        finally:
            # Signal run_live() to stop once upstream ends
            live_request_queue.close()

    # ------------------------------------------------------------------
    # Downstream: run_live() → WebSocket
    # ------------------------------------------------------------------
    async def downstream_task() -> None:
        is_interrupted = False

        try:
            async for event in runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                # ── Priority 1: Model / connection error ──────────────────
                if event.error_code:
                    _log(
                        "error",
                        f"model error {event.error_code}: {event.error_message}",
                        "MODEL_ERR",
                    )
                    terminal_codes = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "MAX_TOKENS", "CANCELLED"}
                    if event.error_code in terminal_codes:
                        await websocket.send_json(
                            {"type": "ERROR", "code": event.error_code, "message": event.error_message}
                        )
                        break
                    # Transient error — keep processing
                    continue

                # ── AWAITING_PIN downstream suppression ─────────────────
                # After a tool fires that transitions the session to AWAITING_PIN,
                # we suppress all Gemini output (audio + events) except for the
                # remainder of the current turn (which carries Fatima's "enter
                # your PIN" message). The turn_complete event resets interruption.
                # We sample the state once per tool_response/audio group, not
                # per event, to avoid excessive Redis calls in tight loops.
                try:
                    from backend.services.session_state_service import is_awaiting_pin
                    _awaiting = await is_awaiting_pin(_auth_sid)
                except Exception:
                    _awaiting = False

                if _awaiting:
                    # Allow tool_response events through (so PIN_REQUIRED is sent)
                    # but suppress audio and content events.
                    _has_fn_resp = bool(
                        event.get_function_responses()
                        if hasattr(event, "get_function_responses") else []
                    )
                    if not _has_fn_resp:
                        # Suppress audio, transcription, and turn_complete during
                        # PIN entry so the browser is fully quiet.
                        continue

                # ── Priority 2: Interruption (barge-in) ──────────────────
                if event.interrupted:
                    if not is_interrupted:
                        is_interrupted = True
                        # 1. Mark Fatima as no longer speaking so subsequent audio
                        #    chunks are discarded rather than forwarded.
                        session_state["is_ai_speaking"] = False
                        # 2. Tell the browser to stop the audio player and cancel
                        #    all scheduled AudioBufferSourceNode instances, then
                        #    also send the canonical AUDIO_FLUSH envelope.
                        await websocket.send_json({"type": "interrupted"})
                        await websocket.send_json(audio_flush_event())
                        # 3. Emit a structured log line for the Cloud Run log stream.
                        logger.info(
                            {"event": "barge_in", "session_id": session_id, "timestamp": time.time()}
                        )
                        _log("info", "barge-in → interrupted + AUDIO_FLUSH sent", "BARGE_IN")
                    continue

                # ── Priority 3: Turn complete ────────────────────────────
                if event.turn_complete:
                    is_interrupted = False
                    session_state["is_ai_speaking"] = False
                    await websocket.send_json(turn_complete_event())
                    _log("info", "turn complete", "TURN_COMPLETE")
                    continue

                # ── While interrupted: discard content events ────────────
                if is_interrupted:
                    continue

                # ── Priority 5: Audio inline_data ────────────────────────
                if event.content and event.content.parts:
                    for part in event.content.parts:
                        if part.inline_data and part.inline_data.data:
                            # Mark Fatima as speaking so the barge-in handler
                            # knows there is live audio in flight.
                            session_state["is_ai_speaking"] = True
                            # Send raw PCM as binary WebSocket frame for low latency
                            await websocket.send_bytes(part.inline_data.data)
                            _log(
                                "debug",
                                "sent audio chunk to client",
                                "AUDIO_OUT",
                                bytes=len(part.inline_data.data),
                            )

                # ── Priority 6: Tool function responses ──────────────────
                fn_responses = event.get_function_responses() if hasattr(event, "get_function_responses") else []
                for fn_resp in (fn_responses or []):
                    fn_name: str = fn_resp.name or ""
                    await _route_tool_response(
                        websocket=websocket,
                        tool_name=fn_name,
                        response=fn_resp.response,
                        log_fn=_log,                        session_id=session_id,                    )

        except WebSocketDisconnect:
            _log("info", "WebSocket disconnected during downstream", "DISCONNECT")
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            exc_str = str(exc)
            if "RESOURCE_EXHAUSTED" in exc_str or "Maximum concurrent sessions" in exc_str:
                _log("warning", "Gemini Live quota exceeded — max concurrent sessions reached", "QUOTA_EXCEEDED")
                with contextlib.suppress(Exception):
                    await websocket.send_json({
                        "type": "ERROR",
                        "code": "RESOURCE_EXHAUSTED",
                        "message": "The AI service is at capacity. Please wait 30 seconds and try again.",
                    })
            else:
                _log("error", f"downstream error: {exc}", "DOWNSTREAM_ERR", tb=_traceback.format_exc())
        finally:
            live_request_queue.close()

    # ------------------------------------------------------------------
    # Run both tasks concurrently
    # ------------------------------------------------------------------
    up_task   = asyncio.create_task(upstream_task(), name=f"upstream-{session_id}")
    down_task = asyncio.create_task(downstream_task(), name=f"downstream-{session_id}")
    sub_task  = asyncio.create_task(
        _redis_payment_subscriber(websocket, _auth_sid, _log),
        name=f"redis-sub-{session_id}",
    )

    try:
        done, pending = await asyncio.wait(
            [up_task, down_task, sub_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
    finally:
        live_request_queue.close()
        _log("info", "bridge closed")


# ---------------------------------------------------------------------------
# Redis pub/sub subscriber — delivers PAYMENT_CONFIRMED to the WebSocket
# ---------------------------------------------------------------------------

async def _redis_payment_subscriber(
    websocket: WebSocket,
    auth_session_id: str,
    log_fn: Any,
) -> None:
    """
    Subscribe to Redis channel session:{auth_session_id} and forward any
    PAYMENT_CONFIRMED message to the connected WebSocket as a typed event.

    This task runs for the full lifetime of the WebSocket connection alongside
    upstream_task and downstream_task. It is cancelled when either of those
    tasks completes (i.e., at disconnect).

    The payment webhook (/payments/webhook) publishes to this channel after
    verifying the HMAC signature and updating the cart status to payment_received.
    """
    if not auth_session_id:
        log_fn("warning", "redis subscriber skipped — no auth_session_id", "REDIS_SUB_SKIP")
        return

    try:
        from backend.services.redis_client import get_redis
        redis = get_redis()
    except RuntimeError:
        log_fn("warning", "redis not initialised — payment events unavailable", "REDIS_NOT_INIT")
        return

    channel = f"session:{auth_session_id}"
    pubsub = redis.pubsub()

    try:
        await pubsub.subscribe(channel)
        log_fn("info", f"redis subscriber active on {channel!r}", "REDIS_SUB_START")

        async for message in pubsub.listen():
            # listen() yields subscription confirmations and data messages alike.
            if not isinstance(message, dict) or message.get("type") != "message":
                continue

            raw_data = message.get("data", "")
            if not isinstance(raw_data, str):
                # decode_responses=True ensures all values are str, but guard anyway.
                try:
                    raw_data = raw_data.decode("utf-8")
                except Exception:
                    continue

            try:
                payload = json.loads(raw_data)
            except json.JSONDecodeError:
                log_fn("warning", "redis message not valid JSON", "REDIS_BAD_MSG")
                continue

            msg_type = payload.get("type", "")

            if msg_type == "PAYMENT_CONFIRMED":
                ref: str = payload.get("payment_reference", "")
                try:
                    await websocket.send_json(
                        payment_confirmed_event(payment_reference=ref)
                    )
                    log_fn("info", f"PAYMENT_CONFIRMED delivered: {ref!r}", "PAYMENT_CONFIRMED")
                except Exception as send_exc:
                    log_fn(
                        "warning",
                        f"failed to deliver PAYMENT_CONFIRMED: {send_exc}",
                        "PAYMENT_DELIVER_ERR",
                    )

    except asyncio.CancelledError:
        pass
    except Exception as exc:
        log_fn("error", f"redis subscriber error: {exc}", "REDIS_SUB_ERR")
    finally:
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe(channel)
        with contextlib.suppress(Exception):
            await pubsub.aclose()
        log_fn("info", "redis subscriber closed", "REDIS_SUB_STOP")


# ---------------------------------------------------------------------------
# Tool-response router
# ---------------------------------------------------------------------------

async def _route_tool_response(
    websocket: WebSocket,
    tool_name: str,
    response: Any,
    log_fn: Any,
    session_id: str = "",
) -> None:
    """
    Inspect a tool function response and send the corresponding UI event.

    Tool response shapes (all wrap status + data + message):
        recommend_products      → data.products [list]
        manage_cart             → data.cart_total, data.items [list]
        generate_checkout_link  → data.checkout_url, data.payment_reference
        update_location         → data.state (str)
        search_disease_matches  → no UI event (agent narrates)
    """
    # Normalise: response may be a dict or a Pydantic object
    if hasattr(response, "model_dump"):
        resp_dict: dict = response.model_dump()
    elif isinstance(response, dict):
        resp_dict = response
    else:
        resp_dict = {"status": "unknown", "data": {}, "message": str(response)}

    status: str  = resp_dict.get("status", "error")
    data:   dict = resp_dict.get("data", {}) or {}
    message: str = resp_dict.get("message", "")

    if status != "success":
        await websocket.send_json(tool_error_event(tool_name=tool_name, error=message))
        logger.info(
            {
                "event": "tool_error",
                "tool": tool_name,
                "error": message,
                "session_id": session_id,
            }
        )
        log_fn("warning", f"tool {tool_name!r} returned non-success", "TOOL_ERROR")
        return

    try:
        if tool_name == "recommend_products":
            products = data.get("products", [])
            # Retrieve the disease/location context from the data dict if available
            disease_category = data.get("disease_category", "")
            location = data.get("location", "")
            await websocket.send_json(products_recommended_event(products=products, message=message))
            logger.info(
                {
                    "event": "tool_call",
                    "tool": "recommend_products",
                    "disease": disease_category,
                    "location": location,
                    "products_returned": len(products),
                    "session_id": session_id,
                }
            )
            log_fn("info", f"PRODUCTS_RECOMMENDED ({len(products)} items)", "PRODUCTS_RECOMMENDED")

        elif tool_name == "manage_cart":
            await websocket.send_json(
                cart_updated_event(
                    items=data.get("items", []),
                    cart_total=data.get("cart_total", 0.0),
                    message=message,
                )
            )
            log_fn("info", "CART_UPDATED", "CART_UPDATED")

        elif tool_name == "generate_checkout_link":
            await websocket.send_json(
                checkout_link_event(
                    checkout_url=data.get("checkout_url", ""),
                    payment_reference=data.get("payment_reference", ""),
                    message=message,
                )
            )
            log_fn("info", "CHECKOUT_LINK sent", "CHECKOUT_LINK")

        elif tool_name == "update_location":
            state_val = data.get("state", "")
            await websocket.send_json(location_confirmed_event(state=state_val, message=message))
            log_fn("info", f"LOCATION_CONFIRMED: {state_val!r}", "LOCATION_CONFIRMED")

        elif tool_name == "search_disease_matches":
            # Agent narrates results; no separate UI event.
            # Emit the structured log judges will see in the Cloud Run stream.
            matches = data.get("matches", [])
            low_confidence = data.get("low_confidence", False)
            top_match = matches[0] if matches else {}
            logger.info(
                {
                    "event": "tool_call",
                    "tool": "search_disease_matches",
                    "top_match": top_match.get("disease_name", ""),
                    "similarity": top_match.get("similarity", 0.0),
                    "low_confidence": low_confidence,
                    "session_id": session_id,
                }
            )
            log_fn("info", f"disease search returned {len(matches)} matches", "DISEASE_SEARCH")

        elif tool_name == "find_nearest_vet_clinic":
            clinics = data.get("clinics", [])
            radius_m = data.get("radius_m", 0)
            fallback_message = data.get("fallback_message")
            await websocket.send_json(
                clinics_found_event(
                    clinics=clinics,
                    radius_m=radius_m,
                    fallback_message=fallback_message,
                    message=message,
                )
            )
            log_fn("info", f"CLINICS_FOUND ({len(clinics)} clinics, radius={radius_m}m)", "CLINICS_FOUND")

        # ── Phase 3 tool routes ──────────────────────────────────────

        elif tool_name in ("search_products", "find_cheaper_option"):
            products = data.get("products", [])
            await websocket.send_json(products_recommended_event(products=products, message=message))
            logger.info(
                {
                    "event": "tool_call",
                    "tool": tool_name,
                    "query": data.get("query", ""),
                    "state": data.get("state", ""),
                    "products_returned": len(products),
                    "session_id": session_id,
                }
            )
            log_fn("info", f"PRODUCTS_RECOMMENDED ({len(products)} items) via {tool_name}", "PRODUCTS_RECOMMENDED")

        elif tool_name == "identify_product_from_frame":
            # The tool sets is_scanning_product=True in session state and returns
            # action="EXAMINE_PRODUCT_IN_FRAME". Signal the frontend to show the
            # scanning indicator. The model will read the frame and call
            # search_products next, which clears the scanning state.
            await websocket.send_json(scanning_product_event(message=message))
            log_fn("info", "SCANNING_PRODUCT event sent", "SCANNING_PRODUCT")

        elif tool_name == "update_cart":
            await websocket.send_json(
                cart_updated_event(
                    items=data.get("items", []),
                    cart_total=data.get("cart_total", 0.0),
                    message=message,
                )
            )
            log_fn("info", "CART_UPDATED (update_cart)", "CART_UPDATED")

        elif tool_name == "place_order":
            await websocket.send_json(
                order_confirmed_event(
                    order_reference=data.get("order_reference", ""),
                    total=data.get("total", 0.0),
                    items=data.get("items", []),
                    estimated_delivery=data.get("estimated_delivery", "24–48 hours"),
                    sms_sent=data.get("sms_sent", False),
                    message=message,
                )
            )
            logger.info(
                {
                    "event": "tool_call",
                    "tool": "place_order",
                    "order_reference": data.get("order_reference", ""),
                    "total": data.get("total", 0.0),
                    "sms_sent": data.get("sms_sent", False),
                    "session_id": session_id,
                }
            )
            log_fn("info", f"ORDER_CONFIRMED: {data.get('order_reference', '')}", "ORDER_CONFIRMED")

        # ── Phase 5 tool routes ─────────────────────────────────────────────────

        elif tool_name == "register_phone":
            # Emit PIN_REQUIRED so the frontend shows the PIN overlay.
            phone_out = data.get("phone_number", "")
            is_ret: bool = resp_dict.get("is_returning", False)
            await websocket.send_json(
                pin_required_event(
                    phone_number=phone_out,
                    is_returning=is_ret,
                    message=message,
                )
            )
            logger.info(
                {
                    "event": "tool_call",
                    "tool": "register_phone",
                    "is_returning": is_ret,
                    "session_id": session_id,
                }
            )
            log_fn("info", f"PIN_REQUIRED sent (is_returning={is_ret})", "PIN_REQUIRED")

        elif tool_name == "get_order_history":
            # Fatima narrates the order history aloud — no UI card is emitted.
            # Just log the structured event for Cloud Run observability.
            total = data.get("total_orders", 0)
            logger.info(
                {
                    "event": "tool_call",
                    "tool": "get_order_history",
                    "total_orders": total,
                    "session_id": session_id,
                }
            )
            log_fn("info", f"ORDER_HISTORY fetched ({total} orders)", "ORDER_HISTORY")

        else:
            log_fn("warning", f"unrecognised tool: {tool_name!r}", "UNKNOWN_TOOL")

    except Exception as exc:
        await websocket.send_json(tool_error_event(tool_name=tool_name, error=str(exc)))
        logger.info(
            {
                "event": "tool_error",
                "tool": tool_name,
                "error": str(exc),
                "session_id": session_id,
            }
        )
        log_fn("error", f"error routing tool response for {tool_name!r}: {exc}", "TOOL_ROUTE_ERR")
