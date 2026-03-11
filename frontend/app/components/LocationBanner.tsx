'use client';

/**
 * app/components/LocationBanner.tsx
 *
 * Bottom-sheet location detection UI.
 *
 * States:
 *   - Loading: GPS still resolving → "Detecting your location…"
 *   - Detected: state resolved, awaiting user confirm / deny
 *   - Manual input: after deny OR when GPS failed (hasGPSError)
 *   - Confirmed (confirmedLocation set): show small confirmed pill
 *
 * Confirm flow: calls onConfirm(detectedState) → backend fires update_location
 *                → LOCATION_CONFIRMED event → confirmedLocation is set
 * Deny flow:    setIsDenied → render text input → onConfirm(manualEntry)
 */

import React, { useState, useId } from 'react';
import { Location, Global } from 'iconsax-react';


export interface LocationBannerProps {
  /** Nominatim-resolved state string. Null while GPS is loading or failed. */
  detectedState: string | null;
  /** Set by LOCATION_CONFIRMED — triggers the "confirmed pill" view. */
  confirmedLocation: string | null;
  hasGPSError: boolean;
  isLoading: boolean;
  /** Call sendSessionContext(state) — wires to the backend update_location tool. */
  onConfirm: (state: string) => void;
  /** Called when the user taps "Not my state" — switches to manual input. */
  onDeny: () => void;
}

