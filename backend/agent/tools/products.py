"""
backend/agent/tools/products.py

ADK tool: recommend_products

Queries the Supabase products table for active veterinary products that:
  1. Are tagged with the confirmed disease category (disease_tags @> [category])
  2. Are available in the farmer's Nigerian state (states_available @> [state])

Returns up to 5 products ordered by price ascending. Falls back to a keyword
search across disease_tags if the exact disease_name produces no results.

The return shape for the "data.products" array is the WebSocket contract for
the PRODUCTS_RECOMMENDED frontend event in Phase 4 — do not alter field names.

Environment variables required:
    SUPABASE_URL              – https://<ref>.supabase.co
    SUPABASE_ANON_KEY         – Anon key (read access to products)
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Any

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

_MAX_PRODUCTS = 5


# ---------------------------------------------------------------------------
# Lazy singleton client
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_supabase_client():
    """Return a cached Supabase client initialised from environment variables."""
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_ANON_KEY must be set."
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fetch_exact(disease_category: str, state: str) -> list[dict[str, Any]]:
    """Exact array-containment query: disease_tags @> [disease_category]."""
    db = _get_supabase_client()
    response = (
        db.table("products")
        .select(
            "id, name, base_price, image_url, description, dosage_notes"
        )
        .contains("disease_tags", [disease_category])
        .contains("states_available", [state])
        .eq("is_active", True)
        .order("base_price")
        .limit(_MAX_PRODUCTS)
        .execute()
    )
    # getattr returns Any, bypassing the supabase stub's JSON union type
    data: Any = getattr(response, "data", None)
    return data if isinstance(data, list) else []


def _fetch_keyword_fallback(disease_category: str, state: str) -> list[dict[str, Any]]:
    """
    Keyword fallback: fetch all active products in the state and filter client-side
    by checking whether any disease_tag contains the first meaningful word of the
    disease_category (case-insensitive).

    Used when the database has no product tagged with the exact disease_name.
    """
    keyword = disease_category.split("(")[0].strip().lower()
    db = _get_supabase_client()
    response = (
        db.table("products")
        .select(
            "id, name, base_price, image_url, description, dosage_notes, disease_tags"
        )
        .contains("states_available", [state])
        .eq("is_active", True)
        .order("base_price")
        .execute()
    )
    # getattr returns Any, bypassing the supabase stub's JSON union type
    data: Any = getattr(response, "data", None)
    all_rows: list[dict[str, Any]] = data if isinstance(data, list) else []
    # Filter by keyword match across any tag
    filtered = [
        row for row in all_rows
        if any(
            keyword in tag.lower()
            for tag in (row.get("disease_tags") or [])
        )
    ]
    return filtered[:_MAX_PRODUCTS]


# ---------------------------------------------------------------------------
# Public ADK tool function
# ---------------------------------------------------------------------------

def recommend_products(
    disease_category: str,
    location: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """
    Recommend veterinary products available near the farmer for a confirmed
    livestock condition.

    Queries the products table for active items where disease_tags contains
    the disease_category and states_available contains the farmer's state.
    Falls back to keyword-based tag matching if the exact name has no results.
    Returns up to 5 products ordered by price ascending.

    The "data.products" array in the success response is the exact payload
    shape that the Phase 4 WebSocket bridge broadcasts as a PRODUCTS_RECOMMENDED
    event to the Next.js frontend. Do not add, remove, or rename the fields in
    each product dict.

    Args:
        disease_category:
            The confirmed disease name from search_disease_matches, e.g.
            "Ruminal Bloat" or "Contagious Caprine Pleuropneumonia (CCPP)".
            If empty, the value stored in session state is used.
        location:
            The farmer's Nigerian state name (title-case, no "State" suffix,
            e.g. "Rivers"). If empty, falls back to session state farmer_state.

    Returns:
        A dict with keys:
            status (str): "success" or "error"
            data (dict): {"products": [...]} on success; each product dict has
                id (str), name (str), price_ngn (float), image_url (str),
                description (str), dosage_notes (str).
            message (str): Human-readable summary or error description.
    """
    # Resolve disease_category from session state if caller did not supply it
    effective_disease = (disease_category or "").strip()
    if not effective_disease:
        effective_disease = (
            tool_context.state.get("confirmed_disease") or ""
        ).strip()

    # Resolve location from session state if caller did not supply it
    effective_location = (location or "").strip()
    if not effective_location:
        effective_location = (
            tool_context.state.get("farmer_state") or ""
        ).strip()

    if not effective_disease or not effective_location:
        missing = []
        if not effective_disease:
            missing.append("disease condition")
        if not effective_location:
            missing.append("your Nigerian state")
        return {
            "status": "error",
            "data": {"products": []},
            "message": (
                f"I need {' and '.join(missing)} to search for products. "
                "Please provide the missing information."
            ),
        }

    logger.info(
        "recommend_products: searching for '%s' in '%s'",
        effective_disease,
        effective_location,
    )

    try:
        rows = _fetch_exact(effective_disease, effective_location)

        if not rows:
            logger.info(
                "recommend_products: no exact tag match; trying keyword fallback"
            )
            rows = _fetch_keyword_fallback(effective_disease, effective_location)

    except Exception as exc:
        logger.error("recommend_products: Supabase query failed: %s", exc)
        return {
            "status": "error",
            "data": {"products": []},
            "message": "Product search is temporarily unavailable. Please try again.",
        }

    if not rows:
        return {
            "status": "error",
            "data": {"products": []},
            "message": (
                f"No products found for '{effective_disease}' in {effective_location}. "
                "Please contact a local veterinary supplier directly."
            ),
        }

    products = [
        {
            "id": str(row.get("id", "")),
            "name": str(row.get("name", "")),
            "base_price": float(row.get("base_price", 0)),
            "image_url": str(row.get("image_url", "")),
            "description": str(row.get("description", "")),
            "dosage_notes": str(row.get("dosage_notes", "")),
        }
        for row in rows
    ]

    logger.info(
        "recommend_products: returning %d product(s) for '%s' in '%s'",
        len(products),
        effective_disease,
        effective_location,
    )

    return {
        "status": "success",
        "data": {"products": products},
        "message": (
            f"Found {len(products)} product(s) for {effective_disease} "
            f"available in {effective_location}."
        ),
    }
