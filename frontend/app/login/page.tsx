'use client';

/**
 * app/login/page.tsx
 *
 * WafriAI login page — three-step flow:
 *   Step 1: Enter Nigeria phone number (+234 prefix)
 *   Step 2: Enter 6-digit PIN (or create PIN if first time)
 *   Step 3: Forgot PIN → enter OTP → set new PIN
 *
 * On success the farmer info is saved to localStorage and the user is
 * redirected to the main session page (/).
 */

import React, { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'https://fieldvet-backend-1041869895037.us-central1.run.app'
    : 'http://localhost:8000');
const FARMER_KEY  = 'wafrivet_farmer';  // localStorage key for logged-in farmer

type Step =
  | 'phone'         // Enter phone number
  | 'pin'           // Enter existing PIN
  | 'pin_setup'     // Create new PIN (first time, post-OTP reset, or register)
  | 'otp_request'   // Enter phone to receive OTP (forgot PIN)
  | 'otp_verify';   // Enter OTP + new PIN

type Mode = 'login' | 'register';

// ── Helper: format phone for display ─────────────────────────────────────────

function maskPhone(e164: string): string {
  // +2348012345678 → +234 801 234 ****
  if (e164.length < 8) return e164;
  return e164.slice(0, -4).replace(/(\+\d{3})(\d{3})(\d{3})/, '$1 $2 $3') + ' ****';
}

// ── Helper: parse raw input to E.164 Nigeria ──────────────────────────────────

function toE164Nigeria(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11)   return `+234${digits.slice(1)}`;
  if (digits.length === 10)                              return `+234${digits}`;
  return null;
}

// ── 6-digit PIN input ─────────────────────────────────────────────────────────

interface PinInputProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

