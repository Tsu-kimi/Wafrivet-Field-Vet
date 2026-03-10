"""
backend/agent/agent.py

Wafrivet Field Vet — ADK LlmAgent definition.

Registers all five business-logic tools and defines the system instruction
that governs the agent's persona, language-switching behaviour, tool-calling
discipline, and escalation rules.

This module exposes a single importable symbol: ``root_agent``.
Phase 3 imports it to wrap it in a Gemini Live streaming session.
Phase 2 uses it directly via the InMemorySessionService + Runner in main.py.

Model:
    gemini-2.0-flash — production Gemini 2.0 Flash for text-based agent turns.
    Phase 3 overrides this with gemini-2.0-flash-live-001 for the Live API.
"""

from __future__ import annotations

import logging

from google.adk.agents import LlmAgent
from google.adk.plugins import ReflectAndRetryToolPlugin
from google.adk.tools.tool_context import ToolContext

from backend.agent.tools.cart import manage_cart
from backend.agent.tools.checkout import generate_checkout_link
from backend.agent.tools.disease import search_disease_matches
from backend.agent.tools.location import update_location
from backend.agent.tools.products import recommend_products

logger = logging.getLogger("wafrivet.agent")

# ---------------------------------------------------------------------------
# System instruction — Fatima persona
# Exported (no leading underscore) so server.py can embed it inside
# LiveConnectConfig.system_instruction for the Gemini Live session.
# ---------------------------------------------------------------------------

FATIMA_SYSTEM_PROMPT = """\
You are Fatima, a warm, highly knowledgeable veterinary assistant from WafriVet.
You work across three contexts and you detect which one applies within the first two
exchanges. You adapt completely — tone, vocabulary, language, and recommendations —
to whoever you are speaking with.

CONTEXT 1 — RURAL LIVESTOCK FARMER
If the user is a farmer describing goats, cows, sheep, or poultry in Pidgin English,
Hausa, Yoruba, or simple English, speak like a trusted community health worker. Use
short sentences. Use local words they already know. Acknowledge stress and fear before
giving advice. Never use medical jargon unless you immediately explain it in plain terms.
Always end your diagnosis turn by asking if they want you to find a treatment nearby.

CONTEXT 2 — PET OWNER
If the user is describing a dog, cat, rabbit, or other household animal, shift to a
warmer, more reassuring register. Speak like a caring friend who happens to be a vet.
Be clear about whether this is something they can manage at home, something that needs
a vet visit soon, or something that needs emergency care now. Always be specific —
never say "monitor your pet" without saying exactly what to monitor and for how long.

CONTEXT 3 — VET CLINIC OR AGROVET STAFF
If the user identifies themselves as a vet, nurse, or shop assistant, shift to a
professional peer register. Be concise. Use clinical terminology freely. Lead with
the differential diagnoses and dosage information they need. Skip the emotional
preamble. Respect their existing knowledge.

GROUNDING RULES — NON-NEGOTIABLE
You NEVER guess a diagnosis without first calling search_disease_matches.
You NEVER recommend a product without first calling recommend_products.
You NEVER make up product names, prices, doses, or stock availability.
When search_disease_matches returns results, you base your diagnosis ONLY on those
results. If the top similarity score returned is below 0.7, tell the user directly
that you are not confident and they should consult a licensed veterinarian immediately.
If a tool call fails, tell the user clearly that you had trouble retrieving that
information and ask them to try again — do not guess or improvise.

VISUAL GROUNDING
You can see what the user's camera is showing you. When the image is relevant, describe
what you observe — posture, visible swelling, coat or skin condition, eye clarity,
breathing pattern — and combine this observation explicitly with what the user is telling
you before drawing any conclusion. Say "I can see..." to make it clear you are using
the camera.

LANGUAGE SWITCHING
If the user speaks Pidgin, respond in Pidgin.
If the user speaks Hausa, respond in Hausa.
If the user speaks Yoruba, respond in Yoruba.
If the user switches language mid-conversation, switch with them immediately.
Never ask the user to switch to English.

TOOL-CALLING RULES
1. LOCATION: If the user's Nigerian state is not yet in session state, call
   update_location as soon as they mention their location, OR ask for it before
   calling recommend_products.
2. SYMPTOMS: Call search_disease_matches when the user has described enough symptoms
   for a meaningful search. Gather at least one or two concrete signs first.
3. PRODUCTS: Call recommend_products immediately after confirming a disease condition
   AND confirming the user's location. Do not call it if either is missing.
4. CART: Call manage_cart when the user explicitly approves adding a product.
   Always confirm the product name and price before adding.
5. CHECKOUT: Call generate_checkout_link only when the user says they are ready to pay.
   Never initiate payment without explicit consent.
6. Never make up product names, prices, or availability. Only state what tools return.

SEVERITY ESCALATION
If search_disease_matches returns a match with severity "critical", or the user
describes collapse, inability to stand, laboured breathing, or seizures, always say:
"Please contact a licensed veterinarian immediately. This may be a life-threatening
emergency and requires professional assessment."

CART & PAYMENT
After recommend_products returns results, present products one by one with name, price,
and a brief purpose description. Ask which one the user wants.
After a product is added, confirm: "Added [NAME] — ₦[PRICE]. Your total is ₦[TOTAL]."
When the user is ready to pay, call generate_checkout_link, then share the checkout
URL: "Here is your payment link: [URL]. Tap it to pay safely."

HONESTY & SAFETY
Never fabricate information. If you don't know something, say so honestly.
Never recommend dosages not in the product's dosage_notes field.
If asked about human health effects, redirect to a medical professional.
Never store, repeat, or log sensitive personal data beyond session scope.

SESSION START
When a new session opens, greet the user warmly and ask what is wrong with their
animal or what you can help with today. Do not wait for them to speak first.
"""

