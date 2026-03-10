'use client';

/**
 * app/hooks/useWebSocketSession.ts
 *
 * Manages a single WebSocket connection to /ws/{user_id}/{session_id}.
 *
 * Features:
 *   - useReducer state machine for all session state (no useState for domain data)
 *   - Exponential-backoff auto-reconnect: base 1 s, ×2, max 5 retries, cap 30 s
 *   - On reconnect, auto re-sends the confirmed state as a TEXT message so the
 *     agent's location context is restored without requiring a new GPS lookup
 *   - Ref-based audio callbacks — always calls the latest playChunk / flush
 *     without triggering a reconnection loop when callbacks are re-created
 *   - Binary frames (ArrayBuffer) route directly to onAudioChunk; reducer never
 *     sees raw PCM data
 *   - JSON frames are parsed and dispatched to the reducer by type
 *   - Clean teardown on component unmount (close code 1000)
 */

import { useRef, useEffect, useCallback, useReducer } from 'react';
import {
  isServerEvent,
  type CartItem,
  type Product,
  type TranscriptionEvent,
} from '@/app/types/events';

// ── Public types ──────────────────────────────────────────────────────────────

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface SessionState {
  connectionState: ConnectionState;
  products: Product[];
  cartItems: CartItem[];
  /** Current cart total in NGN. Updated by CART_UPDATED events. */
  cartTotal: number;
  /** Paystack authorization URL set when CHECKOUT_LINK event arrives. */
  checkoutUrl: string | null;
  payment_reference: string | null;
  /** Canonical Nigerian state name confirmed by the backend update_location tool. */
  confirmedLocation: string | null;
  /** Rolling window of the last 50 transcription events. */
  transcripts: TranscriptionEvent[];
  /**
   * True while Gemini is streaming audio back to the browser.
   * Note: WebSocketProvider overrides this with the audio player's more
   * accurate queue-drain signal (isAISpeaking) before exposing it via context.
   */
  isAgentSpeaking: boolean;
  lastError: string | null;
}

export interface UseWebSocketSessionOptions {
  /** Base URL for the backend, e.g. "ws://localhost:8000" or "wss://...run.app". */
  wsBaseUrl: string;
  userId: string;
  sessionId: string;
  /** Called with each raw PCM ArrayBuffer received from the server. */
  onAudioChunk: (chunk: ArrayBuffer) => void;
  /** Called when AUDIO_FLUSH event is received. */
  onAudioFlush: () => void;
  /** Set to false to defer connecting (e.g. while IDs are initialising). */
  enabled?: boolean;
}

// ── Reducer ───────────────────────────────────────────────────────────────────

type ReducerAction =
  | { type: 'CONNECTING'; reconnecting: boolean }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'CONN_ERROR'; message: string }
  | { type: 'AGENT_SPEAKING'; value: boolean }
  | { type: 'TRANSCRIPTION'; event: TranscriptionEvent }
  | { type: 'PRODUCTS_RECOMMENDED'; products: Product[] }
  | { type: 'CART_UPDATED'; items: CartItem[]; cart_total: number }
  | { type: 'CHECKOUT_LINK'; checkout_url: string; payment_reference: string }
  | { type: 'LOCATION_CONFIRMED'; state: string }
  | { type: 'TOOL_ERROR'; tool_name: string; error: string }
  | { type: 'MODEL_ERROR'; code: string; message: string };

const INITIAL_STATE: SessionState = {
  connectionState: 'idle',
  products: [],
  cartItems: [],
  cartTotal: 0,
  checkoutUrl: null,
  payment_reference: null,
  confirmedLocation: null,
  transcripts: [],
  isAgentSpeaking: false,
  lastError: null,
};

