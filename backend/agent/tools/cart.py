"""
backend/agent/tools/cart.py

ADK tool: manage_cart

Manages the farmer's active shopping cart in the Supabase carts table.
Supports three actions: add a product, remove a product, or clear the cart.

The carts table uses phone as a unique key. An upsert is performed on every
operation so calls are fully idempotent — duplicate calls with the same
arguments produce the same final state.

The "data" return shape is the WebSocket contract for the CART_UPDATED
frontend event in Phase 4. Do not alter field names.

Environment variables required:
    SUPABASE_URL              – https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY – Service-role key (read/write access to carts, products)
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
# Lazy singleton client
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_supabase_client():
    """Return a cached Supabase client initialised from environment variables."""
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
        )
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
    Look up a product by ID and return its name and price.

    Raises:
        ValueError: if the product does not exist or is inactive.
    """
    db = _get_supabase_client()
    response = (
        db.table("products")
        .select("id, name, base_price")
        .eq("id", product_id)
        .eq("is_active", True)
        .single()
        .execute()
    )
    # getattr returns Any, bypassing the supabase stub's JSON union type
    raw: Any = getattr(response, "data", None)
    if not raw:
        raise ValueError(f"Product {product_id!r} not found or inactive.")
    return raw


def _load_cart(phone: str) -> dict[str, Any] | None:
    """
    Fetch the active cart row for the given phone number.

    Returns the row dict (with id, items_json, total_amount) or None if no
    cart exists yet.
    """
    db = _get_supabase_client()
    response = (
        db.table("carts")
        .select("id, items_json, total_amount")
        .eq("phone", phone)
        .maybe_single()
        .execute()
    )
    # getattr returns Any, also guards against response being None per the stubs
    raw: Any = getattr(response, "data", None)
    return raw if raw else None


def _calculate_total(items: list[dict[str, Any]]) -> float:
    """Sum subtotals for all line items in the cart."""
    return sum(float(item.get("subtotal", 0)) for item in items)


def _upsert_cart(
    phone: str,
    items: list[dict[str, Any]],
    total: float,
    session_id: str,
) -> None:
    """
    Persist the cart to Supabase using an upsert on the phone unique constraint
    (migration 018 added carts_phone_unique).
    """
    db = _get_supabase_client()
    db.table("carts").upsert(
        {
            "phone": phone,
            "items_json": items,
            "total_amount": round(total, 2),
            "session_id": session_id,
            "status": "active",
        },
        on_conflict="phone",
    ).execute()


# ---------------------------------------------------------------------------
# Public ADK tool function
# ---------------------------------------------------------------------------

def manage_cart(
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

    Args:
        action:
            One of "add", "remove", or "clear".
            "add"    – Append product_id to the cart (or increase qty if present).
            "remove" – Remove product_id from the cart entirely.
            "clear"  – Empty the cart and reset the total to zero.
        phone:
            Farmer's E.164 phone number (e.g. "+2348012345678"). Used as the
            cart's unique identifier in Supabase.
        product_id:
            UUID of the product to add or remove. Required for "add" and
            "remove"; ignored for "clear".
        qty:
            Quantity to add. Defaults to 1. Ignored for "remove" and "clear".

    Returns:
        A dict with keys:
            status (str): "success" or "error"
            data (dict): {"cart_total": float, "items": [...]} on success.
                Each item has: product_id, product_name, quantity,
                unit_price, subtotal.
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
        return {
            "status": "error",
            "data": {},
            "message": str(exc),
        }

    # Derive session_id from ToolContext (ADK provides this automatically)
    session_id: str = getattr(tool_context, "session_id", "") or ""

    # Validate qty for add
    if action == "add":
        qty = max(1, int(qty or 1))

    try:
        existing_cart = _load_cart(phone)
        current_items: list[dict[str, Any]] = (
            list(existing_cart.get("items_json") or [])
            if existing_cart
            else []
        )

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

            # Look up product to get authoritative name and price
            try:
                product = _fetch_product(product_id)
            except ValueError as exc:
                return {
                    "status": "error",
                    "data": {},
                    "message": str(exc),
                }

            unit_price = float(product["base_price"])
            product_name = str(product["name"])

            # Check if product already in cart — increase qty if so
            found = False
            updated_items = []
            for item in current_items:
                if item.get("product_id") == product_id:
                    new_qty = int(item.get("quantity", 1)) + qty
                    updated_items.append(
                        {
                            "product_id": product_id,
                            "product_name": product_name,
                            "quantity": new_qty,
                            "unit_price": unit_price,
                            "subtotal": round(unit_price * new_qty, 2),
                        }
                    )
                    found = True
                else:
                    updated_items.append(item)

            if not found:
                updated_items.append(
                    {
                        "product_id": product_id,
                        "product_name": product_name,
                        "quantity": qty,
                        "unit_price": unit_price,
                        "subtotal": round(unit_price * qty, 2),
                    }
                )

            new_total = _calculate_total(updated_items)
            action_msg = (
                f"Added {qty}× '{product_name}' to cart. "
                f"Total: ₦{new_total:,.2f}."
            )

        # Persist to Supabase
        _upsert_cart(phone, updated_items, new_total, session_id)

        # Update session state
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

    except Exception as exc:
        logger.error("manage_cart: unexpected error: %s", exc)
        return {
            "status": "error",
            "data": {},
            "message": "Cart update failed unexpectedly. Please try again.",
        }
