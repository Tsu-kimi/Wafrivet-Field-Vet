'use client';

/**
 * app/components/PinOverlay.tsx
 *
 * Full-screen PIN entry overlay for Phase 5 farmer identity management.
 *
 * Modes:
 *   "setup"  — First-time PIN creation (farmer enters PIN twice to confirm)
 *   "verify" — Returning farmer verifies existing PIN
 *
 * Security properties:
 *   - input type="password" with inputMode="numeric" — never echoes characters
 *   - autoComplete="off" + autoCorrect="off" — no browser-assisted fill
 *   - PIN never stored in client state beyond the single API call
 *   - HTTP calls go to the same-origin FastAPI backend; no PIN leaves the device unencrypted
 *   - Lockout seconds respected: UI shows countdown and disables input during lockout
 *
 * Audio:
 *   - Calls suspendAudio() on mount to silence Gemini while PIN is active
 *   - Calls resumeAudio() after a successful PIN action before closing
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocketContext } from '@/app/components/WebSocketProvider';

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'setup' | 'setup_confirm' | 'verify' | 'otp_request' | 'otp_confirm';

interface PinOverlayProps {
  /** E.164 phone number that just registered (e.g. "+2348012345678"). */
  phoneNumber: string;
  /** True if the farmer already has a PIN set (verify flow); false for setup. */
  isReturning: boolean;
  /** Called after a successful PIN setup or verify so the parent can hide the overlay. */
  onSuccess: (farmerName: string) => void;
}

