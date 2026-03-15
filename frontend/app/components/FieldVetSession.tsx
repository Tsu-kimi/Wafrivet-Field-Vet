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
import { useRouter } from 'next/navigation';

import { useWebSocketContext } from './WebSocketProvider';
import { Notification, CloseSquare, Location } from 'iconsax-react';
import { useMediaPipeline } from '@/app/hooks/useMediaPipeline';
import { useGeolocation } from '@/app/hooks/useGeolocation';

import { CameraView } from './CameraView';
import { LocationBanner } from './LocationBanner';
import { ProductCardRow } from './ProductCardRow';
import { ClinicCardRow } from './ClinicCardRow';
import { PayButton } from './PayButton';

import { MediaControls } from './MediaControls';
import { ActionMenu } from './ActionMenu';
import { CartOverlay } from './CartOverlay';

import type { Product } from '@/app/types/events';

type AddressForm = {
  unit: string;
  street: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
  delivery_phone: string;
};

type SavedAddress = AddressForm & {
  id: string;
  is_default: boolean;
  formatted: string;
};

const EMPTY_ADDRESS_FORM: AddressForm = {
  unit: '',
  street: '',
  city: '',
  state: '',
  country: 'Nigeria',
  postal_code: '',
  delivery_phone: '',
};

// ── Component ─────────────────────────────────────────────────────────────────

