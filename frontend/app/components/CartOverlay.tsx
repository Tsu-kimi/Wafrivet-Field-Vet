'use client';

import React from 'react';
import { ArrowLeft2, Minus, Add, Trash } from 'iconsax-react';
import type { CartItem } from '@/app/types/events';

interface CartOverlayProps {
  open: boolean;
  items: CartItem[];
  total: number;
  onClose: () => void;
  onIncrement: (item: CartItem) => void;
  onDecrement: (item: CartItem) => void;
  onRemove: (item: CartItem) => void;
  onCheckout: () => void;
}

export function CartOverlay({
  open,
  items,
  total,
  onClose,
  onIncrement,
  onDecrement,
  onRemove,
  onCheckout,
}: CartOverlayProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Shopping cart"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 115,
        background: 'color-mix(in srgb, var(--color-bg) 78%, black)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'calc(14px + var(--spacing-safe-top)) 16px 12px',
          borderBottom: '1px solid var(--color-border)',
          background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Back to camera"
          style={{
            height: '44px',
            minWidth: '44px',
            border: '1px solid var(--color-border)',
            borderRadius: '999px',
            background: 'transparent',
            color: 'var(--color-text)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <ArrowLeft2 size={20} color="currentColor" />
        </button>
        <h3
          style={{
            margin: 0,
            color: 'var(--color-text)',
            fontSize: '20px',
            fontFamily: 'var(--font-fraunces)',
          }}
        >
          Your Cart
        </h3>
        <div style={{ width: '44px' }} />
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 16px 120px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {items.length === 0 && (
          <div
            style={{
              marginTop: '14vh',
              textAlign: 'center',
              color: 'var(--color-text-muted)',
            }}
          >
            <p style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>Your cart is empty</p>
            <p style={{ margin: '8px 0 0', fontSize: '13px' }}>
              Ask Fatima for products and add items to continue.
            </p>
          </div>
        )}

        {items.map((item) => (
          <article
            key={item.product_id}
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: '14px',
              padding: '12px',
              background: 'color-mix(in srgb, var(--color-surface-2) 85%, transparent)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
              <p
                style={{
                  margin: 0,
                  color: 'var(--color-text)',
                  fontSize: '14px',
                  fontWeight: 700,
                  lineHeight: 1.4,
                }}
              >
                {item.product_name}
              </p>
              <button
                onClick={() => onRemove(item)}
                aria-label={`Remove ${item.product_name}`}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--color-error)',
                  minWidth: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Trash size={18} color="currentColor" />
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>
                ₦{item.unit_price.toLocaleString('en-NG')} each
              </span>
              <span style={{ color: 'var(--color-text)', fontSize: '15px', fontWeight: 800 }}>
                ₦{item.subtotal.toLocaleString('en-NG')}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                onClick={() => onDecrement(item)}
                aria-label={`Decrease ${item.product_name}`}
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Minus size={16} color="currentColor" />
              </button>
              <div
                style={{
                  minWidth: '44px',
                  textAlign: 'center',
                  color: 'var(--color-text)',
                  fontSize: '16px',
                  fontWeight: 700,
                }}
              >
                {item.quantity}
              </div>
              <button
                onClick={() => onIncrement(item)}
                aria-label={`Increase ${item.product_name}`}
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Add size={16} color="currentColor" />
              </button>
            </div>
          </article>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: '12px 16px calc(12px + var(--spacing-safe-bottom))',
          borderTop: '1px solid var(--color-border)',
          background: 'color-mix(in srgb, var(--color-surface) 94%, transparent)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '13px', fontWeight: 600 }}>
            Total
          </span>
          <span style={{ color: 'var(--color-text)', fontSize: '20px', fontWeight: 800 }}>
            ₦{total.toLocaleString('en-NG')}
          </span>
        </div>
        <button
          onClick={onCheckout}
          disabled={items.length === 0}
          style={{
            minHeight: '48px',
            borderRadius: '12px',
            border: 'none',
            background: items.length > 0 ? 'var(--color-primary)' : 'var(--color-border)',
            color: 'var(--color-white)',
            fontSize: '15px',
            fontWeight: 800,
          }}
        >
          Proceed to Checkout
        </button>
      </div>
    </div>
  );
}