function sessionReducer(state: SessionState, action: ReducerAction): SessionState {
  switch (action.type) {
    case 'CONNECTING':
      return {
        ...state,
        connectionState: action.reconnecting ? 'reconnecting' : 'connecting',
      };

    case 'CONNECTED':
      return { ...state, connectionState: 'connected', lastError: null };

    case 'DISCONNECTED':
      return { ...state, connectionState: 'idle' };

    case 'CONN_ERROR':
      return { ...state, connectionState: 'error', lastError: action.message };

    case 'AGENT_SPEAKING':
      return { ...state, isAgentSpeaking: action.value };

    case 'TRANSCRIPTION':
      return {
        ...state,
        // Rolling window: keep last 50 utterances to bound memory usage.
        transcripts: [...state.transcripts.slice(-49), action.event],
      };

    case 'PRODUCTS_RECOMMENDED':
      return { ...state, products: action.products };

    case 'CART_UPDATED':
      return {
        ...state,
        cartItems: action.items,
        cartTotal: action.cart_total,
      };

    case 'CHECKOUT_LINK':
      return {
        ...state,
        checkoutUrl: action.checkout_url,
        payment_reference: action.payment_reference,
      };

    case 'LOCATION_CONFIRMED':
      return { ...state, confirmedLocation: action.state };

    case 'TOOL_ERROR':
      return {
        ...state,
        lastError: `Tool error in ${action.tool_name}: ${action.error}`,
      };

    case 'MODEL_ERROR':
      return { ...state, lastError: `${action.code}: ${action.message}` };

    default:
      return state;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWebSocketSession({
  wsBaseUrl,
  userId,
  sessionId,
  onAudioChunk,
  onAudioFlush,
  enabled = true,
}: UseWebSocketSessionOptions) {
  const [state, dispatch] = useReducer(sessionReducer, INITIAL_STATE);

  const wsRef           = useRef<WebSocket | null>(null);
  const retryCountRef   = useRef(0);
  const retryTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef      = useRef(true);

  /**
   * Mirror of state.confirmedLocation kept in a ref so the reconnect
   * handler can read the current value without a stale closure over state.
   */
  const confirmedLocationRef = useRef<string | null>(null);

  // Keep audio callbacks in refs so WS message handlers always call the
  // latest version without re-creating the WebSocket on every render.
  const onAudioChunkRef = useRef(onAudioChunk);
  const onAudioFlushRef = useRef(onAudioFlush);
  useEffect(() => { onAudioChunkRef.current = onAudioChunk; }, [onAudioChunk]);
  useEffect(() => { onAudioFlushRef.current = onAudioFlush; }, [onAudioFlush]);

  // Sync the location ref whenever the reducer updates confirmedLocation.
  useEffect(() => {
    confirmedLocationRef.current = state.confirmedLocation;
  }, [state.confirmedLocation]);

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;
    if (!userId || !sessionId) return;

    const url = `${wsBaseUrl}/ws/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`;
    const isReconnect = retryCountRef.current > 0;

    dispatch({ type: 'CONNECTING', reconnecting: isReconnect });

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(1000, 'unmounted during connect'); return; }

      const wasReconnect = retryCountRef.current > 0;
      retryCountRef.current = 0;
      dispatch({ type: 'CONNECTED' });

      // Restore the agent's location context automatically on reconnect so
      // product filtering and session state remain consistent.
      if (wasReconnect && confirmedLocationRef.current) {
        ws.send(
          JSON.stringify({ type: 'TEXT', text: `My location is ${confirmedLocationRef.current}` }),
        );
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;

      // ── Binary frame: raw 24 kHz PCM from Gemini ──────────────────────────
      // Route directly to the audio player; never pass to the reducer.
      if (event.data instanceof ArrayBuffer) {
        onAudioChunkRef.current(event.data);
        dispatch({ type: 'AGENT_SPEAKING', value: true });
        return;
      }

      // ── Text frame: JSON ServerEvent ──────────────────────────────────────
      if (typeof event.data !== 'string') return;

      let raw: unknown;
      try {
        raw = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }

      if (!isServerEvent(raw)) return;

      switch (raw.type) {
        case 'AUDIO_FLUSH':
          onAudioFlushRef.current();
          dispatch({ type: 'AGENT_SPEAKING', value: false });
          break;

        case 'TURN_COMPLETE':
          dispatch({ type: 'AGENT_SPEAKING', value: false });
          break;

        case 'TRANSCRIPTION':
          dispatch({ type: 'TRANSCRIPTION', event: raw });
          break;

        case 'PRODUCTS_RECOMMENDED':
          dispatch({ type: 'PRODUCTS_RECOMMENDED', products: raw.products });
          break;

        case 'CART_UPDATED':
          dispatch({
            type: 'CART_UPDATED',
            items: raw.items,
            cart_total: raw.cart_total,
          });
          break;

        case 'CHECKOUT_LINK':
          dispatch({
            type: 'CHECKOUT_LINK',
            checkout_url: raw.checkout_url,
            payment_reference: raw.payment_reference,
          });
          break;

        case 'LOCATION_CONFIRMED':
          dispatch({ type: 'LOCATION_CONFIRMED', state: raw.state });
          break;

        case 'TOOL_ERROR':
          dispatch({
            type: 'TOOL_ERROR',
            tool_name: raw.tool_name,
            error: raw.error,
          });
          break;

        case 'ERROR':
          dispatch({ type: 'MODEL_ERROR', code: raw.code, message: raw.message });
          break;

        default: {
          // Narrow raw to an object with a `type` field for the warning.
          const unhandled = raw as { type: string };
          console.warn(
            '[useWebSocketSession] Unhandled server event type:',
            unhandled.type,
            raw,
          );
          break;
        }
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      dispatch({ type: 'CONN_ERROR', message: 'WebSocket connection error.' });
    };

    ws.onclose = (event: CloseEvent) => {
      if (!mountedRef.current) return;
      wsRef.current = null;

      // Normal close (component unmount) or explicitly disabled — no retry.
      if (event.code === 1000 || !enabled) {
        dispatch({ type: 'DISCONNECTED' });
        return;
      }

      if (retryCountRef.current >= MAX_RETRIES) {
        dispatch({
          type: 'CONN_ERROR',
          message: 'Connection lost after max retries. Please refresh.',
        });
        return;
      }

      // Exponential backoff: 1 s → 2 s → 4 s → 8 s → 16 s, capped at 30 s.
      const delay = Math.min(BASE_DELAY_MS * (2 ** retryCountRef.current), 30_000);
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(connect, delay);
    };

  // connect is intentionally only reconstructed when connection identity
  // props change; audio callbacks are accessed via refs to avoid this.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsBaseUrl, userId, sessionId, enabled]);

  // Start / stop the connection lifecycle.
  useEffect(() => {
    mountedRef.current = true;
    if (enabled) connect();
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      wsRef.current?.close(1000, 'component unmounted');
    };
  // Re-run only when `enabled` flips; `connect` ref stability is sufficient.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // ── Outbound helpers ────────────────────────────────────────────────────────

  /** Send a raw 16 kHz 16-bit mono PCM ArrayBuffer to the backend. */
  const sendAudioChunk = useCallback((buffer: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(buffer);
    }
  }, []);

  /** Send a base64-encoded JPEG camera frame as an IMAGE message. */
  const sendFrame = useCallback((base64Jpeg: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'IMAGE', data: base64Jpeg }));
    }
  }, []);

  /** Send an arbitrary text message (typed input, commands, etc.). */
  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'TEXT', text }));
    }
  }, []);

  /**
   * Signal the backend to interrupt the current AI response.
   * The backend bridge is expected to halt the Gemini turn and
   * the server will emit AUDIO_FLUSH to clear the browser queue.
   */
  const sendInterrupt = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'INTERRUPT' }));
    }
  }, []);

  /**
   * Send the farmer's confirmed Nigerian state to the backend so the
   * update_location tool can re-confirm it (used on reconnect and manual
   * location correction flows).
   */
  const sendSessionContext = useCallback((farmerState: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: 'TEXT', text: `My location is ${farmerState}` }),
      );
    }
  }, []);

  return {
    state,
    sendAudioChunk,
    sendFrame,
    sendText,
    sendInterrupt,
    sendSessionContext,
  };
}
