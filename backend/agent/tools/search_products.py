"""
backend/agent/tools/search_products.py

ADK tool: search_products

Hybrid product search combining full-text search (FTS) and pgvector cosine
similarity, merged via Reciprocal Rank Fusion (RRF). Returns a ranked list of
product-distributor pairings so Fatima presents the cheapest available option
in the farmer's state first, without mentioning distributors or databases.

Also exposes find_cheaper_option() which is called internally when the farmer
says "is there a cheaper option?" — it first checks whether another distributor
in the same state has the exact same product cheaper, then falls back to an
alternative product search if not.

Environment variables required:
    SUPABASE_URL              – https://<ref>.supabase.co
    SUPABASE_ANON_KEY         – Anon key (read access to products, distributor_inventory)
    GOOGLE_CLOUD_PROJECT      – GCP project ID for Vertex AI embeddings
    GOOGLE_CLOUD_LOCATION     – GCP region (default: us-central1)
"""

from __future__ import annotations

import logging
import os
import re
import time
from functools import lru_cache
from typing import Any, Optional

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

# Embedding config — must match products.embedding vector(1536) column
_EMBEDDING_MODEL_ID    = "gemini-embedding-001"
_EMBEDDING_DIMENSIONS  = 1536
_RETRY_ATTEMPTS        = 3
_RETRY_DELAY           = 4       # seconds between Vertex AI retries
_MAX_RESULTS           = 5

_SPECIES_HINTS: dict[str, tuple[str, ...]] = {
    "cattle": ("cattle", "cow", "cows", "bovine"),
    "goat": ("goat", "goats", "caprine"),
    "sheep": ("sheep", "ovine", "ram", "ewes"),
    "poultry": ("poultry", "chicken", "broiler", "layers", "bird"),
    "pig": ("pig", "pigs", "swine", "porcine"),
}

_GENERIC_PRODUCT_WORDS = (
    "product",
    "products",
    "medicine",
    "medicines",
    "drug",
    "drugs",
    "treatment",
    "treatments",
)

# Strip conversational filler that pollutes the semantic embedding and degrades
# retrieval precision. These are patterns that appear when the model passes the
# farmer's raw speech as the query instead of extracting the search intent.
_CONVERSATIONAL_PREFIX_RE = re.compile(
    r"^(can you (give|show|find|search|list|get)( me)?( all| some| any)?|"
    r"please (find|give|show|list|search)( me)?|"
    r"i (want|need|would like)( to (see|buy|get|find))?|"
    r"do you have( any| some)?|"
    r"what (are|do you have for|can you recommend for)|"
    r"give me( all| some| a list of)?|"
    r"show me( all| some)?|"
    r"find me( some| all)?|"
    r"search for|"
    r"look for|"
    r"recommend( me)?( some| any)?)\s+",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Lazy singleton clients
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_supabase_client():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_ANON_KEY must be set."
        )
    from supabase import create_client  # type: ignore
    return create_client(url, key)


@lru_cache(maxsize=1)
def _get_genai_client():
    project  = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1").strip()
    if not project:
        raise EnvironmentError("GOOGLE_CLOUD_PROJECT must be set.")
    from google import genai as _genai  # type: ignore
    return _genai.Client(vertexai=True, project=project, location=location)


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------

def _embed_query(text: str) -> list[float]:
    """
    Generate a RETRIEVAL_QUERY embedding for the query string.
    Output dimension matches the products.embedding column (vector(1536)).

    Returns:
        List of floats of length _EMBEDDING_DIMENSIONS.

    Raises:
        RuntimeError: if all retry attempts fail.
    """
    from google.genai import types as _gt  # type: ignore

    client = _get_genai_client()
    config = _gt.EmbedContentConfig(
        task_type="RETRIEVAL_QUERY",
        output_dimensionality=_EMBEDDING_DIMENSIONS,
    )

    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            result = client.models.embed_content(
                model=_EMBEDDING_MODEL_ID,
                contents=[text],
                config=config,
            )
            vec: list[float] = result.embeddings[0].values  # type: ignore[index]
            if len(vec) != _EMBEDDING_DIMENSIONS:
                raise ValueError(
                    f"Expected {_EMBEDDING_DIMENSIONS}-dim vector, got {len(vec)}"
                )
            return vec
        except Exception as exc:
            if attempt < _RETRY_ATTEMPTS:
                logger.warning(
                    "Vertex AI embedding attempt %d/%d failed: %s – retrying in %ds",
                    attempt, _RETRY_ATTEMPTS, exc, _RETRY_DELAY,
                )
                time.sleep(_RETRY_DELAY)
            else:
                raise RuntimeError(
                    f"All {_RETRY_ATTEMPTS} embedding attempts failed for query: "
                    f"{text[:80]!r}"
                ) from exc
    raise RuntimeError("Embedding loop exited without result")


