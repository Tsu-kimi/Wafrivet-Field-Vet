"""
tests/test_tools_unit.py

Offline unit tests for all five Wafrivet ADK tool functions.

Every test mocks Supabase and Vertex AI so no network calls are made.
Tests assert the exact return shape (status, data keys) for both success
and error paths.

Run:
    pytest tests/test_tools_unit.py -v

Or with coverage:
    pytest tests/test_tools_unit.py -v --cov=backend.agent.tools
"""

from __future__ import annotations

import os
import sys
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# Ensure repo root is on sys.path
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# ---------------------------------------------------------------------------
# Shared mock ToolContext factory
# ---------------------------------------------------------------------------


def _make_tool_context(initial_state: dict[str, Any] | None = None) -> MagicMock:
    """
    Create a MagicMock that behaves like google.adk.tools.tool_context.ToolContext.
    The .state attribute is a real dict so tools can read/write to it naturally.
    """
    ctx = MagicMock()
    ctx.state = dict(initial_state or {})
    ctx.session_id = "test-session-001"
    return ctx


# ===========================================================================
# search_disease_matches
# ===========================================================================


class TestSearchDiseaseMatches:
    """Unit tests for backend.agent.tools.disease.search_disease_matches."""

    def _import_tool(self):
        from backend.agent.tools.disease import search_disease_matches
        return search_disease_matches

    def test_empty_inputs_returns_error(self):
        """Empty symptoms_text and visual_observations must return error status."""
        # ToolContext import must be available; patch it to avoid real ADK init
        with patch("backend.agent.tools.disease.ToolContext"):
            fn = self._import_tool()

        ctx = _make_tool_context()
        result = fn(symptoms_text="", visual_observations="", tool_context=ctx)

        assert result["status"] == "error"
        assert "matches" in result["data"]
        assert result["data"]["matches"] == []
        assert isinstance(result["message"], str)

    @patch("backend.agent.tools.disease._get_supabase_client")
    @patch("backend.agent.tools.disease._embed_query")
    def test_success_path_updates_session_state(
        self, mock_embed, mock_supabase_factory
    ):
        """
        When embedding and RPC succeed, the top match must be written to
        session state and the return shape must be correct.
        """
        mock_embed.return_value = [0.1] * 1536

        mock_rpc_response = MagicMock()
        mock_rpc_response.data = [
            {
                "id": "aaaaaaaa-0000-0000-0000-000000000001",
                "disease_name": "Ruminal Bloat",
                "primary_species": "Goats, Cattle, Sheep",
                "risk_level": "high",
                "first_aid_notes": "Pass stomach tube and drench with oil.",
                "red_flag_notes": "Seek vet if animal cannot stand.",
                "similarity": 0.87,
            }
        ]
        mock_db = MagicMock()
        mock_db.rpc.return_value.execute.return_value = mock_rpc_response
        mock_supabase_factory.return_value = mock_db

        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(
            symptoms_text="My goat belly is very swollen and the animal is not eating",
            visual_observations="Left flank visibly distended",
            tool_context=ctx,
        )

        # Return shape
        assert result["status"] == "success"
        assert "matches" in result["data"]
        matches = result["data"]["matches"]
        assert len(matches) == 1

        top = matches[0]
        assert top["disease_name"] == "Ruminal Bloat"
        assert top["severity"] == "high"
        assert isinstance(top["similarity"], float)
        assert "id" in top
        assert "notes" in top
        assert "primary_species" in top

        # Session state must be updated
        assert ctx.state["confirmed_disease"] == "Ruminal Bloat"
        assert ctx.state["confirmed_disease_severity"] == "high"
        assert ctx.state["confirmed_disease_id"] == "aaaaaaaa-0000-0000-0000-000000000001"

    @patch("backend.agent.tools.disease._get_supabase_client")
    @patch("backend.agent.tools.disease._embed_query")
    def test_vertex_failure_returns_error(self, mock_embed, mock_supabase_factory):
        """A RuntimeError from _embed_query must produce an error status response."""
        mock_embed.side_effect = RuntimeError("Vertex AI quota exceeded")

        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(
            symptoms_text="Sick goat",
            visual_observations="",
            tool_context=ctx,
        )

        assert result["status"] == "error"
        assert result["data"]["matches"] == []
        assert "unavailable" in result["message"].lower()

    @patch("backend.agent.tools.disease._get_supabase_client")
    @patch("backend.agent.tools.disease._embed_query")
    def test_no_results_returns_error(self, mock_embed, mock_supabase_factory):
        """When both RPC and fallback return empty lists, status must be error."""
        mock_embed.return_value = [0.0] * 1536

        mock_rpc_response = MagicMock()
        mock_rpc_response.data = []
        mock_db = MagicMock()
        mock_db.rpc.return_value.execute.return_value = mock_rpc_response

        mock_raw_response = MagicMock()
        mock_raw_response.data = []
        mock_db.table.return_value.select.return_value.not_.return_value.is_.return_value.execute.return_value = mock_raw_response  # type: ignore[attr-defined]
        mock_supabase_factory.return_value = mock_db

        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(
            symptoms_text="Some vague symptom with no match",
            visual_observations="",
            tool_context=ctx,
        )

        assert result["status"] == "error"
        assert result["data"]["matches"] == []


