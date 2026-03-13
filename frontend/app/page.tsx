'use client';

/**
 * app/page.tsx — Root page.
 *
 * Auth gate: redirects unauthenticated users to /login.
 * Shows the Onboarding carousel only on the first visit after login.
 * Once onboarding is complete, goes straight to the FieldVetSession.
 */

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Onboarding } from './components/Onboarding';
import { AuthScreen } from './components/AuthScreen';
import { WebSocketProvider } from './components/WebSocketProvider';
import { FieldVetSession } from './components/FieldVetSession';

const ONBOARDED_KEY = 'wafrivet_onboarded_v3';
const USER_IDENTITY_KEY = 'wafrivet_user_identity';
const FARMER_KEY = 'wafrivet_farmer';

export default function Home() {
  const router = useRouter();
  // 'onboarding' | 'auth' | 'session' | null
  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState<'onboarding' | 'auth' | 'session' | null>(null);

  useEffect(() => {
    setMounted(true);
    
    // Guard: require login before allowing access.
    const farmer = localStorage.getItem(FARMER_KEY);
    if (!farmer) {
      router.replace('/login');
      return;
    }
    
    const userIdentity = localStorage.getItem(USER_IDENTITY_KEY);

    if (!userIdentity) {
      setStep('auth');
    } else {
      setStep('session');
    }
  }, [router]);

  const handleAuthComplete = (identity: { phoneNumber: string; name: string }) => {
    localStorage.setItem(USER_IDENTITY_KEY, JSON.stringify(identity));
    // Also set the stable user_id to the phone number for the WebSocketProvider
    sessionStorage.setItem('wafrivet_user_id', identity.phoneNumber.replace(/\+/g, ''));
    setStep('session');
  };

  // Hold rendering until mounted and localStorage has been read
  if (!mounted || step === null) return null;

  if (step === 'auth') {
    return <AuthScreen onComplete={handleAuthComplete} />;
  }

  return (
    <WebSocketProvider>
      <FieldVetSession />
    </WebSocketProvider>
  );
}
