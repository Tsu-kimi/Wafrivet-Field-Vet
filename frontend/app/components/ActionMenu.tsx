'use client';

import React, { useState, useRef, useEffect } from 'react';
import { 
  ArrowDown2, 
  Notification, 
  Global, 
  ShoppingCart, 
  Location,
  CloseSquare
} from 'iconsax-react';

interface ActionMenuProps {
  onShowNotifications: () => void;
  onResetLocation: () => void;
  onShowCart: () => void;
  hasNotifications: boolean;
  cartCount: number;
  cartTotal: number;
}

export function ActionMenu({
  onShowNotifications,
  onResetLocation,
  onShowCart,
  hasNotifications,
  cartCount,
  cartTotal,
}: ActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const toggleMenu = () => setIsOpen(!isOpen);

  const baseItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '44px',
    height: '44px',
    cursor: 'pointer',
    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    WebkitTapHighlightColor: 'transparent',
    background: 'none',
    border: 'none',
    padding: 0,
  };

  const triggerButtonStyle: React.CSSProperties = {
    ...baseItemStyle,
    borderRadius: '50%',
    background: 'color-mix(in srgb, var(--color-surface-2) 60%, transparent)',
    border: '1px solid var(--color-border)',
    backdropFilter: 'blur(12px)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  };

  return (
    <div ref={menuRef} style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '12px' }}>
      {/* Trigger Button */}
      <button
        onClick={toggleMenu}
        style={{
          ...triggerButtonStyle,
          background: (hasNotifications && !isOpen) || (cartCount > 0 && !isOpen)
            ? 'color-mix(in srgb, var(--color-error) 22%, transparent)' 
            : triggerButtonStyle.background,
          border: (hasNotifications && !isOpen) || (cartCount > 0 && !isOpen) 
            ? '1px solid var(--color-error)' 
            : triggerButtonStyle.border,
          transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          zIndex: 100,
          position: 'relative',
        }}
        aria-label={`Toggle action menu${cartCount > 0 ? `, ${cartCount} items in cart` : ''}`}
        aria-expanded={isOpen}
      >
        <ArrowDown2 
          variant="Linear" 
          color={(hasNotifications && !isOpen) || (cartCount > 0 && !isOpen) ? 'var(--color-error)' : 'var(--color-white)'} 
          size={24} 
        />
        {cartCount > 0 && !isOpen && (
          <span
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              background: 'var(--color-error)',
              color: 'var(--color-white)',
              fontSize: '10px',
              fontWeight: 800,
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '2px solid var(--color-surface-2)',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            }}
          >
            {cartCount}
          </span>
        )}
      </button>

      {/* Dropdown Items */}
      {isOpen && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          {/* Notification Icon */}
          <button
            onClick={() => {
              onShowNotifications();
              setIsOpen(false);
            }}
            style={{
              ...baseItemStyle,
              animation: 'menu-slide-down 0.3s cubic-bezier(0.22, 1, 0.36, 1) both',
              animationDelay: '0.05s',
            }}
            aria-label="View notifications"
          >
            <Notification 
              variant="Linear" 
              color="var(--color-white)" 
              size={24} 
            />
          </button>

          {/* Globe/Website Icon */}
          <a
            href="https://wafrivet.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...baseItemStyle,
              animation: 'menu-slide-down 0.3s cubic-bezier(0.22, 1, 0.36, 1) both',
              animationDelay: '0.1s',
            }}
            aria-label="Visit Wafrivet website"
          >
            <Global variant="Linear" color="var(--color-white)" size={24} />
          </a>

          {/* Cart Icon */}
          <button
            onClick={() => {
              onShowCart();
              setIsOpen(false);
            }}
            style={{
              ...baseItemStyle,
              animation: 'menu-slide-down 0.3s cubic-bezier(0.22, 1, 0.36, 1) both',
              animationDelay: '0.15s',
              position: 'relative',
            }}
            aria-label={`Go to cart, ${cartCount} items, total ₦${cartTotal.toLocaleString('en-NG')}`}
          >
            <ShoppingCart variant="Linear" color="var(--color-white)" size={24} />
            {cartCount > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: '6px',
                  right: '6px',
                  background: 'var(--color-primary)',
                  color: 'var(--color-white)',
                  fontSize: '9px',
                  fontWeight: 800,
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1.5px solid var(--color-surface)',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                }}
              >
                {cartCount}
              </span>
            )}
          </button>

          {/* Location Icon */}
          <button
            onClick={() => {
              onResetLocation();
              setIsOpen(false);
            }}
            style={{
              ...baseItemStyle,
              animation: 'menu-slide-down 0.3s cubic-bezier(0.22, 1, 0.36, 1) both',
              animationDelay: '0.2s',
            }}
            aria-label="Reset location"
          >
            <Location variant="Linear" color="var(--color-white)" size={24} />
          </button>
        </div>
      )}
    </div>
  );
}
