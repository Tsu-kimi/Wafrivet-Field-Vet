'use client';

import React, { useState, useEffect } from 'react';
import { People, Profile2User, Lock, UserTick } from 'iconsax-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Farmer {
  id: string;
  phone_number: string | null;
  name: string | null;
  state: string | null;
  pin_set_at: string | null;
  failed_pin_attempts: number;
  locked_until: string | null;
  created_at: string;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const [users, setUsers] = useState<Farmer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchQ, setSearchQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const LIMIT = 20;

  function fetchUsers() {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (searchQ) params.set('q', searchQ);
    fetch(`/api/admin/users?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => { setUsers(data.users ?? []); setTotal(data.total ?? 0); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchUsers(); }, [page, searchQ]); // eslint-disable-line

  const totalPages = Math.ceil(total / LIMIT);

  function isLocked(user: Farmer) {
    if (!user.locked_until) return false;
    return new Date(user.locked_until) > new Date();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div>
        <h2 style={{ fontSize: 22, fontFamily: 'var(--font-fraunces)', color: 'var(--color-forest)', fontWeight: 700 }}>
          Users
        </h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>
          {total} registered farmer{total !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Search */}
      <input
        type="search"
        placeholder="Search by name or phone…"
        value={searchQ}
        onChange={e => { setSearchQ(e.target.value); setPage(1); }}
        style={{
          padding: '9px 12px', borderRadius: 8, border: '1.5px solid rgba(107,125,86,0.25)',
          background: '#fff', fontSize: 13, color: 'var(--color-text)', outline: 'none',
          maxWidth: 360, fontFamily: 'var(--font-inter)',
        }}
      />

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(248,81,73,0.1)', border: '1px solid var(--color-error)', borderRadius: 8, padding: '10px 14px', color: 'var(--color-error)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--color-bone-light)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 8px rgba(58,68,46,0.07)' }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted)' }}>Loading users…</div>
        ) : users.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted)' }}>
            <People size={64} variant="Bulk" color="var(--color-sage)" style={{ opacity: 0.2, marginBottom: 16 }} />
            <div style={{ fontWeight: 600 }}>No users found</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(107,125,86,0.06)' }}>
                  {['Name', 'Phone', 'State', 'PIN Status', 'Failed PINs', 'Status', 'Joined'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(user => {
                  const locked = isLocked(user);
                  return (
                    <tr key={user.id} style={{ borderBottom: '1px solid rgba(107,125,86,0.1)' }}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600 }}>{user.name ?? '—'}</div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {user.id.slice(0, 12)}…
                        </div>
                      </td>
                      <td style={tdStyle}>{user.phone_number ?? '—'}</td>
                      <td style={tdStyle}>{user.state ?? '—'}</td>
                      <td style={tdStyle}>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                          background: user.pin_set_at ? 'rgba(63,185,80,0.15)' : 'rgba(210,153,34,0.15)',
                          color: user.pin_set_at ? '#3fb950' : '#d29922',
                        }}>
                          {user.pin_set_at ? '✓ Set' : 'Not Set'}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: user.failed_pin_attempts > 0 ? 'var(--color-error)' : 'var(--color-text-muted)' }}>
                          {user.failed_pin_attempts}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        {locked ? (
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4, 
                            padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                            background: 'rgba(248,81,73,0.15)', color: 'var(--color-error)',
                          }}>
                            <Lock size={12} variant="Bold" /> Locked
                          </span>
                        ) : (
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                            background: 'rgba(63,185,80,0.15)', color: '#3fb950',
                          }}>
                            Active
                          </span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--color-text-muted)' }}>
                        {new Date(user.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: '2-digit' })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Stats summary */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <MiniStat label="Total Users" value={total} icon={<People size={18} variant="Bulk" />} />
        <MiniStat label="With PIN Set" value={users.filter(u => u.pin_set_at).length} icon={<UserTick size={18} variant="Bulk" />} />
        <MiniStat label="Locked Accounts" value={users.filter(u => isLocked(u)).length} color="var(--color-error)" icon={<Lock size={18} variant="Bulk" />} />
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{ ...secondaryBtnStyle, opacity: page === 1 ? 0.4 : 1 }}
          >
            ← Previous
          </button>
          <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            style={{ ...secondaryBtnStyle, opacity: page === totalPages ? 0.4 : 1 }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color, icon }: { label: string; value: number; color?: string; icon?: React.ReactNode }) {
  const iconColor = color ?? 'var(--color-sage)';
  return (
    <div style={{
      background: 'var(--color-bone-light)', borderRadius: 10, padding: '16px 20px',
      boxShadow: '0 1px 6px rgba(58,68,46,0.06)',
      display: 'flex', alignItems: 'center', gap: 16,
      minWidth: 180,
    }}>
      <div style={{ 
        width: 36, height: 36, borderRadius: 8, background: `${iconColor}15`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: iconColor,
        flexShrink: 0,
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color: color ?? 'var(--color-forest)', fontFamily: 'var(--font-fraunces)', marginTop: 2 }}>
          {value}
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '10px 16px',
  fontWeight: 600, color: 'var(--color-text-muted)',
  fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
};

const tdStyle: React.CSSProperties = {
  padding: '12px 16px',
  color: 'var(--color-text)',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'transparent', color: 'var(--color-text)',
  border: '1.5px solid rgba(107,125,86,0.3)', borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
