/**
 * app/types/events.ts
 *
 * TypeScript interfaces for every WebSocket message type in the
 * Wafrivet Field Vet Live streaming protocol (Phase 5 contract).
 *
 * Source of truth: backend/streaming/events.py
 * WebSocket endpoint: /ws/{user_id}/{session_id}
 *
 * ── Transport directions ──────────────────────────────────────────────────────
 *  Server → Client
 *    Binary frame  : raw 24 kHz PCM audio from Gemini (play via Web Audio)
 *    JSON frame    : one of ServerEvent (discriminated on `type`)
 *
 *  Client → Server
 *    Binary frame  : raw 16 kHz 16-bit mono PCM audio from the mic
 *    JSON frame    : one of ClientMessage (IMAGE | TEXT)
 */

// ── Event type string constants ───────────────────────────────────────────────
//
// These string literals MUST match the Python constants in events.py exactly.

/** WebSocket path prefix. Full path: /ws/{user_id}/{session_id} */
export const WS_PATH = '/ws' as const;

/** All stable event type string literals. */
export const WT = {
  // ── Server → Client ────────────────────────────────────────────────────────
  /** Discard the browser audio queue; stop playing stale audio. */
  AUDIO_FLUSH:           'AUDIO_FLUSH',
  /** STT transcription fragment (user voice or agent TTS output). */
  TRANSCRIPTION:         'TRANSCRIPTION',
  /** Agent finished its response turn. */
  TURN_COMPLETE:         'TURN_COMPLETE',
  /** The ADK recommend_products tool fired: render product cards. */
  PRODUCTS_RECOMMENDED:  'PRODUCTS_RECOMMENDED',
  /** The ADK manage_cart tool fired: refresh cart badge and line items. */
  CART_UPDATED:          'CART_UPDATED',
  /** The ADK generate_checkout_link tool fired: show Pay Now button. */
  CHECKOUT_LINK:         'CHECKOUT_LINK',
  /** The ADK update_location tool fired: state confirmed. */
  LOCATION_CONFIRMED:    'LOCATION_CONFIRMED',
  /** An ADK tool returned a non-success status. */
  TOOL_ERROR:            'TOOL_ERROR',
  /** Terminal Gemini model error (safety, block, token limit, cancel). */
  ERROR:                 'ERROR',

  // ── Client → Server (JSON frames) ─────────────────────────────────────────
  /** A JPEG camera frame, base64-encoded. */
  IMAGE:     'IMAGE',
  /** A text message (typed fallback or command). */
  TEXT:      'TEXT',
  /** Signal the backend to interrupt the current AI response turn. */
  INTERRUPT: 'INTERRUPT',
} as const;

export type WTKey = keyof typeof WT;

// ── Domain model shapes ───────────────────────────────────────────────────────

/**
 * A veterinary product card pushed by the recommend_products ADK tool.
 *
 * Field names match the Supabase `products` table columns selected in
 * backend/agent/tools/products.py:
 *   SELECT id, name, base_price, image_url, description, dosage_notes
 *
 * NOTE: the price field is `base_price` (the DB column name), not `price_ngn`.
 *       Prices are in Nigerian Naira (NGN).
 *
 * image_url is a relative path served from the Next.js public/ directory,
 * e.g. "/images/products/BLT-001.jpg". Place product images in
 * frontend/public/images/products/ for local development.
 */
export interface Product {
  id: string;
  name: string;
  /** Price in NGN — stored in the `base_price` column of the products table. */
  base_price: number;
  /** Relative path e.g. "/images/products/BLT-001.jpg" (Next.js public/). */
  image_url: string;
  description: string;
  dosage_notes: string;
}

/**
 * A single line item in the farmer's active cart.
 * Matches backend/agent/session.py CartItem TypedDict exactly.
 */
export interface CartItem {
  product_id: string;
  product_name: string;
  quantity: number;
  /** Unit price in NGN. */
  unit_price: number;
  /** unit_price × quantity in NGN. */
  subtotal: number;
}

// ── Server → Client JSON events ───────────────────────────────────────────────