# ---------------------------------------------------------------------------
# RPC helper
# ---------------------------------------------------------------------------

def _rpc_hybrid_search(
    query_text: str,
    query_vec: list[float],
    farmer_state: str,
    result_limit: int,
    price_ceiling: Optional[float],
    exclude_ids: list[str],
    category_filter: Optional[str],
) -> list[dict[str, Any]]:
    """
    Call the hybrid_search_products Supabase RPC function and return raw rows.
    """
    db  = _get_supabase_client()
    vec_literal = "[" + ",".join(str(round(v, 8)) for v in query_vec) + "]"

    params: dict[str, Any] = {
        "query_text":    query_text,
        "query_embedding": vec_literal,
        "farmer_state":  farmer_state,
        "result_limit":  result_limit,
    }
    if price_ceiling is not None:
        params["price_ceiling"] = round(float(price_ceiling), 2)
    if exclude_ids:
        # PostgREST requires array literals as strings for RPC parameters
        params["exclude_ids"] = "{" + ",".join(exclude_ids) + "}"
    if category_filter:
        params["category_filter"] = category_filter

    response = db.rpc("hybrid_search_products", params).execute()
    raw: Any = getattr(response, "data", None)
    return raw if isinstance(raw, list) else []


def _rpc_find_cheaper(
    product_id: str,
    farmer_state: str,
    current_price: float,
) -> dict[str, Any] | None:
    """
    Call find_cheaper_distributor RPC. Returns the cheaper distributor row or None.
    """
    db = _get_supabase_client()
    response = db.rpc(
        "find_cheaper_distributor",
        {
            "p_product_id":    product_id,
            "p_farmer_state":  farmer_state,
            "p_current_price": round(current_price, 2),
        },
    ).execute()
    raw: Any = getattr(response, "data", None)
    if isinstance(raw, list) and raw:
        return raw[0]
    return None


# ---------------------------------------------------------------------------
# Result shaping
# ---------------------------------------------------------------------------

def _shape_result(row: dict[str, Any], rank: int) -> dict[str, Any]:
    """Convert a raw RPC row to the standard search result dict."""
    return {
        "product_id":     str(row.get("product_id", "")),
        "product_name":   str(row.get("product_name", "")),
        "description":    str(row.get("description", "")),
        "dosage_notes":   str(row.get("dosage_notes", "")),
        "image_url":      str(row.get("image_url", "")),
        "category":       str(row.get("category", "")),
        "disease_tags":   list(row.get("disease_tags") or []),
        "price":          float(row.get("price", 0)),
        "stock_qty":      int(row.get("stock_qty", 0)),
        "distributor_id": str(row.get("distributor_id", "")) if row.get("distributor_id") else None,
        "rrf_rank":       rank,
        # Include base_price alias for frontend backward compatibility
        "base_price":     float(row.get("price", 0)),
    }


def _enrich_query_for_species_intent(query: str) -> str:
    """
    Strip conversational prefixes and expand generic animal queries so hybrid
    retrieval anchors to vet commerce intent rather than natural-language noise.

    Two-step pipeline:
      1. Remove conversational filler (e.g. "can you give me all") that dilutes
         the embedding and lowers retrieval precision.
      2. If the cleaned query contains generic product words (medicine, drugs …)
         together with a known livestock species, append a veterinary context tail
         so the embedding space aligns to vet-commerce documents.
    """
    # Step 1 — strip conversational prefixes
    cleaned = _CONVERSATIONAL_PREFIX_RE.sub("", query).strip()
    if not cleaned:
        cleaned = query  # safety fallback — never return empty

    lowered = cleaned.lower()

    # Step 2 — species intent expansion for generic queries
    if not any(word in lowered for word in _GENERIC_PRODUCT_WORDS):
        return cleaned

    matched_species: list[str] = []
    for canonical, aliases in _SPECIES_HINTS.items():
        if any(re.search(rf"\b{re.escape(alias)}\b", lowered) for alias in aliases):
            matched_species.append(canonical)

    if not matched_species:
        return cleaned

    species_tail = ", ".join(dict.fromkeys(matched_species))
    return f"{cleaned} veterinary medicines and treatments for {species_tail}"


