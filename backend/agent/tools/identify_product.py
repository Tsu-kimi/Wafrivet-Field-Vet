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
    Read a physical product label that is CURRENTLY VISIBLE in the live camera
    feed and search the catalogue for a match.

    PRECONDITION — only call this tool when ALL of the following are true:
      1. You can already see a physical object (bottle, sachet, bag, box, syringe)
         being deliberately held up or pointed at the camera in the current frame.
      2. The farmer's intent is clearly to identify or buy that specific product
         (e.g. "do you have this?", "can I get this?", "what is this product?",
         "I want to buy what I'm showing you", "check this label").
      3. Do NOT call this tool for purely verbal product requests where nothing
         is being shown to the camera — use search_products directly instead.
      4. Do NOT call this tool if the camera shows only the farmer's face,
         background, or an empty frame.

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
            "You have been asked to read a product label from the live video stream. "
            "First, confirm there is a physical product clearly in frame:\n"
            "• If NO product or label is visible, say exactly: "
            "'I cannot see a product clearly — could you hold it up closer to the camera?' "
            "and do NOT call search_products.\n"
            "• If a product IS visible, read as much of the label as you can:\n"
            "  – Brand name (e.g. Terramycin LA, Albendazole Suspension)\n"
            "  – Generic or active ingredient (e.g. oxytetracycline, ivermectin)\n"
            "  – Concentration / dosage strength (e.g. 20%, 1%, 200 mg)\n"
            "  – Manufacturer name\n"
            "  – NAFDAC registration number if visible\n"
            "Then say 'I can see [product name]' and immediately call search_products "
            "with the brand name or active ingredient as the query string.\n"
            "If the label is present but blurry, ask the farmer to hold it closer "
            "and stay still before trying again."
        ),
        "message": "Examining product label from camera feed.",
    }