function PinInput({ value, onChange, disabled, autoFocus }: PinInputProps) {
  const slots = Array.from({ length: 6 });
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the hidden input on any cell click.
  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && value.length === 0) e.preventDefault();
  };

  return (
    <div style={{ position: 'relative' }}>
      {/* Hidden input that captures digits */}
      <input
        ref={inputRef}
        type="tel"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        value={value}
        disabled={disabled}
        maxLength={6}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 6);
          onChange(v);
        }}
        onKeyDown={handleKey}
        aria-label="6-digit PIN"
        style={{
          position: 'absolute',
          opacity: 0,
          width: '100%',
          height: '100%',
          top: 0,
          left: 0,
          cursor: 'default',
        }}
      />
      {/* Visual cells */}
      <div
        onClick={focusInput}
        style={{
          display: 'flex',
          gap: '10px',
          justifyContent: 'center',
          cursor: 'text',
        }}
      >
        {slots.map((_, i) => {
          const filled = i < value.length;
          const active = i === value.length;
          return (
            <div
              key={i}
              aria-hidden="true"
              style={{
                width: '44px',
                height: '52px',
                borderRadius: '10px',
                border: `2px solid ${active ? 'var(--color-primary)' : filled ? 'var(--color-sage-dark)' : 'var(--color-border)'}`,
                background: filled ? 'var(--color-primary)' : 'var(--color-surface-2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '24px',
                color: 'var(--color-white)',
                transition: 'border-color 0.15s, background 0.15s',
                boxShadow: active ? '0 0 0 3px color-mix(in srgb, var(--color-primary) 25%, transparent)' : 'none',
              }}
            >
              {filled ? '•' : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main login page ───────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();

  const [step, setStep]               = useState<Step>('phone');
  const [phone, setPhone]             = useState('');
  const [phoneE164, setPhoneE164]     = useState('');
  const [pin, setPin]                 = useState('');
  const [pinConfirm, setPinConfirm]   = useState('');
  const [otp, setOtp]                 = useState('');
  const [newPin, setNewPin]           = useState('');
  const [newPinConfirm, setNewPinConfirm] = useState('');
  const [mode, setMode]               = useState<Mode>('login');
  const [error, setError]             = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);

  const [ready, setReady]             = useState(false);

  // Redirect already-logged-in farmers straight to the session page (at root).
  useEffect(() => {
    const stored = localStorage.getItem(FARMER_KEY);
    if (stored) {
      router.replace('/');
    } else {
      setReady(true);
    }
  }, [router]);

  const clearError = () => setError(null);

  // ── Step 1: phone submission ──────────────────────────────────────────────

  const handlePhoneSubmit = () => {
    clearError();
    const e164 = toE164Nigeria(phone);
    if (!e164) {
      setError('Enter a valid Nigerian phone number (e.g. 0801 234 5678).');
      return;
    }
    setPhoneE164(e164);
    // Register: skip login attempt, go straight to PIN creation.
    setStep(mode === 'register' ? 'pin_setup' : 'pin');
  };

  // ── Step 2: PIN login ─────────────────────────────────────────────────────

  const handlePinLogin = useCallback(async () => {
    if (pin.length !== 6) return;
    clearError();
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/farmers/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneE164, pin }),
      });
      const data = await res.json();

      if (!res.ok) {
        const detail = data?.detail ?? 'Incorrect PIN. Please try again.';
        setError(detail);
        setPin('');
        return;
      }

      if (data.needs_pin_setup) {
        // Farmer exists but hasn't set a PIN yet.
        setPin('');
        setStep('pin_setup');
        return;
      }

      // Successful login.
      localStorage.setItem(
        FARMER_KEY,
        JSON.stringify({ phone: data.phone_number, name: data.name }),
      );
      router.replace('/');
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, [pin, phoneE164, router]);

  // Auto-submit when all 6 digits are entered.
  useEffect(() => {
    if (step === 'pin' && pin.length === 6) handlePinLogin();
  }, [pin, step, handlePinLogin]);

  // ── Step 2b: new PIN setup (first time) ───────────────────────────────────

  const handlePinSetup = async () => {
    clearError();
    if (pinConfirm.length !== 6) return;
    if (pin !== pinConfirm) {
      setError('PINs do not match. Please try again.');
      setPinConfirm('');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/farmers/pin`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneE164, pin }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.detail ?? 'Could not save your PIN. Please try again.');
        return;
      }
      // PIN set — now log in.
      localStorage.setItem(
        FARMER_KEY,
        JSON.stringify({ phone: phoneE164, name: null }),
      );
      router.replace('/');
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (step === 'pin_setup' && pin.length === 6 && pinConfirm.length === 6) {
      handlePinSetup();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinConfirm]);

  // ── Step 3a: request OTP ──────────────────────────────────────────────────

  const handleOtpRequest = async () => {
    clearError();
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/farmers/pin/reset/request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneE164 }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.detail ?? 'Could not send OTP. Please try again.');
        return;
      }
      setStep('otp_verify');
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  // ── Step 3b: verify OTP + set new PIN ────────────────────────────────────

  const handleOtpVerify = async () => {
    clearError();
    if (otp.length !== 6 || newPin.length !== 6 || newPinConfirm.length !== 6) return;
    if (newPin !== newPinConfirm) {
      setError('New PINs do not match. Please try again.');
      setNewPinConfirm('');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/farmers/pin/reset/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneE164, otp, new_pin: newPin }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.detail ?? 'Invalid or expired OTP.');
        setOtp('');
        return;
      }
      // PIN reset successful — now log in with the new PIN.
      setPin(newPin);
      setStep('pin');
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  if (!ready) return null;

  // ── Render ────────────────────────────────────────────────────────────────
  const tabs = [
    { id: 'login', label: 'Sign In' },
    { id: 'register', label: 'Register' },
  ];

  return (
    <main
      style={{
        minHeight: '100svh',
        background: 'var(--color-bg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        fontFamily: 'var(--font-inter)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '400px',
          background: 'var(--color-white)',
          borderRadius: '32px',
          padding: '40px 32px',
          boxShadow: '0 20px 60px rgba(58, 68, 46, 0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: '32px',
          animation: 'fade-in 0.6s ease-out',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontFamily: 'var(--font-fraunces)',
              fontSize: '32px',
              fontWeight: 800,
              color: 'var(--color-primary)',
              letterSpacing: '-1px',
              marginBottom: '8px',
            }}
          >
            WafriAI
          </div>
          <p style={{ fontSize: '15px', color: 'var(--color-text-muted)', margin: 0 }}>
            {step === 'phone'
              ? (mode === 'login' ? 'Welcome back! Sign in to continue.' : 'Create an account to get started.')
              : 'Secure your account'}
          </p>
        </div>

        {/* ── Step 1: Phone ──────────────────────────────────────────────── */}
        {step === 'phone' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Tab Switched */}
            <div
              style={{
                display: 'flex',
                background: 'var(--color-bone-light)',
                padding: '6px',
                borderRadius: '16px',
                gap: '4px',
              }}
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setMode(tab.id as Mode);
                    clearError();
                  }}
                  style={{
                    flex: 1,
                    padding: '12px',
                    borderRadius: '12px',
                    border: 'none',
                    background: mode === tab.id ? 'var(--color-primary)' : 'transparent',
                    color: mode === tab.id ? 'var(--color-white)' : 'var(--color-text-muted)',
                    fontSize: '14px',
                    fontWeight: mode === tab.id ? 700 : 500,
                    transition: 'all 0.2s ease',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label
                htmlFor="phone"
                style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)', marginLeft: '4px' }}
              >
                Phone Number
              </label>
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                placeholder="0801 234 5678"
                autoFocus
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  clearError();
                }}
                onKeyDown={(e) => e.key === 'Enter' && handlePhoneSubmit()}
                style={{
                  width: '100%',
                  padding: '16px 20px',
                  borderRadius: '16px',
                  border: '2px solid var(--color-bone)',
                  background: 'var(--color-bone-light)',
                  fontSize: '16px',
                  color: 'var(--color-text)',
                  outline: 'none',
                  transition: 'border-color 0.2s',
                }}
              />
            </div>

            {error && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: '12px',
                  background: 'color-mix(in srgb, var(--color-error) 10%, white)',
                  color: 'var(--color-error)',
                  fontSize: '13px',
                  fontWeight: 500,
                  border: '1px solid color-mix(in srgb, var(--color-error) 20%, transparent)',
                }}
              >
                {error}
              </div>
            )}

            <button
              onClick={handlePhoneSubmit}
              disabled={loading || phone.trim().length < 10}
              style={{
                width: '100%',
                padding: '18px',
                borderRadius: '16px',
                border: 'none',
                background: 'var(--color-primary)',
                color: 'var(--color-white)',
                fontSize: '16px',
                fontWeight: 700,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                boxShadow: '0 8px 24px color-mix(in srgb, var(--color-primary) 30%, transparent)',
                transition: 'all 0.2s',
              }}
            >
              {loading ? 'Processing...' : mode === 'register' ? 'Create Account' : 'Continue'}
            </button>
          </div>
        )}

        {/* ── Step 2: PIN ────────────────────────────────────────────────── */}
        {(step === 'pin' || step === 'pin_setup') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', textAlign: 'center' }}>
            <div>
              <p style={{ fontSize: '15px', color: 'var(--color-text)', marginBottom: '4px' }}>
                {step === 'pin' ? 'Enter PIN for' : 'Create a 6-digit PIN for'}
              </p>
              <p style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-primary)', margin: 0 }}>
                {maskPhone(phoneE164)}
              </p>
            </div>

            <div style={{ margin: '8px 0' }}>
              <PinInput value={pin} onChange={setPin} disabled={loading} autoFocus />
            </div>

            {step === 'pin_setup' && pin.length === 6 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                  Confirm your PIN
                </p>
                <PinInput value={pinConfirm} onChange={setPinConfirm} disabled={loading} autoFocus />
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: '12px',
                  background: 'color-mix(in srgb, var(--color-error) 10%, white)',
                  color: 'var(--color-error)',
                  fontSize: '13px',
                  fontWeight: 500,
                  border: '1px solid color-mix(in srgb, var(--color-error) 20%, transparent)',
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {step === 'pin' && (
                <button
                  onClick={() => {
                    setStep('otp_request');
                    clearError();
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-primary)',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Forgot PIN?
                </button>
              )}
              <button
                onClick={() => {
                  setStep('phone');
                  setPin('');
                  setPinConfirm('');
                  clearError();
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-text-muted)',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  marginTop: '8px',
                }}
              >
                ← Use a different number
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: OTP ────────────────────────────────────────────────── */}
        {(step === 'otp_request' || step === 'otp_verify') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', textAlign: 'center' }}>
            <p style={{ fontSize: '15px', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              {step === 'otp_request'
                ? `We'll send a one-time code to ${maskPhone(phoneE164)} to reset your PIN.`
                : `Enter the 6-digit code sent to ${maskPhone(phoneE164)}.`}
            </p>

            {step === 'otp_verify' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <PinInput value={otp} onChange={setOtp} disabled={loading} autoFocus />
                
                {otp.length === 6 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)' }}>New PIN</p>
                      <PinInput value={newPin} onChange={setNewPin} disabled={loading} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)' }}>Confirm New PIN</p>
                      <PinInput value={newPinConfirm} onChange={setNewPinConfirm} disabled={loading} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: '12px',
                  background: 'color-mix(in srgb, var(--color-error) 10%, white)',
                  color: 'var(--color-error)',
                  fontSize: '13px',
                  fontWeight: 500,
                  border: '1px solid color-mix(in srgb, var(--color-error) 20%, transparent)',
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <button
                onClick={step === 'otp_request' ? handleOtpRequest : handleOtpVerify}
                disabled={loading || (step === 'otp_verify' && (otp.length < 6 || newPin.length < 6 || newPinConfirm.length < 6))}
                style={{
                  width: '100%',
                  padding: '18px',
                  borderRadius: '16px',
                  border: 'none',
                  background: 'var(--color-primary)',
                  color: 'var(--color-white)',
                  fontSize: '16px',
                  fontWeight: 700,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.7 : 1,
                  boxShadow: '0 8px 24px color-mix(in srgb, var(--color-primary) 30%, transparent)',
                  transition: 'all 0.2s',
                }}
              >
                {loading ? 'Processing...' : step === 'otp_request' ? 'Send OTP' : 'Reset PIN & Login'}
              </button>
              <button
                onClick={() => {
                  setStep('pin');
                  clearError();
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-text-muted)',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                ← Back to Login
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
