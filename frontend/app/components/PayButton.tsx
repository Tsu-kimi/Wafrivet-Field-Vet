'use client';

/**
 * app/components/PayButton.tsx
 *
 * Full-width "Pay Now" button using Paystack inline SDK.
 *
 * Triggered when checkoutUrl arrives (CHECKOUT_LINK event). Instead of
 * redirecting to the pre-generated URL, we call PaystackPop.newTransaction()
 * with the Paystack public key so the popup appears in-app without a page
 * leave — better UX on mobile browsers.
 *
 * @paystack/inline-js is loaded via dynamic import inside the click handler
 * so it never executes during Next.js server-side prerendering (the package
 * accesses `window` at module initialisation time, which would throw on the
 * server).
 *
 * Environment variable required (set in .env.local or Vercel):
 *   NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY
 *
 * On success: shows a fullscreen payment-success overlay.
 */

import React, { useState } from 'react';

export interface PayButtonProps {
  /** Cart total in NGN — converted to kobo (×100) when calling Paystack. */
  cartTotal: number;
}

export function PayButton({ cartTotal }: PayButtonProps) {
  const [showSuccess, setShowSuccess] = useState(false);
  const [isLoading,   setIsLoading]   = useState(false);
  const paystackKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY ?? '';

  const handlePay = async () => {
    if (!paystackKey) {
      console.warn(
        '[PayButton] NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY is not set. ' +
          'Add it to .env.local (or Vercel project settings) and rebuild.',
      );
      return;
    }

    setIsLoading(true);
    try {
      // Dynamic import prevents the Paystack bundle (which accesses `window`
      // at module-init time) from executing during SSR prerendering.
      const { default: PaystackPop } = await import('@paystack/inline-js');
      PaystackPop.newTransaction({
        key: paystackKey,
        // Demo email placeholder — Paystack requires an email field.
        email: 'farmer@wafrivet.app',
        amount: Math.round(cartTotal * 100), // NGN → kobo
        currency: 'NGN',
        metadata: { source: 'wafrivet-field-vet', version: '1.0' },
        onSuccess: () => {
          setIsLoading(false);
          setShowSuccess(true);
        },
        onCancel: () => {
          // User dismissed popup without paying.
          setIsLoading(false);
        },
        onError: (err) => {
          console.error('[PayButton] Paystack error:', err.message);
          setIsLoading(false);
        },
      });
    } catch (err) {
      console.error('[PayButton] Failed to load Paystack:', err);
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* ── Pay Now button ─────────────────────────────────────────────── */}
      <button
        onClick={() => void handlePay()}
        disabled={isLoading}
        style={{
          width: '100%',
          background: isLoading
            ? 'rgba(232,101,26,0.5)'
            : 'linear-gradient(135deg, #e8651a 0%, #d4a017 100%)',
          color: '#fff',
          border: 'none',
          borderRadius: '18px',
          padding: '0 24px',
          fontSize: '18px',
          fontWeight: 800,
          cursor: isLoading ? 'not-allowed' : 'pointer',
          minHeight: '64px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          boxShadow: isLoading
            ? 'none'
            : '0 6px 28px rgba(232, 101, 26, 0.5), 0 2px 8px rgba(0,0,0,0.3)',
          letterSpacing: '0.01em',
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
          textShadow: '0 1px 3px rgba(0,0,0,0.25)',
          transition: 'background 0.2s ease, box-shadow 0.2s ease',
        }}
        aria-label={`Pay ₦${cartTotal.toLocaleString('en-NG')} now with Paystack`}
        aria-busy={isLoading}
      >
        <span aria-hidden style={{ fontSize: '20px' }}>
          {isLoading ? '⏳' : '💳'}
        </span>
        <span>
          {isLoading
            ? 'Opening payment…'
            : `Pay ₦${cartTotal.toLocaleString('en-NG')} Now`}
        </span>
      </button>

      {/* ── Payment success overlay ───────────────────────────────────── */}
      {showSuccess && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Payment successful"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10, 14, 20, 0.94)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '22px',
            zIndex: 200,
            padding: '32px 24px',
            animation: 'fade-in 0.3s ease',
          }}
        >
          {/* Success icon */}
          <div
            aria-hidden
            style={{
              width: '88px',
              height: '88px',
              borderRadius: '50%',
              background: 'rgba(46, 160, 67, 0.18)',
              border: '3px solid #2ea043',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '40px',
              boxShadow: '0 0 40px rgba(46, 160, 67, 0.3)',
            }}
          >
            ✓
          </div>

          <h2
            style={{
              fontSize: '26px',
              fontWeight: 800,
              color: '#e6edf3',
              textAlign: 'center',
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Payment Successful!
          </h2>

          <p
            style={{
              fontSize: '15px',
              color: '#8b949e',
              textAlign: 'center',
              lineHeight: 1.65,
              maxWidth: '320px',
              margin: 0,
            }}
          >
            Your order has been placed. A veterinary supplier will contact you
            to arrange delivery of your products.
          </p>

          <button
            onClick={() => setShowSuccess(false)}
            style={{
              background: 'linear-gradient(135deg, #2ea043, #238636)',
              color: '#fff',
              border: 'none',
              borderRadius: '14px',
              padding: '0 36px',
              fontSize: '16px',
              fontWeight: 700,
              cursor: 'pointer',
              minHeight: '56px',
              minWidth: '180px',
              boxShadow: '0 4px 20px rgba(46,160,67,0.4)',
              touchAction: 'manipulation',
            }}
          >
            Done
          </button>
        </div>
      )}
    </>
  );
}

