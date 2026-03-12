'use client';

/**
 * app/components/FieldVetSession.tsx
 *
 * Main orchestration shell for WafriAI — Phase 5 Part 4.
 *
 * Layout (all children are position:absolute inside the full-screen <main>):
 *   z=0   CameraView        — fills viewport, rear camera + indicators
 *   z=20  TranscriptStrip   — semi-transparent strip, top portion
 *   z=30  ProductCardRow    — slides up from bottom when products arrive
 *   z=38  CartBadge         — floating bottom-right, only when cart non-empty
 *   z=45  PayButton         — full-width at bottom, only when checkoutUrl set
 *   z=55  LocationBanner    — bottom sheet until location confirmed
 *
 * Event wiring (all handled in useWebSocketSession reducer; effects here
 * drive animation triggers and imperative side-effects):
 *   PRODUCTS_RECOMMENDED → products state → ProductCardRow slide-up
 *   CART_UPDATED         → cartItems/cartTotal + cartVersion bump → CartBadge pulse
 *   CHECKOUT_LINK        → checkoutUrl → PayButton appears
 *   LOCATION_CONFIRMED   → confirmedLocation → LocationBanner pill
 *   binary frames        → onAudioChunk → audioPlayer (in WebSocketProvider)
 *   AUDIO_FLUSH          → onAudioFlush → flush (in WebSocketProvider)
 *   unhandled events     → console.warn in useWebSocketSession switch default
 */

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
} from 'react';

import { useWebSocketContext } from './WebSocketProvider';
import { Notification, CloseSquare } from 'iconsax-react';
import { useMediaPipeline } from '@/app/hooks/useMediaPipeline';
import { useGeolocation } from '@/app/hooks/useGeolocation';

import { CameraView } from './CameraView';
import { LocationBanner } from './LocationBanner';
import { ProductCardRow } from './ProductCardRow';
import { ClinicCardRow } from './ClinicCardRow';
import { CartBadge } from './CartBadge';
import { PayButton } from './PayButton';

