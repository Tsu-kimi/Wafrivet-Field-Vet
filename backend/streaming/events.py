"""
backend/streaming/events.py

Typed outbound event envelopes sent over the WebSocket to the frontend.

Every message is a JSON object with a top-level ``"type"`` key drawn from the
constants below, plus the fields defined in each TypedDict.

Phase 5 contract — these type strings are stable:
    AUDIO_FLUSH            — browser must discard its audio queue immediately
    TRANSCRIPTION          — speech-to-text for user or agent speech
    TURN_COMPLETE          — agent has finished its response turn
    PRODUCTS_RECOMMENDED   — product cards to render in the UI
    CART_UPDATED           — shopping-cart state refresh
    CHECKOUT_LINK          — payment link to present to the farmer
    LOCATION_CONFIRMED     — Nigerian state confirmed in session
    TOOL_ERROR             — a tool call failed; no data available
"""
from __future__ import annotations

from typing import Any, List, Optional


# ---------------------------------------------------------------------------
# Type constant strings (stable Phase 5 contract)
# ---------------------------------------------------------------------------

T_AUDIO_FLUSH          = "AUDIO_FLUSH"
T_TRANSCRIPTION        = "TRANSCRIPTION"
T_TURN_COMPLETE        = "TURN_COMPLETE"
T_PRODUCTS_RECOMMENDED = "PRODUCTS_RECOMMENDED"
T_CART_UPDATED         = "CART_UPDATED"
T_CHECKOUT_LINK        = "CHECKOUT_LINK"
T_LOCATION_CONFIRMED   = "LOCATION_CONFIRMED"
T_TOOL_ERROR           = "TOOL_ERROR"


# ---------------------------------------------------------------------------
# Factory helpers — each returns a dict ready for websocket.send_json()
# ---------------------------------------------------------------------------

def audio_flush_event() -> dict:
    return {"type": T_AUDIO_FLUSH}


def transcription_event(text: str, author: str, is_final: bool = False) -> dict:
    """
    Args:
        text    — the transcribed text fragment
        author  — "user" for input transcription, agent name for output
        is_final — True when this is the final (non-partial) transcription
    """
    return {
        "type":     T_TRANSCRIPTION,
        "text":     text,
        "author":   author,
        "is_final": is_final,
    }


def turn_complete_event() -> dict:
    return {"type": T_TURN_COMPLETE}


def products_recommended_event(products: List[dict], message: str = "") -> dict:
    """
    Args:
        products — list of product dicts from recommend_products tool response:
                   [{id, name, price_ngn, image_url, description, dosage_notes}]
        message  — optional human-readable summary from the tool
    """
    return {
        "type":     T_PRODUCTS_RECOMMENDED,
        "products": products,
        "message":  message,
    }


def cart_updated_event(
    items: List[dict],
    cart_total: float,
    message: str = "",
) -> dict:
    """
    Args:
        items      — list of cart line items from manage_cart tool response
        cart_total — current cart total in NGN
        message    — optional human-readable summary from the tool
    """
    return {
        "type":       T_CART_UPDATED,
        "items":      items,
        "cart_total": cart_total,
        "message":    message,
    }


def checkout_link_event(
    checkout_url: str,
    payment_reference: str,
    message: str = "",
) -> dict:
    return {
        "type":              T_CHECKOUT_LINK,
        "checkout_url":      checkout_url,
        "payment_reference": payment_reference,
        "message":           message,
    }


def location_confirmed_event(state: str, message: str = "") -> dict:
    return {
        "type":    T_LOCATION_CONFIRMED,
        "state":   state,
        "message": message,
    }


def tool_error_event(tool_name: str, error: str) -> dict:
    return {
        "type":      T_TOOL_ERROR,
        "tool_name": tool_name,
        "error":     error,
    }
