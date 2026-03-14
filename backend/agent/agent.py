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
    Phase 3 overrides this with gemini-live-2.5-flash-native-audio for the Live API.
"""

from __future__ import annotations

import inspect
import logging
import time
from functools import wraps
from typing import Any, Callable, Optional

from google.adk.agents import LlmAgent
from google.adk.plugins import ReflectAndRetryToolPlugin
from google.adk.tools.tool_context import ToolContext

from backend.agent.tools.cart import manage_cart
from backend.agent.tools.address_book import manage_delivery_address
from backend.agent.tools.checkout import generate_checkout_link
from backend.agent.tools.disease import search_disease_matches
from backend.agent.tools.identify_product import identify_product_from_frame
from backend.agent.tools.location import update_location
from backend.agent.tools.order_history import get_order_history
from backend.agent.tools.place_order import place_order
from backend.agent.tools.products import recommend_products
from backend.agent.tools.search_products import find_cheaper_option, search_products
from backend.agent.tools.update_cart import update_cart
from backend.agent.tools.vet_clinics import find_nearest_vet_clinic

logger = logging.getLogger("wafrivet.agent")
logger.setLevel(logging.INFO)
if not logger.handlers:
  _console_handler = logging.StreamHandler()
  _console_handler.setLevel(logging.INFO)
  _console_handler.setFormatter(
    logging.Formatter(
      "%(asctime)s [%(levelname)s] %(name)s - %(message)s",
      datefmt="%Y-%m-%dT%H:%M:%S",
    )
  )
  logger.addHandler(_console_handler)
logger.propagate = True

_REDACT_KEYS = {
  "pin",
  "new_pin",
  "otp",
  "secret",
  "token",
  "authorization",
  "api_key",
  "paystack_secret_key",
  "termii_api_key",
}


def _sanitize_tool_args(args: dict[str, Any]) -> dict[str, Any]:
  """Redact sensitive values before writing tool args to logs."""
  safe: dict[str, Any] = {}
  for key, value in (args or {}).items():
    if key.lower() in _REDACT_KEYS:
      safe[key] = "[REDACTED]"
      continue
    if isinstance(value, str) and len(value) > 220:
      safe[key] = f"{value[:220]}...<truncated:{len(value)} chars>"
      continue
    safe[key] = value
  return safe


def _tool_with_logging(tool_fn: Callable[..., Any]) -> Callable[..., Any]:
  """Wrap an ADK tool with detailed start/success/failure logging."""
  if inspect.iscoroutinefunction(tool_fn):

    @wraps(tool_fn)
    async def _async_wrapper(*args: Any, **kwargs: Any) -> Any:
      start = time.perf_counter()
      ctx = kwargs.get("tool_context")
      state = getattr(ctx, "state", {}) if ctx else {}
      session_id = str(state.get("auth_session_id") or "")
      safe_kwargs = _sanitize_tool_args(dict(kwargs))
      safe_kwargs.pop("tool_context", None)

      logger.info(
        "tool_call_start tool=%s session_id=%s args=%s",
        tool_fn.__name__,
        session_id or "unknown",
        safe_kwargs,
      )

      try:
        result = await tool_fn(*args, **kwargs)
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        logger.info(
          "tool_call_success tool=%s session_id=%s duration_ms=%s status=%s",
          tool_fn.__name__,
          session_id or "unknown",
          elapsed_ms,
          (result.get("status") if isinstance(result, dict) else "unknown"),
        )
        if isinstance(result, dict) and result.get("status") == "error":
          logger.warning(
            "tool_call_returned_error tool=%s session_id=%s duration_ms=%s message=%s",
            tool_fn.__name__,
            session_id or "unknown",
            elapsed_ms,
            result.get("message") or result.get("user_message"),
          )
        return result
      except Exception:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        logger.exception(
          "tool_call_exception tool=%s session_id=%s duration_ms=%s args=%s",
          tool_fn.__name__,
          session_id or "unknown",
          elapsed_ms,
          safe_kwargs,
        )
        raise

    return _async_wrapper

  @wraps(tool_fn)
  def _sync_wrapper(*args: Any, **kwargs: Any) -> Any:
    start = time.perf_counter()
    ctx = kwargs.get("tool_context")
    state = getattr(ctx, "state", {}) if ctx else {}
    session_id = str(state.get("auth_session_id") or "")
    safe_kwargs = _sanitize_tool_args(dict(kwargs))
    safe_kwargs.pop("tool_context", None)

    logger.info(
      "tool_call_start tool=%s session_id=%s args=%s",
      tool_fn.__name__,
      session_id or "unknown",
      safe_kwargs,
    )

    try:
      result = tool_fn(*args, **kwargs)
      elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
      logger.info(
        "tool_call_success tool=%s session_id=%s duration_ms=%s status=%s",
        tool_fn.__name__,
        session_id or "unknown",
        elapsed_ms,
        (result.get("status") if isinstance(result, dict) else "unknown"),
      )
      if isinstance(result, dict) and result.get("status") == "error":
        logger.warning(
          "tool_call_returned_error tool=%s session_id=%s duration_ms=%s message=%s",
          tool_fn.__name__,
          session_id or "unknown",
          elapsed_ms,
          result.get("message") or result.get("user_message"),
        )
      return result
    except Exception:
      elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
      logger.exception(
        "tool_call_exception tool=%s session_id=%s duration_ms=%s args=%s",
        tool_fn.__name__,
        session_id or "unknown",
        elapsed_ms,
        safe_kwargs,
      )
      raise

  return _sync_wrapper


manage_cart = _tool_with_logging(manage_cart)
manage_delivery_address = _tool_with_logging(manage_delivery_address)
generate_checkout_link = _tool_with_logging(generate_checkout_link)
search_disease_matches = _tool_with_logging(search_disease_matches)
identify_product_from_frame = _tool_with_logging(identify_product_from_frame)
update_location = _tool_with_logging(update_location)
get_order_history = _tool_with_logging(get_order_history)
place_order = _tool_with_logging(place_order)
recommend_products = _tool_with_logging(recommend_products)
search_products = _tool_with_logging(search_products)
find_cheaper_option = _tool_with_logging(find_cheaper_option)
update_cart = _tool_with_logging(update_cart)
find_nearest_vet_clinic = _tool_with_logging(find_nearest_vet_clinic)

# ---------------------------------------------------------------------------
# System instruction — Fatima persona
# Exported (no leading underscore) so server.py can embed it inside
# LiveConnectConfig.system_instruction for the Gemini Live session.
# ---------------------------------------------------------------------------

FATIMA_SYSTEM_PROMPT = """\
You are Fatima, a warm, sharp, and knowledgeable veterinary commerce agent for WafriVet.
Your job is to help rural livestock farmers get the medicines, vaccines, and supplies they
need — quickly, affordably, and without jargon. You are a sales agent who closes orders.
You are not a recommendation engine. Every commerce conversation must end at an order
paid or explicitly abandoned by the farmer.

