"""
backend/agent/tools/location.py

ADK tool: update_location

Validates and normalises the farmer's Nigerian state name, writes it to
session state, and returns a LOCATION_CONFIRMED event signal so the Phase 4
WebSocket bridge can broadcast the new location to the Next.js frontend.

Accepts common aliases and alternate spellings (e.g. "Abuja" → "FCT",
"crossriver" → "Cross River"). Returns an error with a helpful prompt if the
state cannot be recognised.

No external API calls or database writes — all logic is in-process.
"""

from __future__ import annotations

import logging
from typing import Any

from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Canonical Nigerian states + FCT
# Title-case, no "State" suffix — matches products.states_available values.
# ---------------------------------------------------------------------------

NIGERIAN_STATES: frozenset[str] = frozenset(
    {
        "Abia",
        "Adamawa",
        "Akwa Ibom",
        "Anambra",
        "Bauchi",
        "Bayelsa",
        "Benue",
        "Borno",
        "Cross River",
        "Delta",
        "Ebonyi",
        "Edo",
        "Ekiti",
        "Enugu",
        "FCT",          # Federal Capital Territory (Abuja)
        "Gombe",
        "Imo",
        "Jigawa",
        "Kaduna",
        "Kano",
        "Katsina",
        "Kebbi",
        "Kogi",
        "Kwara",
        "Lagos",
        "Nasarawa",
        "Niger",
        "Ogun",
        "Ondo",
        "Osun",
        "Oyo",
        "Plateau",
        "Rivers",
        "Sokoto",
        "Taraba",
        "Yobe",
        "Zamfara",
    }
)

# Aliases map lowercase input → canonical state name
_STATE_ALIASES: dict[str, str] = {
    # FCT / Abuja
    "abuja": "FCT",
    "fct": "FCT",
    "federal capital territory": "FCT",
    "federal capital": "FCT",
    # Two-word states that farmers commonly write without spaces
    "akwaibom": "Akwa Ibom",
    "akwa ibom state": "Akwa Ibom",
    "crossriver": "Cross River",
    "cross river state": "Cross River",
    # "State" suffix variants
    **{f"{s.lower()} state": s for s in NIGERIAN_STATES},
    # Plain lowercase matches
    **{s.lower(): s for s in NIGERIAN_STATES},
}


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _normalize_state(raw: str) -> str | None:
    """
    Attempt to resolve a raw state string to its canonical form.

    Tries in order:
      1. Direct match in NIGERIAN_STATES (after title-casing).
      2. Lookup in _STATE_ALIASES (after lowercasing and stripping whitespace).

    Returns the canonical state name or None if unrecognised.
    """
    cleaned = raw.strip()

    # Try title-case direct match first
    title_cased = cleaned.title()
    if title_cased in NIGERIAN_STATES:
        return title_cased

    # Alias lookup (lowercase, collapsed whitespace)
    key = " ".join(cleaned.lower().split())
    return _STATE_ALIASES.get(key)


# ---------------------------------------------------------------------------
# Public ADK tool function
# ---------------------------------------------------------------------------

def update_location(
    state: str,
    tool_context: ToolContext,
) -> dict[str, Any]:
    """
    Record the farmer's Nigerian state, validate it, and emit a location
    confirmed signal so the frontend location banner can be updated.

    Normalises common aliases and alternate spellings before writing to session
    state. Returns an error with a list of valid state names if the input is
    not recognised, giving the farmer a chance to correct it.

    Args:
        state:
            The farmer's Nigerian state name as spoken or typed. Common
            variants are accepted (e.g. "Abuja", "Cross Rivers", "rivers state",
            "Lagos"). FCT and Abuja are both mapped to "FCT".

    Returns:
        A dict with keys:
            status (str): "success" or "error"
            data (dict): On success, {"event": "LOCATION_CONFIRMED", "state": str}.
                The "event" field is used by the Phase 4 WebSocket bridge to
                determine which frontend message to broadcast.
            message (str): Confirmation or guidance message.
    """
    raw = (state or "").strip()

    if not raw:
        return {
            "status": "error",
            "data": {},
            "message": (
                "I need your Nigerian state to find products near you. "
                "Please tell me which state you are in."
            ),
        }

    canonical = _normalize_state(raw)

    if canonical is None:
        # Build a helpful suggestion: find states whose name starts with the
        # same letter as the farmer's input to guide them toward the right name.
        first_letter = raw[0].upper()
        suggestions = sorted(
            s for s in NIGERIAN_STATES if s.startswith(first_letter)
        )
        hint = (
            f"Did you mean one of these? {', '.join(suggestions)}"
            if suggestions
            else "Please use the standard Nigerian state name."
        )
        return {
            "status": "error",
            "data": {},
            "message": (
                f"I could not recognise '{raw}' as a Nigerian state. {hint}"
            ),
        }

    # Write to session state
    tool_context.state["farmer_state"] = canonical
    tool_context.state["location_source"] = "voice"

    logger.info(
        "update_location: state confirmed as '%s' (raw input: '%s')",
        canonical,
        raw,
    )

    return {
        "status": "success",
        "data": {
            "event": "LOCATION_CONFIRMED",
            "state": canonical,
        },
        "message": (
            f"Got it — you are in {canonical}. "
            "I will now look for products available there."
        ),
    }