import { PinOverlay } from './PinOverlay';
import { MediaControls } from './MediaControls';
import { ActionMenu } from './ActionMenu';

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
    lastError,
    isScanningProduct,
    orderConfirmed,
    pinRequired,
    paymentConfirmed,
    sendAudio,
    sendImage,
    sendText,
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

  // Send GPS coordinates to the backend as soon as lat/lon resolve so
  // find_nearest_vet_clinic can be called immediately, even before geocoding.
  const gpsSentRef = useRef(false);
  useEffect(() => {
    if (lat !== null && lon !== null && !gpsSentRef.current) {
      if (connectionState !== 'connected') {
        console.log(
          `[FieldVetSession] GPS resolved (lat=${lat}, lon=${lon}) but WS is "${connectionState}" — will send once connected`,
        );
        return;
      }
      gpsSentRef.current = true;
      console.log(
        `[FieldVetSession] Sending LOCATION_DATA (GPS only) — lat=${lat}, lon=${lon}`,
      );
      // Send coords immediately (state may still be null — geocoding in progress)
      sendLocationData(lat, lon, null, null);
    }
  }, [lat, lon, connectionState, sendLocationData]);

  // Once geocoding resolves, send a second LOCATION_DATA with the state name.
  // This always runs even if GPS coords were already sent, so the backend
  // receives the geocoded state independently of the raw GPS send above.
  const stateSentRef = useRef(false);
  useEffect(() => {
    if (detectedState && !stateSentRef.current && connectionState === 'connected') {
      stateSentRef.current = true;
      console.log(
        `[FieldVetSession] Sending LOCATION_DATA (geocoded) — state="${detectedState}", lga="${lga}"`,
      );
      sendLocationData(lat, lon, detectedState, lga);
    }
  }, [detectedState, connectionState, lat, lon, lga, sendLocationData]);

  // Reset both flags on reconnect so location is re-sent after a session drop.
  useEffect(() => {
    if (connectionState === 'connecting') {
      gpsSentRef.current = false;
      stateSentRef.current = false;
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
  const [errorLog, setErrorLog] = useState<{ id: number, message: string, time: Date }[]>([]);
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
  const {
    videoRef,
    canvasRef,
    isCapturing,
    permissionError,
    activateMic,
    isMuted,
    isCameraPaused,
    toggleMute,
    toggleCamera
  } = useMediaPipeline({
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

  const handleResetLocation = useCallback(() => {
    setLocalConfirmedLocation(null);
    // You might also want to tell the user they can re-detect or re-enter
  }, []);

  const handleShowCart = useCallback(() => {
    // Scroll to cart or highlight cart badge
    // Since CartBadge has its own positioning, we'll just pulse it again
    setCartVersion(v => v + 1);
  }, []);

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

  // MediaControls bottom position — sitting just above the cart badge or pay button area
  const mediaControlsBottom = payButtonVisible
    ? 'calc(180px + var(--spacing-safe-bottom))'
    : 'calc(100px + var(--spacing-safe-bottom))';

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

      {/* ── Scanning product overlay — shown while identify_product_from_frame is active (z=60) */}
      {isScanningProduct && (
        <div
          role="status"
          aria-live="polite"
          aria-label="Scanning product label"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(3px)',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: '72px',
              height: '72px',
              borderRadius: '50%',
              border: '4px solid color-mix(in srgb, var(--color-white) 15%, transparent)',
              borderTopColor: 'var(--color-primary)',
              animation: 'spin 0.9s linear infinite',
              marginBottom: '16px',
            }}
          />
          <p style={{ color: 'var(--color-white)', fontSize: '14px', fontWeight: 700, textAlign: 'center', margin: 0 }}>
            Reading label…
          </p>
        </div>
      )}

      {/* ── Order confirmed banner (z=62) ─────────────────────────────────── */}
      {orderConfirmed && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 'calc(16px + var(--spacing-safe-top))',
            left: '16px',
            right: '16px',
            zIndex: 62,
            background: 'color-mix(in srgb, var(--color-forest) 95%, transparent)',
            border: '1.5px solid var(--color-primary)',
            borderRadius: '14px',
            padding: '14px 16px',
            backdropFilter: 'blur(10px)',
            animation: 'slide-up 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <p style={{ margin: '0 0 2px', fontSize: '11px', fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            ✓ Order confirmed
          </p>
          <p style={{ margin: '0 0 6px', fontSize: '16px', fontWeight: 800, color: 'var(--color-white)' }}>
            Ref: {orderConfirmed.order_reference}
          </p>
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-text-muted)' }}>
            ₦{orderConfirmed.total.toLocaleString('en-NG')} · Delivery: {orderConfirmed.estimated_delivery}
            {orderConfirmed.sms_sent && ' · SMS sent ✓'}
          </p>
        </div>
      )}

      {/* ── Payment confirmed banner (z=63) ─────────────────────────────────── */}
      {paymentConfirmed && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: orderConfirmed
              ? 'calc(130px + var(--spacing-safe-top))'
              : 'calc(16px + var(--spacing-safe-top))',
            left: '16px',
            right: '16px',
            zIndex: 63,
            background: 'color-mix(in srgb, #14532d 95%, transparent)',
            border: '1.5px solid #22c55e',
            borderRadius: '14px',
            padding: '14px 16px',
            backdropFilter: 'blur(10px)',
            animation: 'slide-up 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <p style={{ margin: '0 0 2px', fontSize: '11px', fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            ✓ Payment received
          </p>
          <p style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: 800, color: 'var(--color-white)' }}>
            ₦{paymentConfirmed.amount_ngn.toLocaleString('en-NG')} confirmed
          </p>
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--color-text-muted)' }}>
            Ref: {paymentConfirmed.payment_reference}
          </p>
        </div>
      )}

      {/* ── Top Right Action Menu (Dropdown) ─────────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(14px + var(--spacing-safe-top))',
          right: '16px',
          zIndex: 65,
        }}
      >
        <ActionMenu
          onShowNotifications={() => setShowErrorLog(true)}
          onResetLocation={handleResetLocation}
          onShowCart={handleShowCart}
          hasNotifications={errorLog.length > 0}
        />
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

      {/* ── Media Controls — bottom-right (z=35) ─────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          bottom: mediaControlsBottom,
          right: '16px',
          zIndex: 35,
        }}
      >
        <MediaControls
          isMuted={isMuted}
          isCameraPaused={isCameraPaused}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
          isVisible={isCapturing}
        />
      </div>

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

      {/* ── Phase 5 PIN overlay — full-screen, highest z-index (z=200) ────────── */}
      {pinRequired && (
        <PinOverlay
          phoneNumber={pinRequired.phone_number}
          isReturning={pinRequired.is_returning}
          onSuccess={() => {
            // sendPinVerified is called inside PinOverlay via context — it
            // dispatches IDENTITY_VERIFIED which sets pinRequired to null,
            // causing this component to unmount automatically.
          }}
        />
      )}
    </main>
  );
}

