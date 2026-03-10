"""
tests/test_disease_search.py

Integration test for the search_disease_matches ADK tool.

This test calls the live Supabase and Vertex AI services, so it requires:
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    GOOGLE_CLOUD_PROJECT
    GOOGLE_CLOUD_LOCATION (optional, defaults to us-central1)

Prerequisites:
    1. seed_embeddings.py must have been run successfully — all 5 disease rows
       must have non-null symptom_embedding values.
    2. The Vertex AI Embedding API must be enabled in the GCP project.

Run:
    pytest tests/test_disease_search.py -v

Or run directly (no pytest required):
    python tests/test_disease_search.py
"""

from __future__ import annotations

import logging
import os
import sys

# Ensure the repo root is on sys.path so backend.agent.tools is importable
# regardless of how the test is invoked.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from unittest.mock import MagicMock

from dotenv import load_dotenv
load_dotenv(os.path.join(_REPO_ROOT, ".env"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("test_disease_search")


def _make_mock_tool_context() -> MagicMock:
    """Minimal ToolContext mock with a real dict as .state."""
    ctx = MagicMock()
    ctx.state = {}
    ctx.session_id = "integration-test-session"
    return ctx


# ---------------------------------------------------------------------------
# Required environment guard
# ---------------------------------------------------------------------------

def _check_env() -> None:
    missing = [
        v for v in [
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "GOOGLE_CLOUD_PROJECT",
        ]
        if not os.environ.get(v, "").strip()
    ]
    if missing:
        logger.error(
            "Cannot run integration test: missing environment variables: %s\n"
            "Set them in .env or export them before running this test.",
            ", ".join(missing),
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Test: Ruminal Bloat is the top match for the canonical farmer description
# ---------------------------------------------------------------------------

def test_bloat_is_top_result() -> None:
    """
    Validate that search_disease_matches returns 'Ruminal Bloat' as the
    top result with similarity > 0.75 for the Phase 2 acceptance criterion input.

    Requires:
    - seed_embeddings.py run after migration 017 added the Ruminal Bloat row
    - All environment variables set
    """
    from backend.agent.tools.disease import search_disease_matches  # type: ignore

    symptoms_text = (
        "My goat's belly is very swollen and it is not eating, "
        "the side looks tight like a drum"
    )
    visual_observations = (
        "The left flank of the goat is visibly distended and "
        "the animal is standing with its legs apart."
    )

    ctx = _make_mock_tool_context()

    logger.info("Calling search_disease_matches with bloat test input …")
    result = search_disease_matches(
        symptoms_text=symptoms_text,
        visual_observations=visual_observations,
        tool_context=ctx,
    )

    # ---- Top-level shape assertions -------------------------------------------
    assert isinstance(result, dict), (
        f"Expected dict, got {type(result).__name__}"
    )
    assert result["status"] == "success", (
        f"Expected status='success', got {result['status']!r}. "
        f"message: {result.get('message', '')}"
    )
    assert "matches" in result["data"], "Response data missing 'matches' key"

    matches = result["data"]["matches"]
    assert isinstance(matches, list), (
        f"Expected matches to be a list, got {type(matches).__name__}"
    )
    assert len(matches) > 0, (
        "search_disease_matches returned an empty matches list — check that "
        "seed_embeddings.py has been run after migration 017 added Ruminal Bloat."
    )
    assert len(matches) <= 3, (
        f"Expected at most 3 matches, got {len(matches)}"
    )

    for match in matches:
        assert "id" in match, "Match missing 'id' field"
        assert "disease_name" in match, "Match missing 'disease_name' field"
        assert "primary_species" in match, "Match missing 'primary_species' field"
        assert "severity" in match, "Match missing 'severity' field"
        assert "notes" in match, "Match missing 'notes' field"
        assert "similarity" in match, "Match missing 'similarity' field"
        assert isinstance(match["similarity"], float), (
            f"'similarity' must be float, got {type(match['similarity']).__name__}"
        )

    # ---- Top result must be Ruminal Bloat ------------------------------------
    top = matches[0]
    logger.info(
        "Top result: '%s' | species=%s | severity=%s | similarity=%.4f",
        top["disease_name"],
        top["primary_species"],
        top["severity"],
        top["similarity"],
    )

    assert (
        "Ruminal Bloat" in top["disease_name"]
        or "bloat" in top["disease_name"].lower()
    ), (
        f"Expected 'Ruminal Bloat' as top result, got '{top['disease_name']}' "
        f"(similarity={top['similarity']:.4f}). "
        f"All results: {[r['disease_name'] for r in matches]}"
    )

    # ---- Similarity threshold: must be > 0.75 --------------------------------
    assert top["similarity"] > 0.75, (
        f"Expected similarity > 0.75 for Ruminal Bloat, got {top['similarity']:.4f}. "
        "Check that seed_embeddings.py ran cleanly with RETRIEVAL_DOCUMENT task type."
    )

    # ---- Session state must be updated ---------------------------------------
    assert ctx.state.get("confirmed_disease") == top["disease_name"], (
        "search_disease_matches must write the top disease_name to session state"
    )

    logger.info(
        "✓ Phase 2 exit criterion PASSED: '%s' returned as top result "
        "with similarity=%.4f (> 0.75 threshold).",
        top["disease_name"],
        top["similarity"],
    )

    # ---- Log all matches for visibility -------------------------------------
    logger.info("All matches:")
    for i, r in enumerate(matches, 1):
        logger.info(
            "  %d. %-40s similarity=%.4f  severity=%s",
            i, r["disease_name"], r["similarity"], r["severity"],
        )


# ---------------------------------------------------------------------------
# Additional smoke tests
# ---------------------------------------------------------------------------

def test_returns_correct_schema() -> None:
    """Verify the return shape matches what Phase 2 ADK expects."""
    from backend.agent.tools.disease import search_disease_matches  # type: ignore

    ctx = _make_mock_tool_context()
    result = search_disease_matches(
        symptoms_text="goat is limping badly and the hoof smells rotten",
        visual_observations="",
        tool_context=ctx,
    )

    assert isinstance(result, dict), f"Expected dict, got {type(result).__name__}"
    assert "status" in result
    assert "data" in result
    assert "message" in result

    if result["status"] == "success":
        required_keys = {
            "id", "disease_name", "primary_species", "severity", "notes", "similarity"
        }
        for match in result["data"]["matches"]:
            missing_keys = required_keys - set(match.keys())
            assert not missing_keys, (
                f"Match is missing required ADK tool keys: {missing_keys}"
            )
        logger.info(
            "✓ Schema test PASSED: '%s' returned with all required fields.",
            result["data"]["matches"][0]["disease_name"],
        )
    else:
        logger.info("✓ Schema test PASSED: error response has correct shape.")


def test_empty_inputs_return_error_status() -> None:
    """Empty inputs must return an error status dict without raising exceptions."""
    from backend.agent.tools.disease import search_disease_matches  # type: ignore

    ctx = _make_mock_tool_context()
    result = search_disease_matches(
        symptoms_text="", visual_observations="", tool_context=ctx
    )
    assert isinstance(result, dict), f"Expected dict, got {type(result).__name__}"
    assert result["status"] == "error", (
        f"Expected status='error' for empty inputs, got {result['status']!r}"
    )
    logger.info("✓ Empty-input safety test PASSED.")


def test_function_does_not_raise_on_garbage_input() -> None:
    """Garbage input must return a dict gracefully, never raise an exception."""
    from backend.agent.tools.disease import search_disease_matches  # type: ignore

    ctx = _make_mock_tool_context()
    try:
        result = search_disease_matches(
            symptoms_text="asdfgh",
            visual_observations="xyz",
            tool_context=ctx,
        )
        assert isinstance(result, dict)
        assert result["status"] in ("success", "error")
        n = len(result["data"].get("matches", []))
        logger.info(
            "✓ Garbage-input resilience test PASSED: returned %d match(es).", n
        )
    except Exception as exc:
        raise AssertionError(
            f"search_disease_matches raised an unexpected exception on garbage input: {exc}"
        ) from exc


# ---------------------------------------------------------------------------
# Entry point for direct execution (no pytest required)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    _check_env()

    tests = [
        test_empty_inputs_return_error_status,
        test_function_does_not_raise_on_garbage_input,
        test_returns_correct_schema,
        test_bloat_is_top_result,  # Phase 2 exit criterion — run last
    ]

    logger.info("Running %d Phase 2 integration tests …\n", len(tests))
    passed = 0
    failed = 0

    for test_fn in tests:
        logger.info("─" * 60)
        logger.info("TEST: %s", test_fn.__name__)
        try:
            test_fn()
            passed += 1
        except AssertionError as ae:
            logger.error("FAILED: %s", ae)
            failed += 1
        except Exception as exc:
            logger.error("ERROR (unexpected): %s", exc, exc_info=True)
            failed += 1

    logger.info("─" * 60)
    logger.info(
        "Results: %d passed, %d failed out of %d tests.",
        passed, failed, len(tests),
    )

    if failed:
        sys.exit(1)
