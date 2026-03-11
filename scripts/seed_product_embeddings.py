#!/usr/bin/env python3
"""
scripts/seed_product_embeddings.py

Idempotent embedding backfill for the products table.

Iterates over active products with a NULL embedding column and generates
1536-dimension Vertex AI embeddings using gemini-embedding-001 with
task_type=RETRIEVAL_DOCUMENT. The source text is a concatenation of:
    name + " " + category + " " + description + " " + dosage_notes

Matching the hybrid_search_products RPC which queries with 1536-dim
RETRIEVAL_QUERY embeddings via the <=> cosine distance operator.

Usage:
    python scripts/seed_product_embeddings.py
    python scripts/seed_product_embeddings.py --force   # Re-embed all rows

Environment variables (in .env or exported):
    SUPABASE_URL              – Project URL
    SUPABASE_SERVICE_ROLE_KEY – Service-role key
    GOOGLE_CLOUD_PROJECT      – GCP project ID
    GOOGLE_CLOUD_LOCATION     – GCP region (default: us-central1)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from typing import Any, Optional

from dotenv import load_dotenv

# Bootstrap: load .env from project root (two dirs above scripts/)
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_REPO_ROOT, ".env"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("seed_product_embeddings")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
EMBEDDING_MODEL_ID = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 1536          # Must match products.embedding vector(1536)
RETRY_ATTEMPTS = 5
RETRY_DELAY_SECONDS = 15             # Avoid Vertex AI quota errors on free tier


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------

def _embed_document(client: Any, text: str, title: Optional[str] = None) -> list[float]:
    """
    Embed a single document text using RETRIEVAL_DOCUMENT task type.

    Args:
        client: Initialised google.genai.Client for Vertex AI.
        text:   Concatenated product fields to embed.
        title:  Optional title hint (product name) to improve embedding quality.

    Returns:
        List of floats of length EMBEDDING_DIMENSIONS.

    Raises:
        RuntimeError: if all retry attempts fail.
    """
    from google.genai import types as genai_types  # type: ignore

    config = genai_types.EmbedContentConfig(
        task_type="RETRIEVAL_DOCUMENT",
        title=title,
        output_dimensionality=EMBEDDING_DIMENSIONS,
    )

    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            result = client.models.embed_content(
                model=EMBEDDING_MODEL_ID,
                contents=[text],
                config=config,
            )
            vec: list[float] = result.embeddings[0].values  # type: ignore[index]
            if len(vec) != EMBEDDING_DIMENSIONS:
                raise ValueError(
                    f"Expected {EMBEDDING_DIMENSIONS} dims, got {len(vec)}"
                )
            return vec
        except Exception as exc:
            if attempt < RETRY_ATTEMPTS:
                logger.warning(
                    "Embedding attempt %d/%d failed: %s – retrying in %ds",
                    attempt, RETRY_ATTEMPTS, exc, RETRY_DELAY_SECONDS,
                )
                time.sleep(RETRY_DELAY_SECONDS)
            else:
                raise RuntimeError(
                    f"All {RETRY_ATTEMPTS} embedding attempts failed for product "
                    f"(first 60 chars: '{text[:60]}')"
                ) from exc
    raise RuntimeError("Embedding loop exited without result")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run(force: bool = False) -> None:
    """
    Run the embedding backfill.

    Args:
        force: If True, re-embed all active products regardless of whether
               they already have an embedding. Default is False (skip rows
               where embedding IS NOT NULL).
    """
    # Validate environment
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1").strip()

    missing = [k for k, v in {
        "SUPABASE_URL": url,
        "SUPABASE_SERVICE_ROLE_KEY": key,
        "GOOGLE_CLOUD_PROJECT": project,
    }.items() if not v]

    if missing:
        logger.error("Missing required environment variables: %s", ", ".join(missing))
        sys.exit(1)

    # Import heavy dependencies after env validation
    try:
        from supabase import create_client, Client  # type: ignore  # noqa: F401
        from google import genai  # type: ignore
    except ImportError as exc:
        logger.error(
            "Missing dependency: %s\nRun: pip install supabase google-genai python-dotenv",
            exc,
        )
        sys.exit(1)

    db: Any = create_client(url, key)
    genai_client: Any = genai.Client(vertexai=True, project=project, location=location)

    logger.info(
        "Starting product embedding backfill (model=%s, dims=%d, force=%s)",
        EMBEDDING_MODEL_ID, EMBEDDING_DIMENSIONS, force,
    )

    # Fetch products needing embedding
    query = db.table("products").select(
        "id, name, category, description, dosage_notes"
    ).eq("is_active", True)

    if not force:
        query = query.is_("embedding", "null")

    response = query.execute()
    rows: list[dict[str, Any]] = getattr(response, "data", None) or []

    if not rows:
        logger.info("No products require embedding. All up to date.")
        return

    logger.info("Products to embed: %d", len(rows))
    success_count = 0
    error_count = 0

    for i, row in enumerate(rows, start=1):
        product_id   = row["id"]
        product_name = row.get("name", "")
        category     = row.get("category", "")
        description  = row.get("description", "")
        dosage_notes = row.get("dosage_notes", "")

        # Build document text: title-weighted by ordering name first
        doc_text = " ".join(filter(None, [
            product_name,
            category,
            description,
            dosage_notes,
        ]))

        logger.info("[%d/%d] Embedding: %s", i, len(rows), product_name)

        try:
            vec = _embed_document(genai_client, doc_text, title=product_name)
        except RuntimeError as exc:
            logger.error(
                "[%d/%d] FAILED to embed product %s (%s): %s",
                i, len(rows), product_name, product_id, exc,
            )
            error_count += 1
            continue

        # Format vector as pgvector literal string for the Supabase client
        vec_literal = "[" + ",".join(str(round(v, 8)) for v in vec) + "]"

        try:
            db.table("products").update(
                {"embedding": vec_literal}
            ).eq("id", product_id).execute()
            logger.info("[%d/%d] ✓ Upserted embedding for %s", i, len(rows), product_name)
            success_count += 1
        except Exception as exc:
            logger.error(
                "[%d/%d] FAILED to write embedding for %s: %s",
                i, len(rows), product_name, exc,
            )
            error_count += 1
            continue

        # Throttle to stay within Vertex AI free-tier quota (~5 RPM)
        if i < len(rows):
            time.sleep(RETRY_DELAY_SECONDS)

    logger.info(
        "Backfill complete. Success: %d  Errors: %d  Total: %d",
        success_count, error_count, len(rows),
    )
    if error_count > 0:
        logger.warning(
            "%d product(s) failed to embed. Re-run without --force to retry only failed rows.",
            error_count,
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Backfill Vertex AI embeddings for products in the Supabase catalogue. "
            "Safe to re-run — only processes rows with NULL embeddings by default."
        )
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-embed ALL active products, including those with existing embeddings.",
    )
    args = parser.parse_args()
    run(force=args.force)
