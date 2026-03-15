"""
backend/agent/tools/disease.py

ADK tool: search_disease_matches

Embeds the farmer's symptom description + visual observations using the
Vertex AI gemini-embedding-001 model (task_type=RETRIEVAL_QUERY, 3072 dims),
then runs a cosine-similarity search against the disease_content table in
Supabase using pgvector's <=> operator.

Returns the top-3 most semantically relevant goat/livestock conditions.

This module is designed to be imported directly by the ADK agent definition
(Phase 2) with zero interface changes. It has no global side effects on import.

Environment variables required:
    SUPABASE_URL              – https://<ref>.supabase.co
    SUPABASE_ANON_KEY         – Anon key (read access to disease_content)
    GOOGLE_CLOUD_PROJECT      – GCP project ID
    GOOGLE_CLOUD_LOCATION     – GCP region (default: us-central1)
"""

from __future__ import annotations

import logging
import os
import time
from functools import lru_cache
from typing import Any, cast

from google.adk.tools.tool_context import ToolContext
from google import genai as _genai
from google.genai import types as _genai_types

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_EMBEDDING_MODEL_ID = "gemini-embedding-001"  # 3072-dim native; supports up to 3072 via Matryoshka
_EMBEDDING_DIMENSIONS = 3072
_TOP_K = 3
_RETRY_ATTEMPTS = 3
_RETRY_DELAY = 4  # seconds between Vertex AI retry attempts


# ---------------------------------------------------------------------------
# Lazy singleton clients
# Clients are initialised on first call so the module can be imported without
# any credentials present (e.g. during unit-test mocking or linting).
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


@lru_cache(maxsize=1)
def _get_genai_client() -> _genai.Client:
    """Return a cached google.genai Client configured for Vertex AI."""
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1").strip()
    if not project:
        raise EnvironmentError("GOOGLE_CLOUD_PROJECT must be set.")
    return _genai.Client(vertexai=True, project=project, location=location)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _embed_query(text: str) -> list[float]:
    """
    Convert the farmer's combined input text into a query embedding.

    Uses task_type=RETRIEVAL_QUERY (optimised for similarity retrieval against
    RETRIEVAL_DOCUMENT vectors stored in the database).

    Args:
        text: Combined symptom description + visual observations.

    Returns:
        List of floats with length _EMBEDDING_DIMENSIONS.

    Raises:
        RuntimeError: after all retry attempts are exhausted.
    """
    client = _get_genai_client()
    config = _genai_types.EmbedContentConfig(
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
                    f"All {_RETRY_ATTEMPTS} embedding attempts failed"
                ) from exc
    raise RuntimeError(f"No embedding attempts were made (_RETRY_ATTEMPTS={_RETRY_ATTEMPTS})")


def _cosine_similarity_query(query_vec: list[float]) -> list[dict[str, Any]]:
    """
    Run pgvector cosine-similarity search against disease_content.symptom_embedding
    via the match_disease Supabase RPC function.

    Args:
        query_vec: Query embedding vector of length _EMBEDDING_DIMENSIONS.

    Returns:
        List of up to _TOP_K dicts with keys:
            id, disease_name, primary_species, risk_level,
            first_aid_notes, red_flag_notes, symptoms_text,
            visual_observations, non_visual_symptoms, treatment_text, similarity
    """
    db = _get_supabase_client()

    # Supabase PostgREST accepts the vector column argument as a string in the
    # standard pgvector literal format: '[0.1,0.2,...]'
    vec_literal = "[" + ",".join(str(round(v, 8)) for v in query_vec) + "]"

    # The match_disease function signature (migration fix_match_disease_parameter_ambiguity):
    #   match_disease(query_embedding vector, match_count int, match_threshold float8)
    # NOTE: parameter was renamed from 'symptom_embedding' to 'query_embedding' to prevent
    # PostgreSQL from shadowing the parameter with the same-named table column inside the
    # SQL function body, which previously caused every row to score similarity=1.0.
    result = db.rpc(
        "match_disease",
        {
            "query_embedding": vec_literal,
            "match_count": _TOP_K,
            "match_threshold": 0.5,  # Low floor so we always get results even for edge cases
        },
    ).execute()

    raw_data = result.data
    if not isinstance(raw_data, list):
        return []
    return cast(list[dict[str, Any]], raw_data)


