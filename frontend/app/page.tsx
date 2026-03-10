/**
 * app/page.tsx — Root page Server Component.
 *
 * This file MUST NOT contain 'use client'. It is a Server Component.
 *
 * It renders FieldVetSession as its only child. FieldVetSession is a
 * Client Component, so its interactive logic executes on the client.
 *
 * In Next.js App Router, a Server Component that renders a Client Component
 * is the correct pattern for splitting server-controlled routing from
 * client-controlled interactivity. No data fetching is needed at the page
 * level — all state arrives via the WebSocket connection.
 */

import { FieldVetSession } from './components/FieldVetSession';

export default function Home() {
  return <FieldVetSession />;
}
