"""
backend/agent/tools/identify_product.py

ADK tool: identify_product_from_frame

Called by Fatima when she detects that a farmer is presenting a physical
product to the camera (e.g. "do you have this?", "what is this product?",
"can you see what I have here?").

This tool takes no parameters — the Gemini Live model already has access to
the live camera feed via the real-time video stream. Calling this tool:
  1. Sets is_scanning_product = True in session state so the WebSocket bridge
     emits a SCANNING_PRODUCT event to the frontend (visual indicator).
  2. Returns a directive response that tells the model to examine the product
     visible in the current video frame and extract identifiable details, then
     immediately call search_products with those details as the query.

The flow is:
  farmer shows product → model calls identify_product_from_frame()
  → bridge emits SCANNING_PRODUCT → frontend shows scanning indicator
  → model extracts product details from live video
  → model calls search_products(query=<extracted name or ingredient>)
  → bridge emits PRODUCTS_RECOMMENDED → frontend shows results
"""

from __future__ import annotations

from typing import Any

from google.adk.tools.tool_context import ToolContext


def identify_product_from_frame(tool_context: ToolContext) -> dict[str, Any]:
    """
    Signal Fatima to read the product label visible in the live camera feed
    and surface matching products from the catalogue.

    This tool takes no parameters because the Gemini Live model can already
    see the camera feed. Call it whenever the farmer says something that
    implies they are showing a physical product label to the camera, such as:
      - "do you have this?"
      - "can you see this product?"
      - "what is this called?"
      - "I want to buy this" (while pointing camera at a label)
      - "check what I'm showing you"

    Returns:
        A directive dict instructing the model on the precise extraction task.
        The model uses this response to guide its next action.
    """
    # Signal the frontend to show the scanning indicator via session state.
    # The bridge reads this flag from the tool response and emits SCANNING_PRODUCT.
    tool_context.state["is_scanning_product"] = True

    return {
        "status": "success",
        "action": "EXAMINE_PRODUCT_IN_FRAME",
        "directive": (
            "Carefully examine the product label currently visible in the live "
            "video stream. Extract as much of the following as you can read clearly:"
            "\n• Brand name (e.g. Terramycin LA, Albendazole Suspension)"
            "\n• Generic or active ingredient name (e.g. oxytetracycline, ivermectin)"
            "\n• Concentration or dosage strength (e.g. 20%, 1%, 200 mg)"
            "\n• Manufacturer or company name"
            "\n• NAFDAC registration number if visible"
            "\n\nIf you can read the label clearly, say 'I can see [product name]' "
            "and immediately call search_products with the brand name or active "
            "ingredient as the query string. "
            "If the label is blurry or not clearly visible, ask the farmer to hold "
            "the product closer and keep it still so you can read it."
        ),
        "message": "Examining product label from camera feed.",
    }
