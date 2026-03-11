"""
backend/agent/tools/update_cart.py

ADK tool: update_cart

Updates a line item quantity or removes it from the farmer's active cart.
Fatima calls this when the farmer changes their mind mid-conversation —
e.g. "change the quantity to 2" or "actually, remove the ivermectin".

Fully idempotent: calling with the same arguments produces the same cart state.
Passing quantity=0 removes the line item entirely.

The tool reuses the same Supabase upsert pattern as manage_cart so cart
state remains consistent across both tools.

Environment variables required:
    SUPABASE_URL              – https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY – Service-role key (read/write access to carts)
"""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache
from typing import Any

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")


@lru_cache(maxsize=1)
def _get_supabase_client():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


def _validate_phone(phone: str) -> str:
    normalized = phone.strip()
    if not _PHONE_REGEX.match(normalized):
        raise ValueError(
            f"Phone must be E.164 format (e.g. +2348012345678), got: {normalized!r}"
        )
    return normalized


def _load_cart(phone: str) -> dict[str, Any] | None:
    db = _get_supabase_client()
    response = (
        db.table("carts")
        .select("id, items_json, total_amount, status")
        .eq("phone", phone)
        .maybe_single()
        .execute()
    )
    raw: Any = getattr(response, "data", None)
    return raw if raw else None


def _calculate_total(items: list[dict[str, Any]]) -> float:
    return sum(float(item.get("subtotal", 0)) for item in items)


def update_cart(
    phone: str,
    product_id: str,
    quantity: int,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """
    Update the quantity of a specific product in the farmer's cart or remove it.

    Call this when the farmer wants to change a previously added product's
    quantity or remove a product entirely. Do NOT call it to add a new product
    for the first time — use manage_cart with action="add" for that.

    Args:
        phone:
            Farmer's E.164 phone number (e.g. "+2348012345678"). Must match
            the phone used when the cart was created.
        product_id:
            UUID of the product line item to update. Must already be in
            the farmer's cart.
        quantity:
            New quantity for the product. Set to 0 to remove the item entirely.
            Must be 0 or a positive integer.

    Returns:
        A dict with:
            status  (str):  "success" or "error"
            data    (dict): {cart_total: float, items: [...]}
            message (str):  Confirmation or error description.
    """
    # Validate inputs
    try:
        phone = _validate_phone(phone)
    except ValueError as exc:
        return {"status": "error", "data": {}, "message": str(exc)}

    product_id = (product_id or "").strip()
    if not product_id:
        return {
            "status": "error",
            "data":   {},
            "message": "product_id is required.",
        }

    quantity = int(quantity or 0)
    if quantity < 0:
        return {
            "status": "error",
            "data":   {},
            "message": "Quantity must be 0 (remove) or a positive integer.",
        }

    # Cart must not be a placed/completed order
    cart = _load_cart(phone)
    if not cart:
        return {
            "status": "error",
            "data":   {},
            "message": "No active cart found for this phone number.",
        }

    if cart.get("status") not in ("active", None):
        return {
            "status": "error",
            "data":   {},
            "message": (
                "This cart has already been submitted and cannot be modified."
            ),
        }

    current_items: list[dict[str, Any]] = list(cart.get("items_json") or [])

    # Find the target item
    found = any(item.get("product_id") == product_id for item in current_items)
    if not found:
        return {
            "status": "error",
            "data":   {},
            "message": f"Product {product_id!r} is not in the cart.",
        }

    if quantity == 0:
        # Remove the item
        updated_items = [
            item for item in current_items
            if item.get("product_id") != product_id
        ]
        action_msg = "Item removed from your cart."
    else:
        # Update quantity
        updated_items = []
        for item in current_items:
            if item.get("product_id") == product_id:
                unit_price = float(item.get("unit_price", 0))
                updated_items.append({
                    **item,
                    "quantity": quantity,
                    "subtotal": round(unit_price * quantity, 2),
                })
            else:
                updated_items.append(item)
        action_msg = f"Quantity updated to {quantity}."

    new_total = _calculate_total(updated_items)

    try:
        db = _get_supabase_client()
        db.table("carts").update(
            {
                "items_json":   updated_items,
                "total_amount": round(new_total, 2),
            }
        ).eq("phone", phone).execute()
    except Exception as exc:
        logger.error("update_cart: Supabase write failed: %s", exc)
        return {
            "status": "error",
            "data":   {},
            "message": "Failed to update your cart. Please try again.",
        }

    # Sync session state
    tool_context.state["cart_items"] = updated_items
    tool_context.state["cart_total"] = new_total

    return {
        "status": "success",
        "data": {
            "cart_total": round(new_total, 2),
            "items":      updated_items,
        },
        "message": f"{action_msg} Cart total: ₦{new_total:,.2f}.",
    }
