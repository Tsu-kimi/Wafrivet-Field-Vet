"""
backend/agent/tools/update_cart.py

ADK tool: update_cart

Updates a line item quantity or removes it from the farmer's active cart.
Fatima calls this when the farmer changes their mind mid-conversation —
e.g. "change the quantity to 2" or "actually, remove the ivermectin".

Fully idempotent: calling with the same arguments produces the same cart state.
Passing quantity=0 removes the line item entirely.

Phase 4 change: switched from service_role Supabase client to asyncpg with
rls_context so anon-role RLS policies are enforced correctly.

Environment variables required:
    SUPABASE_DB_URL – asyncpg DSN (Supabase transaction pooler, port 6543)
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")


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


async def update_cart(
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

    # Retrieve RLS session identity from ADK state
    auth_session_id: str = str(tool_context.state.get("auth_session_id") or "")
    if not auth_session_id:
        return {
            "status": "error",
            "data":   {},
            "message": "Session not established. Please reconnect.",
        }

    import json as _json
    from backend.db.rls import rls_context

    try:
        async with rls_context(auth_session_id, phone=phone) as conn:
            row = await conn.fetchrow(
                "SELECT id, items_json, total_amount, status "
                "FROM public.carts WHERE phone = $1",
                phone,
            )

            if not row:
                return {
                    "status": "error",
                    "data":   {},
                    "message": "No active cart found for this phone number.",
                }

            if row["status"] not in ("active", None):
                return {
                    "status": "error",
                    "data":   {},
                    "message": "This cart has already been submitted and cannot be modified.",
                }

            items_raw = row["items_json"]
            current_items: list[dict[str, Any]] = []
            if items_raw:
                if isinstance(items_raw, str):
                    current_items = _json.loads(items_raw)
                elif isinstance(items_raw, list):
                    current_items = list(items_raw)

            found = any(item.get("product_id") == product_id for item in current_items)
            if not found:
                return {
                    "status": "error",
                    "data":   {},
                    "message": f"Product {product_id!r} is not in the cart.",
                }

            if quantity == 0:
                updated_items = [
                    item for item in current_items
                    if item.get("product_id") != product_id
                ]
                action_msg = "Item removed from your cart."
            else:
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

            await conn.execute(
                """
                UPDATE public.carts
                SET items_json   = $1::jsonb,
                    total_amount = $2,
                    updated_at   = NOW()
                WHERE phone = $3
                """,
                _json.dumps(updated_items),
                round(new_total, 2),
                phone,
            )

    except Exception as exc:
        logger.error("update_cart: DB operation failed: %s", exc)
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
