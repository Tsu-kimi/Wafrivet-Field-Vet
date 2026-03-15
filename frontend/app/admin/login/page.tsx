'use client';

import React, { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import logo from '@/app/assets/Green_Black___White_Modern_Creative_Agency_Typography_Logo-removebg-preview.png';

export default function AdminLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'loading' | 'setup' | 'login'>('loading');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/admin/setup')
      .then(r => r.json())
      .then(data => setMode(data.needsSetup ? 'setup' : 'login'))
      .catch(() => setMode('login'));
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Login failed.'); return; }
      router.push('/admin');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetup(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Setup failed.'); return; }
      setMode('login');
      setPassword('');
      setConfirm('');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === 'loading') {
    return (
      <div style={pageStyle}>
        <span style={{ color: 'var(--color-text-muted)' }}>Loading…</span>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: 'var(--color-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 12px',
            overflow: 'hidden',
          }}>
            <Image src={logo} alt="WafriAI" width={56} height={56} style={{ objectFit: 'contain' }} />
          </div>
          <h1 style={{ fontSize: 22, fontFamily: 'var(--font-fraunces)', color: 'var(--color-forest)', fontWeight: 700 }}>
            WafriAI Admin
          </h1>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4 }}>
            {mode === 'setup' ? 'Create your first admin account' : 'Sign in to manage the platform'}
          </p>
        </div>

        {error && (
          <div style={{
            background: 'rgba(248,81,73,0.1)', border: '1px solid var(--color-error)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 16,
            color: 'var(--color-error)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        <form onSubmit={mode === 'setup' ? handleSetup : handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {mode === 'setup' && (
            <label style={labelStyle}>
              <span style={labelTextStyle}>Full Name</span>
              <input
                type="text" value={name} onChange={e => setName(e.target.value)}
                required placeholder="Wafri Admin"
                style={inputStyle}
              />
            </label>
          )}

          <label style={labelStyle}>
            <span style={labelTextStyle}>Email Address</span>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              required placeholder="admin@wafri.ai"
              style={inputStyle}
            />
          </label>

          <label style={labelStyle}>
            <span style={labelTextStyle}>Password</span>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              required placeholder={mode === 'setup' ? 'Min 8 characters' : '••••••••'}
              style={inputStyle}
            />
          </label>

          {mode === 'setup' && (
            <label style={labelStyle}>
              <span style={labelTextStyle}>Confirm Password</span>
              <input
                type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                required placeholder="Repeat password"
                style={inputStyle}
              />
            </label>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              marginTop: 4, padding: '12px 0',
              background: submitting ? 'rgba(107,125,86,0.5)' : 'var(--color-sage)',
              color: '#fff', border: 'none', borderRadius: 8,
              fontSize: 15, fontWeight: 600, cursor: submitting ? 'not-allowed' : 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {submitting ? 'Please wait…' : mode === 'setup' ? 'Create Admin Account' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: '100svh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--color-bg)',
  padding: '24px 16px',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 420,
  background: 'var(--color-bone-light)',
  borderRadius: 16,
  padding: 36,
  boxShadow: '0 4px 32px rgba(58,68,46,0.12)',
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const labelTextStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text)',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1.5px solid rgba(107,125,86,0.3)',
  background: '#fff',
  fontSize: 14,
  color: 'var(--color-text)',
  outline: 'none',
  fontFamily: 'var(--font-inter)',
  transition: 'border-color 0.15s',
};