def _raw_similarity_query(query_vec: list[float]) -> list[dict[str, Any]]:
    """
    Fallback: perform a table scan with cosine distance ordering via the
    Supabase Python client filter/order API.

    This is used when the match_disease RPC call fails unexpectedly. It fetches
    all rows with non-null symptom_embedding and performs client-side ranking.
    Inefficient at scale but safe for up to ~100 disease rows in the MVP.

    Args:
        query_vec: Query embedding vector.

    Returns:
        List of up to _TOP_K result dicts.
    """
    import math

    db = _get_supabase_client()

    response = db.table("disease_content").select(
        "id, disease_name, primary_species, risk_level, "
        "first_aid_notes, red_flag_notes, symptoms_text, "
        "visual_observations, non_visual_symptoms, treatment_text, "
        "symptom_embedding"
    ).not_.is_("symptom_embedding", "null").execute()

    raw_rows = response.data
    if not isinstance(raw_rows, list) or not raw_rows:
        return []
    rows: list[Any] = raw_rows

    def _cosine_sim(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        mag_a = math.sqrt(sum(x * x for x in a))
        mag_b = math.sqrt(sum(x * x for x in b))
        if mag_a == 0 or mag_b == 0:
            return 0.0
        return dot / (mag_a * mag_b)

    scored = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        row: dict[str, Any] = item
        stored_vec = row.get("symptom_embedding")
        if not stored_vec:
            continue
        # Supabase returns vector columns as a list of floats in Python client v2
        if isinstance(stored_vec, str):
            stored_vec = [float(x) for x in stored_vec.strip("[]").split(",")]
        if not isinstance(stored_vec, list):
            continue
        sim = _cosine_sim(query_vec, stored_vec)
        scored.append({**row, "similarity": sim})

    scored.sort(key=lambda r: r["similarity"], reverse=True)
    return scored[:_TOP_K]


# ---------------------------------------------------------------------------
# Public ADK tool function
# ---------------------------------------------------------------------------

def search_disease_matches(
    symptoms_text: str,
    visual_observations: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """
    Search the disease_content table for livestock conditions that best match
    the farmer's described symptoms and visual observations.

    Embeds the combined input text using Vertex AI (task_type=RETRIEVAL_QUERY)
    and runs a cosine-similarity search against the symptom_embedding column
    in Supabase using the match_disease RPC function (pgvector). Updates
    session state with the top match so subsequent tools can use it without
    re-querying.

    Args:
        symptoms_text:
            The farmer's spoken or typed description in plain language
            (e.g. "My goat belly is very big and tight on the left side,
            the animal is not eating and keeps crying").
        visual_observations:
            Camera-frame observations generated by Gemini visual reasoning
            (e.g. "The left flank is visibly distended and the animal is
            standing with legs apart"). Pass an empty string if unavailable.

    Returns:
        A dict with keys:
            status (str): "success" or "error"
            data (dict): On success, contains "matches" — a list of up to 3
                dicts each with: id, disease_name, primary_species, severity,
                notes, similarity.
            message (str): Human-readable summary or error description.
    """
    if not symptoms_text and not visual_observations:
        logger.warning("search_disease_matches called with empty inputs")
        return {
            "status": "error",
            "data": {"matches": []},
            "message": (
                "Please describe what you are observing in the animal before "
                "I can search for matching conditions."
            ),
        }

    # Combine both sources into one query text.
    parts = []
    if symptoms_text:
        parts.append(symptoms_text.strip())
    if visual_observations:
        parts.append(f"Visual signs: {visual_observations.strip()}")
    combined_input = " ".join(parts)

    logger.info(
        "search_disease_matches: embedding combined input (%d chars)", len(combined_input)
    )

    # Step 1: embed the query
    try:
        query_vec = _embed_query(combined_input)
    except RuntimeError as exc:
        logger.warning("search_disease_matches: embedding failed – %s", exc)
        return {
            "status": "error",
            "data": {"matches": []},
            "message": "Condition search is temporarily unavailable. Please try again.",
        }

    logger.info(
        "search_disease_matches: query embedding ready (%d dims) – querying Supabase",
        len(query_vec),
    )

    # Step 2: similarity search – try the RPC first, fall back to client-side ranking
    raw_results: list[dict[str, Any]] = []
    try:
        raw_results = _cosine_similarity_query(query_vec)
    except Exception as rpc_exc:
        logger.warning(
            "search_disease_matches: match_disease RPC failed (%s) – "
            "attempting raw query fallback",
            rpc_exc,
        )
        try:
            raw_results = _raw_similarity_query(query_vec)
        except Exception as sql_exc:
            logger.warning(
                "search_disease_matches: raw fallback also failed (%s)",
                sql_exc,
            )
            return {
                "status": "error",
                "data": {"matches": []},
                "message": "Condition search is temporarily unavailable. Please try again.",
            }

    if not raw_results:
        logger.warning(
            "search_disease_matches: no results returned – check that "
            "symptom_embedding is populated in disease_content"
        )
        return {
            "status": "error",
            "data": {"matches": []},
            "message": (
                "I could not find a matching condition in my database. Please "
                "describe the symptoms in more detail."
            ),
        }

    # Step 3: normalise output shape
    matches: list[dict[str, Any]] = []
    for row in raw_results:
        similarity = float(row.get("similarity", 0.0))

        first_aid = (row.get("first_aid_notes") or "").strip()
        red_flag = (row.get("red_flag_notes") or "").strip()
        notes_parts = []
        if first_aid:
            notes_parts.append(f"First aid: {first_aid}")
        if red_flag:
            notes_parts.append(f"Red flags: {red_flag}")
        notes = "\n\n".join(notes_parts)

        matches.append(
            {
                "id": str(row.get("id", "")),
                "disease_name": str(row.get("disease_name", "")),
                "primary_species": str(row.get("primary_species", "")),
                "severity": str(row.get("risk_level", "medium")),
                "notes": notes,
                # Differential diagnosis fields — agent uses these to ask
                # targeted follow-up questions when multiple matches are close.
                "key_symptoms": str(row.get("symptoms_text") or ""),
                "visual_observations": str(row.get("visual_observations") or ""),
                "non_visual_symptoms": str(row.get("non_visual_symptoms") or ""),
                "typical_management": str(row.get("treatment_text") or ""),
                "similarity": round(similarity, 6),
            }
        )

    # Step 4: persist top match to session state so other tools can use it
    if matches:
        top = matches[0]
        tool_context.state["confirmed_disease"] = top["disease_name"]
        tool_context.state["confirmed_disease_id"] = top["id"]
        tool_context.state["confirmed_disease_severity"] = top["severity"]
        tool_context.state["active_species"] = top["primary_species"]
        logger.info(
            "search_disease_matches: session state updated – confirmed_disease='%s' "
            "severity='%s' (similarity=%.4f)",
            top["disease_name"],
            top["severity"],
            top["similarity"],
        )

    top_similarity = matches[0]["similarity"] if matches else 0.0

    logger.info(
        "search_disease_matches: returning %d match(es). Top: '%s' (similarity=%.4f)",
        len(matches),
        matches[0]["disease_name"] if matches else "—",
        top_similarity,
    )

    # ---------------------------------------------------------------------------
    # Confidence gate — low_confidence flag guards against hallucination.
    # The agent reads this flag and follows the system-prompt rule to tell the
    # user it is not certain and advise them to consult a licensed vet.
    # ---------------------------------------------------------------------------
    _CONFIDENCE_THRESHOLD = 0.7
    low_confidence = top_similarity < _CONFIDENCE_THRESHOLD

    # ---------------------------------------------------------------------------
    # Differential gate — needs_clarification flag fires when the top two matches
    # are too close to call confidently (spread < 0.08).  The agent must ask at
    # least one targeted follow-up question before presenting a diagnosis.
    # ---------------------------------------------------------------------------
    _SPREAD_THRESHOLD = 0.08
    needs_clarification = (
        len(matches) >= 2
        and (matches[0]["similarity"] - matches[1]["similarity"]) < _SPREAD_THRESHOLD
    )

    if needs_clarification:
        logger.info(
            "search_disease_matches: differential gap too narrow "
            "(%.4f vs %.4f, spread=%.4f) – asking for clarification",
            matches[0]["similarity"],
            matches[1]["similarity"],
            matches[0]["similarity"] - matches[1]["similarity"],
        )

    if low_confidence:
        logger.warning(
            "search_disease_matches: low confidence (top similarity=%.4f < %.2f) – "
            "advising vet consultation",
            top_similarity,
            _CONFIDENCE_THRESHOLD,
        )
        return {
            "status": "success",
            "data": {
                "matches": matches,
                "low_confidence": True,
                "needs_clarification": needs_clarification,
                "best_guess": matches[0] if matches else None,
            },
            "message": (
                "No strong match found. "
                "Advise user to consult a licensed veterinarian immediately."
            ),
        }

    return {
        "status": "success",
        "data": {
            "matches": matches,
            "low_confidence": False,
            "needs_clarification": needs_clarification,
        },
        "message": (
            f"Found {len(matches)} possible condition(s). "
            f"Top match: {matches[0]['disease_name']} "
            f"(similarity {top_similarity:.2f})."
            + (" Ask a clarifying question before presenting a diagnosis."
               if needs_clarification else "")
        ),
    }
