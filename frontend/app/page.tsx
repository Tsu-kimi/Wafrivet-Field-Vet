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

const ONBOARDED_KEY = 'wafrivet_onboarded';
const USER_IDENTITY_KEY = 'wafrivet_user_identity';
const FARMER_KEY = 'wafrivet_farmer';

export default function Home() {
  const router = useRouter();
  // 'onboarding' | 'auth' | 'session' | null
  const [step, setStep] = useState<'onboarding' | 'auth' | 'session' | null>(null);

  useEffect(() => {
    // Guard: require login before allowing access.
    const farmer = localStorage.getItem(FARMER_KEY);
    if (!farmer) {
      router.replace('/login');
      return;
    }
    const alreadyOnboarded = localStorage.getItem(ONBOARDED_KEY) === '1';
    const userIdentity = localStorage.getItem(USER_IDENTITY_KEY);

    if (!alreadyOnboarded) {
      setStep('onboarding');
    } else if (!userIdentity) {
      setStep('auth');
    } else {
      setStep('session');
    }
  }, []);

  const handleOnboardingComplete = () => {
    localStorage.setItem(ONBOARDED_KEY, '1');
    setStep('auth');
  };

  const handleAuthComplete = (identity: { phoneNumber: string; name: string }) => {
    localStorage.setItem(USER_IDENTITY_KEY, JSON.stringify(identity));
    // Also set the stable user_id to the phone number for the WebSocketProvider
    sessionStorage.setItem('wafrivet_user_id', identity.phoneNumber.replace(/\+/g, ''));
    setStep('session');
  };

  // Hold rendering until localStorage has been read
  if (step === null) return null;

  if (step === 'onboarding') {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  if (step === 'auth') {
    return <AuthScreen onComplete={handleAuthComplete} />;
  }

  return (
    <WebSocketProvider>
      <FieldVetSession />
    </WebSocketProvider>
  );
}