/** Instructs the browser to immediately discard its audio playback queue. */
export interface AudioFlushEvent {
  type: 'AUDIO_FLUSH';
}

/**
 * A speech-to-text transcription fragment.
 * author = "user" for farmer microphone input; agent name for AI output.
 * is_final = true when the fragment is complete (not a streaming partial).
 */
export interface TranscriptionEvent {
  type: 'TRANSCRIPTION';
  text: string;
  /** "user" | agent name (e.g. "Wafrivet Field Vet") */
  author: string;
  is_final: boolean;
}

/** Agent completed its response turn; hide any "thinking" indicator. */
export interface TurnCompleteEvent {
  type: 'TURN_COMPLETE';
}

/** Render product cards in the UI when the AI recommends treatments. */
export interface ProductsRecommendedEvent {
  type: 'PRODUCTS_RECOMMENDED';
  products: Product[];
  /** Optional human-readable summary from the tool. */
  message: string;
}

/** Full cart state refresh. Update badge count and line-item list. */
export interface CartUpdatedEvent {
  type: 'CART_UPDATED';
  items: CartItem[];
  /** Current cart total in NGN. */
  cart_total: number;
  message: string;
}

/**
 * Paystack payment link generated by generate_checkout_link.
 * Render a "Pay Now" button that opens checkout_url in a new tab.
 */
export interface CheckoutLinkEvent {
  type: 'CHECKOUT_LINK';
  /** Paystack authorization URL (test or live). */
  checkout_url: string;
  /** Unique Paystack transaction reference for lookup/reconciliation. */
  payment_reference: string;
  message: string;
}

/** Farmer's Nigerian state confirmed; use for product region filtering. */
export interface LocationConfirmedEvent {
  type: 'LOCATION_CONFIRMED';
  /** Canonical title-case state name e.g. "Rivers", "Lagos", "FCT". */
  state: string;
  message: string;
}

/** An ADK tool returned a non-success status; agent will narrate the error. */
export interface ToolErrorEvent {
  type: 'TOOL_ERROR';
  tool_name: string;
  error: string;
}

/**
 * Terminal Gemini model error. Possible codes:
 *   SAFETY | PROHIBITED_CONTENT | BLOCKLIST | MAX_TOKENS | CANCELLED
 * The WebSocket will close after this event.
 */
export interface ModelErrorEvent {
  type: 'ERROR';
  code: string;
  message: string;
}

/** Discriminated union of every server → client JSON event. */
export type ServerEvent =
  | AudioFlushEvent
  | TranscriptionEvent
  | TurnCompleteEvent
  | ProductsRecommendedEvent
  | CartUpdatedEvent
  | CheckoutLinkEvent
  | LocationConfirmedEvent
  | ToolErrorEvent
  | ModelErrorEvent;

// ── Client → Server JSON messages ─────────────────────────────────────────────
// Binary PCM audio frames are sent as ArrayBuffer — not typed here.

/**
 * A JPEG video frame captured from the rear camera.
 * data is the raw base64 string (no data: URI prefix).
 */
export interface ImageMessage {
  type: 'IMAGE';
  /** Base64-encoded JPEG, no "data:image/jpeg;base64," prefix. */
  data: string;
}

/** A text message: typed user input or programmatic command. */
export interface TextMessage {
  type: 'TEXT';
  text: string;
}

/**
 * Sent to interrupt an in-progress AI response turn.
 * The backend bridge stops the current Gemini turn and the server
 * emits AUDIO_FLUSH to clear the browser's audio queue.
 */
export interface InterruptMessage {
  type: 'INTERRUPT';
}

/** Discriminated union of all client → server JSON messages. */
export type ClientMessage = ImageMessage | TextMessage | InterruptMessage;

// ── Type guard ────────────────────────────────────────────────────────────────

/**
 * Minimal runtime guard: confirms the parsed JSON has a string `type` field.
 * Full schema validation is omitted for performance (trust the backend).
 */
export function isServerEvent(data: unknown): data is ServerEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    typeof (data as Record<string, unknown>).type === 'string'
  );
}
