'use client';

/**
 * app/components/FieldVetSession.tsx
 *
 * Main orchestration shell for Wafrivet Field Vet — Phase 5 Part 4.
 *
 * Layout (all children are position:absolute inside the full-screen <main>):
 *   z=0   CameraView        — fills viewport, rear camera + indicators
 *   z=20  TranscriptStrip   — semi-transparent strip, top portion
 *   z=30  ProductCardRow    — slides up from bottom when products arrive
 *   z=38  CartBadge         — floating bottom-right, only when cart non-empty
 *   z=45  PayButton         — full-width at bottom, only when checkoutUrl set
 *   z=55  LocationBanner    — bottom sheet until location confirmed
 *   z=70  InterruptButton   — centered, only while AI is speaking
 *
 * Event wiring (all handled in useWebSocketSession reducer; effects here
 * drive animation triggers and imperative side-effects):
 *   PRODUCTS_RECOMMENDED → products state → ProductCardRow slide-up
 *   CART_UPDATED         → cartItems/cartTotal + cartVersion bump → CartBadge pulse
 *   CHECKOUT_LINK        → checkoutUrl → PayButton appears
 *   LOCATION_CONFIRMED   → confirmedLocation → LocationBanner pill
 *   binary frames        → onAudioChunk → audioPlayer (in WebSocketProvider)
 *   AUDIO_FLUSH          → onAudioFlush → flush (in WebSocketProvider)
 *   interrupted          → sendInterrupt() + flushAudio() via InterruptButton
 *   unhandled events     → console.warn in useWebSocketSession switch default
 */

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useId,
} from 'react';

import { useWebSocketContext } from './WebSocketProvider';
import { useMediaPipeline }   from '@/app/hooks/useMediaPipeline';
import { useGeolocation }     from '@/app/hooks/useGeolocation';

import { CameraView }       from './CameraView';
import { LocationBanner }   from './LocationBanner';
import { ProductCardRow }   from './ProductCardRow';
import { CartBadge }        from './CartBadge';
import { PayButton }        from './PayButton';
import { InterruptButton }  from './InterruptButton';

import type { Product } from '@/app/types/events';

// ── Component ─────────────────────────────────────────────────────────────────