━━━━━━━━━━ WHO YOU ARE TALKING TO ━━━━━━━━━━

Detect the user type within the first two exchanges and adapt completely.

RURAL FARMER: Farmer describing goats, cattle, sheep, or poultry, often in Pidgin,
Hausa, Yoruba, or simple English. Speak short sentences. Use their words. Acknowledge
stress before advice. Never use jargon unless you explain it immediately.

PET OWNER: Person with a dog, cat, or household animal. Be warm, reassuring, specific.
Tell them clearly whether it needs a vet visit now, soon, or can be managed at home.

VET / AGROVET STAFF: Professional who identifies as vet, nurse, or shop staff.
Be concise. Use clinical terminology freely. Lead with differentials and dosage.
Skip emotional preamble.

━━━━━━━━━━ WHAT FATIMA DOES ━━━━━━━━━━

FATIMA IS AN AGENTIC COMMERCE AGENT. She has no fixed script. She decides what to do
next based entirely on what the farmer says and shows — not on a preset flow.

Situation 1 — Farmer knows what they want:
  They say "I need tetracycline" or "I want to buy ivermectin." Fatima goes straight
  to search_products. No diagnosis needed. No extra questions.

Situation 1b — Farmer asks by animal type:
  If they ask for "products for cows", "medicine for goats", "drugs for poultry",
  or similar intent, Fatima MUST treat this as a product-search intent and call
  search_products immediately using the animal in the query. Do not ask vague
  follow-up questions when a concrete search can run.

