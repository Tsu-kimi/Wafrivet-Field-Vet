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
import { Notification, CloseSquare } from 'iconsax-react';
import { useMediaPipeline }   from '@/app/hooks/useMediaPipeline';
import { useGeolocation }     from '@/app/hooks/useGeolocation';

import { CameraView }       from './CameraView';
import { LocationBanner }   from './LocationBanner';
import { ProductCardRow }   from './ProductCardRow';
import { ClinicCardRow }    from './ClinicCardRow';
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
    clinics,
    clinicsFallbackMessage,
    confirmedLocation,
    isAgentSpeaking,
    lastError,
    sendAudio,
    sendImage,
    sendText,
    sendInterrupt,
    flushAudio,
    resumeContext,
    sendLocationData,
    clearError,
  } = useWebSocketContext();

  // ── Geolocation ─────────────────────────────────────────────────────────────
  const {
    detectedState,
    lat,
    lon,
    lga,
    hasGPSError,
    isLoading: geoLoading,
  } = useGeolocation();

  // Send GPS coordinates to the backend once they resolve.
  // This populates farmer_lat / farmer_lon in the ADK session state so
  // find_nearest_vet_clinic can be called immediately when needed.
  const gpsSentRef = useRef(false);
  useEffect(() => {
    if (
      lat !== null &&
      lon !== null &&
      connectionState === 'connected' &&
      !gpsSentRef.current
    ) {
      gpsSentRef.current = true;
      sendLocationData(lat, lon, detectedState, lga);
    }
  }, [lat, lon, connectionState, detectedState, lga, sendLocationData]);

  // Reset the sent flag on reconnect so GPS is re-sent after a session drop.
  useEffect(() => {
    if (connectionState === 'connecting') {
      gpsSentRef.current = false;
    }
  }, [connectionState]);

  /**
   * Optimistic local location state — set immediately when the user confirms
   * via the LocationBanner so the UI responds instantly without waiting for
   * the backend LOCATION_CONFIRMED round-trip.
   */
  const [localConfirmedLocation, setLocalConfirmedLocation] = useState<string | null>(null);
  const effectiveConfirmedLocation = confirmedLocation || localConfirmedLocation;

  // ── Error Logging & Notifications ───────────────────────────────────────────
  const [errorLog, setErrorLog] = useState<{id: number, message: string, time: Date}[]>([]);
  const [toastError, setToastError] = useState<string | null>(null);
  const [isToastVisible, setIsToastVisible] = useState(false);
  const [showErrorLog, setShowErrorLog] = useState(false);

  useEffect(() => {
    if (lastError) {
      setToastError(lastError);
      setIsToastVisible(true);
      setErrorLog((prev) => [...prev, { id: Date.now(), message: lastError, time: new Date() }]);
      
      // Step 1: Trigger the CSS exit animation at 4.5 seconds
      const hideTimer = setTimeout(() => {
        setIsToastVisible(false);
      }, 4500);

      // Step 2: Completely remove the text from DOM and clear context at 5 seconds
      const clearTimer = setTimeout(() => {
        setToastError(null);
        clearError();
      }, 5000);

      return () => {
        clearTimeout(hideTimer);
        clearTimeout(clearTimer);
      };
    }
  }, [lastError]);

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
  // Optimistically dismiss the banner immediately on confirm, then send the
  // location message so the agent can call update_location in the background.
  const handleLocationConfirm = useCallback(
    (state: string) => {
      setLocalConfirmedLocation(state);
      sendText(`My location is ${state}`);
    },
    [sendText],
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
  // ClinicCardRow sits just above the product row when both are present.
  // When no products, it sits at the same position as the product row.
  const clinicRowBottom = products.length > 0
    ? `calc(${payButtonVisible ? '256px' : '170px'} + var(--spacing-safe-bottom))`
    : productRowBottom;
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
        background: 'var(--color-bg)',
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



      {/* ── Top Right Action Buttons (Notification) ───────────────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(14px + var(--spacing-safe-top))',
          right: '16px', // Align with the right edge
          zIndex: 65,
        }}
      >
        <button
          onClick={() => setShowErrorLog(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            background: errorLog.length > 0 ? 'color-mix(in srgb, var(--color-error) 22%, transparent)' : 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
            border: `1px solid ${errorLog.length > 0 ? 'var(--color-error)' : 'var(--color-border)'}`,
            backdropFilter: 'blur(8px)',
            pointerEvents: 'auto',
            transition: 'background 0.2s',
            cursor: 'pointer',
          }}
          aria-label="View error log"
        >
          <Notification variant="Linear" color={errorLog.length > 0 ? 'var(--color-error)' : 'var(--color-white)'} size={24} />
        </button>
      </div>

      {/* ── Error Log Panel ─────────────────────────────────────────────── */}
      {showErrorLog && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(64px + var(--spacing-safe-top))',
            right: '16px',
            width: '320px',
            maxHeight: '400px',
            background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)',
            border: '1px solid var(--color-border)',
            borderRadius: '16px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            zIndex: 80,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            backdropFilter: 'blur(12px)',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--color-text)', fontFamily: 'var(--font-fraunces)' }}>Event Log</h3>
            <button
              onClick={() => setShowErrorLog(false)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
            >
              <CloseSquare size={24} color="var(--color-text-muted)" />
            </button>
          </div>
          {errorLog.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '14px', margin: 0 }}>No errors reported.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {errorLog.slice().reverse().map((err) => (
                <div key={err.id} style={{ background: 'color-mix(in srgb, var(--color-error) 12%, transparent)', padding: '10px', borderRadius: '8px', borderLeft: '3px solid var(--color-error)' }}>
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-text)' }}>{err.message}</p>
                  <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'var(--color-text-muted)' }}>{err.time.toLocaleTimeString()}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Error notification bar (Dynamic Island) ────────────────────── */}
      <div
        role="alert"
        style={{
          position: 'absolute',
          top: 'calc(14px + var(--spacing-safe-top))',
          left: '50%',
          transform: `translateX(-50%) translateY(${isToastVisible ? '0' : '-200%'}) scale(${isToastVisible ? '1' : '0.85'})`,
          opacity: isToastVisible ? 1 : 0,
          background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)',
          border: '1px solid var(--color-border)',
          borderRadius: '999px',
          padding: '8px 18px',
          fontSize: '13px',
          fontWeight: 700,
          color: 'var(--color-primary)',
          zIndex: 100, // Highest z-index to appear over everything like Dynamic Island
          textAlign: 'center',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 8px 32px color-mix(in srgb, var(--color-primary) 20%, transparent)',
          transition: 'all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          maxWidth: '85vw',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center' }}>
          <Notification variant="Bold" color="var(--color-primary)" size={16} />
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {toastError || 'No error'}
        </span>
      </div>

      {/* ── Clinic card row — slides up from bottom on CLINICS_FOUND (z=28) */}
      {(clinics.length > 0 || clinicsFallbackMessage) && (
        <div
          style={{
            position: 'absolute',
            bottom: clinicRowBottom,
            left: 0,
            right: 0,
            zIndex: 28,
          }}
        >
          <ClinicCardRow clinics={clinics} fallbackMessage={clinicsFallbackMessage} />
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

      {/* ── Location banner — bottom sheet until confirmed (z=55) ─────── */}
      <LocationBanner
        detectedState={detectedState}
        confirmedLocation={effectiveConfirmedLocation}
        hasGPSError={hasGPSError}
        isLoading={geoLoading}
        onConfirm={handleLocationConfirm}
        onDeny={() => {
          /* Deny is handled internally in LocationBanner — switches to manual input */
        }}
      />

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
              background: 'var(--color-surface)',
              border: '1.5px solid var(--color-border)',
              borderRadius: '12px',
              padding: '0 14px',
              fontSize: '15px',
              color: 'var(--color-text)',
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
                ? 'var(--color-primary)'
                : 'color-mix(in srgb, var(--color-primary) 30%, transparent)',
              color: 'var(--color-white)',
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

