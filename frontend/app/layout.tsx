/**
 * app/layout.tsx — Root Server Component layout.
 *
 * This file MUST NOT contain 'use client'. It is a Server Component.
 * It may import Client Components (WebSocketProvider) — Next.js App Router
 * propagates the client boundary at the import point, not here.
 *
 * Responsibilities:
 *   - Define HTML shell (<html>, <body>)
 *   - Configure mobile viewport metadata (full-screen, no user scale)
 *   - Wrap the page tree in <WebSocketProvider> to share WS context
 *
 * Viewport export: Next.js 14+ generateViewport / viewport.
 *   Using the exported `viewport` constant avoids deprecated <meta> tags.
 */

import { Inter, Fraunces, JetBrains_Mono } from 'next/font/google';
import type { Metadata, Viewport } from 'next';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

// ── Document metadata ─────────────────────────────────────────────────────────

export const metadata: Metadata = {
  title: 'WafriAI — AI Livestock Assistant',
  description:
    'Real-time multimodal AI veterinary assistant for West African livestock farmers. ' +
    'Talk to the AI, show your animal on camera, get instant diagnosis and treatment.',
  applicationName: 'WafriAI',
  icons: { icon: '/icon.png' },
  // Open Graph for sharing
  openGraph: {
    title: 'WafriAI',
    description: 'AI-powered vet for West African livestock farmers.',
    type: 'website',
  },
};

// ── Mobile viewport — full-screen, disable pinch-zoom ─────────────────────────
//
// viewportFit: 'cover' ensures content reaches into safe-area on notch phones.
// userScalable: false + maximumScale: 1 prevents unintended zoom on iOS/Android.
// Exported as a separate `viewport` constant per Next.js 14+ convention.

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#D9E0D0', // Bone
};

import { OnboardingGuard } from './components/OnboardingGuard';

// ── Root layout (Server Component) ────────────────────────────────────────────

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable} ${mono.variable}`}>
      <body>
        <OnboardingGuard>
          {children}
        </OnboardingGuard>
      </body>
    </html>
  );
}