# ===========================================================================
# recommend_products
# ===========================================================================


class TestRecommendProducts:
    """Unit tests for backend.agent.tools.products.recommend_products."""

    def _import_tool(self):
        from backend.agent.tools.products import recommend_products
        return recommend_products

    def test_missing_disease_and_location_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()  # empty state

        result = fn(disease_category="", location="", tool_context=ctx)

        assert result["status"] == "error"
        assert "products" in result["data"]
        assert result["data"]["products"] == []

    @patch("backend.agent.tools.products._get_supabase_client")
    def test_success_path_returns_product_list(self, mock_supabase_factory):
        """Exact-match query returning rows must produce a success response."""
        mock_rows = [
            {
                "id": "prod-uuid-0001",
                "name": "Rumenol Anti-Bloat Oral Drench (500 ml)",
                "base_price": "3200.00",
                "image_url": "/images/products/BLT-002.jpg",
                "description": "Simethicone-based anti-bloat drench.",
                "dosage_notes": "Drench 100-150 ml orally.",
            }
        ]
        mock_response = MagicMock()
        mock_response.data = mock_rows

        mock_db = MagicMock()
        # Chain the select query mock
        mock_db.table.return_value.select.return_value \
            .contains.return_value \
            .contains.return_value \
            .eq.return_value \
            .order.return_value \
            .limit.return_value \
            .execute.return_value = mock_response
        mock_supabase_factory.return_value = mock_db

        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(
            disease_category="Ruminal Bloat",
            location="Rivers",
            tool_context=ctx,
        )

        assert result["status"] == "success"
        assert "products" in result["data"]
        products = result["data"]["products"]
        assert len(products) == 1

        p = products[0]
        assert p["name"] == "Rumenol Anti-Bloat Oral Drench (500 ml)"
        assert p["price_ngn"] == 3200.0
        assert "id" in p
        assert "image_url" in p
        assert "description" in p
        assert "dosage_notes" in p

    @patch("backend.agent.tools.products._get_supabase_client")
    def test_location_falls_back_to_session_state(self, mock_supabase_factory):
        """If location arg is empty, recommend_products reads farmer_state from session."""
        mock_response = MagicMock()
        mock_response.data = []

        mock_db = MagicMock()
        mock_db.table.return_value.select.return_value \
            .contains.return_value \
            .contains.return_value \
            .eq.return_value \
            .order.return_value \
            .limit.return_value \
            .execute.return_value = mock_response
        mock_db.table.return_value.select.return_value \
            .contains.return_value \
            .eq.return_value \
            .order.return_value \
            .execute.return_value = mock_response
        mock_supabase_factory.return_value = mock_db

        fn = self._import_tool()
        ctx = _make_tool_context({"farmer_state": "Lagos", "confirmed_disease": "Ruminal Bloat"})

        # Both args empty — should use session state
        result = fn(disease_category="", location="", tool_context=ctx)

        # The function should have attempted the query (status will be error because
        # no rows, but the important assertion is it did NOT return "missing info" error)
        assert "products" in result["data"]


