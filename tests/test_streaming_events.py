"""
tests/test_streaming_events.py

Offline pytest suite for the Wafrivet Phase 3 streaming layer.

All tests use mocked ADK components — no network calls, no Supabase, no Gemini API.

Coverage:
  - events.py: all factory functions produce correct dicts
  - bridge.py:
      * AUDIO_FLUSH emitted on event.interrupted
      * is_interrupted suppresses content events until turn_complete
      * TURN_COMPLETE emitted on event.turn_complete
      * TRANSCRIPTION emitted for input/output transcription events
      * PRODUCTS_RECOMMENDED emitted on recommend_products response
      * CART_UPDATED emitted on manage_cart response
      * CHECKOUT_LINK emitted on generate_checkout_link response
      * LOCATION_CONFIRMED emitted on update_location response
      * TOOL_ERROR emitted on non-success tool response
      * Terminal error codes (SAFETY) break the downstream loop
  - session_store.py:
      * Stale sessions return None (>20 h)
      * Fresh sessions return session_id

Run:
    pytest tests/test_streaming_events.py -v
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, List, Optional, cast
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import WebSocket

import pytest

from backend.streaming.events import (
    T_AUDIO_FLUSH,
    T_CART_UPDATED,
    T_CHECKOUT_LINK,
    T_LOCATION_CONFIRMED,
    T_PRODUCTS_RECOMMENDED,
    T_TOOL_ERROR,
    T_TRANSCRIPTION,
    T_TURN_COMPLETE,
    audio_flush_event,
    cart_updated_event,
    checkout_link_event,
    location_confirmed_event,
    products_recommended_event,
    tool_error_event,
    transcription_event,
    turn_complete_event,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

@dataclass
class FakeWebSocket:
    """Minimal WebSocket double for testing bridge functions."""
    sent_json: List[dict] = field(default_factory=list)
    sent_bytes: List[bytes] = field(default_factory=list)

    async def send_json(self, data: dict) -> None:
        self.sent_json.append(data)

    async def send_bytes(self, data: bytes) -> None:
        self.sent_bytes.append(data)

    async def receive(self) -> dict:
        # Immediately signal disconnect so upstream_task exits quickly
        return {"type": "websocket.disconnect"}


def _make_event(
    interrupted: bool = False,
    turn_complete: bool = False,
    partial: bool = False,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    content: Optional[Any] = None,
    input_transcription: Optional[Any] = None,
    output_transcription: Optional[Any] = None,
    fn_responses: Optional[list] = None,
) -> MagicMock:
    """Build a fake ADK Event MagicMock."""
    evt = MagicMock()
    evt.interrupted      = interrupted
    evt.turn_complete    = turn_complete
    evt.partial          = partial
    evt.error_code       = error_code
    evt.error_message    = error_message
    evt.content          = content
    evt.input_transcription  = input_transcription
    evt.output_transcription = output_transcription
    evt.author           = "wafrivet_field_vet"
    evt.get_function_calls    = MagicMock(return_value=[])
    evt.get_function_responses = MagicMock(return_value=fn_responses or [])
    return evt


def _make_fn_response(name: str, response: dict) -> MagicMock:
    fr = MagicMock()
    fr.name     = name
    fr.response = response
    return fr


def _make_transcription(text: str, is_partial: bool = False) -> MagicMock:
    t = MagicMock()
    t.text       = text
    t.is_partial = is_partial
    return t


async def _stream(*events: Any) -> AsyncIterator:
    for ev in events:
        yield ev


# ---------------------------------------------------------------------------
# events.py tests
# ---------------------------------------------------------------------------

class TestEventFactories:

    def test_audio_flush_type(self):
        assert audio_flush_event()["type"] == T_AUDIO_FLUSH

    def test_turn_complete_type(self):
        assert turn_complete_event()["type"] == T_TURN_COMPLETE

    def test_transcription_fields(self):
        ev = transcription_event("hello", author="user", is_final=True)
        assert ev["type"]     == T_TRANSCRIPTION
        assert ev["text"]     == "hello"
        assert ev["author"]   == "user"
        assert ev["is_final"] is True

    def test_products_recommended_fields(self):
        prods = [{"id": "p1", "name": "OxyMax", "price_ngn": 3500}]
        ev = products_recommended_event(products=prods, message="Found 1 product")
        assert ev["type"]     == T_PRODUCTS_RECOMMENDED
        assert ev["products"] == prods
        assert ev["message"]  == "Found 1 product"

    def test_cart_updated_fields(self):
        items = [{"product_id": "p1", "quantity": 2}]
        ev = cart_updated_event(items=items, cart_total=7000.0, message="Added OxyMax")
        assert ev["type"]       == T_CART_UPDATED
        assert ev["cart_total"] == 7000.0
        assert ev["items"]      == items

    def test_checkout_link_fields(self):
        ev = checkout_link_event(
            checkout_url="https://pay.example.com/abc",
            payment_reference="ref-123",
            message="Pay here",
        )
        assert ev["type"]              == T_CHECKOUT_LINK
        assert ev["checkout_url"]      == "https://pay.example.com/abc"
        assert ev["payment_reference"] == "ref-123"

    def test_location_confirmed_fields(self):
        ev = location_confirmed_event(state="Rivers", message="Location set")
        assert ev["type"]  == T_LOCATION_CONFIRMED
        assert ev["state"] == "Rivers"

    def test_tool_error_fields(self):
        ev = tool_error_event(tool_name="recommend_products", error="DB timeout")
        assert ev["type"]      == T_TOOL_ERROR
        assert ev["tool_name"] == "recommend_products"
        assert ev["error"]     == "DB timeout"


# ---------------------------------------------------------------------------
# bridge.py downstream event routing tests
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.asyncio


class TestBridgeDownstream:
    """
    Test the downstream event routing in run_bridge() by injecting fake events
    into the runner.run_live() async generator.
    """

    async def _run_with_events(self, *events: Any) -> FakeWebSocket:
        """
        Wire a FakeWebSocket + fake runner into run_bridge() and drain all events.
        """
        from backend.streaming.bridge import run_bridge

        ws   = FakeWebSocket()
        sess = AsyncMock()
        # get_session returns value (session exists)
        sess.get_session = AsyncMock(return_value=MagicMock())

        mock_run_config = MagicMock()
        fake_runner     = MagicMock()

        async def _fake_run_live(**kwargs: Any):
            for ev in events:
                yield ev

        fake_runner.run_live = _fake_run_live

        await run_bridge(
            websocket=cast(WebSocket, ws),
            user_id="u1",
            session_id="s1",
            runner=fake_runner,
            session_service=sess,
            run_config=mock_run_config,
        )
        return ws

    async def test_audio_flush_on_interrupted(self):
        ev = _make_event(interrupted=True)
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_AUDIO_FLUSH in types_sent

    async def test_interrupted_suppresses_content_until_turn_complete(self):
        """Events between interrupted and turn_complete must not produce content."""
        audio_content = MagicMock()
        audio_content.parts = [MagicMock(inline_data=MagicMock(data=b"\x00" * 100))]

        events = [
            _make_event(interrupted=True),
            _make_event(content=audio_content),   # should be discarded
            _make_event(turn_complete=True),
        ]
        ws = await self._run_with_events(*events)

        # Binary audio must NOT have been sent during the interrupted window
        assert len(ws.sent_bytes) == 0
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_AUDIO_FLUSH    in types_sent
        assert T_TURN_COMPLETE  in types_sent

    async def test_turn_complete_event_sent(self):
        ev = _make_event(turn_complete=True)
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_TURN_COMPLETE in types_sent

    async def test_turn_complete_resets_interrupted(self):
        """After turn_complete, new content should be forwarded again."""
        audio_content = MagicMock()
        audio_content.parts = [MagicMock(inline_data=MagicMock(data=b"\x01" * 100))]

        events = [
            _make_event(interrupted=True),
            _make_event(turn_complete=True),
            _make_event(content=audio_content),  # should be forwarded now
        ]
        ws = await self._run_with_events(*events)
        assert len(ws.sent_bytes) == 1

    async def test_input_transcription_sent(self):
        tr = _make_transcription("My goat is sick", is_partial=False)
        ev = _make_event(input_transcription=tr)
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_TRANSCRIPTION in types_sent
        tr_ev = next(e for e in ws.sent_json if e["type"] == T_TRANSCRIPTION)
        assert tr_ev["author"]  == "user"
        assert tr_ev["text"]    == "My goat is sick"
        assert tr_ev["is_final"] is True

    async def test_output_transcription_sent(self):
        tr = _make_transcription("Treating bloat with Bloateze", is_partial=False)
        ev = _make_event(output_transcription=tr)
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_TRANSCRIPTION in types_sent
        tr_ev = next(e for e in ws.sent_json if e["type"] == T_TRANSCRIPTION)
        assert tr_ev["author"] != "user"

    async def test_products_recommended_event(self):
        products = [
            {"id": "p1", "name": "BloatEze", "price_ngn": 5000,
             "image_url": "/images/products/bloateze.jpg",
             "description": "Anti-bloat drench", "dosage_notes": "20 ml/cow"},
        ]
        fn_resp = _make_fn_response(
            "recommend_products",
            {"status": "success", "data": {"products": products}, "message": "Found 1"},
        )
        ev = _make_event(fn_responses=[fn_resp])
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_PRODUCTS_RECOMMENDED in types_sent
        pr_ev = next(e for e in ws.sent_json if e["type"] == T_PRODUCTS_RECOMMENDED)
        assert pr_ev["products"] == products

    async def test_cart_updated_event(self):
        items = [{"product_id": "p1", "product_name": "BloatEze", "quantity": 1,
                  "unit_price": 5000, "subtotal": 5000}]
        fn_resp = _make_fn_response(
            "manage_cart",
            {"status": "success",
             "data": {"cart_total": 5000.0, "items": items},
             "message": "Added BloatEze"},
        )
        ev = _make_event(fn_responses=[fn_resp])
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_CART_UPDATED in types_sent
        cart_ev = next(e for e in ws.sent_json if e["type"] == T_CART_UPDATED)
        assert cart_ev["cart_total"] == 5000.0

    async def test_checkout_link_event(self):
        fn_resp = _make_fn_response(
            "generate_checkout_link",
            {"status": "success",
             "data": {"checkout_url": "https://pay.wafrivet.com/xyz",
                      "payment_reference": "ref-XYZ"},
             "message": "Pay here"},
        )
        ev = _make_event(fn_responses=[fn_resp])
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_CHECKOUT_LINK in types_sent
        ck_ev = next(e for e in ws.sent_json if e["type"] == T_CHECKOUT_LINK)
        assert "wafrivet.com" in ck_ev["checkout_url"]

    async def test_location_confirmed_event(self):
        fn_resp = _make_fn_response(
            "update_location",
            {"status": "success",
             "data": {"event": "LOCATION_CONFIRMED", "state": "Rivers"},
             "message": "Location set"},
        )
        ev = _make_event(fn_responses=[fn_resp])
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_LOCATION_CONFIRMED in types_sent
        loc_ev = next(e for e in ws.sent_json if e["type"] == T_LOCATION_CONFIRMED)
        assert loc_ev["state"] == "Rivers"

    async def test_tool_error_on_failure_status(self):
        fn_resp = _make_fn_response(
            "recommend_products",
            {"status": "error", "data": {}, "message": "DB connection failed"},
        )
        ev = _make_event(fn_responses=[fn_resp])
        ws = await self._run_with_events(ev)
        types_sent = [e["type"] for e in ws.sent_json]
        assert T_TOOL_ERROR in types_sent
        err_ev = next(e for e in ws.sent_json if e["type"] == T_TOOL_ERROR)
        assert err_ev["tool_name"] == "recommend_products"

    async def test_terminal_error_breaks_loop(self):
        """SAFETY error should send ERROR event and stop processing further events."""
        events = [
            _make_event(error_code="SAFETY", error_message="content blocked"),
            # This turn_complete should NOT be processed after terminal error
            _make_event(turn_complete=True),
        ]
        ws = await self._run_with_events(*events)
        types_sent = [e["type"] for e in ws.sent_json]
        assert "ERROR" in types_sent
        # turn_complete should not appear since loop broke on SAFETY
        assert T_TURN_COMPLETE not in types_sent

    async def test_audio_bytes_forwarded(self):
        """Binary audio from inline_data should be sent as bytes."""
        audio_bytes = b"\x01\x02" * 50
        part = MagicMock()
        part.inline_data = MagicMock(data=audio_bytes)
        content = MagicMock()
        content.parts = [part]
        ev = _make_event(content=content)
        ws = await self._run_with_events(ev)
        assert len(ws.sent_bytes) == 1
        assert ws.sent_bytes[0] == audio_bytes


# ---------------------------------------------------------------------------
# session_store.py tests (mocked Supabase client)
# ---------------------------------------------------------------------------

class TestSessionStore:

    def _make_supabase_response(self, data: Optional[dict]) -> MagicMock:
        resp = MagicMock()
        resp.data = data
        return resp

    def test_get_session_handle_fresh(self):
        """A recent entry returns the session_id."""
        from datetime import datetime, timezone, timedelta
        from unittest.mock import patch, MagicMock

        fresh_ts = datetime.now(timezone.utc).isoformat()
        fake_data = {"session_id": "sess-abc", "updated_at": fresh_ts}

        with patch("backend.streaming.session_store._get_client") as mock_client:
            chain = MagicMock()
            chain.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value = self._make_supabase_response(fake_data)
            mock_client.return_value = chain

            from backend.streaming.session_store import get_session_handle
            result = get_session_handle("user-001")

        assert result == "sess-abc"

    def test_get_session_handle_stale(self):
        """An entry older than 20 h returns None."""
        from datetime import datetime, timezone, timedelta
        from unittest.mock import patch, MagicMock

        stale_ts = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        fake_data = {"session_id": "sess-old", "updated_at": stale_ts}

        with patch("backend.streaming.session_store._get_client") as mock_client:
            chain = MagicMock()
            chain.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value = self._make_supabase_response(fake_data)
            mock_client.return_value = chain

            from backend.streaming.session_store import get_session_handle
            result = get_session_handle("user-002")

        assert result is None

    def test_get_session_handle_no_row(self):
        """Missing row returns None."""
        from unittest.mock import patch, MagicMock

        with patch("backend.streaming.session_store._get_client") as mock_client:
            chain = MagicMock()
            chain.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value = self._make_supabase_response(None)
            mock_client.return_value = chain

            from backend.streaming.session_store import get_session_handle
            result = get_session_handle("user-003")

        assert result is None

    def test_upsert_session_handle_calls_supabase(self):
        """upsert_session_handle must call .upsert(...).execute()."""
        from unittest.mock import patch, MagicMock, call

        with patch("backend.streaming.session_store._get_client") as mock_client:
            chain  = MagicMock()
            upsert = MagicMock()
            chain.table.return_value.upsert.return_value.execute = upsert
            mock_client.return_value = chain

            from backend.streaming.session_store import upsert_session_handle
            upsert_session_handle("user-001", "sess-new")

        chain.table.assert_called_once_with("session_handles")
        assert chain.table.return_value.upsert.called
        upsert.assert_called_once()
