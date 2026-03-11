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
import { ShoppingCart } from 'iconsax-react';

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
        background: 'var(--color-primary)',
        borderRadius: '28px',
        padding: '10px 16px',
        minHeight: '52px',
        boxShadow: '0 4px 24px color-mix(in srgb, var(--color-primary) 45%, transparent)',
        cursor: 'default',
        animation: isPulsing ? 'cart-pulse 0.52s ease-out' : 'none',
        transformOrigin: 'center',
        userSelect: 'none',
        backdropFilter: 'blur(6px)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center' }} aria-hidden>
        <ShoppingCart variant="Bold" size={24} color="var(--color-white)" />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            color: 'color-mix(in srgb, var(--color-white) 85%, transparent)',
            letterSpacing: '0.04em',
          }}
        >
          {itemCount} item{itemCount !== 1 ? 's' : ''}
        </span>
        <span
          style={{
            fontSize: '14px',
            fontWeight: 800,
            color: 'var(--color-white)',
          }}
        >
          ₦{total.toLocaleString('en-NG')}
        </span>
      </div>
    </div>
  );
}
