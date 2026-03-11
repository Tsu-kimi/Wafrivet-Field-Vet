'use client';

/**
 * app/page.tsx — Root page.
 *
 * It conditionally renders the Onboarding carousel on first load.
 * Once the user completes onboarding, it mounts the FieldVetSession.
 */

import React, { useState } from 'react';
import { FieldVetSession } from './components/FieldVetSession';
import { Onboarding } from './components/Onboarding';

export default function Home() {
  const [showOnboarding, setShowOnboarding] = useState(true);

  if (showOnboarding) {
    return <Onboarding onComplete={() => setShowOnboarding(false)} />;
  }

  return <FieldVetSession />;
}
