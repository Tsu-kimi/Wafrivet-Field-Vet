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

  // ── Confirmed pill ────────────────────────────────────────────────────────
  if (confirmedLocation) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          bottom: 'calc(14px + var(--spacing-safe-bottom))',
          left: '16px',
          background: 'rgba(46, 160, 67, 0.22)',
          border: '1px solid rgba(63, 185, 80, 0.5)',
          borderRadius: '24px',
          padding: '7px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          zIndex: 55,
          animation: 'fade-in 0.4s ease',
          backdropFilter: 'blur(8px)',
        }}
      >
        <span style={{ fontSize: '14px' }}>📍</span>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 700,
            color: '#3fb950',
            textShadow: '0 1px 3px rgba(0,0,0,0.6)',
          }}
        >
          {confirmedLocation}
        </span>
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
        background: 'rgba(16, 22, 32, 0.97)',
        borderTopLeftRadius: '22px',
        borderTopRightRadius: '22px',
        padding: '22px 18px',
        paddingBottom: 'calc(22px + var(--spacing-safe-bottom))',
        zIndex: 55,
        animation: 'slide-up 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
        borderTop: '1px solid rgba(255,255,255,0.09)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 -4px 40px rgba(0,0,0,0.5)',
      }}
    >
      {/* ── Loading state ────────────────────────────────────────────────── */}
      {isLoading && !detectedState && !hasGPSError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            color: '#8b949e',
            minHeight: '48px',
          }}
        >
          <span style={{ fontSize: '20px' }}>📍</span>
          <span style={{ fontSize: '15px', fontWeight: 500 }}>
            Detecting your location…
          </span>
        </div>
      )}

      {/* ── Manual text input (GPS failed or user denied) ────────────────── */}
      {showManualInput && (
        <div>
          <p
            style={{
              fontSize: '15px',
              fontWeight: 700,
              color: '#e6edf3',
              marginBottom: '6px',
            }}
          >
            {hasGPSError
              ? '📍 GPS unavailable — enter your state'
              : '📍 Enter your Nigerian state'}
          </p>
          <p
            style={{
              fontSize: '13px',
              color: '#8b949e',
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
                background: '#1c2535',
                border: '1.5px solid #30363d',
                borderRadius: '12px',
                padding: '0 14px',
                fontSize: '16px',
                color: '#e6edf3',
                minHeight: '52px',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={!manualState.trim()}
              style={{
                background: manualState.trim() ? '#2ea043' : 'rgba(46,160,67,0.3)',
                color: '#fff',
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
              color: '#8b949e',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: '6px',
            }}
          >
            📍 Detected location
          </p>
          <p
            style={{
              fontSize: '22px',
              fontWeight: 800,
              color: '#e6edf3',
              marginBottom: '10px',
              lineHeight: 1.2,
            }}
          >
            {detectedState}
          </p>
          <p
            style={{
              fontSize: '13px',
              color: '#8b949e',
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
                background: 'linear-gradient(135deg, #2ea043, #238636)',
                color: '#fff',
                border: 'none',
                borderRadius: '14px',
                padding: '0 14px',
                fontSize: '16px',
                fontWeight: 700,
                cursor: 'pointer',
                minHeight: '56px',
                boxShadow: '0 4px 16px rgba(46,160,67,0.35)',
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
                color: '#e6edf3',
                border: '1.5px solid #30363d',
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
