"""
backend/agent/tools/cart.py

ADK tool: manage_cart

Manages the farmer's active shopping cart in the Supabase carts table.
Supports three actions: add a product, remove a product, or clear the cart.

Phase 4 change: switched from service_role Supabase Python client to the
asyncpg connection pool with rls_context. Every Supabase query is now
executed inside an asyncpg transaction after setting the app.session_id
transaction-local config variable, so the anon-role RLS policies enforce
row isolation correctly.

The tool reads auth_session_id from tool_context.state to identify the
RLS-scoped session. The farmer's E.164 phone number is passed as a second
RLS identifier once known, enabling the phone-based fallback policy on carts.

Environment variables required:
    SUPABASE_DB_URL   – asyncpg DSN (Supabase transaction pooler, port 6543)
    SUPABASE_URL      – Supabase REST URL (for product catalog lookups)
    SUPABASE_ANON_KEY – anon key for catalog reads (no farmer data accessed)
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache
from typing import Any, Optional

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

# E.164 phone number regex matching the carts table check constraint
_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")

_VALID_ACTIONS = frozenset({"add", "remove", "clear"})


# ---------------------------------------------------------------------------
# Catalog client — anon key, read-only, no RLS context needed
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_catalog_client():
    """
    Return a Supabase client using the anon key for product catalog reads.
    Products are public-read (anon_select_products RLS policy); no session context needed.
    """
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError("SUPABASE_URL and SUPABASE_ANON_KEY must be set.")
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _validate_phone(phone: str) -> str:
    """
    Normalize and validate an E.164 phone number.

    Returns the normalized phone string, or raises ValueError if invalid.
    """
    normalized = phone.strip()
    if not _PHONE_REGEX.match(normalized):
        raise ValueError(
            f"Phone must be in E.164 format (e.g. +2348012345678), got: {normalized!r}"
        )
    return normalized


def _fetch_product(product_id: str) -> dict[str, Any]:
    """
    Look up a product by ID from the catalog (public data — uses anon key).
    Products are globally readable; no RLS session context is required.

    Raises:
        ValueError: if the product does not exist or is inactive.
    """
    db = _get_catalog_client()
    response = (
        db.table("products")
        .select("id, name, base_price")
        .eq("id", product_id)
        .eq("is_active", True)
        .maybe_single()  # returns None instead of raising PGRST116 on 0 rows
        .execute()
    )
    raw: Any = getattr(response, "data", None)
    if not raw:
        raise ValueError(f"Product {product_id!r} not found or inactive.")
    return raw


def _calculate_total(items: list[dict[str, Any]]) -> float:
    """Sum subtotals for all line items in the cart."""
    return sum(float(item.get("subtotal", 0)) for item in items)


# ---------------------------------------------------------------------------
# Public ADK tool function (async — ADK LlmAgent supports async tools)
# ---------------------------------------------------------------------------

async def manage_cart(
    action: str,
    phone: str,
    tool_context: ToolContext,
    product_id: Optional[str] = None,
    qty: int = 1,
) -> dict[str, Any]:
    """
    Add, remove, or clear items in the farmer's shopping cart.

    Upserts the cart row in Supabase using phone as the unique key.
    Recalculates the total after every mutation. Updates session state
    (cart_items and cart_total) so the agent always reflects the current cart.

    Phase 4: Uses asyncpg rls_context with auth_session_id from tool_context.state
    to enforce row-level security. The anon_insert_own_cart and
    anon_update_own_cart RLS policies restrict access to rows whose session_id
    matches the transaction-local app.session_id set by rls_context.

    Args:
        action:
            One of "add", "remove", or "clear".
        phone:
            Farmer's E.164 phone number (e.g. "+2348012345678").
        product_id:
            UUID of the product to add or remove (required for add/remove).
        qty:
            Quantity to add. Defaults to 1.

    Returns:
        A dict with keys:
            status (str): "success" or "error"
            data (dict): {"cart_total": float, "items": [...]} on success.
            message (str): Human-readable summary or error description.
    """
    # Validate action
    action = (action or "").strip().lower()
    if action not in _VALID_ACTIONS:
        return {
            "status": "error",
            "data": {},
            "message": (
                f"Invalid action '{action}'. Must be one of: add, remove, clear."
            ),
        }

    # Validate phone
    try:
        phone = _validate_phone(phone)
    except ValueError as exc:
        return {"status": "error", "data": {}, "message": str(exc)}

    # Retrieve auth_session_id from ADK session state (set by websocket_endpoint)
    auth_session_id: str = str(tool_context.state.get("auth_session_id") or "")
    if not auth_session_id:
        return {
            "status": "error",
            "data": {},
            "message": "Session not established. Please reconnect.",
        }

    if action == "add":
        qty = max(1, int(qty or 1))

    try:
        import json as _json
        from backend.db.rls import rls_context

        async with rls_context(auth_session_id, phone=phone) as conn:
            # ── Load current cart ──────────────────────────────────────────
            row = await conn.fetchrow(
                "SELECT id, items_json, total_amount FROM public.carts WHERE phone = $1",
                phone,
            )
            current_items: list[dict[str, Any]] = []
            if row and row["items_json"]:
                items_raw = row["items_json"]
                if isinstance(items_raw, str):
                    current_items = _json.loads(items_raw)
                elif isinstance(items_raw, list):
                    current_items = list(items_raw)

            if action == "clear":
                updated_items: list[dict[str, Any]] = []
                new_total = 0.0
                action_msg = "Cart cleared."

            elif action == "remove":
                if not product_id:
                    return {
                        "status": "error",
                        "data": {},
                        "message": "product_id is required for the 'remove' action.",
                    }
                updated_items = [
                    item for item in current_items
                    if item.get("product_id") != product_id
                ]
                new_total = _calculate_total(updated_items)
                action_msg = f"Item removed from cart. New total: ₦{new_total:,.2f}."

            else:  # action == "add"
                if not product_id:
                    return {
                        "status": "error",
                        "data": {},
                        "message": "product_id is required for the 'add' action.",
                    }

                # Product lookup via catalog client (public read — no RLS needed)
                try:
                    product = _fetch_product(product_id)
                except ValueError as exc:
                    return {"status": "error", "data": {}, "message": str(exc)}

                unit_price = float(product["base_price"])
                product_name = str(product["name"])

                found = False
                updated_items = []
                for item in current_items:
                    if item.get("product_id") == product_id:
                        new_qty = int(item.get("quantity", 1)) + qty
                        updated_items.append({
                            "product_id": product_id,
                            "product_name": product_name,
                            "quantity": new_qty,
                            "unit_price": unit_price,
                            "subtotal": round(unit_price * new_qty, 2),
                        })
                        found = True
                    else:
                        updated_items.append(item)

                if not found:
                    updated_items.append({
                        "product_id": product_id,
                        "product_name": product_name,
                        "quantity": qty,
                        "unit_price": unit_price,
                        "subtotal": round(unit_price * qty, 2),
                    })

                new_total = _calculate_total(updated_items)
                action_msg = (
                    f"Added {qty}× '{product_name}' to cart. "
                    f"Total: ₦{new_total:,.2f}."
                )

            # ── Persist cart (upsert on phone unique constraint) ───────────
            # The anon_insert_own_cart / anon_update_own_cart RLS policies
            # require session_id = current_setting('app.session_id', true),
            # which rls_context has already set within this transaction.
            await conn.execute(
                """
                INSERT INTO public.carts
                    (phone, items_json, total_amount, session_id, status)
                VALUES ($1, $2::jsonb, $3, $4, 'active')
                ON CONFLICT (phone) DO UPDATE
                    SET items_json   = EXCLUDED.items_json,
                        total_amount = EXCLUDED.total_amount,
                        session_id   = EXCLUDED.session_id,
                        status       = 'active',
                        updated_at   = NOW()
                """,
                phone,
                _json.dumps(updated_items),
                round(new_total, 2),
                auth_session_id,
            )

    except Exception as exc:
        logger.error("manage_cart: unexpected error: %s", exc)
        return {
            "status": "error",
            "data": {},
            "message": "Cart update failed unexpectedly. Please try again.",
        }

    # Update session state so the agent never re-asks for cart contents
    tool_context.state["cart_items"] = updated_items
    tool_context.state["cart_total"] = round(new_total, 2)

    logger.info(
        "manage_cart: action='%s' phone='%s' items=%d total=%.2f",
        action,
        phone,
        len(updated_items),
        new_total,
    )

    return {
        "status": "success",
        "data": {
            "cart_total": round(new_total, 2),
            "items": updated_items,
        },
        "message": action_msg,
    }