export function LocationBanner({
  detectedState,
  confirmedLocation,
  hasGPSError,
  isLoading,
  onConfirm,
  onDeny,
}: LocationBannerProps) {
  const [isDenied, setIsDenied]       = useState(false);
  const [manualState, setManualState] = useState('');
  const inputId = useId();

  // ── Confirmed pill & Globe Link ───────────────────────────────────────────
  if (confirmedLocation) {
    return (
      <div style={{
        position: 'absolute',
        top: 'calc(14px + var(--spacing-safe-top))',
        left: '16px',
        right: '16px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start', // Align to top to allow individual top-offsets if needed
        zIndex: 55,
        pointerEvents: 'none', // Allow clicks to pass through the container
      }}>
        {/* Left Side: Location Pill */}
        <div
          role="status"
          aria-live="polite"
          style={{
            background: 'color-mix(in srgb, var(--color-primary) 22%, transparent)',
            border: '1px solid var(--color-white)',
            borderRadius: '24px',
            padding: '7px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            animation: 'fade-in 0.4s ease',
            backdropFilter: 'blur(8px)',
            pointerEvents: 'auto', // Re-enable clicks for the pill itself
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center' }}>
            <Location variant="Bold" color="var(--color-white)" size={16} />
          </span>
          <span
            style={{
              fontSize: '13px',
              fontWeight: 700,
              color: 'var(--color-white)',
            }}
          >
            {confirmedLocation}
          </span>
        </div>

        {/* Right Side: Website Link */}
        <a
          href="https://wafrivet.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            background: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
            border: '1px solid var(--color-border)',
            backdropFilter: 'blur(8px)',
            pointerEvents: 'auto', // Re-enable clicks for the link
            transition: 'background 0.2s',
            marginTop: '50px', // Below the notification icon (40px icon + 10px gap)
          }}
          aria-label="Visit Wafrivet website"
        >
          <Global variant="Linear" color="var(--color-white)" size={24} />
        </a>
      </div>
    );
  }

  const showManualInput = hasGPSError || isDenied;

  return (
    <div
      role="dialog"
      aria-label="Location confirmation"
      aria-modal="false"
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'color-mix(in srgb, var(--color-surface-2) 97%, transparent)',
        borderTopLeftRadius: '22px',
        borderTopRightRadius: '22px',
        padding: '22px 18px',
        paddingBottom: 'calc(22px + var(--spacing-safe-bottom))',
        zIndex: 55,
        animation: 'slide-up 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
        borderTop: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 -4px 40px rgba(0,0,0,0.1)',
      }}
    >
      {/* ── Loading state ────────────────────────────────────────────────── */}
      {isLoading && !detectedState && !hasGPSError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            color: 'var(--color-text-muted)',
            minHeight: '48px',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center' }}>
            <Location variant="Linear" color="var(--color-text-muted)" size={24} />
          </span>
          <span style={{ fontSize: '15px', fontWeight: 500, fontFamily: 'var(--font-fraunces)' }}>
            Detecting your location…
          </span>
        </div>
      )}

      {/* ── Manual text input (GPS failed or user denied) ────────────────── */}
      {showManualInput && (
        <div>
          <p
            style={{
              fontSize: '18px',
              fontFamily: 'var(--font-fraunces)',
              fontWeight: 700,
              color: 'var(--color-text)',
              marginBottom: '6px',
            }}
          >
            {hasGPSError
              ? 'GPS unavailable — enter your state'
              : 'Enter your Nigerian state'}
          </p>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--color-text-muted)',
              marginBottom: '14px',
              lineHeight: 1.5,
            }}
          >
            {hasGPSError
              ? 'Location access failed. Type your state below so we can show nearby products.'
              : 'Type your state to find veterinary products in your area.'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const val = manualState.trim();
              if (val) onConfirm(val);
            }}
            style={{ display: 'flex', gap: '10px' }}
          >
            <label htmlFor={inputId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>
              Nigerian state name
            </label>
            <input
              id={inputId}
              type="text"
              value={manualState}
              onChange={(e) => setManualState(e.target.value)}
              placeholder="e.g. Rivers, Lagos, Kano…"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              style={{
                flex: 1,
                background: 'var(--color-bg)',
                border: '1.5px solid var(--color-border)',
                borderRadius: '12px',
                padding: '0 14px',
                fontSize: '16px',
                color: 'var(--color-text)',
                minHeight: '52px',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={!manualState.trim()}
              style={{
                background: manualState.trim() ? 'var(--color-primary)' : 'color-mix(in srgb, var(--color-primary) 30%, transparent)',
                color: 'var(--color-white)',
                border: 'none',
                borderRadius: '12px',
                padding: '0 20px',
                fontSize: '15px',
                fontWeight: 700,
                cursor: manualState.trim() ? 'pointer' : 'not-allowed',
                minHeight: '52px',
                minWidth: '72px',
                transition: 'background 0.2s',
              }}
            >
              Go
            </button>
          </form>
        </div>
      )}

      {/* ── Detected state — confirm / deny ──────────────────────────────── */}
      {!showManualInput && detectedState && (
        <div>
          <p
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: '6px',
            }}
          >
            Detected location
          </p>
          <p
            style={{
              fontSize: '26px',
              fontFamily: 'var(--font-fraunces)',
              fontWeight: 800,
              color: 'var(--color-text)',
              marginBottom: '10px',
              lineHeight: 1.2,
            }}
          >
            {detectedState}
          </p>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--color-text-muted)',
              marginBottom: '18px',
              lineHeight: 1.55,
            }}
          >
            Is this correct? Confirming shows products available in your area.
          </p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => onConfirm(detectedState)}
              style={{
                flex: 1,
                background: 'var(--color-primary)',
                color: 'var(--color-white)',
                border: 'none',
                borderRadius: '14px',
                padding: '0 14px',
                fontSize: '16px',
                fontWeight: 700,
                cursor: 'pointer',
                minHeight: '56px',
                boxShadow: '0 4px 16px color-mix(in srgb, var(--color-primary) 35%, transparent)',
                touchAction: 'manipulation',
              }}
              aria-label={`Confirm location as ${detectedState}`}
            >
              ✓ Yes, that's me
            </button>
            <button
              onClick={() => {
                setIsDenied(true);
                onDeny();
              }}
              style={{
                flex: 1,
                background: 'transparent',
                color: 'var(--color-text)',
                border: '1.5px solid var(--color-border)',
                borderRadius: '14px',
                padding: '0 14px',
                fontSize: '16px',
                fontWeight: 600,
                cursor: 'pointer',
                minHeight: '56px',
                touchAction: 'manipulation',
              }}
              aria-label="Deny detected location and enter manually"
            >
              ✕ Wrong state
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
