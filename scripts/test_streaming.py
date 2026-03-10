"""
scripts/test_streaming.py

Live end-to-end test for the Wafrivet Phase 3 WebSocket streaming server.

What it does:
  1. Connects to ws://localhost:8000/ws/{user_id}/{session_id}
  2. Streams raw PCM audio from a WAV file (or a generated sine-wave tone)
     in 100 ms chunks, simulating a real farmer voice transmission
  3. After 3 seconds, simulates an interruption by sending a new TEXT message
     while audio is still streaming
  4. Prints every JSON event received from the server (structured events)
  5. Saves any received binary audio chunks to /tmp/wafrivet_output.pcm

Usage:
    # Start the server first:
    python backend/main.py --mode server

    # In a second terminal:
    python scripts/test_streaming.py
    python scripts/test_streaming.py --wav path/to/voice.wav
    python scripts/test_streaming.py --text "My cow is coughing badly"

Prerequisites:
    pip install websockets python-dotenv
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import struct
import sys
import time
import wave
from pathlib import Path
from typing import Optional

import websockets
from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError

# ---------------------------------------------------------------------------
# Default test parameters
# ---------------------------------------------------------------------------

DEFAULT_HOST    = "localhost"
DEFAULT_PORT    = 8000
DEFAULT_USER_ID = "test-farmer-001"
DEFAULT_SESSION = "test-session-001"
AUDIO_CHUNK_MS  = 100  # milliseconds per send
SAMPLE_RATE     = 16_000
CHANNELS        = 1
SAMPLE_WIDTH    = 2  # 16-bit PCM → 2 bytes per sample

OUTPUT_PCM_PATH = Path("/tmp/wafrivet_output.pcm")
INTERRUPT_AFTER_S = 3.0   # seconds before simulating interruption
TEST_DURATION_S   = 30.0  # maximum test run time


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_sine_wave(duration_s: float = 2.0, freq_hz: float = 440.0) -> bytes:
    """Generate a mono 16-bit PCM sine-wave buffer (simulates voice input)."""
    n_samples = int(SAMPLE_RATE * duration_s)
    amplitude = 8_000  # moderate volume, well within 16-bit range
    samples = [
        int(amplitude * math.sin(2 * math.pi * freq_hz * i / SAMPLE_RATE))
        for i in range(n_samples)
    ]
    return struct.pack(f"<{n_samples}h", *samples)


def _load_wav(wav_path: str) -> bytes:
    """Read a WAV file and return raw 16-bit PCM at 16 kHz (mono)."""
    with wave.open(wav_path, "rb") as wf:
        if wf.getframerate() != SAMPLE_RATE:
            print(
                f"[WARN] WAV sample rate is {wf.getframerate()} Hz; "
                f"Gemini Live expects {SAMPLE_RATE} Hz. Proceeding anyway."
            )
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
    return raw


def _chunk_audio(pcm: bytes, chunk_ms: int = AUDIO_CHUNK_MS) -> list[bytes]:
    """Split PCM bytes into equal-sized chunks."""
    chunk_bytes = int(SAMPLE_RATE * (chunk_ms / 1000) * SAMPLE_WIDTH * CHANNELS)
    return [pcm[i:i + chunk_bytes] for i in range(0, len(pcm), chunk_bytes)]


# ---------------------------------------------------------------------------
# Main test coroutine
# ---------------------------------------------------------------------------

async def run_streaming_test(
    host: str,
    port: int,
    user_id: str,
    session_id: str,
    wav_path: Optional[str],
    text_message: Optional[str],
) -> None:
    uri = f"ws://{host}:{port}/ws/{user_id}/{session_id}"
    print(f"\n[*] Connecting to {uri}\n")

    output_buf: bytearray = bytearray()
    events_received: int = 0
    start_t = time.monotonic()

    async with websockets.connect(uri, ping_interval=20) as ws:
        print("[*] WebSocket connected\n")

        # ------------------------------------------------------------------
        # Receiver: print all incoming events
        # ------------------------------------------------------------------
        async def receive_loop() -> None:
            nonlocal events_received
            with open(OUTPUT_PCM_PATH, "wb") as pcm_file:
                async for raw_msg in ws:
                    if isinstance(raw_msg, bytes):
                        # Binary frame = PCM audio from the agent
                        pcm_file.write(raw_msg)
                        output_buf.extend(raw_msg)
                        print(f"  [AUDIO_OUT] {len(raw_msg)} bytes received", flush=True)
                    else:
                        # Text frame = JSON event
                        try:
                            ev = json.loads(raw_msg)
                        except json.JSONDecodeError:
                            print(f"  [RAW] {raw_msg}", flush=True)
                            continue

                        events_received += 1
                        ev_type = ev.get("type", "?")
                        elapsed = time.monotonic() - start_t

                        if ev_type == "TRANSCRIPTION":
                            print(
                                f"  [{elapsed:.1f}s] TRANSCRIPTION "
                                f"({ev.get('author','?')}): {ev.get('text','')!r}",
                                flush=True,
                            )
                        elif ev_type == "AUDIO_FLUSH":
                            print(f"  [{elapsed:.1f}s] *** AUDIO_FLUSH — clear audio queue ***", flush=True)
                        elif ev_type == "TURN_COMPLETE":
                            print(f"  [{elapsed:.1f}s] --- TURN COMPLETE ---", flush=True)
                        elif ev_type == "PRODUCTS_RECOMMENDED":
                            products = ev.get("products", [])
                            print(
                                f"  [{elapsed:.1f}s] PRODUCTS_RECOMMENDED "
                                f"({len(products)} products):",
                                flush=True,
                            )
                            for p in products[:3]:
                                print(f"    • {p.get('name')} — ₦{p.get('price_ngn')}", flush=True)
                        elif ev_type == "CART_UPDATED":
                            print(
                                f"  [{elapsed:.1f}s] CART_UPDATED — total ₦{ev.get('cart_total')}",
                                flush=True,
                            )
                        elif ev_type == "CHECKOUT_LINK":
                            print(
                                f"  [{elapsed:.1f}s] CHECKOUT_LINK → {ev.get('checkout_url')}",
                                flush=True,
                            )
                        elif ev_type == "LOCATION_CONFIRMED":
                            print(
                                f"  [{elapsed:.1f}s] LOCATION_CONFIRMED: {ev.get('state')}",
                                flush=True,
                            )
                        elif ev_type == "TOOL_ERROR":
                            print(
                                f"  [{elapsed:.1f}s] TOOL_ERROR [{ev.get('tool_name')}]: {ev.get('error')}",
                                flush=True,
                            )
                        elif ev_type == "ERROR":
                            print(
                                f"  [{elapsed:.1f}s] SERVER_ERROR {ev.get('code')}: {ev.get('message')}",
                                flush=True,
                            )
                        else:
                            print(f"  [{elapsed:.1f}s] {ev_type}: {ev}", flush=True)

        # ------------------------------------------------------------------
        # Sender: stream audio or send text
        # ------------------------------------------------------------------
        async def send_loop() -> None:
            interrupted = False

            if text_message:
                # Text-only mode
                payload = json.dumps({"type": "TEXT", "text": text_message})
                await ws.send(payload)
                print(f"[*] Sent TEXT: {text_message!r}")
                await asyncio.sleep(TEST_DURATION_S)
                return

            # Audio mode
            if wav_path:
                pcm = _load_wav(wav_path)
                print(f"[*] Loaded WAV: {wav_path} ({len(pcm)} bytes PCM)")
            else:
                pcm = _generate_sine_wave(duration_s=6.0, freq_hz=440.0)
                print(f"[*] Generated sine-wave PCM ({len(pcm)} bytes, 6 s at 440 Hz)")

            chunks = _chunk_audio(pcm)
            print(f"[*] Streaming {len(chunks)} audio chunks ({AUDIO_CHUNK_MS} ms each)\n")

            for i, chunk in enumerate(chunks):
                try:
                    await ws.send(chunk)  # will raise if closed
                except Exception:
                    break

                elapsed = time.monotonic() - start_t
                # Simulate interruption after INTERRUPT_AFTER_S seconds
                if elapsed >= INTERRUPT_AFTER_S and not interrupted:
                    interrupted = True
                    interrupt_text = "Actually, tell me about goat bloat treatments instead."
                    payload = json.dumps({"type": "TEXT", "text": interrupt_text})
                    await ws.send(payload)
                    print(f"\n[*] [{elapsed:.1f}s] INTERRUPT sent: {interrupt_text!r}\n")

                await asyncio.sleep(AUDIO_CHUNK_MS / 1000)

            # Keep connection open to receive remaining events
            await asyncio.sleep(TEST_DURATION_S - (time.monotonic() - start_t))

        try:
            await asyncio.wait_for(
                asyncio.gather(receive_loop(), send_loop(), return_exceptions=True),
                timeout=TEST_DURATION_S + 5,
            )
        except asyncio.TimeoutError:
            pass
        except (ConnectionClosedOK, ConnectionClosedError):
            pass

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    total_s = time.monotonic() - start_t
    print(f"\n[*] Test complete in {total_s:.1f}s")
    print(f"    Events received : {events_received}")
    print(f"    Audio output    : {len(output_buf)} bytes → {OUTPUT_PCM_PATH}")
    if output_buf:
        print(f"    Play with: ffplay -f s16le -ar 24000 -ac 1 {OUTPUT_PCM_PATH}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Wafrivet streaming test client")
    parser.add_argument("--host",       default=DEFAULT_HOST)
    parser.add_argument("--port",       type=int, default=DEFAULT_PORT)
    parser.add_argument("--user-id",    default=DEFAULT_USER_ID)
    parser.add_argument("--session-id", default=DEFAULT_SESSION)
    parser.add_argument("--wav",        help="Path to a 16 kHz mono WAV file (optional)")
    parser.add_argument("--text",       help="Send a one-shot TEXT message instead of audio")
    args = parser.parse_args()

    asyncio.run(
        run_streaming_test(
            host=args.host,
            port=args.port,
            user_id=args.user_id,
            session_id=args.session_id,
            wav_path=args.wav,
            text_message=args.text,
        )
    )


if __name__ == "__main__":
    main()
