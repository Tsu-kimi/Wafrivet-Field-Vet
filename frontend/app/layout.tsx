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
import { WebSocketProvider } from './components/WebSocketProvider';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

// ── Document metadata ─────────────────────────────────────────────────────────

export const metadata: Metadata = {
  title: 'Wafrivet Field Vet — AI Livestock Assistant',
  description:
    'Real-time multimodal AI veterinary assistant for West African livestock farmers. ' +
    'Talk to the AI, show your animal on camera, get instant diagnosis and treatment.',
  applicationName: 'Wafrivet Field Vet',
  icons: { icon: '/favicon.ico' },
  // Open Graph for sharing
  openGraph: {
    title: 'Wafrivet Field Vet',
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

// ── Root layout (Server Component) ────────────────────────────────────────────

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable} ${mono.variable}`}>
      <body>
        {/*
          WebSocketProvider is a Client Component. Importing it here is valid
          in App Router — the client boundary starts at the component itself,
          not at the Server Component that renders it.

          children (from page.tsx) are Server-rendered and passed through
          WebSocketProvider as opaque React nodes; they do NOT become client
          components simply because their parent is one.
        */}
        <WebSocketProvider>{children}</WebSocketProvider>
      </body>
    </html>
  );
}
