'use client';

/**
 * app/hooks/useMediaPipeline.ts
 *
 * Captures microphone audio and rear-camera video frames, passing both to
 * the caller for forwarding over the WebSocket to Gemini Live.
 *
 * Audio path:
 *   getUserMedia({ audio: { channelCount: 1, sampleRate: 16000,
 *                           echoCancellation: true, noiseSuppression: true } })
 *   → ScriptProcessorNode (Float32 PCM)
 *   → convert to Int16 ArrayBuffer at 16 kHz
 *   → onAudioChunk(ArrayBuffer)   [caller sends as binary WS frame]
 *
 * Video path:
 *   getUserMedia({ video: { facingMode: 'environment',
 *                           width: { ideal: 640 }, height: { ideal: 480 } } })
 *   → <video> element (preview) via videoRef
 *   → canvas.toDataURL('image/jpeg', 0.6) every framePeriodMs
 *   → onVideoFrame(base64String)  [caller sends as IMAGE JSON message]
 *
 * activateMic() MUST be called from a user-gesture handler (onClick /
 * onTouchEnd). AudioContext.resume() is invoked inside it — calling it
 * from useEffect would be blocked by browser autoplay policy.
 *
 * On useEffect cleanup, track.stop() is called on every MediaStream track.
 * This is MANDATORY to extinguish the camera LED when the component unmounts.
 *
 * NOTE: ScriptProcessorNode is deprecated but remains the most reliable
 * audio capture path on Android WebView / Chrome Mobile as of 2026.
 */

import { useRef, useCallback, useState, useEffect } from 'react';

export interface UseMediaPipelineOptions {
  /** Receives raw 16 kHz 16-bit mono PCM chunks as ArrayBuffer. */
  onAudioChunk: (chunk: ArrayBuffer) => void;
  /** Receives base64-encoded JPEG frames (no data: URI prefix). */
  onVideoFrame: (base64Jpeg: string) => void;
  /**
   * Interval between video frame captures in milliseconds.
   * Default: 1500 ms. Reduce for richer visual context at the cost of bandwidth.
   */
  framePeriodMs?: number;
}

export interface UseMediaPipelineReturn {
  /**
   * Wire to a <video autoPlay playsInline muted> element to preview the
   * rear camera stream. React sets the DOM reference on mount.
   */
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  /**
   * Wire to a hidden <canvas> element for frame capture.
   * If not attached to a DOM element, the hook creates one off-screen.
   */
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  /** True while both audio capture and video frame capture are running. */
  isCapturing: boolean;
  /** Human-readable error if getUserMedia permission was denied or failed. */
  permissionError: string | null;
  /**
   * Request camera + microphone permissions and start capture.
   * Wire this to an onClick / onTouchEnd handler — never call from useEffect.
   * Calls AudioContext.resume() internally while inside a user gesture.
   */
  activateMic: () => Promise<void>;
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Round n up to the nearest power of two.
 * ScriptProcessorNode requires bufferSize ∈ {256, 512, 1024, 2048, 4096, …}.
 */
function nearestPowerOfTwo(n: number): number {
  if (n <= 0) return 256;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMediaPipeline({
  onAudioChunk,
  onVideoFrame,
  framePeriodMs = 1_500,
}: UseMediaPipelineOptions): UseMediaPipelineReturn {
  const [isCapturing,    setIsCapturing]    = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // Exposed to the caller for DOM wiring.
  const videoRef  = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Internal — not exposed.
  const streamRef    = useRef<MediaStream | null>(null);
  const audioCtxRef  = useRef<AudioContext | null>(null);
  const sourceRef    = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Ref guard: prevents double-invocation before the state re-render settles.
  const isCapturingRef = useRef(false);

  // Stable callback refs — always invoke the latest version without
  // causing activateMic to be recreated every render.
  const onAudioChunkRef = useRef(onAudioChunk);
  const onVideoFrameRef = useRef(onVideoFrame);
  onAudioChunkRef.current = onAudioChunk;
  onVideoFrameRef.current = onVideoFrame;

  // ── Mandatory cleanup: kill camera LED on unmount ─────────────────────────
  useEffect(() => {
    return () => {
      if (frameTimerRef.current) {
        clearInterval(frameTimerRef.current);
      }
      sourceRef.current?.disconnect();
      processorRef.current?.disconnect();
      void audioCtxRef.current?.close();
      // MANDATORY: stop() every track so the browser removes the camera LED.
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, []); // Runs cleanup exactly once on unmount.

  // ── activateMic ───────────────────────────────────────────────────────────
  const activateMic = useCallback(async () => {
    if (isCapturingRef.current) return;
    setPermissionError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16_000,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: {
          facingMode: 'environment',
          width:  { ideal: 640 },
          height: { ideal: 480 },
        },
      });
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera and microphone permission denied. Please allow access and try again.'
          : err instanceof DOMException && err.name === 'NotFoundError'
          ? 'No camera or microphone found on this device.'
          : 'Could not start camera and microphone. Please check permissions and try again.';
      setPermissionError(message);
      return;
    }

    streamRef.current = stream;

    // ── Video preview ─────────────────────────────────────────────────────
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }

    // ── Canvas for frame capture ──────────────────────────────────────────
    // Use a DOM-attached canvas if available; otherwise create one off-screen.
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    canvasRef.current.width  = 640;
    canvasRef.current.height = 480;
    const ctx2d = canvasRef.current.getContext('2d');

    frameTimerRef.current = setInterval(() => {
      const video  = videoRef.current;
      const canvas = canvasRef.current;
      if (
        !video  || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA ||
        !canvas || !ctx2d
      ) return;

      ctx2d.drawImage(video, 0, 0, 640, 480);
      // Strip the "data:image/jpeg;base64," URI prefix — backend expects raw base64.
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      const base64  = dataUrl.slice('data:image/jpeg;base64,'.length);
      onVideoFrameRef.current(base64);
    }, framePeriodMs);

    // ── Audio capture ─────────────────────────────────────────────────────
    // AudioContext.resume() is safe here: we are executing inside a user
    // gesture handler. Calling it from useEffect is blocked by autoplay policy.
    const audioCtx = new AudioContext({ sampleRate: 16_000 });
    await audioCtx.resume();
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);
    sourceRef.current = source;

    // ~100 ms of 16 kHz audio = 1600 samples → nearest power of two = 2048.
    const bufferSize = nearestPowerOfTwo(Math.round((16_000 * 100) / 1_000));
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16   = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s  = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // .slice() produces a transferable copy safe to post via WebSocket.
      onAudioChunkRef.current(pcm16.buffer.slice(0));
    };

    source.connect(processor);
    // Connecting to destination prevents garbage-collection in some browsers.
    processor.connect(audioCtx.destination);

    isCapturingRef.current = true;
    setIsCapturing(true);
  }, [framePeriodMs]);

  return { videoRef, canvasRef, isCapturing, permissionError, activateMic };
}
