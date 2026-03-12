'use client';

import React from 'react';
import { Microphone2, MicrophoneSlash, Video, VideoSlash } from 'iconsax-react';

interface MediaControlsProps {
  isMuted: boolean;
  isCameraPaused: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  isVisible: boolean;
}

export function MediaControls({
  isMuted,
  isCameraPaused,
  onToggleMute,
  onToggleCamera,
  isVisible,
}: MediaControlsProps) {
  if (!isVisible) return null;

  const buttonStyle: React.CSSProperties = {
    width: '48px',
    height: '48px',
    borderRadius: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    backdropFilter: 'blur(16px)',
    border: '1.5px solid var(--color-border)',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        animation: 'fade-in 0.3s ease',
      }}
    >
      <button
        onClick={onToggleCamera}
        style={{
          ...buttonStyle,
          background: isCameraPaused 
            ? 'color-mix(in srgb, var(--color-error) 20%, rgba(255,255,255,0.6))' 
            : 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
          transform: isCameraPaused ? 'scale(1.05)' : 'scale(1)',
        }}
        onPointerDown={(e) => (e.currentTarget.style.transform = 'scale(0.92)')}
        onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        aria-label={isCameraPaused ? "Resume camera" : "Pause camera"}
      >
        {isCameraPaused ? (
          <VideoSlash size={24} color="var(--color-error)" variant="Broken" />
        ) : (
          <Video size={24} color="var(--color-text)" variant="Linear" />
        )}
      </button>

      <button
        onClick={onToggleMute}
        style={{
          ...buttonStyle,
          background: isMuted 
            ? 'color-mix(in srgb, var(--color-error) 20%, rgba(255,255,255,0.6))' 
            : 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
          transform: isMuted ? 'scale(1.05)' : 'scale(1)',
        }}
        onPointerDown={(e) => (e.currentTarget.style.transform = 'scale(0.92)')}
        onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
      >
        {isMuted ? (
          <MicrophoneSlash size={24} color="var(--color-error)" variant="Broken" />
        ) : (
          <Microphone2 size={24} color="var(--color-text)" variant="Linear" />
        )}
      </button>
    </div>
  );
}