# ---------------------------------------------------------------------------
# Public ADK tool — search_products
# ---------------------------------------------------------------------------

def search_products(
    query: str,
    tool_context: ToolContext,
    farmer_state: Optional[str] = None,
    sort_by: str = "rank",
    price_ceiling: Optional[float] = None,
    exclude_product_ids: Optional[list[str]] = None,
    category: Optional[str] = None,
) -> dict[str, Any]:
    """
    Search the Wafrivet product catalogue using hybrid FTS + semantic search.

    Combines PostgreSQL full-text search and Vertex AI vector similarity,
    merging the two result sets via Reciprocal Rank Fusion (RRF) so products
    matching both layers rank higher than products matched by only one.

    Each result carries the cheapest price from a distributor in the farmer's
    state. If no local distributor has the product, the catalogue base_price
    is used as a fallback.

    Args:
        query:
            Free-text product search query. May be a brand name
            ("tetracycline"), a generic ingredient ("oxytetracycline"),
            a symptom ("swollen joints"), or text extracted from a product
            label by the identify_product_from_frame tool.
        farmer_state:
            The farmer's canonical Nigerian state name (e.g. "Lagos").
            Falls back to the session's farmer_state if not provided.
        sort_by:
            Result ordering — "rank" (default RRF score), "price_asc", or
            "price_desc".
        price_ceiling:
            Exclude products priced above this amount in NGN. NULL = no limit.
        exclude_product_ids:
            List of product UUIDs to omit (used when showing alternatives).
        category:
            Optional product category filter (e.g. "antibiotic").

    Returns:
        A dict with:
            status  (str):  "success" or "error"
            data    (dict): {products: [list of ranked results], query: str,
                             state: str, total_found: int}
            message (str):  Human-readable summary for the agent to read aloud.
    """
    # Validate and sanitise query — no raw DB interpolation
    raw_query = (query or "").strip()
    if not raw_query:
        return {
            "status": "error",
            "data":   {},
            "message": "A search query is required. Please describe the product you need.",
        }
    # Cap query length to prevent abuse / unexpectedly large embeddings
    raw_query = raw_query[:400]
    query = _enrich_query_for_species_intent(raw_query)

    # Resolve farmer state from session if not passed explicitly
    state: str = (farmer_state or "").strip()
    if not state:
        state = (tool_context.state.get("farmer_state") or "").strip()
    if not state:
        return {
            "status": "error",
            "data":   {},
            "message": (
                "I need to know your Nigerian state before I can search for "
                "products. Please tell me which state you are in."
            ),
        }

    exclude_ids: list[str] = [
        eid.strip() for eid in (exclude_product_ids or []) if eid.strip()
    ]
    cat_filter = (category or "").strip() or None

    try:
        # Generate RETRIEVAL_QUERY embedding for the query
        query_vec = _embed_query(query)

        # Call hybrid RPC
        raw_rows = _rpc_hybrid_search(
            query_text     = query,
            query_vec      = query_vec,
            farmer_state   = state,
            result_limit   = _MAX_RESULTS,
            price_ceiling  = price_ceiling,
            exclude_ids    = exclude_ids,
            category_filter= cat_filter,
        )
    except EnvironmentError as exc:
        logger.error("search_products: env error: %s", exc)
        return {
            "status": "error",
            "data":   {},
            "message": "Product search is temporarily unavailable. Please try again.",
        }
    except Exception as exc:
        logger.error("search_products: unexpected error: %s", exc)
        return {
            "status": "error",
            "data":   {},
            "message": "I had trouble searching for products. Please try again.",
        }

    # Shape results
    shaped = [_shape_result(row, rank=i + 1) for i, row in enumerate(raw_rows)]

    # Optional re-sort (RRF rank is default; price sorts are secondary uses)
    if sort_by == "price_asc":
        shaped.sort(key=lambda r: r["price"])
    elif sort_by == "price_desc":
        shaped.sort(key=lambda r: r["price"], reverse=True)
    # "rank" keeps RRF order from the DB (already sorted by rrf_score DESC)

    # Persist results in session state so add_to_cart and update_cart can
    # look up distributor_id without requiring the agent to re-pass it
    tool_context.state["last_search_results"] = shaped
    tool_context.state["is_scanning_product"]  = False

    if not shaped:
        return {
            "status": "success",
            "data": {
                "products":    [],
                "query":       raw_query,
                "state":       state,
                "total_found": 0,
            },
            "message": (
                f"I could not find any products matching '{raw_query}' available in "
                f"{state} right now. Try a different name or a broader term."
            ),
        }

    top = shaped[0]
    msg = (
        f"Found {len(shaped)} product(s) matching '{query}' in {state}. "
        f"Top result: {top['product_name']} at ₦{top['price']:,.2f}."
    )

    return {
        "status": "success",
        "data": {
            "products":    shaped,
            "query":       raw_query,
            "state":       state,
            "total_found": len(shaped),
        },
        "message": msg,
    }