interface ApiError {
  detail?: string;
  locked?: boolean;
  lockout_seconds?: number;
  attempt?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const json = await res.json() as T;
  if (!res.ok) throw json;
  return json;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PinDots({ length, filled }: { length: number; filled: number }) {
  return (
    <div className="flex gap-4 justify-center my-6" aria-hidden="true">
      {Array.from({ length }).map((_, i) => (
        <div
          key={i}
          className={[
            'w-4 h-4 rounded-full border-2 transition-all duration-150',
            i < filled
              ? 'bg-green-400 border-green-400'
              : 'bg-transparent border-gray-400',
          ].join(' ')}
        />
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PinOverlay({ phoneNumber, isReturning, onSuccess }: PinOverlayProps) {
  const { suspendAudio, resumeAudio, sendPinVerified } = useWebSocketContext();

  const [mode, setMode]           = useState<Mode>(isReturning ? 'verify' : 'setup');
  const [pin, setPin]             = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [otp, setOtp]             = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [locked, setLocked]       = useState(false);
  const [lockoutSecs, setLockoutSecs] = useState(0);
  const [attempt, setAttempt]     = useState(0);
  const [otpSent, setOtpSent]     = useState(false);

  const pinInputRef    = useRef<HTMLInputElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const otpInputRef    = useRef<HTMLInputElement>(null);
  const lockTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  // Suspend audio on mount; resume on unmount (caller closes overlay after success).
  useEffect(() => {
    suspendAudio();
    return () => {
      if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-focus the active input when mode changes.
  useEffect(() => {
    const el = mode === 'otp_confirm' ? otpInputRef.current
             : mode === 'setup_confirm' ? confirmInputRef.current
             : pinInputRef.current;
    el?.focus();
  }, [mode]);

  // Lockout countdown timer.
  const startLockoutTimer = useCallback((seconds: number) => {
    setLocked(true);
    setLockoutSecs(seconds);
    lockTimerRef.current = setInterval(() => {
      setLockoutSecs(prev => {
        if (prev <= 1) {
          clearInterval(lockTimerRef.current!);
          lockTimerRef.current = null;
          setLocked(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);
  }, []);

  const handleApiError = useCallback((err: unknown) => {
    const apiErr = err as ApiError;
    if (apiErr.locked && apiErr.lockout_seconds) {
      startLockoutTimer(apiErr.lockout_seconds);
      setError(`Too many attempts. Try again in ${apiErr.lockout_seconds}s.`);
    } else {
      setError(apiErr.detail ?? 'Something went wrong. Please try again.');
    }
    if (apiErr.attempt) setAttempt(apiErr.attempt);
    setPin('');
    setConfirmPin('');
    pinInputRef.current?.focus();
  }, [startLockoutTimer]);

  // ── PIN setup flow ─────────────────────────────────────────────────────────

  const handleSetupFirst = useCallback(async () => {
    if (pin.length !== 6) return;
    // Move to confirmation step — no server call yet.
    setMode('setup_confirm');
  }, [pin]);

  const handleSetupConfirm = useCallback(async () => {
    if (confirmPin.length !== 6) return;
    if (pin !== confirmPin) {
      setError('PINs do not match. Please try again.');
      setConfirmPin('');
      confirmInputRef.current?.focus();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await postJson<{ farmer_name: string; message: string }>(
        '/farmers/pin',
        { phone_number: phoneNumber, pin },
      );
      resumeAudio();
      sendPinVerified(data.farmer_name);
      onSuccess(data.farmer_name);
    } catch (err) {
      handleApiError(err);
      setMode('setup');
    } finally {
      setLoading(false);
    }
  }, [pin, confirmPin, phoneNumber, resumeAudio, sendPinVerified, onSuccess, handleApiError]);

  // ── PIN verify flow ────────────────────────────────────────────────────────

  const handleVerify = useCallback(async () => {
    if (pin.length !== 6) return;
    setLoading(true);
    setError(null);
    try {
      const data = await postJson<{ farmer_name: string; message: string }>(
        '/farmers/pin/verify',
        { phone_number: phoneNumber, pin },
      );
      resumeAudio();
      sendPinVerified(data.farmer_name);
      onSuccess(data.farmer_name);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }, [pin, phoneNumber, resumeAudio, sendPinVerified, onSuccess, handleApiError]);

  // ── OTP / forgot PIN flow ─────────────────────────────────────────────────

  const handleForgotPin = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await postJson('/farmers/pin/reset/request', { phone_number: phoneNumber });
      setOtpSent(true);
      setMode('otp_confirm');
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }, [phoneNumber, handleApiError]);

  const handleOtpConfirm = useCallback(async () => {
    if (otp.length !== 6 || pin.length !== 6) return;
    setLoading(true);
    setError(null);
    try {
      const data = await postJson<{ farmer_name: string; message: string }>(
        '/farmers/pin/reset/verify',
        { phone_number: phoneNumber, otp, new_pin: pin },
      );
      resumeAudio();
      sendPinVerified(data.farmer_name);
      onSuccess(data.farmer_name);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }, [otp, pin, phoneNumber, resumeAudio, sendPinVerified, onSuccess, handleApiError]);

  // ── PIN input handler — auto-submit at 6 digits ───────────────────────────

  const handlePinChange = useCallback((val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 6);
    setPin(digits);
    setError(null);
    if (digits.length === 6) {
      if (mode === 'setup') void handleSetupFirst();
      else if (mode === 'verify') void handleVerify();
    }
  }, [mode, handleSetupFirst, handleVerify]);

  const handleConfirmChange = useCallback((val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 6);
    setConfirmPin(digits);
    setError(null);
    if (digits.length === 6) void handleSetupConfirm();
  }, [handleSetupConfirm]);

  const handleOtpChange = useCallback((val: string) => {
    const digits = val.replace(/\D/g, '').slice(0, 6);
    setOtp(digits);
    setError(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const title =
    mode === 'setup'         ? 'Create your PIN'
    : mode === 'setup_confirm' ? 'Confirm your PIN'
    : mode === 'verify'      ? 'Enter your PIN'
    : mode === 'otp_request' ? 'Reset PIN'
    : /* otp_confirm */        'Enter OTP + New PIN';

  const subtitle =
    mode === 'setup'         ? 'Choose a 6-digit PIN to secure your account'
    : mode === 'setup_confirm' ? 'Re-enter your PIN to confirm'
    : mode === 'verify'      ? `Welcome back! Enter your PIN for ${phoneNumber}`
    : mode === 'otp_request' ? 'We will send a one-time code to your phone'
    : /* otp_confirm */        otpSent
                               ? `Enter the 6-digit code sent to ${phoneNumber}, then your new PIN`
                               : 'Enter the OTP and your new 6-digit PIN';

  const activePinValue   = mode === 'setup_confirm' ? confirmPin : pin;
  const activeInputRef   = mode === 'setup_confirm' ? confirmInputRef : pinInputRef;
  const activeChangeHandler = mode === 'setup_confirm' ? handleConfirmChange : handlePinChange;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Card */}
      <div className="w-full max-w-sm mx-4 bg-gray-900 rounded-2xl shadow-2xl p-8 flex flex-col items-center text-white">

        {/* Lock icon */}
        <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
          <svg viewBox="0 0 24 24" className="w-8 h-8 text-green-400 fill-current">
            <path d="M12 1C9.24 1 7 3.24 7 6v1H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2V6c0-2.76-2.24-5-5-5zm0 2c1.65 0 3 1.35 3 3v1H9V6c0-1.65 1.35-3 3-3zm0 9a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/>
          </svg>
        </div>

        <h2 className="text-xl font-bold mb-1">{title}</h2>
        <p className="text-sm text-gray-400 text-center mb-2">{subtitle}</p>

        {/* Attempt counter */}
        {attempt > 0 && !locked && (
          <p className="text-xs text-yellow-400 mb-2">
            Attempt {attempt} of 7 — too many failures will lock your account temporarily.
          </p>
        )}

        {/* Error message */}
        {error && (
          <p role="alert" className="text-sm text-red-400 text-center mb-2">
            {error}
          </p>
        )}

        {/* Lockout countdown */}
        {locked && lockoutSecs > 0 && (
          <p className="text-sm text-orange-400 mb-2">
            Locked — try again in {lockoutSecs}s
          </p>
        )}

        {/* OTP confirm special layout */}
        {mode === 'otp_confirm' ? (
          <>
            <label className="w-full text-xs text-gray-400 mb-1">One-time code</label>
            <input
              ref={otpInputRef}
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCorrect="off"
              spellCheck={false}
              maxLength={6}
              value={otp}
              onChange={e => handleOtpChange(e.target.value)}
              disabled={loading || locked}
              placeholder="• • • • • •"
              className="w-full text-center text-2xl tracking-[0.5em] rounded-xl bg-gray-800 border border-gray-600 focus:border-green-400 focus:outline-none py-3 mb-4 disabled:opacity-50"
            />
            <label className="w-full text-xs text-gray-400 mb-1">New PIN</label>
            <input
              ref={pinInputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={6}
              value={pin}
              onChange={e => handlePinChange(e.target.value)}
              disabled={loading || locked}
              placeholder="• • • • • •"
              className="w-full text-center text-2xl tracking-[0.5em] rounded-xl bg-gray-800 border border-gray-600 focus:border-green-400 focus:outline-none py-3 mb-4 disabled:opacity-50"
            />
            <button
              onClick={() => void handleOtpConfirm()}
              disabled={loading || locked || otp.length !== 6 || pin.length !== 6}
              className="w-full py-3 rounded-xl bg-green-500 hover:bg-green-400 disabled:opacity-40 font-semibold transition-colors"
            >
              {loading ? 'Resetting…' : 'Reset PIN'}
            </button>
          </>
        ) : (
          <>
            {/* PIN dots visualisation */}
            <PinDots length={6} filled={activePinValue.length} />

            {/* Hidden but accessible PIN input */}
            <input
              ref={activeInputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={6}
              value={activePinValue}
              onChange={e => activeChangeHandler(e.target.value)}
              disabled={loading || locked}
              aria-label={mode === 'setup_confirm' ? 'Confirm your 6-digit PIN' : 'Enter your 6-digit PIN'}
              className="w-full opacity-0 absolute pointer-events-none"
            />

            {/* Tap-to-focus on-screen keyboard target */}
            <button
              onClick={() => activeInputRef.current?.focus()}
              className="w-full py-4 rounded-xl bg-gray-800 border border-gray-700 text-center text-2xl tracking-[0.5em] mb-4 select-none"
              aria-hidden="true"
              tabIndex={-1}
            >
              {'•'.repeat(activePinValue.length).padEnd(6, '○')}
            </button>

            {/* Forgot PIN link — only in verify mode */}
            {mode === 'verify' && (
              <button
                onClick={() => void handleForgotPin()}
                disabled={loading}
                className="text-xs text-green-400 hover:text-green-300 mb-4 underline disabled:opacity-40"
              >
                Forgot PIN? Send reset code
              </button>
            )}

            {/* Back button for setup confirm */}
            {mode === 'setup_confirm' && (
              <button
                onClick={() => { setMode('setup'); setConfirmPin(''); setError(null); }}
                className="text-xs text-gray-400 hover:text-gray-300 mb-4 underline"
              >
                Back — re-enter PIN
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