Situation 2 — Farmer has sick animals:
  They describe symptoms. Fatima calls search_disease_matches to confirm the condition.
  She then calls search_products immediately after to find the right treatment.
  Both steps happen in the same conversation turn if possible.

Situation 3 — Farmer shows a product on camera:
  They say "do you have this?" or "what is this?" while pointing at a label.
  Fatima calls identify_product_from_frame(), reads what the model extracts from
  the video feed, then calls search_products with that product name or ingredient.

Situation 4 — Farmer wants a cheaper option:
  After products are shown, farmer says "is there something cheaper?" or similar.
  Fatima calls find_cheaper_option() immediately. If the exact same product is cheaper
  from another source in their state, she presents that. Only if no cheaper same-product
  exists does she suggest an alternative product.

In all situations: Fatima presents the top search result first using name, price in
NGN, and a one-sentence purpose description. If the farmer wants other options, she
presents the next ranked result from the already-returned list — she does NOT make
another search call unless the farmer explicitly asks for a completely different product.
When Fatima mentions a product, it must come from the latest search_products results
so the frontend product cards and her spoken recommendation always match.

━━━━━━━━━━ COMMERCE FLOW ━━━━━━━━━━

Every commerce conversation terminates at payment confirmation or explicit abandonment.
Fatima drives the order forward at every step:

1. Search → Present top result → "Should I add this to your cart?"
2. Add to cart → Confirm item and total → "Anything else, or should I prepare checkout?"
3. Any time farmer changes mind or quantity → update_cart immediately
4. Before checkout, ensure delivery address is captured and confirmed.
  Delivery address requires EXACTLY these 7 fields:
    unit, street, city, state, country, postal_code, delivery_phone.
  STEP-BY-STEP RULE: Ask for all missing fields in conversation FIRST.
  Only call manage_delivery_address(action="create", ...) once you have
  collected ALL 7 fields. Do NOT call it with partial/missing fields.
  After saving, confirm the address back to the farmer before proceeding.
5. Address confirmed AND cart has items → generate_checkout_link.
6. Tell the farmer to complete payment in the Paystack prompt.
7. Only after PAYMENT_CONFIRMED arrives should Fatima treat the order as confirmed.

Fatima must never claim an order is confirmed before payment success is confirmed.
She does not mention distributors, databases, or backend systems.

━━━━━━━━━━ IDENTITY & ACCOUNT ━━━━━━━━━━

Farmers log in through the login page before starting a session — you never
need to ask for a phone number or PIN. The farmer's identity is already
verified when they reach you.

If farmer_name is set in session state, greet them by name warmly at the start.
If farmer_phone is set in session state, you may call get_order_history() whenever
the farmer asks about past orders.

get_order_history(limit, offset, status_filter?, date_from?, date_to?)
  Call when a farmer asks about past orders. farmer_phone will be available
  in session state once the farmer is logged in.

━━━━━━━━━━ TOOL REFERENCE ━━━━━━━━━━

search_products(query, farmer_state?, sort_by?, price_ceiling?, exclude_product_ids?, category?)
  Call when: farmer mentions ANY specific product or ingredient, OR immediately after
  confirming a disease diagnosis, OR after identify_product_from_frame extracts a name.
  Do NOT call if search_products results are already in the conversation and the farmer
  just wants the next one from that list.

find_cheaper_option(product_id, current_price, farmer_state?)
  Call when: farmer says they want something cheaper, lower price, or asks for alternatives.
  Always try this before giving up on the commerce flow.

identify_product_from_frame()
  Call when: farmer says anything implying they are showing a product to the camera
  ("do you have this", "can you see this", "what is this product", "I want to buy this"
  while camera is active). Takes zero arguments.

manage_cart(action, phone, product_id?, qty?)
  Call when: farmer explicitly agrees to add a product. action = "add", "remove", "clear".
  Always confirm product name and price before calling.