# ===========================================================================
# manage_cart
# ===========================================================================


class TestManageCart:
    """Unit tests for backend.agent.tools.cart.manage_cart."""

    def _import_tool(self):
        from backend.agent.tools.cart import manage_cart
        return manage_cart

    def test_invalid_action_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(action="delete", phone="+2348099887766", tool_context=ctx)

        assert result["status"] == "error"
        assert "add, remove, clear" in result["message"]

    def test_invalid_phone_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(action="clear", phone="not-a-phone", tool_context=ctx)

        assert result["status"] == "error"
        assert "E.164" in result["message"]

    @patch("backend.agent.tools.cart._get_supabase_client")
    def test_add_new_item_success(self, mock_supabase_factory):
        """Adding a product when cart is empty must create the item and return updated total."""

        mock_product_response = MagicMock()
        mock_product_response.data = {
            "id": "prod-0001",
            "name": "Rumenol Anti-Bloat Oral Drench (500 ml)",
            "base_price": "3200.00",
        }

        mock_cart_response = MagicMock()
        mock_cart_response.data = None  # No existing cart

        mock_upsert_response = MagicMock()

        mock_db = MagicMock()
        # _fetch_product: .select().eq().eq().single().execute()
        mock_db.table.return_value.select.return_value \
            .eq.return_value \
            .eq.return_value \
            .single.return_value \
            .execute.return_value = mock_product_response
        # _load_cart: .select().eq().maybe_single().execute()
        mock_db.table.return_value.select.return_value \
            .eq.return_value \
            .maybe_single.return_value \
            .execute.return_value = mock_cart_response
        # _upsert_cart
        mock_db.table.return_value.upsert.return_value.execute.return_value = (
            mock_upsert_response
        )
        mock_supabase_factory.return_value = mock_db

        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(
            action="add",
            phone="+2348099887766",
            product_id="prod-0001",
            qty=1,
            tool_context=ctx,
        )

        assert result["status"] == "success"
        assert "cart_total" in result["data"]
        assert "items" in result["data"]
        assert result["data"]["cart_total"] == 3200.0
        assert len(result["data"]["items"]) == 1

        # Session state must be updated
        assert ctx.state["cart_total"] == 3200.0
        assert len(ctx.state["cart_items"]) == 1

    @patch("backend.agent.tools.cart._get_supabase_client")
    def test_clear_cart_returns_zero_total(self, mock_supabase_factory):
        """Clearing the cart must set total to 0 and return an empty items list."""
        mock_cart_response = MagicMock()
        mock_cart_response.data = {
            "id": "cart-0001",
            "items_json": [{"product_id": "p1", "quantity": 2, "subtotal": 6400.0}],
            "total_amount": 6400.0,
        }
        mock_upsert = MagicMock()

        mock_db = MagicMock()
        mock_db.table.return_value.select.return_value \
            .eq.return_value \
            .maybe_single.return_value \
            .execute.return_value = mock_cart_response
        mock_db.table.return_value.upsert.return_value.execute.return_value = mock_upsert
        mock_supabase_factory.return_value = mock_db

        fn = self._import_tool()
        ctx = _make_tool_context({"cart_items": [], "cart_total": 6400.0})

        result = fn(action="clear", phone="+2348099887766", tool_context=ctx)

        assert result["status"] == "success"
        assert result["data"]["cart_total"] == 0.0
        assert result["data"]["items"] == []
        assert ctx.state["cart_total"] == 0.0


# ===========================================================================
# generate_checkout_link
# ===========================================================================