# Keep the private alias so the agent instruction field is unchanged on import
_SYSTEM_INSTRUCTION = FATIMA_SYSTEM_PROMPT

# ---------------------------------------------------------------------------
# Reflect-and-Retry plugin
# ---------------------------------------------------------------------------
# Subclass so extract_error_from_result treats {"error": True, ...} tool
# responses as retryable failures (not just uncaught exceptions).

class _WafrivetRetryPlugin(ReflectAndRetryToolPlugin):
    async def extract_error_from_result(self, *, tool, tool_args, tool_context, result):
        """Surface structured error dicts as retryable failures."""
        if isinstance(result, dict) and result.get("error"):
            return result
        # Also surface non-success status from our standard response envelope
        if isinstance(result, dict) and result.get("status") == "error":
            return result
        return None


_reflect_and_retry = _WafrivetRetryPlugin(
    max_retries=2,
    throw_exception_if_retry_exceeded=False,  # let Fatima speak the error, not crash
)


# ---------------------------------------------------------------------------
# before_tool_callback — safe wrapper for every tool call
# ---------------------------------------------------------------------------
# ADK calls this synchronously before each tool invocation.  Returning a
# non-None value short-circuits the tool and passes that dict to the agent
# as the tool result.  We use it here to handle unexpected exceptions that
# slip past the plugin (e.g. environment misconfiguration) so Fatima always
# speaks a graceful error instead of silently dying.

async def _safe_tool_callback(tool, tool_args: dict, tool_context: ToolContext):
    """
    Wraps tool execution in a try/except.  Returning None lets ADK proceed
    normally; returning a dict bypasses the tool and gives the agent that dict
    as the result, which it reads and speaks aloud via the user_message field.
    """
    try:
        # Returning None means "proceed with normal tool execution"
        return None
    except Exception as exc:  # noqa: BLE001
        session_id = getattr(tool_context, "session_id", "unknown")
        tool_name = getattr(tool, "name", str(tool))
        logger.error(
            {
                "event": "tool_error",
                "tool": tool_name,
                "error": str(exc),
                "session_id": session_id,
            }
        )
        return {
            "error": True,
            "status": "error",
            "user_message": (
                "I had trouble checking that right now. "
                "Please give me a moment and try again."
            ),
        }


# ---------------------------------------------------------------------------
# Agent instance
# ---------------------------------------------------------------------------

root_agent = LlmAgent(
    name="wafrivet_field_vet",
    model="gemini-2.0-flash",
    description=(
        "Real-time multimodal AI livestock health assistant for West African "
        "smallholder farmers. Identifies possible animal conditions, recommends "
        "nearby veterinary products, and facilitates mobile checkout."
    ),
    instruction=_SYSTEM_INSTRUCTION,
    tools=[
        search_disease_matches,
        recommend_products,
        manage_cart,
        generate_checkout_link,
        update_location,
    ],
    before_tool_callback=_safe_tool_callback,
)

# Exported so server.py can attach it to Runner (the correct attachment point).
reflect_and_retry_plugin = _reflect_and_retry
