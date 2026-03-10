'use client';

/**
 * app/hooks/useAudioPlayer.ts
 *
 * Queues and plays raw 24 kHz 16-bit signed PCM audio chunks received from
 * the Gemini Live API via the backend WebSocket binary frames.
 *
 * Design constraints:
 *   - Single AudioContext created once, kept alive across flushes.
 *   - AudioContext.resume() MUST only be called from a user gesture.
 *     Call resumeContext() from an onClick handler — never inside useEffect.
 *   - Each ArrayBuffer chunk: read Int16 values → convert to Float32 →
 *     write into AudioBuffer → schedule via AudioBufferSourceNode.start()
 *     at currentTime + accumulated queued duration for gapless playback.
 *   - isAISpeaking: true when first chunk of a turn starts playing,
 *     false when the tracked-node count drains to zero.
 *   - flush(): stops all scheduled nodes in-place (no close/reopen), so
 *     the next chunk can play immediately without another user gesture.
 */

import { useRef, useCallback, useState } from 'react';

/** Gemini Live audio output sample rate (fixed at 24 kHz). */
const SAMPLE_RATE_HZ = 24_000;

export interface UseAudioPlayerReturn {
  /** Schedule one raw PCM ArrayBuffer for gapless playback. */
  playChunk: (raw: ArrayBuffer) => void;
  /** Immediately silence all output and reset the playback queue. */
  flush: () => void;
  /**
   * Resume the AudioContext after a user gesture.
   * Wire this to the first meaningful tap/click on the page so the Web
   * Audio API is unlocked before audio chunks arrive.
   * NEVER call this inside useEffect or other non-gesture contexts.
   */
  resumeContext: () => void;
  /** True while at least one scheduled node is still playing. */
  isAISpeaking: boolean;
}

export function useAudioPlayer(): UseAudioPlayerReturn {
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** Wall-clock time (AudioContext seconds) up to which audio is scheduled. */
  const scheduledUntilRef = useRef<number>(0);
  /** All currently-active (scheduled or playing) source nodes. */
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const [isAISpeaking, setIsAISpeaking] = useState(false);

  /**
   * Returns the single AudioContext, creating it lazily on first call.
   * Safe to call from useCallback — uses only refs, never stale closures.
   */
  const getCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE_HZ });
      scheduledUntilRef.current = 0;
    }
    return audioCtxRef.current;
  }, []);

  /**
   * Call once from a user gesture (e.g. first screen tap) to unlock the
   * Web Audio API on iOS / Android Chrome browsers.
   *
   * DO NOT call this inside useEffect or any non-gesture code path.
   */
  const resumeContext = useCallback(() => {
    const ctx = getCtx();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
  }, [getCtx]);

  const playChunk = useCallback((raw: ArrayBuffer) => {
    const ctx = getCtx();

    // NOTE: we deliberately do NOT call ctx.resume() here.
    // AudioContext.resume() requires a user gesture; the UI calls
    // resumeContext() on first interaction. If the context is still
    // suspended when chunks arrive, they will be scheduled but silent
    // until the user interacts — acceptable for the loading state.

    // Decode: Int16 little-endian PCM → Float32 in [-1.0, +1.0]
    const pcm16 = new Int16Array(raw);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32_768;
    }

    const buffer = ctx.createBuffer(
      /* channels   */ 1,
      /* frameCount */ float32.length,
      /* sampleRate */ SAMPLE_RATE_HZ,
    );
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Schedule gaplessly: start immediately if we're behind, otherwise
    // queue after the last scheduled chunk ends.
    const now = ctx.currentTime;
    const startAt = Math.max(now, scheduledUntilRef.current);
    source.start(startAt);
    scheduledUntilRef.current = startAt + buffer.duration;

    // Track speaking state: true on first chunk, false when queue empties.
    activeSourcesRef.current.push(source);
    setIsAISpeaking(true);

    source.onended = () => {
      // Guard: remove only if still tracked (not already cleared by flush).
      const idx = activeSourcesRef.current.indexOf(source);
      if (idx !== -1) {
        activeSourcesRef.current.splice(idx, 1);
        if (activeSourcesRef.current.length === 0) {
          setIsAISpeaking(false);
        }
      }
    };
  }, [getCtx]);

  /**
   * Stop all scheduled and playing nodes immediately (mid-sentence flush).
   * The AudioContext is kept alive — the next playChunk call resumes
   * without requiring another user gesture.
   */
  const flush = useCallback(() => {
    // Snapshot and clear the tracking array before stopping nodes so that
    // the onended callbacks that fire synchronously do not see stale state.
    const toStop = activeSourcesRef.current;
    activeSourcesRef.current = [];
    scheduledUntilRef.current = 0;
    setIsAISpeaking(false);

    for (const src of toStop) {
      try {
        src.stop();
      } catch {
        // Already ended naturally — ignore DOMException.
      }
      src.disconnect();
    }
  }, []);

  return { playChunk, flush, resumeContext, isAISpeaking };
}
