'use client';

/**
 * app/components/WebSocketProvider.tsx
 *
 * Client Component — must NOT be imported with 'use client' in layout.tsx.,
 * layout.tsx (Server Component) imports this and wraps children with it;
 * Next.js App Router propagates the client boundary correctly.
 *
 * Responsibilities:
 *   1. Generate/restore stable user_id and session_id from sessionStorage
 *      (deferred to useEffect to avoid SSR hydration mismatch).
 *   2. Instantiate useAudioPlayer and useWebSocketSession.
 *   3. Distribute all session state + send helpers via React context.
 *
 * Key design decisions:
 *   - isAgentSpeaking in the context is sourced from the audio player's
 *     queue-drain signal (isAISpeaking), not from binary-frame reception.
 *     This means the UI speaking indicator turns off only when audio
 *     actually finishes playing, not when the last WS binary frame arrives.
 *   - resumeContext() must be wired to the first user interaction on the
 *     page to unlock the Web Audio API on iOS / Android Chrome.
 *
 * WebSocket endpoint: {NEXT_PUBLIC_WS_URL}/ws/{userId}/{sessionId}
 * IDs must match ^[a-zA-Z0-9_\-]{1,128}$ (server-side validation).
 */

import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  useRef,
} from 'react';

import { useAudioPlayer } from '@/app/hooks/useAudioPlayer';
import {
  useWebSocketSession,
  type SessionState,
} from '@/app/hooks/useWebSocketSession';

// ── Context shape ─────────────────────────────────────────────────────────────

export interface WebSocketContextValue extends SessionState {
  /**
   * True while the audio player queue has active nodes.
   * Overrides SessionState.isAgentSpeaking with the more accurate
   * audio-player signal so the UI speaking indicator matches actual playback.
   */
  isAgentSpeaking: boolean;
  /** Send a raw 16 kHz 16-bit mono PCM ArrayBuffer to the backend. */
  sendAudio: (chunk: ArrayBuffer) => void;
  /** Send a base64-encoded JPEG camera frame as an IMAGE message. */
  sendImage: (base64Jpeg: string) => void;
  /** Send an arbitrary text message (typed input, voice fallback, commands). */
  sendText: (text: string) => void;
  /** Signal the backend to interrupt the current AI response turn. */
  sendInterrupt: () => void;
  /**
   * Immediately silence all scheduled audio nodes and reset the audio queue.
   * Call alongside sendInterrupt() from the InterruptButton handler so audio
   * stops client-side without waiting for the AUDIO_FLUSH server event.
   */
  flushAudio: () => void;
  /**
   * Send the farmer's confirmed Nigerian state to the backend.
   * Use when manually correcting location or restoring context after a page refresh.
   */
  sendSessionContext: (farmerState: string) => void;
  /**
   * Send GPS coordinates to the backend to populate session state.
   * Call once after geolocation resolves; safe to call on every GPS update.
   */
  sendLocationData: (lat: number, lon: number, state?: string | null, lga?: string | null) => void;
  /**
   * Resume the Web Audio API context after a user gesture.
   * Wire to the first meaningful tap/click on the page shell before audio arrives.
   */
  resumeContext: () => void;
  /** Clear the lastError from the session state to allow it to trigger effects again. */
  clearError: () => void;
  /**
   * Phase 5: Suspend the AudioContext while the PIN overlay is shown.
   * Call from PinOverlay on mount so Gemini audio does not play during PIN entry.
   */
  suspendAudio: () => void;
  /**
   * Phase 5: Resume the AudioContext after the PIN overlay is dismissed.
   */
  resumeAudio: () => void;
  /**
   * Phase 5: Send a PIN_VERIFIED message to the bridge so it transitions
   * from AWAITING_PIN → ACTIVE and resumes Gemini audio delivery.
   * Also updates the local session state (identityVerified = true).
   */
  sendPinVerified: (farmerName: string) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// ── Session ID helpers ────────────────────────────────────────────────────────

const KEY_USER_ID    = 'wafrivet_user_id';
const KEY_SESSION_ID = 'wafrivet_session_id';

/**
 * Generate a URL-safe random ID (alphanumeric, 32 chars).
 * Avoids hyphens that some server regexes need escaping for.
 */
function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

interface SessionIds {
  userId: string;
  sessionId: string;
}

/** Read existing IDs from localStorage/sessionStorage or create new ones. */
function getOrCreateIds(): SessionIds {
  // If AuthScreen has set a phone number, use that as the stable userId.
  const storedIdentity = localStorage.getItem('wafrivet_user_identity');
  let userId = '';
  
  if (storedIdentity) {
    try {
      const { phoneNumber } = JSON.parse(storedIdentity);
      userId = phoneNumber.replace(/\+/g, '');
    } catch (e) {
      // fallback
    }
  }

  if (!userId) {
    userId = sessionStorage.getItem(KEY_USER_ID) ?? generateId();
  }
  
  const sessionId = sessionStorage.getItem(KEY_SESSION_ID) ?? generateId();
  
  sessionStorage.setItem(KEY_USER_ID,    userId);
  sessionStorage.setItem(KEY_SESSION_ID, sessionId);
  
  return { userId, sessionId };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const wsBaseUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8000';

  /**
   * Session IDs are initialised in useEffect (client-only) to avoid
   * accessing sessionStorage during SSR and causing hydration mismatches.
   */
  const [ids, setIds] = useState<SessionIds | null>(null);
  const initialised = useRef(false);

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    setIds(getOrCreateIds());
  }, []);

  // Audio playback — single AudioContext kept alive across flushes.
  // isAISpeaking is true while scheduled source nodes are still playing.
  const { playChunk, flush, resumeContext, suspendAudio, resumeAudio, isAISpeaking } = useAudioPlayer();

  // WebSocket session — enabled only after IDs are available.
  const {
    state,
    sendAudioChunk,
    sendFrame,
    sendText,
    sendInterrupt,
    sendSessionContext,
    sendLocationData,
    clearError,
    sendPinVerified,
  } = useWebSocketSession({
    wsBaseUrl,
    userId:    ids?.userId    ?? '',
    sessionId: ids?.sessionId ?? '',
    onAudioChunk: playChunk,
    onAudioFlush: flush,
    enabled: ids !== null,
  });

  const value = useMemo<WebSocketContextValue>(
    () => ({
      ...state,
      // Override with the audio player's accurate queue-drain signal.
      isAgentSpeaking: isAISpeaking,
      // Alias hook method names to the stable context interface names.
      sendAudio:       sendAudioChunk,
      sendImage:       sendFrame,
      sendText,
      sendInterrupt,
      // Expose flush directly so InterruptButton can stop audio client-side
      // without waiting for the server AUDIO_FLUSH event.
      flushAudio:      flush,
      sendSessionContext,
      sendLocationData,
      resumeContext,
      clearError,
      suspendAudio,
      resumeAudio,
      sendPinVerified,
    }),
    [
      state,
      isAISpeaking,
      sendAudioChunk,
      sendFrame,
      sendText,
      sendInterrupt,
      flush,
      sendSessionContext,
      sendLocationData,
      resumeContext,
      clearError,
      suspendAudio,
      resumeAudio,
      sendPinVerified,
    ],
  );

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

/**
 * Access the WebSocket session state and send helpers.
 * Must be called from a component inside <WebSocketProvider>.
 */
export function useWebSocketContext(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error(
      'useWebSocketContext must be used inside <WebSocketProvider>. ' +
      'Did you forget to add <WebSocketProvider> in app/layout.tsx?',
    );
  }
  return ctx;
}
