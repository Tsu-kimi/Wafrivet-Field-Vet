/**
 * pcm-processor.js — AudioWorklet processor for microphone PCM capture.
 *
 * Runs in the AudioWorkletGlobalScope (dedicated audio rendering thread),
 * replacing the deprecated ScriptProcessorNode.
 *
 * Receives real-time Float32 frames from the audio graph, accumulates ~100 ms
 * of audio, resamples to 16 kHz if the AudioContext ran at a different native
 * rate (e.g. 44100 or 48000 Hz on Android), converts to Int16 (s16le mono),
 * and posts a transferable ArrayBuffer to the main thread via MessagePort.
 *
 * Instantiation (main thread):
 *   await audioCtx.audioWorklet.addModule('/pcm-processor.js');
 *   const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor', {
 *     processorOptions: { targetRate: 16000 },
 *   });
 *   workletNode.port.onmessage = (e) => handlePCMChunk(e.data);
 *   source.connect(workletNode);
 *   workletNode.connect(audioCtx.destination);
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    /** Target sample rate expected by Gemini Live (always 16 000 Hz). */
    this._targetRate =
      (options.processorOptions && options.processorOptions.targetRate) ||
      16_000;

    /**
     * `sampleRate` is a global in AudioWorkletGlobalScope — the actual rate
     * the AudioContext is running at (may differ from 16 kHz on mobile).
     * Accumulate enough frames for ~100 ms at the ACTUAL rate.
     */
    this._chunkFrames = Math.round(sampleRate * 0.1);
    this._buffer = [];
    this._bufferedFrames = 0;
  }

  /**
   * Called by the audio rendering engine for every 128-frame quantum.
   * Must return `true` to stay alive.
   */
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    // Slice a copy — the underlying TypedArray is recycled after process() returns.
    this._buffer.push(channel.slice());
    this._bufferedFrames += channel.length;

    if (this._bufferedFrames >= this._chunkFrames) {
      // ── Concatenate accumulated frames ──────────────────────────────────
      const combined = new Float32Array(this._bufferedFrames);
      let offset = 0;
      for (const chunk of this._buffer) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      this._buffer = [];
      this._bufferedFrames = 0;

      // ── Resample to 16 kHz (linear interpolation) if needed ─────────────
      let samples;
      if (sampleRate === this._targetRate) {
        samples = combined;
      } else {
        const ratio  = sampleRate / this._targetRate;
        const outLen = Math.round(combined.length / ratio);
        samples      = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const pos = i * ratio;
          const lo  = Math.floor(pos);
          const hi  = Math.min(lo + 1, combined.length - 1);
          samples[i] = combined[lo] + (combined[hi] - combined[lo]) * (pos - lo);
        }
      }

      // ── Float32 → Int16 (s16le) ─────────────────────────────────────────
      const pcm16 = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const s  = Math.max(-1, Math.min(1, samples[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // ── Zero-copy transfer to main thread ────────────────────────────────
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true; // Keep processor alive.
  }
}

registerProcessor('pcm-processor', PCMProcessor);
