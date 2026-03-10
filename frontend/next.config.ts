import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // ── Supabase Storage — product images migrated to object storage ──────
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
      // ── ngrok tunnels for local integration testing ───────────────────────
      // Remove this block before deploying to production.
      {
        protocol: 'https',
        hostname: '*.ngrok-free.app',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.ngrok.io',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
