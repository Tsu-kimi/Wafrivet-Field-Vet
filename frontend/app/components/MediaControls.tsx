'use client';

import React from 'react';
import { Microphone2, MicrophoneSlash, Video, VideoSlash } from 'iconsax-react';

interface MediaControlsProps {
  isMuted: boolean;
  isCameraPaused: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  isVisible: boolean;
  orientation?: 'vertical' | 'horizontal';
}

export function MediaControls({
  isMuted,
  isCameraPaused,
  onToggleMute,
  onToggleCamera,
  isVisible,
  orientation = 'vertical',
}: MediaControlsProps) {
  if (!isVisible) return null;

  const isHorizontal = orientation === 'horizontal';

  const buttonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '44px',
    height: '44px',
    borderRadius: '50%',
    cursor: 'pointer',
    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    background: 'none',
    border: 'none',
    WebkitTapHighlightColor: 'transparent',
    padding: 0,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        gap: isHorizontal ? '16px' : '12px',
        animation: 'fade-in 0.3s ease',
      }}
    >
      <button
        onClick={onToggleCamera}
        style={{
          ...buttonStyle,
          transform: isCameraPaused ? 'scale(1.05)' : 'scale(1)',
        }}
        onPointerDown={(e) => (e.currentTarget.style.transform = 'scale(0.92)')}
        onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        aria-label={isCameraPaused ? "Resume camera" : "Pause camera"}
      >
        {isCameraPaused ? (
          <VideoSlash size={isHorizontal ? 24 : 32} color="var(--color-white)" variant="Broken" />
        ) : (
          <Video size={isHorizontal ? 24 : 32} color="var(--color-white)" variant="Linear" />
        )}
      </button>

      <button
        onClick={onToggleMute}
        style={{
          ...buttonStyle,
          transform: isMuted ? 'scale(1.05)' : 'scale(1)',
        }}
        onPointerDown={(e) => (e.currentTarget.style.transform = 'scale(0.92)')}
        onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
      >
        {isMuted ? (
          <MicrophoneSlash size={isHorizontal ? 24 : 32} color="var(--color-white)" variant="Broken" />
        ) : (
          <Microphone2 size={isHorizontal ? 24 : 32} color="var(--color-white)" variant="Linear" />
        )}
      </button>
    </div>
  );
}