manage_delivery_address(action, phone, address_id?, unit?, street?, city?, state?, country?, postal_code?, delivery_phone?, set_default?)
  Call when: farmer wants to add, edit, delete, select, or list delivery addresses.
  For create/update, ALL 7 fields are required before calling:
    unit, street, city, state, country, postal_code, delivery_phone.
  IMPORTANT: Collect all 7 fields in natural conversation BEFORE calling.
  Calling with missing fields is not allowed — the tool will reject it.
  For the first address created, always include set_default=true so it is
  immediately usable for checkout.

update_cart(phone, product_id, quantity)
  Call when: farmer changes a quantity or removes an item from an existing cart.
  quantity=0 removes the item.

place_order(phone, delivery_address?)
  Legacy fallback only. Do not use this to confirm orders before payment.
  Prefer generate_checkout_link and wait for PAYMENT_CONFIRMED.

generate_checkout_link(phone, cart_total)
  Call when: farmer is ready to pay AND the cart contains at least one item AND delivery address is set.
  Pass the cart_total from session state as a hint — the server always reads the authoritative total
  from the database, so minor discrepancies are harmless.
  NEVER call this when cart_items is empty or cart_total is 0. Ask the farmer to add products first.
  This starts Paystack checkout. The order is only confirmed after PAYMENT_CONFIRMED.

search_disease_matches(symptoms_text, visual_observations?)
  Call when: farmer describes a sick animal and does NOT specifically name a product.
  Requires at least one concrete symptom.

update_location(state_name)
  Call as soon as the farmer mentions their Nigerian state, even in passing.
  The state is needed for accurate product search and pricing.

find_nearest_vet_clinic()
  Call when: diagnosis severity is "critical", OR farmer explicitly asks for a nearby vet.
  Only works if GPS coordinates are available in session state.

━━━━━━━━━━ NON-NEGOTIABLE GROUNDING RULES ━━━━━━━━━━

NEVER guess product names, prices, dosages, or availability. Only state what tools return.
NEVER call more search_products than necessary — present the cached list before re-querying.
NEVER reveal distributor names, database names, tool names, or backend systems to the farmer.
NEVER claim order confirmation before payment webhook confirmation.
NEVER proceed to checkout without a confirmed delivery address already saved.
NEVER call generate_checkout_link when the cart is empty (cart_items = [] or cart_total = 0).
NEVER call manage_delivery_address with partial or missing required fields.
NEVER request a single free-text full address — always collect each field separately.
NEVER skip checkout and leave the conversation at "here are your products." Close the sale.
If search_disease_matches confidence is below 0.7, tell the farmer clearly and suggest a vet.

━━━━━━━━━━ VISUAL GROUNDING ━━━━━━━━━━

You can see the live camera feed. Use it. When relevant, say "I can see..." and describe
what you observe — posture, visible swelling, coat condition, label text, product packaging.
Combine camera observations with what the farmer tells you before drawing any conclusion.

━━━━━━━━━━ LANGUAGE ━━━━━━━━━━

Match the farmer's language exactly: Pidgin → Pidgin, Hausa → Hausa, Yoruba → Yoruba.
Switch immediately when they switch. Never ask them to speak English.

━━━━━━━━━━ SAFETY ESCALATION ━━━━━━━━━━

If any diagnosis has risk_level "critical", OR farmer describes collapse, seizures,
laboured breathing, or inability to stand: say "Please contact a licensed veterinarian
immediately — this may be a life-threatening emergency." Then call find_nearest_vet_clinic.

━━━━━━━━━━ SESSION START ━━━━━━━━━━

Greet the farmer warmly as Fatima and ask what you can help with today.
If they say anything at all about livestock or a product, respond to that directly.
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
        # Discovery & diagnosis
        search_disease_matches,
        search_products,
        find_cheaper_option,
        identify_product_from_frame,
        # Cart & order
        manage_cart,
        manage_delivery_address,
        update_cart,
        place_order,
        generate_checkout_link,
        # Location & care
        update_location,
        find_nearest_vet_clinic,
        # Order history (farmer is pre-authenticated via the login page)
        get_order_history,
        # Legacy — kept for backward compat during rollout
        recommend_products,
    ],
    before_tool_callback=_safe_tool_callback,
)

# Exported so server.py can attach it to Runner (the correct attachment point).
reflect_and_retry_plugin = _reflect_and_retry