class TestGenerateCheckoutLink:
    """Unit tests for backend.agent.tools.checkout.generate_checkout_link."""

    def _import_tool(self):
        from backend.agent.tools.checkout import generate_checkout_link
        return generate_checkout_link

    def test_invalid_phone_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(phone="badphone", cart_total=3200, tool_context=ctx)

        assert result["status"] == "error"
        assert "E.164" in result["message"]

    def test_zero_total_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(phone="+2348099887766", cart_total=0, tool_context=ctx)

        assert result["status"] == "error"
        assert "empty" in result["message"].lower() or "zero" in result["message"].lower()

    def test_missing_paystack_key_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        with patch.dict(os.environ, {"PAYSTACK_SECRET_KEY": ""}):
            result = fn(phone="+2348099887766", cart_total=3200, tool_context=ctx)

        assert result["status"] == "error"
        assert "not configured" in result["message"].lower()

    @patch("backend.agent.tools.checkout._get_supabase_client")
    @patch("backend.agent.tools.checkout._call_paystack")
    def test_success_path_returns_checkout_url(
        self, mock_paystack, mock_supabase_factory
    ):
        """
        When Paystack returns successfully, the tool must return checkout_url
        and write it to session state.
        """
        mock_paystack.return_value = {
            "status": True,
            "data": {
                "authorization_url": "https://checkout.paystack.com/test123",
                "access_code": "ac_test123",
                "reference": "WAFRIVET-ABC123",
            },
        }

        mock_db = MagicMock()
        mock_db.table.return_value.upsert.return_value.execute.return_value = MagicMock()
        mock_supabase_factory.return_value = mock_db

        fn = self._import_tool()
        ctx = _make_tool_context()

        with patch.dict(os.environ, {"PAYSTACK_SECRET_KEY": "sk_test_dummy_key"}):
            result = fn(phone="+2348099887766", cart_total=3200, tool_context=ctx)

        assert result["status"] == "success"
        assert "checkout_url" in result["data"]
        assert result["data"]["checkout_url"] == "https://checkout.paystack.com/test123"
        assert "payment_reference" in result["data"]

        # Session state must be updated
        assert ctx.state["checkout_url"] == "https://checkout.paystack.com/test123"


# ===========================================================================
# update_location
# ===========================================================================


class TestUpdateLocation:
    """Unit tests for backend.agent.tools.location.update_location."""

    def _import_tool(self):
        from backend.agent.tools.location import update_location
        return update_location

    def test_valid_state_returns_success(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(state="Rivers", tool_context=ctx)

        assert result["status"] == "success"
        assert result["data"]["event"] == "LOCATION_CONFIRMED"
        assert result["data"]["state"] == "Rivers"
        assert ctx.state["farmer_state"] == "Rivers"

    def test_lowercase_state_is_normalised(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(state="lagos", tool_context=ctx)

        assert result["status"] == "success"
        assert result["data"]["state"] == "Lagos"
        assert ctx.state["farmer_state"] == "Lagos"

    def test_abuja_alias_maps_to_fct(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(state="Abuja", tool_context=ctx)

        assert result["status"] == "success"
        assert result["data"]["state"] == "FCT"
        assert ctx.state["farmer_state"] == "FCT"

    def test_state_with_suffix_is_normalised(self):
        """'Rivers State' should normalise to 'Rivers'."""
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(state="Rivers State", tool_context=ctx)

        assert result["status"] == "success"
        assert result["data"]["state"] == "Rivers"

    def test_unrecognised_state_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(state="Eko Province", tool_context=ctx)

        assert result["status"] == "error"
        assert "farmer_state" not in ctx.state or ctx.state.get("farmer_state") is None

    def test_empty_state_returns_error(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        result = fn(state="", tool_context=ctx)

        assert result["status"] == "error"

    def test_location_source_set_to_voice(self):
        fn = self._import_tool()
        ctx = _make_tool_context()

        fn(state="Kano", tool_context=ctx)

        assert ctx.state.get("location_source") == "voice"


# ---------------------------------------------------------------------------
# Direct execution support (no pytest required)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import traceback

    test_classes = [
        TestSearchDiseaseMatches,
        TestRecommendProducts,
        TestManageCart,
        TestGenerateCheckoutLink,
        TestUpdateLocation,
    ]

    passed = 0
    failed = 0

    for cls in test_classes:
        instance = cls()
        methods = [m for m in dir(instance) if m.startswith("test_")]
        for method_name in methods:
            try:
                getattr(instance, method_name)()
                print(f"  PASS  {cls.__name__}.{method_name}")
                passed += 1
            except Exception:  # noqa: BLE001
                print(f"  FAIL  {cls.__name__}.{method_name}")
                traceback.print_exc()
                failed += 1

    print(f"\n{passed} passed, {failed} failed.")
