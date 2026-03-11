'use client';

/**
 * app/components/InterruptButton.tsx
 *
 * Large circular interrupt button — centered over the camera view.
 *
 * Visible only while isAgentSpeaking is true.
 * On tap: calls onInterrupt() which must call both sendInterrupt() and
 * flushAudio() simultaneously so the audio stops immediately and the backend
 * is notified to halt the Gemini response turn.
 *
 * Design goals:
 * - Impossible to miss mid-sentence — bright red, large touch target (90×90px)
 * - Pulsing glow animation to draw attention
 * - Accessible: aria-label, minimum 90px touch target well above 48px minimum
 */

import React from 'react';
import { CloseCircle } from 'iconsax-react';

export interface InterruptButtonProps {
  /** Whether to render the button. Mount/unmount drives the animation. */
  isVisible: boolean;
  /** Must call sendInterrupt() + flushAudio() synchronously. */
  onInterrupt: () => void;
}

export function InterruptButton({
  isVisible,
  onInterrupt,
}: InterruptButtonProps) {
  if (!isVisible) return null;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation(); // Don't bubble to CameraView's tap handler.
        onInterrupt();
      }}
      style={{
        width: '90px',
        height: '90px',
        borderRadius: '50%',
        background: 'color-mix(in srgb, var(--color-warning) 92%, transparent)',
        border: '3.5px solid color-mix(in srgb, var(--color-white) 92%, transparent)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        animation: 'interrupt-pulse 1.4s ease-in-out infinite',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        flexShrink: 0,
        backdropFilter: 'blur(4px)',
      }}
      aria-label="Interrupt AI response and stop speaking"
    >
      <span
        style={{ display: 'flex', alignItems: 'center' }}
        aria-hidden
      >
        <CloseCircle variant="Bold" color="var(--color-white)" size={32} />
      </span>
      <span
        style={{
          fontSize: '9px',
          fontWeight: 800,
          color: 'var(--color-white)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        Stop
      </span>
    </button>
  );
}
