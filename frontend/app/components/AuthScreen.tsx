'use client';

import React, { useState, useEffect } from 'react';
import { User, Call, ArrowRight2, ArrowLeft2, CloseCircle } from 'iconsax-react';

interface AuthScreenProps {
  onComplete: (identity: { phoneNumber: string; name: string }) => void;
}

type AuthStep = 'phone' | 'name';

export function AuthScreen({ onComplete }: AuthScreenProps) {
  const [step, setStep] = useState<AuthStep>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handlePhoneSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Simple validation for Nigerian phone numbers (e.g., 080..., 070..., 090..., 081...)
    const phoneRegex = /^(?:0|234|\+234)\d{10}$/;
    if (!phoneRegex.test(phoneNumber.replace(/\s+/g, ''))) {
      setError('Please enter a valid Nigerian phone number');
      return;
    }
    setError(null);
    triggerTransition('name');
  };

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError('Please enter your full name');
      return;
    }
    onComplete({ phoneNumber, name });
  };

  const triggerTransition = (nextStep: AuthStep) => {
    setIsTransitioning(true);
    setTimeout(() => {
      setStep(nextStep);
      setIsTransitioning(false);
    }, 300);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-bg)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        fontFamily: 'var(--font-inter)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '400px',
          background: 'var(--color-surface-2)',
          borderRadius: '32px',
          padding: '40px 24px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: '32px',
          opacity: isTransitioning ? 0 : 1,
          transform: isTransitioning ? 'translateY(10px)' : 'translateY(0)',
          transition: 'all 0.3s ease-out',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center' }}>
          <h2
            style={{
              fontFamily: 'var(--font-fraunces)',
              fontSize: '28px',
              fontWeight: 800,
              color: 'var(--color-text)',
              margin: '0 0 8px 0',
            }}
          >
            {step === 'phone' ? 'Hello!' : 'Almost there'}
          </h2>
          <p style={{ fontSize: '15px', color: 'var(--color-text-muted)', margin: 0 }}>
            {step === 'phone' 
              ? 'Enter your phone number to get started' 
              : 'What should we call you?'}
          </p>
        </div>

        {/* Form */}
        <form 
          onSubmit={step === 'phone' ? handlePhoneSubmit : handleNameSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
        >
          <div style={{ position: 'relative' }}>
            {step === 'phone' ? (
              <>
                <Call
                  size={20}
                  color="var(--color-primary)"
                  style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="tel"
                  placeholder="0801 234 5678"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '16px 16px 16px 48px',
                    borderRadius: '16px',
                    border: error ? '2px solid var(--color-error)' : '2px solid var(--color-border)',
                    background: 'var(--color-bg)',
                    fontSize: '16px',
                    color: 'var(--color-text)',
                    outline: 'none',
                    transition: 'border-color 0.2s',
                  }}
                />
              </>
            ) : (
              <>
                <User
                  size={20}
                  color="var(--color-primary)"
                  style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="text"
                  placeholder="Your Full Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '16px 16px 16px 48px',
                    borderRadius: '16px',
                    border: error ? '2px solid var(--color-error)' : '2px solid var(--color-border)',
                    background: 'var(--color-bg)',
                    fontSize: '16px',
                    color: 'var(--color-text)',
                    outline: 'none',
                    transition: 'border-color 0.2s',
                  }}
                />
              </>
            )}
          </div>

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-error)', fontSize: '13px' }}>
              <CloseCircle size={16} variant="Bold" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            style={{
              background: 'var(--color-primary)',
              color: 'var(--color-white)',
              border: 'none',
              borderRadius: '16px',
              padding: '18px',
              fontSize: '16px',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              boxShadow: '0 8px 20px color-mix(in srgb, var(--color-primary) 30%, transparent)',
              transition: 'all 0.2s',
            }}
            onPointerDown={(e) => (e.currentTarget.style.transform = 'scale(0.97)')}
            onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >
            {step === 'phone' ? 'Next' : 'Create Account'}
            <ArrowRight2 size={18} variant="Linear" />
          </button>
        </form>

        {/* Footer info/back button */}
        {step === 'name' && (
          <button
            onClick={() => triggerTransition('phone')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-muted)',
              fontSize: '14px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              cursor: 'pointer',
            }}
          >
            <ArrowLeft2 size={16} />
            Change phone number
          </button>
        )}
      </div>
    </div>
  );
}