# ---------------------------------------------------------------------------
# Public ADK tool — find_cheaper_option
# ---------------------------------------------------------------------------

def find_cheaper_option(
    product_id: str,
    current_price: float,
    tool_context: ToolContext,
    farmer_state: Optional[str] = None,
) -> dict[str, Any]:
    """
    Check if a cheaper version of the exact same product is available from
    another distributor in the farmer's state. Falls back to searching for
    an alternative product at a lower price if no cheaper same-product
    distributor is found.

    Fatima calls this tool when the farmer says anything like
    "is there a cheaper option", "do you have it cheaper", or
    "I want a lower price".

    Args:
        product_id:    UUID of the product the farmer is considering.
        current_price: Price in NGN that was already presented to the farmer.
        farmer_state:  Canonical Nigerian state name (falls back to session).

    Returns:
        A dict with:
            status  (str):  "success" or "error"
            data    (dict): {type: "same_product"|"alternative"|"none",
                             product: dict|None, savings_ngn: float}
            message (str):  Summary for the agent to read aloud.
    """
    product_id = (product_id or "").strip()
    if not product_id:
        return {
            "status": "error",
            "data":   {},
            "message": "A product_id is required to check for a cheaper option.",
        }

    state = (farmer_state or "").strip()
    if not state:
        state = (tool_context.state.get("farmer_state") or "").strip()
    if not state:
        return {
            "status": "error",
            "data":   {},
            "message": "I need your Nigerian state to check distributor pricing.",
        }

    try:
        # Step 1: exact same product, different distributor, lower price
        cheaper_row = _rpc_find_cheaper(product_id, state, current_price)
        if cheaper_row:
            savings = round(current_price - float(cheaper_row["price"]), 2)
            return {
                "status": "success",
                "data": {
                    "type":        "same_product",
                    "product_id":  product_id,
                    "price":       float(cheaper_row["price"]),
                    "savings_ngn": savings,
                    "distributor_id": str(cheaper_row.get("distributor_id", "")),
                },
                "message": (
                    f"I found the same product for ₦{cheaper_row['price']:,.2f} — "
                    f"that's ₦{savings:,.2f} cheaper than before."
                ),
            }

        # Step 2: look up the current product's category from last_search_results
        last_results: list[dict] = tool_context.state.get("last_search_results") or []
        category: Optional[str] = None
        for r in last_results:
            if r.get("product_id") == product_id:
                category = r.get("category")
                break

        # Step 3: alternative product — re-run search excluding current product
        query_vec = _embed_query(category or "veterinary medicine")
        alt_rows = _rpc_hybrid_search(
            query_text     = category or "veterinary medicine",
            query_vec      = query_vec,
            farmer_state   = state,
            result_limit   = 1,
            price_ceiling  = current_price,
            exclude_ids    = [product_id],
            category_filter= category,
        )

        if alt_rows:
            alt = _shape_result(alt_rows[0], rank=1)
            savings = round(current_price - alt["price"], 2)
            # Persist in last_search_results so the farmer can add it to cart
            tool_context.state["last_search_results"] = [alt]
            return {
                "status": "success",
                "data": {
                    "type":        "alternative",
                    "product":     alt,
                    "savings_ngn": max(savings, 0.0),
                },
                "message": (
                    f"{alt['product_name']} at ₦{alt['price']:,.2f} is a good "
                    f"alternative — ₦{max(savings, 0.0):,.2f} cheaper."
                ),
            }

        return {
            "status": "success",
            "data":  {"type": "none"},
            "message": (
                "There is no cheaper option available in your area at the moment. "
                "The price I showed you is already the best available."
            ),
        }

    except Exception as exc:
        logger.error("find_cheaper_option error: %s", exc)
        return {
            "status": "error",
            "data":   {},
            "message": "I had trouble checking prices. Please try again.",
        }