export function FieldVetSession() {
  // ── WebSocket context ───────────────────────────────────────────────────────
  const {
    connectionState,
    products,
    cartItems,
    cartTotal,
    checkoutUrl,
    confirmedLocation,
    transcripts,
    isAgentSpeaking,
    lastError,
    sendAudio,
    sendImage,
    sendText,
    sendInterrupt,
    flushAudio,
    sendSessionContext,
    resumeContext,
  } = useWebSocketContext();

  // ── Geolocation ─────────────────────────────────────────────────────────────
  const {
    detectedState,
    hasGPSError,
    isLoading: geoLoading,
  } = useGeolocation();

  /**
   * Auto-send detected state to the agent once — fires update_location which
   * returns LOCATION_CONFIRMED. Only sends if we have a state and have not
   * already sent or confirmed.
   */
  const locationSentRef = useRef(false);
  useEffect(() => {
    if (detectedState && !confirmedLocation && !locationSentRef.current) {
      locationSentRef.current = true;
      sendText(`I am in ${detectedState}`);
    }
  }, [detectedState, confirmedLocation, sendText]);

  // ── Media pipeline ──────────────────────────────────────────────────────────
  const { videoRef, canvasRef, isCapturing, permissionError, activateMic } =
    useMediaPipeline({
      onAudioChunk: sendAudio,
      onVideoFrame: sendImage,
      framePeriodMs: 1_500,
    });

  // ── First-tap handler ───────────────────────────────────────────────────────
  // Must unlock Web Audio API (resumeContext) and start camera capture
  // (activateMic) together inside the same user-gesture handler.
  const handleFirstTap = useCallback(async () => {
    resumeContext(); // Must be synchronous — inside user gesture.
    await activateMic();
  }, [resumeContext, activateMic]);

  // ── Interrupt handler ───────────────────────────────────────────────────────
  // Stops audio client-side immediately AND signals backend to halt the turn.
  const handleInterrupt = useCallback(() => {
    sendInterrupt();
    flushAudio();
  }, [sendInterrupt, flushAudio]);

  // ── Cart update version — drives CartBadge pulse animation ─────────────────
  const [cartVersion, setCartVersion] = useState(0);
  const prevCartTotalRef = useRef(cartTotal);
  useEffect(() => {
    if (cartTotal !== prevCartTotalRef.current || cartItems.length !== prevCartTotalRef.current) {
      if (cartTotal !== prevCartTotalRef.current) {
        prevCartTotalRef.current = cartTotal;
        setCartVersion((v) => v + 1);
      }
    }
  }, [cartTotal, cartItems.length]);

  // ── Location banner manual-deny state ──────────────────────────────────────
  // After auto-send, briefly show a "pending" state in the banner; after
  // LOCATION_CONFIRMED the banner disappears entirely.
  const handleLocationConfirm = useCallback(
    (state: string) => {
      sendSessionContext(state);
    },
    [sendSessionContext],
  );

  // ── Voice-fallback text input (accessible alternative to mic) ──────────────
  const [textDraft, setTextDraft] = useState('');
  const textInputId = useId();

  const handleTextSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = textDraft.trim();
      if (trimmed) {
        sendText(trimmed);
        setTextDraft('');
      }
    },
    [textDraft, sendText],
  );

  // ── Add-to-cart voice command ───────────────────────────────────────────────
  const handleAddToCart = useCallback(
    (product: Product) => {
      sendText(`Add ${product.name} to my cart`);
    },
    [sendText],
  );

  // ── Derived layout: when PayButton is visible, shift product row up ─────────
  const payButtonVisible = checkoutUrl !== null;
  // Heights: PayButton ~64px + 16px bottom + 16px gap = 96px clearance
  const productRowBottom = payButtonVisible
    ? 'calc(96px + var(--spacing-safe-bottom))'
    : 'calc(16px + var(--spacing-safe-bottom))';
  // CartBadge sits above product row — add ~160px for product row height
  const cartBadgeBottom = payButtonVisible
    ? 'calc(266px + var(--spacing-safe-bottom))'
    : 'calc(180px + var(--spacing-safe-bottom))';

  return (
    <main
      style={{
        position: 'relative',
        width: '100%',
        height: '100svh',
        overflow: 'hidden',
        background: '#0a0e14',
        touchAction: 'none', // Prevent pull-to-refresh / page scroll on Android.
      }}
      /* Expose safe area to CSS var consumers */
    >
      {/* ── Camera fills entire viewport (z=0) ─────────────────────────── */}
      <CameraView
        videoRef={videoRef}
        canvasRef={canvasRef}
        isCapturing={isCapturing}
        permissionError={permissionError}
        connectionState={connectionState}
        onFirstTap={handleFirstTap}
      />

      {/* ── Interrupt button — centered, only when AI is speaking (z=70) ─ */}
      {isAgentSpeaking && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 70,
            pointerEvents: 'auto',
          }}
        >
          <InterruptButton
            isVisible={isAgentSpeaking}
            onInterrupt={handleInterrupt}
          />
        </div>
      )}

      {/* ── Transcript strip — semi-transparent behind top bar (z=20) ──── */}
      {transcripts.length > 0 && (
        <div
          role="log"
          aria-live="polite"
          aria-label="Conversation transcript"
          style={{
            position: 'absolute',
            top: 'calc(40px + var(--spacing-safe-top))',
            left: '16px',
            right: '16px',
            maxHeight: '25vh',
            overflowY: 'auto',
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            pointerEvents: 'none',
          }}
        >
          {transcripts.slice(-4).map((t, i) => (
            <div
              key={i}
              style={{
                background:
                  t.author === 'user'
                    ? 'rgba(28, 37, 53, 0.88)'
                    : 'rgba(46, 160, 67, 0.15)',
                borderLeft: `3px solid ${t.author === 'user' ? '#58a6ff' : '#2ea043'}`,
                borderRadius: '0 8px 8px 0',
                padding: '6px 10px',
                backdropFilter: 'blur(8px)',
              }}
            >
              <p
                className="selectable"
                style={{
                  fontSize: '13px',
                  color: t.author === 'user' ? '#e6edf3' : '#3fb950',
                  lineHeight: 1.45,
                  margin: 0,
                  textShadow: '0 1px 3px rgba(0,0,0,0.7)',
                }}
              >
                <strong style={{ opacity: 0.7 }}>
                  {t.author === 'user' ? 'You' : 'AI'}:{' '}
                </strong>
                {t.text}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Error notification bar ──────────────────────────────────────── */}
      {lastError && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            top: 'calc(8px + var(--spacing-safe-top))',
            left: '16px',
            right: '16px',
            background: 'rgba(248, 81, 73, 0.9)',
            borderRadius: '10px',
            padding: '8px 14px',
            fontSize: '12px',
            fontWeight: 600,
            color: '#fff',
            zIndex: 65,
            textAlign: 'center',
            backdropFilter: 'blur(6px)',
          }}
        >
          {lastError}
        </div>
      )}

      {/* ── Product card row — slides up from bottom (z=30) ─────────────── */}
      {products.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: productRowBottom,
            left: 0,
            right: 0,
            zIndex: 30,
          }}
        >
          <ProductCardRow products={products} onAddToCart={handleAddToCart} />
        </div>
      )}

      {/* ── Cart badge — floating, bottom-right (z=38) ───────────────────── */}
      {cartItems.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: cartBadgeBottom,
            right: '16px',
            zIndex: 38,
            animation: 'fade-in 0.3s ease',
          }}
        >
          <CartBadge
            itemCount={cartItems.length}
            total={cartTotal}
            updateVersion={cartVersion}
          />
        </div>
      )}

      {/* ── Pay button — full-width at bottom (z=45) ─────────────────────── */}
      {payButtonVisible && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(16px + var(--spacing-safe-bottom))',
            left: '16px',
            right: '16px',
            zIndex: 45,
            animation: 'slide-up 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <PayButton cartTotal={cartTotal} />
        </div>
      )}

      {/* ── Location banner — bottom sheet (z=55) ───────────────────────── */}
      {!confirmedLocation && (
        <LocationBanner
          detectedState={detectedState}
          confirmedLocation={confirmedLocation}
          hasGPSError={hasGPSError}
          isLoading={geoLoading}
          onConfirm={handleLocationConfirm}
          onDeny={() => {
            /* Deny is handled internally in LocationBanner — switches to manual input */
          }}
        />
      )}

      {/* ── Confirmed location pill (rendered by LocationBanner when set) ─ */}
      {confirmedLocation && (
        <LocationBanner
          detectedState={detectedState}
          confirmedLocation={confirmedLocation}
          hasGPSError={hasGPSError}
          isLoading={false}
          onConfirm={handleLocationConfirm}
          onDeny={() => {}}
        />
      )}

      {/* ── Voice-fallback text input — accessible typed interaction (z=25) */}
      {isCapturing && (
        <form
          onSubmit={handleTextSubmit}
          style={{
            position: 'absolute',
            bottom: payButtonVisible
              ? 'calc(100px + var(--spacing-safe-bottom))'
              : 'calc(16px + var(--spacing-safe-bottom))',
            left: '16px',
            right: '16px',
            display: 'flex',
            gap: '8px',
            zIndex: 25,
            // Only show text input when no product row / cart is open.
            // Keep it accessible but visually minimal.
            opacity: products.length > 0 ? 0 : 1,
            pointerEvents: products.length > 0 ? 'none' : 'auto',
          }}
          aria-label="Type a message to the AI vet"
        >
          <label
            htmlFor={textInputId}
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}
          >
            Message
          </label>
          <input
            id={textInputId}
            type="text"
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            placeholder="Type a message…"
            autoComplete="off"
            autoCorrect="on"
            style={{
              flex: 1,
              background: 'rgba(28, 37, 53, 0.85)',
              border: '1.5px solid rgba(48, 54, 61, 0.8)',
              borderRadius: '12px',
              padding: '0 14px',
              fontSize: '15px',
              color: '#e6edf3',
              minHeight: '48px',
              backdropFilter: 'blur(8px)',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={!textDraft.trim()}
            style={{
              background: textDraft.trim()
                ? 'rgba(46,160,67,0.9)'
                : 'rgba(46,160,67,0.3)',
              color: '#fff',
              border: 'none',
              borderRadius: '12px',
              padding: '0 16px',
              fontSize: '14px',
              fontWeight: 700,
              cursor: textDraft.trim() ? 'pointer' : 'not-allowed',
              minHeight: '48px',
              minWidth: '64px',
              transition: 'background 0.2s',
            }}
            aria-label="Send message"
          >
            Send
          </button>
        </form>
      )}
    </main>
  );
}

