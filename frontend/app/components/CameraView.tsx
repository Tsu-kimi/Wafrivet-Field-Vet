'use client';

/**
 * app/components/CameraView.tsx
 *
 * Full-screen rear-camera video preview.
 *
 * - video element fills the viewport via object-fit: cover
 * - Pulsing green mic indicator (top-left) when isCapturing
 * - Blinking blue CAM badge (top-right) every 1.5 s when frames are sent
 * - Connection status chip (top-center) when not fully connected
 * - Start-tap prompt overlay when the camera has not yet been activated
 * - Passes the onFirstTap gesture through the whole layer so any tap
 *   before activation unlocks the Web Audio API and opens the media streams
 */

import React, { useRef, useCallback } from 'react';
import { Microphone2 } from 'iconsax-react';
import type { ConnectionState } from '@/app/hooks/useWebSocketSession';

export interface CameraViewProps {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  /** True while microphone and camera capture are running. */
  isCapturing: boolean;
  /** Non-null when getUserMedia permission was denied or unavailable. */
  permissionError: string | null;
  connectionState: ConnectionState;
  /**
   * Called on the first screen tap before capture starts.
   * Must call resumeContext() + activateMic() to unlock Web Audio + camera.
   */
  onFirstTap: () => Promise<void>;
}

export function CameraView({
  videoRef,
  canvasRef,
  isCapturing,
  permissionError,
  connectionState,
  onFirstTap,
}: CameraViewProps) {
  const hasActivatedRef = useRef(false);

  const handleTap = useCallback(
    async (e: React.MouseEvent | React.TouchEvent) => {
      // Only capture the first interaction — subsequent taps pass through.
      if (hasActivatedRef.current || isCapturing) return;
      e.preventDefault();
      hasActivatedRef.current = true;
      await onFirstTap();
    },
    [isCapturing, onFirstTap],
  );

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        background: 'var(--color-bg)',
        overflow: 'hidden',
      }}
      onClick={handleTap}
    >
      {/* ── Fullscreen camera preview ────────────────────────────────────── */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }}
        aria-label="Live camera preview"
      />

      {/* ── Hidden canvas for frame capture ─────────────────────────────── */}
      <canvas ref={canvasRef} hidden aria-hidden />

      {/* ── Dark gradient vignette — improves badge legibility ─────────── */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, transparent 30%, transparent 65%, rgba(0,0,0,0.6) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* ── Mic pulsing indicator — top-left ────────────────────────────── */}
      {isCapturing && (
        <div
          role="status"
          aria-label="Microphone active"
          style={{
            position: 'absolute',
            top: 'calc(18px + var(--spacing-safe-top))',
            left: '16px',
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            background: 'var(--color-primary)',
            animation: 'mic-pulse 1.4s ease-in-out infinite',
            zIndex: 10,
          }}
        />
      )}

      {/* ── Frame-sent flash — top-right ────────────────────────────────── */}
      {isCapturing && (
        <div
          role="status"
          aria-label="Sending video frames"
          style={{
            position: 'absolute',
            top: 'calc(12px + var(--spacing-safe-top))',
            right: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            background: 'rgba(0,0,0,0.55)',
            borderRadius: '20px',
            padding: '4px 9px',
            zIndex: 10,
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: 'var(--color-accent)',
              display: 'inline-block',
              animation: 'frame-flash 1.5s steps(1, end) infinite',
            }}
          />
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              color: 'var(--color-text)',
              lineHeight: 1,
              letterSpacing: '0.06em',
            }}
          >
            CAM
          </span>
        </div>
      )}

      {/* ── Connection status chip — top-center ─────────────────────────── */}
      {connectionState !== 'connected' && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 'calc(12px + var(--spacing-safe-top))',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.72)',
            borderRadius: '20px',
            padding: '5px 14px',
            fontSize: '11px',
            fontWeight: 600,
            color: connectionState === 'error' ? 'var(--color-error)' : 'var(--color-warning)',
            zIndex: 10,
            whiteSpace: 'nowrap',
            letterSpacing: '0.04em',
          }}
        >
          {connectionState === 'error'
            ? '⚠ Connection error — tap to retry'
            : connectionState === 'reconnecting'
            ? '↻ Reconnecting…'
            : '● Connecting…'}
        </div>
      )}

      {/* ── First-tap start prompt ───────────────────────────────────────── */}
      {!isCapturing && !permissionError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
            <div
              style={{
                width: '88px',
                height: '88px',
                borderRadius: '50%',
                background: 'color-mix(in srgb, var(--color-primary) 18%, transparent)',
                border: '2.5px solid color-mix(in srgb, var(--color-primary) 75%, transparent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                animation: 'mic-pulse 2s ease-in-out infinite',
              }}
            >
              <Microphone2 variant="Bold" color="var(--color-primary)" size={42} />
            </div>
          <p
            style={{
              color: 'var(--color-text)',
              fontFamily: 'var(--font-fraunces)',
              fontSize: '20px',
              fontWeight: 700,
              textAlign: 'center',
              padding: '0 40px',
              textShadow: '0 2px 8px rgba(0,0,0,0.9)',
              lineHeight: 1.5,
            }}
          >
            Tap anywhere to start
          </p>
          <p
            style={{
              color: 'var(--color-text-muted)',
              fontSize: '13px',
              textAlign: 'center',
              padding: '0 48px',
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            }}
          >
            Allow mic &amp; camera access for AI vet assistance
          </p>
        </div>
      )}

      {/* ── Permission error banner ─────────────────────────────────────── */}
      {permissionError && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            bottom: '140px',
            left: '16px',
            right: '16px',
            background: 'color-mix(in srgb, var(--color-error) 92%, transparent)',
            borderRadius: '14px',
            padding: '14px 18px',
            fontSize: '14px',
            fontWeight: 600,
            color: 'var(--color-white)',
            textAlign: 'center',
            zIndex: 10,
            lineHeight: 1.5,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}
        >
          {permissionError}
        </div>
      )}
    </div>
  );
}
