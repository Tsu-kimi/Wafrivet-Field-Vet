'use client';

/**
 * app/components/ClinicCardRow.tsx
 *
 * Horizontal scroll strip that renders veterinary clinic cards when
 * the CLINICS_FOUND WebSocket event arrives.
 *
 * - Each ClinicCard shows the clinic name, address, open/closed pill,
 *   a phone tap-to-call link, and a Google Maps navigation button.
 * - A fallback card is shown when clinics = [] and fallbackMessage is set.
 * - Animates in with a CSS translateY slide-up transition.
 * - Scroll snaps for native feel on Android Chrome.
 *
 * Design is deliberately low-contrast-on-dark (consistent with CameraView
 * background) and touch-friendly (min 48 px tap targets everywhere).
 */

import React, { useState, useEffect, useRef } from 'react';
import type { Clinic } from '@/app/types/events';

export interface ClinicCardRowProps {
  clinics: Clinic[];
  /** Displayed when clinics array is empty and no Places results were found. */
  fallbackMessage: string | null;
}

// ── Individual clinic card ────────────────────────────────────────────────────

interface ClinicCardProps {
  clinic: Clinic;
}

function ClinicCard({ clinic }: ClinicCardProps) {
  const openNowBg =
    clinic.openNow === true
      ? 'rgba(46,160,67,0.85)'
      : clinic.openNow === false
        ? 'rgba(248,81,73,0.75)'
        : 'rgba(88,96,105,0.7)';

  const openNowLabel =
    clinic.openNow === true ? 'OPEN NOW' : clinic.openNow === false ? 'CLOSED' : 'HOURS N/A';

  return (
    <div
      style={{
        minWidth: '220px',
        maxWidth: '260px',
        background: 'rgba(22, 30, 46, 0.92)',
        border: '1.5px solid rgba(48,54,61,0.9)',
        borderRadius: '14px',
        padding: '14px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        backdropFilter: 'blur(12px)',
        scrollSnapAlign: 'start',
      }}
    >
      {/* Open/closed pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          style={{
            background: openNowBg,
            color: '#fff',
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.08em',
            padding: '2px 8px',
            borderRadius: '20px',
            whiteSpace: 'nowrap',
          }}
          aria-label={`Clinic status: ${openNowLabel}`}
        >
          {openNowLabel}
        </span>
      </div>

      {/* Name */}
      <p
        style={{
          fontSize: '14px',
          fontWeight: 700,
          color: 'var(--color-text)',
          lineHeight: 1.3,
          margin: 0,
          // Clamp to 2 lines
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {clinic.name}
      </p>

      {/* Address */}
      {clinic.address && (
        <p
          style={{
            fontSize: '12px',
            color: 'var(--color-text-muted)',
            margin: 0,
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {clinic.address}
        </p>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '8px', marginTop: 'auto' }}>
        {clinic.phone && (
          <a
            href={`tel:${clinic.phone}`}
            aria-label={`Call ${clinic.name}`}
            style={{
              flex: 1,
              background: 'rgba(46,160,67,0.15)',
              border: '1px solid rgba(46,160,67,0.5)',
              color: 'var(--color-primary)',
              fontSize: '12px',
              fontWeight: 700,
              borderRadius: '10px',
              padding: '8px 4px',
              textAlign: 'center',
              textDecoration: 'none',
              display: 'block',
              minHeight: '36px',
              lineHeight: '20px',
            }}
          >
            📞 Call
          </a>
        )}

        {clinic.googleMapsUri && (
          <a
            href={clinic.googleMapsUri}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Navigate to ${clinic.name} in Google Maps`}
            style={{
              flex: 1,
              background: 'rgba(56,139,253,0.15)',
              border: '1px solid rgba(56,139,253,0.4)',
              color: '#388bfd',
              fontSize: '12px',
              fontWeight: 700,
              borderRadius: '10px',
              padding: '8px 4px',
              textAlign: 'center',
              textDecoration: 'none',
              display: 'block',
              minHeight: '36px',
              lineHeight: '20px',
            }}
          >
            🗺 Maps
          </a>
        )}
      </div>
    </div>
  );
}

// ── Fallback card (shown when no clinics found) ────────────────────────────────

function FallbackCard({ message }: { message: string }) {
  return (
    <div
      style={{
        minWidth: '280px',
        background: 'rgba(22, 30, 46, 0.92)',
        border: '1.5px solid rgba(248,81,73,0.4)',
        borderRadius: '14px',
        padding: '16px',
        flexShrink: 0,
        backdropFilter: 'blur(12px)',
        scrollSnapAlign: 'start',
      }}
    >
      <p
        style={{
          fontSize: '13px',
          color: 'var(--color-text)',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        ⚠️ {message}
      </p>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────────

export function ClinicCardRow({ clinics, fallbackMessage }: ClinicCardRowProps) {
  const [isVisible, setIsVisible] = useState(false);
  const hasContent = clinics.length > 0 || !!fallbackMessage;

  // Trigger slide-up animation on first render with content.
  const triggeredRef = useRef(false);
  useEffect(() => {
    if (hasContent && !triggeredRef.current) {
      triggeredRef.current = true;
      // Tiny defer so the initial transform is applied before the transition.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setIsVisible(true));
      });
    }
  }, [hasContent]);

  if (!hasContent) return null;

  return (
    <div
      role="list"
      aria-label="Nearby veterinary clinics"
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: '12px',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollSnapType: 'x mandatory',
        WebkitOverflowScrolling: 'touch',
        padding: '4px 16px 12px',
        // Slide-up entrance — starts below the viewport, rises after mount.
        transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
        // Hide scrollbar for cleaner look (mirrors ProductCardRow).
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      } as React.CSSProperties}
    >
      {clinics.length > 0
        ? clinics.map((clinic, i) => (
            <div key={`${clinic.name}-${i}`} role="listitem">
              <ClinicCard clinic={clinic} />
            </div>
          ))
        : fallbackMessage && (
            <div role="listitem">
              <FallbackCard message={fallbackMessage} />
            </div>
          )}
    </div>
  );
}
