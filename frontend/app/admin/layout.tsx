'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Image from 'next/image';
import { Element3, Box, Bag2, Profile2User, MessageQuestion, SidebarLeft, SidebarRight } from 'iconsax-react';
import logo from '@/app/assets/w.svg';
import { AdminCtx, type AdminUser } from './admin-context';

// ── Sidebar navigation items ────────────────────────────────────────────────

const NAV = [
  { href: '/admin', label: 'Dashboard', icon: '▦' },
  { href: '/admin/products', label: 'Products', icon: '⬡' },
  { href: '/admin/orders', label: 'Orders', icon: '⬡' },
  { href: '/admin/users', label: 'Users', icon: '⬡' },
  { href: '/admin/support', label: 'Support', icon: '⬡' },
];

// ── Main layout component ────────────────────────────────────────────────────

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    if (pathname === '/admin/login' || pathname === '/admin/setup') {
      setLoading(false);
      return;
    }
    fetch('/api/admin/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.admin) {
          setAdmin(data.admin);
        } else {
          router.push('/admin/login');
        }
      })
      .catch(() => router.push('/admin/login'))
      .finally(() => setLoading(false));
  }, [pathname, router]);

  async function logout() {
    await fetch('/api/admin/auth/logout', { method: 'POST' });
    setAdmin(null);
    router.push('/admin/login');
  }

  if (pathname === '/admin/login' || pathname === '/admin/setup') {
    return (
      <div style={{ minHeight: '100svh', background: 'var(--color-bg)', overflow: 'auto' }}>
        {children}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100svh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'var(--color-bg)',
      }}>
        <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-inter)' }}>
          Loading…
        </span>
      </div>
    );
  }

  return (
    <AdminCtx.Provider value={{ admin, logout }}>
      <div style={{ display: 'flex', height: '100svh', overflow: 'hidden', background: 'var(--color-bg)' }}>
        {/* ── Sidebar ── */}
        <aside style={{
          width: sidebarOpen ? 240 : 64,
          flexShrink: 0,
          background: 'var(--color-forest)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.2s ease',
          overflow: 'hidden',
        }}>
          {/* Logo */}
          <div style={{
            padding: '20px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            minHeight: 72,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'var(--color-bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                overflow: 'hidden',
              }}>
                <Image src={logo} alt="WafriAI" width={36} height={36} style={{ objectFit: 'contain' }} />
              </div>
              {sidebarOpen && (
                <div>
                  <div style={{ color: '#fff', fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-fraunces)' }}>
                    WafriAI
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>Admin Panel</div>
                </div>
              )}
            </div>
            
            <button
              onClick={() => setSidebarOpen(p => !p)}
              style={{
                background: 'rgba(255,255,255,0.1)', border: 'none',
                width: 28, height: 28, borderRadius: 6,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', color: '#fff', transition: 'background 0.2s',
                marginLeft: sidebarOpen ? 0 : 'auto',
                marginRight: sidebarOpen ? 0 : 'auto',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.2)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
            >
              {sidebarOpen ? <SidebarLeft size={18} /> : <SidebarRight size={18} />}
            </button>
          </div>

          {/* Nav links */}
          <nav style={{ flex: 1, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {NAV.map(({ href, label }) => {
              const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
              return (
                <a
                  key={href}
                  href={href}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px', borderRadius: 8,
                    background: active ? 'rgba(107,125,86,0.35)' : 'transparent',
                    color: active ? '#fff' : 'rgba(255,255,255,0.65)',
                    textDecoration: 'none',
                    fontSize: 14,
                    fontWeight: active ? 600 : 400,
                    transition: 'background 0.15s, color 0.15s',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                  onMouseEnter={e => {
                    if (!active) (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,255,255,0.08)';
                  }}
                  onMouseLeave={e => {
                    if (!active) (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
                  }}
                >
                  <NavIcon name={label} active={active} />
                  {sidebarOpen && <span>{label}</span>}
                </a>
              );
            })}
          </nav>

        </aside>

        {/* ── Main content ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Top bar */}
          <header style={{
            height: 56, background: 'var(--color-bone-light)',
            borderBottom: '1px solid rgba(107,125,86,0.2)',
            display: 'flex', alignItems: 'center',
            padding: '0 24px', gap: 16, flexShrink: 0,
          }}>
            <span style={{
              flex: 1, fontFamily: 'var(--font-fraunces)',
              fontSize: 16, color: 'var(--color-forest)', fontWeight: 600,
            }}>
              {NAV.find(n => n.href === '/admin' ? pathname === '/admin' : pathname.startsWith(n.href))?.label ?? 'Admin'}
            </span>
          </header>

          {/* Page content */}
          <main style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
            {children}
          </main>
        </div>
      </div>
    </AdminCtx.Provider>
  );
}

// ── Icon component using SVG paths ─────────────────────────────────────────

function NavIcon({ name, active }: { name: string; active: boolean }) {
  const color = active ? '#fff' : 'rgba(255,255,255,0.65)';
  const size = 18;
  const variant = active ? 'Bold' : 'Outline';

  const icons: Record<string, React.ReactNode> = {
    Dashboard: <Element3 size={size} color={color} variant={variant} />,
    Products: <Box size={size} color={color} variant={variant} />,
    Orders: <Bag2 size={size} color={color} variant={variant} />,
    Users: <Profile2User size={size} color={color} variant={variant} />,
    Support: <MessageQuestion size={size} color={color} variant={variant} />,
  };
  return <>{icons[name] ?? null}</>;
}
