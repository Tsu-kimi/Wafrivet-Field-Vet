'use client';

/**
 * app/components/ProductCardRow.tsx
 *
 * Horizontal scroll strip that slides up from the bottom when products arrive.
 *
 * - Each ProductCard shows the Next.js Image, product name, price in ₦,
 *   and an "Add to cart" button.
 * - The active (last-added) card is visually highlighted with a green border
 *   and filled button.
 * - The strip animates in with a CSS translateY transition on first render.
 * - Scroll snaps are applied for a native feel on Android Chrome.
 */

import React, { useState } from 'react';
import Image from 'next/image';
import type { Product } from '@/app/types/events';

export interface ProductCardRowProps {
  products: Product[];
  onAddToCart: (product: Product) => void;
}

// ── Individual product card ────────────────────────────────────────────────────

interface ProductCardProps {
  product: Product;
  isActive: boolean;
  onTap: () => void;
  onAdd: () => void;
}

function ProductCard({ product, isActive, onTap, onAdd }: ProductCardProps) {
  const hasImage =
    product.image_url && product.image_url.trim().length > 0;

  return (
    <article
      onClick={onTap}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTap();
        }
      }}
      aria-pressed={isActive}
      aria-label={`${product.name}, ₦${product.base_price.toLocaleString('en-NG')}${isActive ? ', selected' : ''}`}
      style={{
        flex: '0 0 160px',
        borderRadius: '16px',
        overflow: 'hidden',
        background: isActive ? '#142014' : '#141a24',
        border: `2px solid ${isActive ? '#2ea043' : '#30363d'}`,
        display: 'flex',
        flexDirection: 'column',
        cursor: 'pointer',
        transition: 'border-color 0.2s ease, background 0.2s ease',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        boxShadow: isActive
          ? '0 0 0 3px rgba(46,160,67,0.25), 0 4px 16px rgba(0,0,0,0.4)'
          : '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      {/* ── Product image ─────────────────────────────────────────────── */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '4/3',
          background: '#1c2535',
          overflow: 'hidden',
        }}
      >
        {hasImage ? (
          <Image
            src={product.image_url}
            alt={product.name}
            fill
            sizes="160px"
            style={{ objectFit: 'cover' }}
            priority={false}
          />
        ) : (
          /* Placeholder when no image is available */
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '32px',
              color: '#30363d',
            }}
            aria-hidden
          >
            💊
          </div>
        )}
      </div>

      {/* ── Product info ──────────────────────────────────────────────── */}
      <div
        style={{
          padding: '10px 10px 12px',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <p
          className="line-clamp-2"
          style={{
            fontSize: '12px',
            fontWeight: 700,
            color: '#e6edf3',
            lineHeight: 1.35,
            margin: 0,
          }}
        >
          {product.name}
        </p>

        <p
          style={{
            fontSize: '14px',
            fontWeight: 800,
            color: '#3fb950',
            margin: 0,
          }}
        >
          ₦{product.base_price.toLocaleString('en-NG')}
        </p>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          style={{
            background: isActive
              ? 'linear-gradient(135deg, #2ea043, #238636)'
              : 'rgba(46, 160, 67, 0.12)',
            color: isActive ? '#fff' : '#3fb950',
            border: `1.5px solid ${isActive ? 'transparent' : 'rgba(46,160,67,0.35)'}`,
            borderRadius: '10px',
            padding: '8px 6px',
            fontSize: '12px',
            fontWeight: 700,
            cursor: 'pointer',
            minHeight: '36px',
            width: '100%',
            transition: 'background 0.2s ease, color 0.2s ease',
            touchAction: 'manipulation',
          }}
          aria-label={`Add ${product.name} to cart`}
        >
          + Add to cart
        </button>
      </div>
    </article>
  );
}

// ── Row ────────────────────────────────────────────────────────────────────────

export function ProductCardRow({
  products,
  onAddToCart,
}: ProductCardRowProps) {
  const [activeProductId, setActiveProductId] = useState<string | null>(null);

  if (products.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Recommended veterinary products"
      style={{ animation: 'slide-up 0.42s cubic-bezier(0.34, 1.38, 0.64, 1)' }}
    >
      <p
        style={{
          fontSize: '11px',
          fontWeight: 700,
          color: '#d4a017',
          textTransform: 'uppercase',
          letterSpacing: '0.09em',
          padding: '0 16px 8px',
          textShadow: '0 1px 4px rgba(0,0,0,0.9)',
          margin: 0,
        }}
      >
        Recommended treatments ({products.length})
      </p>

      {/* Horizontal scroll container — scrollbar hidden via CSS class */}
      <div
        className="hide-scrollbar"
        style={{
          display: 'flex',
          gap: '10px',
          overflowX: 'auto',
          padding: '0 16px 4px',
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {products.map((p) => (
          <div
            key={p.id}
            style={{ scrollSnapAlign: 'start', flex: '0 0 auto' }}
          >
            <ProductCard
              product={p}
              isActive={activeProductId === p.id}
              onTap={() =>
                setActiveProductId(p.id === activeProductId ? null : p.id)
              }
              onAdd={() => {
                setActiveProductId(p.id);
                onAddToCart(p);
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
