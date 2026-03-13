'use client';

import React, { useState, useEffect } from 'react';
import { Onboarding } from './Onboarding';

// Incremented version to ensure even existing sessions see the new flow first.
const ONBOARDED_KEY = 'wafrivet_onboarded_v5_final';

interface OnboardingGuardProps {
  children: React.ReactNode;
}

export function OnboardingGuard({ children }: OnboardingGuardProps) {
  const [status, setStatus] = useState<'loading' | 'onboarding' | 'ready'>('loading');

  useEffect(() => {
    // Check onboarding status ONCE on mount
    const alreadyOnboarded = localStorage.getItem(ONBOARDED_KEY) === '1';
    
    if (alreadyOnboarded) {
      setStatus('ready');
    } else {
      setStatus('onboarding');
    }
  }, []);

  const handleComplete = () => {
    localStorage.setItem(ONBOARDED_KEY, '1');
    setStatus('ready');
  };

  // 1. Initial server render & first client pass: show nothing (empty body)
  // This prevents hydration flashes.
  if (status === 'loading') {
    return <div style={{ background: 'var(--color-bg)', minHeight: '100svh' }} />;
  }

  // 2. Not onboarded: show Onboarding ONLY.
  if (status === 'onboarding') {
    return <Onboarding onComplete={handleComplete} />;
  }

  // 3. Onboarded: show the actual app content.
  return <>{children}</>;
}
