"""
backend/main.py

Wafrivet Field Vet — Local ADK agent test runner (Phase 2).

Runs the golden path demo using InMemorySessionService and a text-based Runner.
This module is the Phase 2 entry point for verifying that the agent + all five
tools run end-to-end without errors before the Live API streaming layer is added
in Phase 3.

Usage:
    python backend/main.py

Prerequisites:
    - .env must be complete (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
      GOOGLE_CLOUD_PROJECT, GOOGLE_API_KEY, PAYSTACK_SECRET_KEY)
    - seed_embeddings.py must have been run so disease_content has embeddings
    - pip install -r backend/requirements.txt

Golden path:
    1. Farmer describes a goat with a swollen belly (triggers search_disease_matches)
    2. Farmer confirms their state as Rivers (triggers update_location)
    3. Agent recommends products (triggers recommend_products)
    4. Farmer adds the first product (triggers manage_cart)
    5. Farmer requests payment link (triggers generate_checkout_link)
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

# ---------------------------------------------------------------------------
# Bootstrap: ensure repo root is on sys.path and .env is loaded
# ---------------------------------------------------------------------------

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from dotenv import load_dotenv  # noqa: E402 — must run before ADK imports

load_dotenv(os.path.join(_REPO_ROOT, ".env"))

# ---------------------------------------------------------------------------
# ADK and agent imports (after env is loaded)
# ---------------------------------------------------------------------------

from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai.types import Content, Part  # noqa: E402

from backend.agent.agent import root_agent  # noqa: E402
from backend.agent.session import INITIAL_STATE  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("wafrivet.main")

# ---------------------------------------------------------------------------
# Golden path conversation turns
# ---------------------------------------------------------------------------

_TEST_PHONE = "+2348099887766"

_GOLDEN_PATH_TURNS = [
    # Turn 1 — farmer describes symptoms (triggers search_disease_matches)
    (
        "My goat belly is very swollen and tight on the left side. "
        "It is not eating and keeps crying. The side look like drum when I tap am."
    ),
    # Turn 2 — farmer provides location (triggers update_location)
    "I dey Rivers State.",
    # Turn 3 — farmer selects a product to add to cart (triggers manage_cart)
    "Abeg add the first product to my cart.",
    # Turn 4 — farmer requests payment (triggers generate_checkout_link)
    "I want to pay now.",
]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

async def run_golden_path() -> None:
    """Execute the four-turn golden path and print agent responses."""

    session_service = InMemorySessionService()
    runner = Runner(
        agent=root_agent,
        app_name="wafrivet",
        session_service=session_service,
    )

    # Create a session with pre-seeded farmer phone
    initial_state: dict = {**INITIAL_STATE, "farmer_phone": _TEST_PHONE}
    session = await session_service.create_session(
        app_name="wafrivet",
        user_id=_TEST_PHONE,
        state=initial_state,
    )

    print("\n" + "=" * 65)
    print("  WAFRIVET FIELD VET — GOLDEN PATH DEMO (Phase 2)")
    print("=" * 65 + "\n")

    for turn_num, turn_text in enumerate(_GOLDEN_PATH_TURNS, start=1):
        print(f"[Turn {turn_num}] Farmer: {turn_text}")

        user_message = Content(
            role="user",
            parts=[Part(text=turn_text)],
        )

        final_text: str | None = None
        async for event in runner.run_async(
            user_id=_TEST_PHONE,
            session_id=session.id,
            new_message=user_message,
        ):
            if event.is_final_response():
                if event.content and event.content.parts:
                    final_text = event.content.parts[0].text

        print(f"[Turn {turn_num}] Agent : {final_text or '(no response)'}")
        print()

    print("=" * 65)
    print("  Demo complete.")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Wafrivet Field Vet backend")
    parser.add_argument(
        "--mode",
        choices=["golden_path", "server"],
        default="server",
        help=(
            "golden_path — run the Phase 2 text demo (default on Phase 2 branch); "
            "server      — start the Phase 3 Live streaming FastAPI server (default)"
        ),
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (server mode)")
    parser.add_argument("--port", type=int, default=8000, help="Bind port (server mode)")
    args = parser.parse_args()

    if args.mode == "golden_path":
        asyncio.run(run_golden_path())
    else:
        import uvicorn
        uvicorn.run(
            "backend.streaming.server:app",
            host=args.host,
            port=args.port,
            reload=False,
            log_level="info",
        )
