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

const API_BASE    = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';
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

  // Redirect already-logged-in farmers straight to the session page.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(FARMER_KEY);
      if (stored) router.replace('/');
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

  // ── Shared styles ─────────────────────────────────────────────────────────

  const containerStyle: React.CSSProperties = {
    minHeight: '100svh',
    background: 'var(--color-bg)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 20px',
    overflowY: 'auto',
  };

  const cardStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '360px',
    background: 'var(--color-surface-2)',
    borderRadius: '20px',
    padding: '32px 24px',
    boxShadow: '0 4px 24px rgba(58,68,46,0.10)',
  };

  const logoStyle: React.CSSProperties = {
    fontSize: '28px',
    fontWeight: 800,
    color: 'var(--color-primary)',
    letterSpacing: '-0.5px',
    marginBottom: '4px',
    textAlign: 'center',
  };

  const subtitleStyle: React.CSSProperties = {
    fontSize: '13px',
    color: 'var(--color-text-muted)',
    textAlign: 'center',
    marginBottom: '28px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--color-text)',
    marginBottom: '6px',
    display: 'block',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '13px 14px',
    borderRadius: '10px',
    border: '1.5px solid var(--color-border)',
    background: 'var(--color-surface)',
    fontSize: '16px',
    color: 'var(--color-text)',
    outline: 'none',
    transition: 'border-color 0.15s',
  };

  const btnStyle: React.CSSProperties = {
    width: '100%',
    padding: '14px',
    borderRadius: '12px',
    border: 'none',
    background: 'var(--color-primary)',
    color: 'var(--color-white)',
    fontSize: '16px',
    fontWeight: 700,
    marginTop: '20px',
    cursor: loading ? 'not-allowed' : 'pointer',
    opacity: loading ? 0.7 : 1,
    transition: 'opacity 0.15s, background 0.15s',
  };

  const errorStyle: React.CSSProperties = {
    marginTop: '12px',
    padding: '10px 12px',
    borderRadius: '8px',
    background: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
    color: 'var(--color-error)',
    fontSize: '13px',
    fontWeight: 500,
  };

  const linkStyle: React.CSSProperties = {
    fontSize: '13px',
    color: 'var(--color-primary)',
    textDecoration: 'underline',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    marginTop: '16px',
    display: 'block',
    textAlign: 'center',
  };

  const backLabel: React.CSSProperties = {
    fontSize: '13px',
    color: 'var(--color-text-muted)',
    textDecoration: 'none',
    display: 'block',
    textAlign: 'center',
    marginTop: '12px',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        {/* Logo */}
        <div style={logoStyle}>WafriAI</div>
        <p style={subtitleStyle}>Your intelligent farm assistant</p>

        {/* ── Step 1: Phone ──────────────────────────────────────────────── */}
        {step === 'phone' && (
          <>
            {/* Login / Register tab switcher */}
            <div style={{
              display: 'flex',
              background: 'var(--color-surface)',
              borderRadius: '10px',
              padding: '4px',
              marginBottom: '24px',
              gap: '4px',
            }}>
              {(['login', 'register'] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); clearError(); }}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: '8px',
                    border: 'none',
                    background: mode === m ? 'var(--color-primary)' : 'transparent',
                    color: mode === m ? 'var(--color-white)' : 'var(--color-text-muted)',
                    fontWeight: mode === m ? 700 : 500,
                    fontSize: '14px',
                    cursor: 'pointer',
                    transition: 'background 0.2s, color 0.2s',
                  }}
                >
                  {m === 'login' ? 'Sign In' : 'Register'}
                </button>
              ))}
            </div>
            <label style={labelStyle} htmlFor="phone">Phone number</label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              placeholder="0801 234 5678"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); clearError(); }}
              onKeyDown={(e) => e.key === 'Enter' && handlePhoneSubmit()}
              style={inputStyle}
            />
            {error && <div role="alert" style={errorStyle}>{error}</div>}
            <button
              style={btnStyle}
              onClick={handlePhoneSubmit}
              disabled={loading || phone.trim().length < 10}
            >
              {mode === 'register' ? 'Create Account' : 'Continue'}
            </button>
          </>
        )}

        {/* ── Step 2: PIN login ──────────────────────────────────────────── */}
        {step === 'pin' && (
          <>
            <p style={{ ...subtitleStyle, marginBottom: '6px', color: 'var(--color-text)' }}>
              Enter PIN for
            </p>
            <p style={{ ...subtitleStyle, fontWeight: 700, fontSize: '15px' }}>
              {maskPhone(phoneE164)}
            </p>
            <PinInput value={pin} onChange={setPin} disabled={loading} autoFocus />
            {error && <div role="alert" style={errorStyle}>{error}</div>}
            {loading && (
              <p style={{ textAlign: 'center', marginTop: '12px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                Signing in…
              </p>
            )}
            <button
              style={linkStyle}
              onClick={() => { setStep('otp_request'); clearError(); }}
            >
              Forgot PIN?
            </button>
            <button
              style={backLabel}
              onClick={() => { setStep('phone'); setPin(''); clearError(); }}
            >
              ← Back
            </button>
          </>
        )}

        {/* ── Step 2b: PIN setup (first time / register) ────────────────── */}
        {step === 'pin_setup' && (
          <>
            <p style={{ ...subtitleStyle, color: 'var(--color-text)', marginBottom: '20px' }}>
              {mode === 'register'
                ? `Create a 6-digit PIN for ${maskPhone(phoneE164)}.`
                : 'Welcome! Create a 6-digit PIN to secure your account.'}
            </p>
            <p style={{ ...labelStyle, textAlign: 'center', marginBottom: '10px' }}>Create PIN</p>
            <PinInput value={pin} onChange={setPin} disabled={loading || pin.length === 6} autoFocus />
            {pin.length === 6 && (
              <>
                <p style={{ ...labelStyle, textAlign: 'center', marginTop: '20px', marginBottom: '10px' }}>
                  Confirm PIN
                </p>
                <PinInput value={pinConfirm} onChange={setPinConfirm} disabled={loading} autoFocus />
              </>
            )}
            {error && <div role="alert" style={errorStyle}>{error}</div>}
            {loading && (
              <p style={{ textAlign: 'center', marginTop: '12px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                Saving PIN…
              </p>
            )}
            <button
              style={backLabel}
              onClick={() => { setStep('phone'); setPin(''); setPinConfirm(''); clearError(); }}
            >
              ← Back
            </button>
            {mode === 'register' && (
              <button
                style={{ ...linkStyle, marginTop: '8px' }}
                onClick={() => { setMode('login'); setStep('phone'); setPin(''); setPinConfirm(''); clearError(); }}
              >
                Already have an account? Sign in
              </button>
            )}
          </>
        )}

        {/* ── Step 3a: OTP request (forgot PIN) ─────────────────────────── */}
        {step === 'otp_request' && (
          <>
            <p style={{ ...subtitleStyle, color: 'var(--color-text)', marginBottom: '20px' }}>
              We'll send a one-time code to {maskPhone(phoneE164)} to reset your PIN.
            </p>
            {error && <div role="alert" style={errorStyle}>{error}</div>}
            <button
              style={btnStyle}
              onClick={handleOtpRequest}
              disabled={loading}
            >
              {loading ? 'Sending…' : 'Send OTP'}
            </button>
            <button
              style={backLabel}
              onClick={() => { setStep('pin'); clearError(); }}
            >
              ← Back
            </button>
          </>
        )}

        {/* ── Step 3b: OTP verify + new PIN ─────────────────────────────── */}
        {step === 'otp_verify' && (
          <>
            <p style={{ ...subtitleStyle, color: 'var(--color-text)', marginBottom: '4px' }}>
              Enter the 6-digit OTP sent to {maskPhone(phoneE164)}.
            </p>
            <p style={{ ...labelStyle, textAlign: 'center', marginBottom: '10px' }}>OTP code</p>
            <PinInput value={otp} onChange={setOtp} disabled={loading} autoFocus />

            {otp.length === 6 && (
              <>
                <p style={{ ...labelStyle, textAlign: 'center', marginTop: '20px', marginBottom: '10px' }}>
                  New PIN
                </p>
                <PinInput value={newPin} onChange={setNewPin} disabled={loading || newPin.length === 6} />
                {newPin.length === 6 && (
                  <>
                    <p style={{ ...labelStyle, textAlign: 'center', marginTop: '20px', marginBottom: '10px' }}>
                      Confirm new PIN
                    </p>
                    <PinInput value={newPinConfirm} onChange={setNewPinConfirm} disabled={loading} autoFocus />
                  </>
                )}
              </>
            )}

            {error && <div role="alert" style={errorStyle}>{error}</div>}
            {loading && (
              <p style={{ textAlign: 'center', marginTop: '12px', color: 'var(--color-text-muted)', fontSize: '13px' }}>
                Resetting PIN…
              </p>
            )}

            {otp.length === 6 && newPin.length === 6 && newPinConfirm.length === 6 && !loading && (
              <button style={btnStyle} onClick={handleOtpVerify}>
                Reset PIN &amp; Log In
              </button>
            )}

            <button
              style={backLabel}
              onClick={() => { setStep('otp_request'); setOtp(''); setNewPin(''); setNewPinConfirm(''); clearError(); }}
            >
              ← Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