export function FieldVetSession() {
  const router = useRouter();

  // ── WebSocket context ───────────────────────────────────────────────────────
  const {
    connectionState,
    products,
    cartItems,
    cartTotal,
    checkoutUrl,
    payment_reference,
    clinics,
    clinicsFallbackMessage,
    confirmedLocation,
    lastError,
    isScanningProduct,
    paymentConfirmed,
    sendAudio,
    sendImage,
    sendText,
    resumeContext,
    sendLocationData,
    locationSnapshotRef,
    retryConnection,
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

  // Keep location snapshot ref updated so WebSocket onopen can send LOCATION_DATA as first message.
  useEffect(() => {
    if (locationSnapshotRef && lat !== null && lon !== null) {
      locationSnapshotRef.current = {
        lat,
        lon,
        state: detectedState ?? undefined,
        lga: lga ?? undefined,
      };
    }
  }, [lat, lon, detectedState, lga, locationSnapshotRef]);

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
    if (detectedState && lat !== null && lon !== null && !stateSentRef.current && connectionState === 'connected') {
      stateSentRef.current = true;
      console.log(
        `[FieldVetSession] Sending LOCATION_DATA (geocoded) — state="${detectedState}", lga="${lga}"`,
      );
      sendLocationData(lat, lon, detectedState, lga);
    }
  }, [detectedState, connectionState, lat, lon, lga, sendLocationData]);

  // Reset both flags on reconnect so location is re-sent after a session drop.
  useEffect(() => {
    if (connectionState === 'connecting' || connectionState === 'reconnecting') {
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
  const [notifications, setNotifications] = useState<
    { id: number; message: string; time: Date; level: 'error' | 'success' }[]
  >([]);
  const [toastError, setToastError] = useState<string | null>(null);
  const [isToastVisible, setIsToastVisible] = useState(false);
  const [showErrorLog, setShowErrorLog] = useState(false);
  const [showOrderToast, setShowOrderToast] = useState(false);
  const [showCartOverlay, setShowCartOverlay] = useState(false);
  const [showStateEditor, setShowStateEditor] = useState(false);
  const [stateDraft, setStateDraft] = useState('');

  // ── Delivery address modal state ───────────────────────────────────────────
  const [showAddressModal, setShowAddressModal] = useState(false);
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [addressForm, setAddressForm] = useState<AddressForm>(EMPTY_ADDRESS_FORM);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [setDefaultOnSave, setSetDefaultOnSave] = useState(true);
  const [addressLoading, setAddressLoading] = useState(false);
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  const API_BASE =
    process.env.NEXT_PUBLIC_API_URL ??
    (process.env.NODE_ENV === 'production'
      ? 'https://fieldvet-backend-1041869895037.us-central1.run.app'
      : 'http://localhost:8000');

  const loadAddresses = useCallback(async () => {
    setAddressLoading(true);
    setAddressError(null);
    try {
      const resp = await fetch(`${API_BASE}/farmers/addresses`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!resp.ok) {
        throw new Error('Could not load address');
      }
      const data = (await resp.json()) as {
        selected_id?: string | null;
        addresses?: SavedAddress[];
      };
      const rows = data.addresses ?? [];
      setAddresses(rows);
      setSelectedAddressId(data.selected_id ?? null);

      if (rows.length === 0) {
        setEditingAddressId(null);
        setAddressForm(EMPTY_ADDRESS_FORM);
        setSetDefaultOnSave(true);
      }
    } catch {
      setAddressError('Could not load your saved addresses. You can still add a new one.');
    } finally {
      setAddressLoading(false);
    }
  }, [API_BASE]);

  const updateAddressFormField = useCallback((field: keyof AddressForm, value: string) => {
    setAddressForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const startCreateAddress = useCallback(() => {
    setEditingAddressId(null);
    setAddressForm(EMPTY_ADDRESS_FORM);
    setSetDefaultOnSave(addresses.length === 0);
    setAddressError(null);
  }, [addresses.length]);

  const startEditAddress = useCallback((addr: SavedAddress) => {
    setEditingAddressId(addr.id);
    setAddressForm({
      unit: addr.unit,
      street: addr.street,
      city: addr.city,
      state: addr.state,
      country: addr.country,
      postal_code: addr.postal_code,
      delivery_phone: addr.delivery_phone,
    });
    setSetDefaultOnSave(addr.is_default);
    setAddressError(null);
  }, []);

  const validateAddressForm = useCallback((): string | null => {
    const requiredEntries: [keyof AddressForm, string][] = [
      ['unit', 'unit'],
      ['street', 'street'],
      ['city', 'city'],
      ['state', 'state'],
      ['country', 'country'],
      ['postal_code', 'postal code'],
      ['delivery_phone', 'delivery phone number'],
    ];
    for (const [field, label] of requiredEntries) {
      if (!addressForm[field].trim()) {
        return `Please enter your ${label}.`;
      }
    }
    return null;
  }, [addressForm]);

  const saveAddress = useCallback(async () => {
    const validationError = validateAddressForm();
    if (validationError) {
      setAddressError(validationError);
      return;
    }

    setAddressSaving(true);
    setAddressError(null);
    try {
      const payload = {
        ...addressForm,
        set_default: setDefaultOnSave,
      };
      const endpoint = editingAddressId
        ? `${API_BASE}/farmers/addresses/${editingAddressId}`
        : `${API_BASE}/farmers/addresses`;
      const method = editingAddressId ? 'PUT' : 'POST';

      const resp = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        throw new Error('Could not save address');
      }

      await loadAddresses();
      setEditingAddressId(null);
      setAddressForm(EMPTY_ADDRESS_FORM);
      setSetDefaultOnSave(false);
      setNotifications((prev) => [
        ...prev,
        {
          id: Date.now(),
          message: editingAddressId ? 'Address updated.' : 'Address saved.',
          time: new Date(),
          level: 'success',
        },
      ]);
    } catch {
      setAddressError('Could not save address. Please try again.');
    } finally {
      setAddressSaving(false);
    }
  }, [API_BASE, addressForm, editingAddressId, loadAddresses, setDefaultOnSave, validateAddressForm]);

  const selectAddress = useCallback(async (addressId: string) => {
    setAddressSaving(true);
    setAddressError(null);
    try {
      const resp = await fetch(`${API_BASE}/farmers/addresses/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ address_id: addressId }),
      });
      if (!resp.ok) {
        throw new Error('Could not select address');
      }

      setSelectedAddressId(addressId);
      await loadAddresses();
      setNotifications((prev) => [
        ...prev,
        { id: Date.now(), message: 'Address selected for delivery.', time: new Date(), level: 'success' },
      ]);
    } catch {
      setAddressError('Could not select this address. Please try again.');
    } finally {
      setAddressSaving(false);
    }
  }, [API_BASE, loadAddresses]);

  const deleteAddress = useCallback(async (addressId: string) => {
    setAddressSaving(true);
    setAddressError(null);
    try {
      const resp = await fetch(`${API_BASE}/farmers/addresses/${addressId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!resp.ok) {
        throw new Error('Could not delete address');
      }

      if (editingAddressId === addressId) {
        setEditingAddressId(null);
        setAddressForm(EMPTY_ADDRESS_FORM);
      }
      await loadAddresses();
      setNotifications((prev) => [
        ...prev,
        { id: Date.now(), message: 'Address deleted.', time: new Date(), level: 'success' },
      ]);
    } catch {
      setAddressError('Could not delete address. Please try again.');
    } finally {
      setAddressSaving(false);
    }
  }, [API_BASE, editingAddressId, loadAddresses]);

  useEffect(() => {
    if (lastError) {
      setToastError(lastError);
      setIsToastVisible(true);
      setNotifications((prev) => [
        ...prev,
        { id: Date.now(), message: lastError, time: new Date(), level: 'error' },
      ]);

      if (lastError.toLowerCase().includes('delivery address')) {
        setShowAddressModal(true);
        void loadAddresses();
      }

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
  }, [lastError, clearError]);

  useEffect(() => {
    if (!paymentConfirmed) return;

    setShowOrderToast(true);
    setNotifications((prev) => [
      ...prev,
      {
        id: Date.now(),
        message: `Order confirmed. Payment ref ${paymentConfirmed.payment_reference}`,
        time: new Date(),
        level: 'success',
      },
    ]);

    const timer = setTimeout(() => {
      setShowOrderToast(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [paymentConfirmed]);

  useEffect(() => {
    void loadAddresses();
  }, [loadAddresses]);

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

  const handleShowCart = useCallback(() => {
    setShowCartOverlay(true);
  }, []);

  const handleAuthAction = useCallback(() => {
    const hasFarmer = !!localStorage.getItem('wafrivet_farmer');
    if (hasFarmer) {
      localStorage.removeItem('wafrivet_farmer');
      localStorage.removeItem('wafrivet_user_identity');
      sessionStorage.removeItem('wafrivet_user_id');
      sessionStorage.removeItem('wafrivet_session_id');
      router.replace('/login');
      return;
    }
    router.replace('/login');
  }, [router]);

  const handleCartIncrement = useCallback((item: { product_name: string; quantity: number }) => {
    sendText(`Change ${item.product_name} quantity to ${item.quantity + 1}`);
  }, [sendText]);

  const handleCartDecrement = useCallback((item: { product_name: string; quantity: number }) => {
    const nextQty = Math.max(item.quantity - 1, 0);
    if (nextQty === 0) {
      sendText(`Remove ${item.product_name} from my cart`);
      return;
    }
    sendText(`Change ${item.product_name} quantity to ${nextQty}`);
  }, [sendText]);

  const handleCartRemove = useCallback((item: { product_name: string }) => {
    sendText(`Remove ${item.product_name} from my cart`);
  }, [sendText]);

  const handleCartCheckout = useCallback(() => {
    sendText('I am ready to checkout now.');
  }, [sendText]);

  const handleSaveState = useCallback(() => {
    const cleaned = stateDraft.trim();
    if (!cleaned) return;
    setLocalConfirmedLocation(cleaned);
    sendText(`My location is ${cleaned}`);
    setShowStateEditor(false);
  }, [sendText, stateDraft]);

  // ── Add-to-cart voice command ───────────────────────────────────────────────
  const handleAddToCart = useCallback(
    (product: Product) => {
      const name = product.name?.trim() || product.product_name?.trim() || 'this product';
      sendText(`Add ${name} to my cart`);
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
  // MediaControls bottom position — sitting just above the cart badge or pay button area
  const hasProducts = products.length > 0;
  const mediaControlsBottom = hasProducts
    ? 'calc(355px + var(--spacing-safe-bottom))'
    : payButtonVisible
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
        isCameraPaused={isCameraPaused}
        permissionError={permissionError}
        connectionState={connectionState}
        onFirstTap={handleFirstTap}
        onRetryConnection={retryConnection}
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

      {/* ── Order confirmed toast (2 seconds) ─────────────────────────────── */}
      {showOrderToast && paymentConfirmed && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 'calc(16px + var(--spacing-safe-top))',
            left: '16px',
            right: '16px',
            zIndex: 62,
            background: 'color-mix(in srgb, #14532d 95%, transparent)',
            border: '1.5px solid #22c55e',
            borderRadius: '14px',
            padding: '14px 16px',
            backdropFilter: 'blur(10px)',
            animation: 'slide-up 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <p style={{ margin: '0 0 2px', fontSize: '11px', fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            ✓ Order confirmed
          </p>
          <p style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: 800, color: 'var(--color-white)' }}>
            ₦{paymentConfirmed.amount_ngn.toLocaleString('en-NG')} payment confirmed
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
          onManageAddress={() => {
            setShowAddressModal(true);
            void loadAddresses();
          }}
          onShowCart={handleShowCart}
          onAuthAction={handleAuthAction}
          isLoggedIn={typeof window !== 'undefined' && !!localStorage.getItem('wafrivet_farmer')}
          hasNotifications={notifications.length > 0}
          cartCount={cartItems.length}
          cartTotal={cartTotal}
        />
      </div>

      {effectiveConfirmedLocation && (
        <button
          onClick={() => {
            setStateDraft(effectiveConfirmedLocation);
            setShowStateEditor(true);
          }}
          aria-label="Edit your state"
          style={{
            position: 'absolute',
            top: 'calc(14px + var(--spacing-safe-top))',
            left: '16px',
            zIndex: 64,
            minHeight: '42px',
            borderRadius: '999px',
            border: '1.5px solid var(--color-white)',
            background: '#000000',
            color: 'var(--color-white)',
            padding: '0 16px',
            fontSize: '14px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            whiteSpace: 'nowrap',
            backdropFilter: 'blur(10px)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <Location size={18} variant="Bold" color="var(--color-white)" />
          {effectiveConfirmedLocation}
        </button>
      )}

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
          {notifications.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '14px', margin: 0 }}>No errors reported.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {notifications.slice().reverse().map((entry) => (
                <div key={entry.id} style={{ background: entry.level === 'error' ? 'color-mix(in srgb, var(--color-error) 12%, transparent)' : 'color-mix(in srgb, var(--color-primary) 16%, transparent)', padding: '10px', borderRadius: '8px', borderLeft: `3px solid ${entry.level === 'error' ? 'var(--color-error)' : 'var(--color-primary)'}` }}>
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-text)' }}>{entry.message}</p>
                  <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'var(--color-text-muted)' }}>{entry.time.toLocaleTimeString()}</p>
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


      {/* ── Media Controls — bottom-right (z=35) ─────────────────────────── */}
      <div
        style={{
          position: 'absolute',
          bottom: mediaControlsBottom,
          right: hasProducts ? '50%' : '16px',
          transform: hasProducts ? 'translateX(50%)' : 'none',
          zIndex: 35,
          transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        <MediaControls
          isMuted={isMuted}
          isCameraPaused={isCameraPaused}
          onToggleMute={toggleMute}
          onToggleCamera={toggleCamera}
          isVisible={isCapturing}
          orientation={hasProducts ? 'horizontal' : 'vertical'}
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
          <PayButton cartTotal={cartTotal} paymentReference={payment_reference ?? ''} />
        </div>
      )}

      {/* ── Delivery address modal ───────────────────────────────────────── */}
      {showAddressModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Delivery address"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 110,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '460px',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '16px',
              padding: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <h3 style={{ margin: 0, color: 'var(--color-text)', fontFamily: 'var(--font-fraunces)', fontSize: '20px' }}>
              Delivery Addresses
            </h3>
            <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '13px', lineHeight: 1.5 }}>
              Save one or more addresses, then select your delivery address for checkout.
            </p>

            <div
              style={{
                maxHeight: '220px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                paddingRight: '4px',
              }}
            >
              {addressLoading ? (
                <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '13px' }}>Loading addresses...</p>
              ) : addresses.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '13px' }}>
                  No saved addresses yet. Add one below.
                </p>
              ) : (
                [...addresses]
                  .sort((a, b) => {
                    if (a.id === selectedAddressId) return -1;
                    if (b.id === selectedAddressId) return 1;
                    return 0;
                  })
                  .map((addr) => {
                  const isSelected = addr.id === selectedAddressId;
                  return (
                    <div
                      key={addr.id}
                      style={{
                        border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                        borderRadius: '12px',
                        padding: '10px 12px',
                        background: isSelected
                          ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-surface))'
                          : 'var(--color-bg)',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        <p style={{ margin: 0, color: 'var(--color-text)', fontSize: '13px', fontWeight: 700, flex: 1 }}>
                          {addr.formatted}
                        </p>
                        {isSelected && (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            background: 'var(--color-primary)',
                            color: 'var(--color-white)',
                            borderRadius: '20px',
                            padding: '2px 8px',
                            fontSize: '11px',
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}>
                            ✓ Delivery
                          </span>
                        )}
                      </div>
                      <p style={{ margin: '4px 0 0', color: 'var(--color-text-muted)', fontSize: '12px' }}>
                        Phone: {addr.delivery_phone}
                      </p>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                        {!isSelected && (
                          <button
                            onClick={() => void selectAddress(addr.id)}
                            disabled={addressSaving}
                            style={{
                              minHeight: '32px',
                              borderRadius: '8px',
                              border: 'none',
                              background: 'var(--color-primary)',
                              color: 'var(--color-white)',
                              padding: '0 12px',
                              fontSize: '12px',
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            Use for delivery
                          </button>
                        )}
                        <button
                          onClick={() => startEditAddress(addr)}
                          disabled={addressSaving}
                          style={{
                            minHeight: '32px',
                            borderRadius: '8px',
                            border: '1px solid var(--color-border)',
                            background: 'transparent',
                            color: 'var(--color-text)',
                            padding: '0 10px',
                            fontSize: '12px',
                            cursor: 'pointer',
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => void deleteAddress(addr.id)}
                          disabled={addressSaving}
                          style={{
                            minHeight: '32px',
                            borderRadius: '8px',
                            border: '1px solid color-mix(in srgb, var(--color-error) 45%, var(--color-border))',
                            background: 'transparent',
                            color: 'var(--color-error)',
                            padding: '0 10px',
                            fontSize: '12px',
                            cursor: 'pointer',
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                <h4 style={{ margin: 0, color: 'var(--color-text)', fontSize: '15px' }}>
                  {editingAddressId ? 'Edit delivery address' : 'Add a new delivery address'}
                </h4>
                <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '12px' }}>
                  We&apos;ll use this as the drop-off location for your order.
                </p>
              </div>
              {addresses.length > 0 && (
                <button
                  onClick={startCreateAddress}
                  disabled={addressSaving}
                  style={{
                    minHeight: '32px',
                    borderRadius: '999px',
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-surface-2)',
                    color: 'var(--color-text)',
                    padding: '0 14px',
                    fontSize: '12px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  + New address
                </button>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: '10px',
              }}
            >
              <input
                value={addressForm.unit}
                onChange={(e) => updateAddressFormField('unit', e.target.value)}
                placeholder="Unit"
                disabled={addressLoading || addressSaving}
                style={{
                  minHeight: '44px',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '10px',
                  padding: '0 12px',
                  fontSize: '14px',
                }}
              />
              <input
                value={addressForm.street}
                onChange={(e) => updateAddressFormField('street', e.target.value)}
                placeholder="Street"
                disabled={addressLoading || addressSaving}
                style={{
                  minHeight: '44px',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '10px',
                  padding: '0 12px',
                  fontSize: '14px',
                }}
              />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                  gap: '10px',
                }}
              >
                <input
                  value={addressForm.city}
                  onChange={(e) => updateAddressFormField('city', e.target.value)}
                  placeholder="City"
                  disabled={addressLoading || addressSaving}
                  style={{
                    minHeight: '44px',
                    background: 'var(--color-bg)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '10px',
                    padding: '0 12px',
                    fontSize: '14px',
                  }}
                />
                <input
                  value={addressForm.state}
                  onChange={(e) => updateAddressFormField('state', e.target.value)}
                  placeholder="State"
                  disabled={addressLoading || addressSaving}
                  style={{
                    minHeight: '44px',
                    background: 'var(--color-bg)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '10px',
                    padding: '0 12px',
                    fontSize: '14px',
                  }}
                />
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                  gap: '10px',
                }}
              >
                <input
                  value={addressForm.country}
                  onChange={(e) => updateAddressFormField('country', e.target.value)}
                  placeholder="Country"
                  disabled={addressLoading || addressSaving}
                  style={{
                    minHeight: '44px',
                    background: 'var(--color-bg)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '10px',
                    padding: '0 12px',
                    fontSize: '14px',
                  }}
                />
                <input
                  value={addressForm.postal_code}
                  onChange={(e) => updateAddressFormField('postal_code', e.target.value)}
                  placeholder="Postal code"
                  disabled={addressLoading || addressSaving}
                  style={{
                    minHeight: '44px',
                    background: 'var(--color-bg)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '10px',
                    padding: '0 12px',
                    fontSize: '14px',
                  }}
                />
              </div>
              <input
                value={addressForm.delivery_phone}
                onChange={(e) => updateAddressFormField('delivery_phone', e.target.value)}
                placeholder="Delivery phone number"
                disabled={addressLoading || addressSaving}
                style={{
                  minHeight: '44px',
                  background: 'var(--color-bg)',
                  color: 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '10px',
                  padding: '0 12px',
                  fontSize: '14px',
                }}
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text)', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={setDefaultOnSave}
                onChange={(e) => setSetDefaultOnSave(e.target.checked)}
                disabled={addressLoading || addressSaving}
              />
              Use as default delivery address
            </label>

            {addressError && (
              <p style={{ margin: 0, color: 'var(--color-error)', fontSize: '12px' }}>{addressError}</p>
            )}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowAddressModal(false);
                  setAddressError(null);
                }}
                disabled={addressSaving}
                style={{
                  minHeight: '44px',
                  padding: '0 14px',
                  borderRadius: '10px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void saveAddress()}
                disabled={addressLoading || addressSaving}
                style={{
                  minHeight: '44px',
                  padding: '0 14px',
                  borderRadius: '10px',
                  border: 'none',
                  background: 'var(--color-primary)',
                  color: 'var(--color-white)',
                  fontWeight: 700,
                }}
              >
                {addressSaving ? 'Saving...' : editingAddressId ? 'Update Address' : 'Save Address'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showStateEditor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit state"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 112,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '420px',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '16px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <h3 style={{ margin: 0, color: 'var(--color-text)', fontFamily: 'var(--font-fraunces)' }}>Change State</h3>
            <input
              value={stateDraft}
              onChange={(e) => setStateDraft(e.target.value)}
              placeholder="e.g. Rivers"
              style={{
                minHeight: '46px',
                borderRadius: '10px',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg)',
                color: 'var(--color-text)',
                padding: '0 12px',
              }}
            />
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowStateEditor(false)}
                style={{
                  minHeight: '42px',
                  borderRadius: '10px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  padding: '0 14px',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveState}
                style={{
                  minHeight: '42px',
                  borderRadius: '10px',
                  border: 'none',
                  background: 'var(--color-primary)',
                  color: 'var(--color-white)',
                  padding: '0 14px',
                  fontWeight: 700,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <CartOverlay
        open={showCartOverlay}
        items={cartItems}
        total={cartTotal}
        onClose={() => setShowCartOverlay(false)}
        onIncrement={handleCartIncrement}
        onDecrement={handleCartDecrement}
        onRemove={handleCartRemove}
        onCheckout={handleCartCheckout}
      />

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

    </main>
  );
}

