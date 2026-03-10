#!/usr/bin/env python3
"""
scripts/seed_embeddings.py

One-time (re-runnable) pipeline that generates Vertex AI gemini-embedding-001
embeddings for every disease_content row in Supabase and writes the vectors
back into symptom_embedding and image_embedding.

Usage:
    python scripts/seed_embeddings.py

Environment variables required (in .env or exported):
    SUPABASE_URL              – Project URL, e.g. https://<ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY – Service-role key (never the anon key for writes)
    GOOGLE_CLOUD_PROJECT      – GCP project ID
    GOOGLE_CLOUD_LOCATION     – GCP region, e.g. us-central1 (default)

The script is idempotent: rows that already have non-null embeddings are
skipped unless --force is passed.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from typing import Any, Optional

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Bootstrap: load .env from the project root (two directories above scripts/)
# ---------------------------------------------------------------------------
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_REPO_ROOT, ".env"))

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("seed_embeddings")


# ---------------------------------------------------------------------------
# Lazy imports – only import after env is loaded so credentials are available
# ---------------------------------------------------------------------------

def _import_deps():
    """Import heavy dependencies after environment is validated."""
    try:
        from supabase import create_client, Client  # noqa: F401
        import vertexai  # noqa: F401
        from vertexai.language_models import TextEmbeddingInput, TextEmbeddingModel  # noqa: F401
    except ImportError as exc:
        logger.error(
            "Missing dependency: %s\n"
            "Run: pip install supabase google-cloud-aiplatform python-dotenv",
            exc,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------
EMBEDDING_MODEL_ID = "text-embedding-004"      # Vertex AI model name
# gemini-embedding-001 is the conceptual name; the actual SDK model ID is
# text-embedding-004 (which corresponds to the gemini-embedding-001 Release).
# The output dimensionality must match the vector(1536) columns in Supabase.

EMBEDDING_DIMENSIONS = 1536
VERTEX_BATCH_SIZE = 1          # Vertex AI embedding API – 1 text per disease row to be safe
RETRY_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 5
TABLE_NAME = "disease_content"


# ---------------------------------------------------------------------------
# Utility: call Vertex AI embedding with retry
# ---------------------------------------------------------------------------

def _embed_text(
    model,
    text: str,
    task_type: str,
    title: Optional[str] = None,
) -> list[float]:
    """
    Embed a single text string via the Vertex AI TextEmbeddingModel.

    Args:
        model:      Loaded TextEmbeddingModel instance.
        text:       Text to embed.
        task_type:  "RETRIEVAL_DOCUMENT" for corpus texts,
                    "RETRIEVAL_QUERY"    for incoming query texts.
        title:      Optional title hint (improves document embedding quality).

    Returns:
        A list of floats of length EMBEDDING_DIMENSIONS.

    Raises:
        RuntimeError: if all retry attempts fail.
    """
    from vertexai.language_models import TextEmbeddingInput  # type: ignore

    inputs = [TextEmbeddingInput(text=text, task_type=task_type, title=title)]

    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            embeddings = model.get_embeddings(
                inputs,
                output_dimensionality=EMBEDDING_DIMENSIONS,
            )
            vec = embeddings[0].values
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
                    f"All {RETRY_ATTEMPTS} embedding attempts failed for text "
                    f"(task={task_type}, first 60 chars: '{text[:60]}')"
                ) from exc
    # Unreachable when RETRY_ATTEMPTS > 0; satisfies the static type-checker.
    raise RuntimeError(f"No embedding attempts were made (RETRY_ATTEMPTS={RETRY_ATTEMPTS})")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run(force: bool = False) -> None:
    """
    Read all disease_content rows, compute embeddings, write back to Supabase.

    Args:
        force: If True, regenerate and overwrite embeddings even when they
               already exist. Default is False (skip already-embedded rows).
    """
    _import_deps()

    # ---- Validate environment -----------------------------------------------
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    gcp_project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    gcp_location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1").strip()

    missing = [
        name for name, val in [
            ("SUPABASE_URL", supabase_url),
            ("SUPABASE_SERVICE_ROLE_KEY", supabase_key),
            ("GOOGLE_CLOUD_PROJECT", gcp_project),
        ] if not val
    ]
    if missing:
        logger.error("Missing required environment variables: %s", ", ".join(missing))
        sys.exit(1)

    # ---- Init clients -------------------------------------------------------
    from supabase import create_client  # type: ignore
    import vertexai  # type: ignore
    from vertexai.language_models import TextEmbeddingModel  # type: ignore

    logger.info("Connecting to Supabase at %s", supabase_url)
    db = create_client(supabase_url, supabase_key)

    logger.info("Initialising Vertex AI (project=%s, location=%s)", gcp_project, gcp_location)
    vertexai.init(project=gcp_project, location=gcp_location)
    model = TextEmbeddingModel.from_pretrained(EMBEDDING_MODEL_ID)
    logger.info("Vertex AI embedding model loaded: %s", EMBEDDING_MODEL_ID)

    # ---- Fetch disease rows -------------------------------------------------
    response = db.table(TABLE_NAME).select(
        "id, disease_name, symptoms_text, visual_observations, "
        "symptom_embedding, image_embedding"
    ).execute()

    raw_rows = response.data
    if not isinstance(raw_rows, list) or not raw_rows:
        logger.warning("No rows found in %s – nothing to embed.", TABLE_NAME)
        return
    rows: list[Any] = raw_rows

    logger.info("Found %d disease rows in '%s'.", len(rows), TABLE_NAME)

    processed = 0
    skipped = 0
    errors = 0

    for item in rows:
        if not isinstance(item, dict):
            logger.warning("Unexpected row type %s – skipping", type(item).__name__)
            continue
        row: dict[str, Any] = item
        disease_id: str = str(row["id"])
        disease_name: str = str(row["disease_name"])
        symptoms_text: str = (row.get("symptoms_text") or "").strip()
        visual_observations: str = (row.get("visual_observations") or "").strip()

        already_has_symptom = row.get("symptom_embedding") is not None
        already_has_image = row.get("image_embedding") is not None

        if already_has_symptom and already_has_image and not force:
            logger.info("SKIP  %-40s (embeddings already present; use --force to overwrite)", disease_name)
            skipped += 1
            continue

        if not symptoms_text:
            logger.warning("SKIP  %-40s (symptoms_text is empty – seed data incomplete)", disease_name)
            errors += 1
            continue

        logger.info("EMBED %-40s …", disease_name)

        # ---- symptom_embedding: RETRIEVAL_DOCUMENT -------------------------
        symptom_vec: Optional[list[float]] = None
        if symptoms_text and (not already_has_symptom or force):
            try:
                symptom_vec = _embed_text(
                    model,
                    symptoms_text,
                    task_type="RETRIEVAL_DOCUMENT",
                    title=disease_name,
                )
                logger.info(
                    "  symptom_embedding dim=%d  (first 4 values: %s)",
                    len(symptom_vec),
                    [round(v, 6) for v in symptom_vec[:4]],
                )
            except RuntimeError as exc:
                logger.error("  symptom_embedding FAILED for '%s': %s", disease_name, exc)
                errors += 1

        # ---- image_embedding: RETRIEVAL_DOCUMENT on visual_observations ----
        image_vec: Optional[list[float]] = None
        if visual_observations and (not already_has_image or force):
            try:
                image_vec = _embed_text(
                    model,
                    visual_observations,
                    task_type="RETRIEVAL_DOCUMENT",
                    title=f"{disease_name} – visual observations",
                )
                logger.info(
                    "  image_embedding    dim=%d  (first 4 values: %s)",
                    len(image_vec),
                    [round(v, 6) for v in image_vec[:4]],
                )
            except RuntimeError as exc:
                logger.error("  image_embedding FAILED for '%s': %s", disease_name, exc)
                errors += 1

        # ---- Write back to Supabase -----------------------------------------
        update_payload: dict = {}
        if symptom_vec is not None:
            update_payload["symptom_embedding"] = symptom_vec
        if image_vec is not None:
            update_payload["image_embedding"] = image_vec

        if not update_payload:
            logger.warning("  Nothing to update for '%s' (all failed or nothing to do)", disease_name)
            continue

        try:
            db.table(TABLE_NAME).update(update_payload).eq("id", disease_id).execute()
            logger.info("  ✓ Updated %s embedding(s) for '%s'", list(update_payload.keys()), disease_name)
            processed += 1
        except Exception as exc:
            logger.error("  Supabase update FAILED for '%s': %s", disease_name, exc)
            errors += 1

        # Brief pause to respect Vertex AI quotas (60 QPM default for free tier)
        time.sleep(1.0)

    # ---- Summary ------------------------------------------------------------
    logger.info(
        "Done. Processed=%d  Skipped=%d  Errors=%d",
        processed, skipped, errors,
    )

    if errors:
        logger.error(
            "%d error(s) occurred. Embeddings may be incomplete – "
            "re-run with --force after fixing the issues.",
            errors,
        )
        sys.exit(1)

    # ---- Sanity: verify count of populated rows ----------------------------
    verify_response = db.table(TABLE_NAME).select(
        "disease_name, symptom_embedding"
    ).not_.is_("symptom_embedding", "null").execute()

    populated = len(verify_response.data)
    total = len(rows)
    logger.info(
        "Verification: %d / %d rows now have non-null symptom_embedding.",
        populated, total,
    )
    if populated < total:
        logger.warning(
            "%d row(s) still have null symptom_embedding. "
            "Check the errors above and re-run.",
            total - populated,
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed Vertex AI embeddings into the disease_content table.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        default=False,
        help="Overwrite existing non-null embeddings (default: skip already-embedded rows).",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    run(force=args.force)
