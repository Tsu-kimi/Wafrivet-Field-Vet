"""
backend/agent/tools/address_book.py

ADK tool: manage_delivery_address

Structured address book operations for farmers:
- list saved addresses
- create a new address
- update an existing address
- delete an address
- select default address for checkout

This tool is conversation-friendly: Fatima can ask for missing fields one by one,
then call this tool to persist the final structured address.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from google.adk.tools.tool_context import ToolContext

from backend.services import farmer_service

_PHONE_REGEX = re.compile(r"^\+[1-9]\d{6,14}$")


async def manage_delivery_address(
    action: str,
    phone: str,
    tool_context: ToolContext,
    address_id: Optional[str] = None,
    unit: Optional[str] = None,
    street: Optional[str] = None,
    city: Optional[str] = None,
    state: Optional[str] = None,
    country: Optional[str] = None,
    postal_code: Optional[str] = None,
    delivery_phone: Optional[str] = None,
    set_default: bool = False,
) -> dict[str, Any]:
    """
    Manage structured delivery addresses for the authenticated farmer session.

    Args:
        action: one of "list", "create", "update", "delete", "select".
        phone: farmer E.164 phone number from session state.
        tool_context: ADK state context containing auth_session_id.
        address_id: required for update/delete/select.
        unit/street/city/state/country/postal_code/delivery_phone:
            required for create/update.
        set_default: whether to select the address for checkout.
    """
    action = (action or "").strip().lower()
    if action not in {"list", "create", "update", "delete", "select"}:
        return {
            "status": "error",
            "data": {},
            "message": "Invalid action. Use one of: list, create, update, delete, select.",
        }

    phone = (phone or "").strip()
    if not _PHONE_REGEX.match(phone):
        return {
            "status": "error",
            "data": {},
            "message": "A valid E.164 phone number is required (e.g. +2348012345678).",
        }

    auth_session_id: str = str(tool_context.state.get("auth_session_id") or "")
    if not auth_session_id:
        return {
            "status": "error",
            "data": {},
            "message": "Session not established. Please reconnect.",
        }

    try:
        if action == "list":
            payload = await farmer_service.list_delivery_addresses(auth_session_id)
            return {
                "status": "success",
                "data": payload,
                "message": "Saved addresses loaded.",
            }

        if action == "select":
            if not address_id:
                return {
                    "status": "error",
                    "data": {},
                    "message": "address_id is required to select an address.",
                }
            selected = await farmer_service.select_delivery_address(
                session_id=auth_session_id,
                address_id=address_id,
            )
            return {
                "status": "success",
                "data": {"address": selected},
                "message": "Delivery address selected for checkout.",
            }

        if action == "delete":
            if not address_id:
                return {
                    "status": "error",
                    "data": {},
                    "message": "address_id is required to delete an address.",
                }
            payload = await farmer_service.delete_delivery_address(
                session_id=auth_session_id,
                address_id=address_id,
            )
            return {
                "status": "success",
                "data": payload,
                "message": "Address deleted.",
            }

        required_fields = {
            "unit": (unit or "").strip(),
            "street": (street or "").strip(),
            "city": (city or "").strip(),
            "state": (state or "").strip(),
            "country": (country or "").strip(),
            "postal_code": (postal_code or "").strip(),
            "delivery_phone": (delivery_phone or "").strip(),
        }
        missing = [name for name, value in required_fields.items() if not value]
        if missing:
            return {
                "status": "error",
                # Mark as intermediate so the bridge suppresses the noisy frontend
                # TOOL_ERROR event — the retry plugin handles this automatically.
                "data": {"missing_fields": missing, "_intermediate": True},
                "message": f"Missing required address fields: {', '.join(missing)}.",
            }

        if action == "create":
            address = await farmer_service.create_delivery_address(
                session_id=auth_session_id,
                set_default=set_default,
                **required_fields,
            )
            return {
                "status": "success",
                "data": {"address": address},
                "message": "Address created successfully.",
            }

        if not address_id:
            return {
                "status": "error",
                "data": {},
                "message": "address_id is required to update an address.",
            }

        address = await farmer_service.update_delivery_address(
            session_id=auth_session_id,
            address_id=address_id,
            set_default=set_default,
            **required_fields,
        )
        return {
            "status": "success",
            "data": {"address": address},
            "message": "Address updated successfully.",
        }
    except ValueError as exc:
        return {
            "status": "error",
            "data": {},
            "message": str(exc),
        }
    except Exception:
        return {
            "status": "error",
            "data": {},
            "message": "Address operation failed. Please try again.",
        }
