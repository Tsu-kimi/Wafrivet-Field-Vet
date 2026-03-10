'use client';

/**
 * app/components/CartBadge.tsx
 *
 * Floating cart summary badge — bottom-right corner, above the pay button.
 *
 * - Invisible when cart is empty (itemCount === 0)
 * - Shows item count and ₦ total
 * - Fires a brief scale-pulse CSS animation on every CART_UPDATED event
 *   (detected via the updateVersion counter incrementing)
 */

import React, { useEffect, useRef, useState } from 'react';

export interface CartBadgeProps {
  itemCount: number;
  /** Current cart total in NGN. */
  total: number;
  /**
   * Monotonically-increasing integer. FieldVetSession increments this on every
   * CART_UPDATED event so CartBadge can trigger its pulse animation without
   * needing to compare deep cart state.
   */
  updateVersion: number;
}

export function CartBadge({ itemCount, total, updateVersion }: CartBadgeProps) {
  const [isPulsing, setIsPulsing] = useState(false);
  const prevVersionRef = useRef(updateVersion);

  useEffect(() => {
    if (updateVersion !== prevVersionRef.current) {
      prevVersionRef.current = updateVersion;
      setIsPulsing(true);
      const t = setTimeout(() => setIsPulsing(false), 550);
      return () => clearTimeout(t);
    }
  }, [updateVersion]);

  if (itemCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`Cart: ${itemCount} item${itemCount !== 1 ? 's' : ''}, ₦${total.toLocaleString('en-NG')}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'linear-gradient(135deg, #2ea043, #238636)',
        borderRadius: '28px',
        padding: '10px 16px',
        minHeight: '52px',
        boxShadow: '0 4px 24px rgba(46, 160, 67, 0.45)',
        cursor: 'default',
        animation: isPulsing ? 'cart-pulse 0.52s ease-out' : 'none',
        transformOrigin: 'center',
        userSelect: 'none',
        backdropFilter: 'blur(6px)',
      }}
    >
      <span style={{ fontSize: '18px', lineHeight: 1 }} aria-hidden>
        🛒
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            color: 'rgba(255,255,255,0.85)',
            letterSpacing: '0.04em',
          }}
        >
          {itemCount} item{itemCount !== 1 ? 's' : ''}
        </span>
        <span
          style={{
            fontSize: '14px',
            fontWeight: 800,
            color: '#fff',
          }}
        >
          ₦{total.toLocaleString('en-NG')}
        </span>
      </div>
    </div>
  );
}
