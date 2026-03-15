'use client';

import React, { useState, useEffect } from 'react';
import { Bag2, ArrowUp2, ArrowDown2 } from 'iconsax-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Order {
  id: string;
  phone: string;
  farmer_name: string | null;
  total_amount: number;
  status: string;
  payment_reference: string | null;
  order_reference: string | null;
  delivery_address: string | null;
  last_known_state: string | null;
  placed_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_OPTIONS = [
  'active', 'pending_payment', 'payment_received',
  'ready_for_dispatch', 'dispatched', 'completed', 'cancelled',
];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  active:               { bg: 'rgba(107,125,86,0.15)', text: '#6B7D56' },
  pending_payment:      { bg: 'rgba(210,153,34,0.15)', text: '#d29922' },
  payment_received:     { bg: 'rgba(63,185,80,0.15)',  text: '#3fb950' },
  ready_for_dispatch:   { bg: 'rgba(88,166,255,0.15)', text: '#58a6ff' },
  dispatched:           { bg: 'rgba(139,148,158,0.15)',text: '#8b949e' },
  completed:            { bg: 'rgba(63,185,80,0.15)',  text: '#3fb950' },
  cancelled:            { bg: 'rgba(248,81,73,0.15)',  text: '#f85149' },
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending_payment: 'Pending Payment',
  payment_received: 'Paid',
  ready_for_dispatch: 'Ready to Ship',
  dispatched: 'Dispatched',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: 'rgba(139,148,158,0.15)', text: '#8b949e' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 20,
      background: colors.bg, color: colors.text,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.text, display: 'inline-block' }} />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const LIMIT = 20;

  function fetchOrders() {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (statusFilter) params.set('status', statusFilter);
    fetch(`/api/admin/orders?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => { setOrders(data.orders ?? []); setTotal(data.total ?? 0); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchOrders(); }, [page, statusFilter]); // eslint-disable-line

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div>
        <h2 style={{ fontSize: 22, fontFamily: 'var(--font-fraunces)', color: 'var(--color-forest)', fontWeight: 700 }}>
          Orders
        </h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>
          {total} total order{total !== 1 ? 's' : ''}{statusFilter ? ` with status "${STATUS_LABELS[statusFilter] ?? statusFilter}"` : ''}
        </p>
      </div>

      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => { setStatusFilter(''); setPage(1); }}
          style={filterBtnStyle(statusFilter === '')}
        >
          All
        </button>
        {STATUS_OPTIONS.map(s => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            style={filterBtnStyle(statusFilter === s)}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(248,81,73,0.1)', border: '1px solid var(--color-error)', borderRadius: 8, padding: '10px 14px', color: 'var(--color-error)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--color-bone-light)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 8px rgba(58,68,46,0.07)' }}>
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted)' }}>Loading orders…</div>
        ) : orders.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted)' }}>
            <Bag2 size={64} variant="Bulk" color="var(--color-sage)" style={{ opacity: 0.2, marginBottom: 16 }} />
            <div style={{ fontWeight: 600 }}>No orders found</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(107,125,86,0.06)' }}>
                  {['Reference', 'Customer', 'Phone', 'State', 'Amount', 'Status', 'Date', ''].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map(order => (
                  <React.Fragment key={order.id}>
                    <tr
                      style={{ borderBottom: '1px solid rgba(107,125,86,0.1)', cursor: 'pointer' }}
                      onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}
                    >
                      <td style={tdStyle}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>
                          {order.order_reference ?? order.id.slice(0, 8) + '…'}
                        </span>
                      </td>
                      <td style={tdStyle}>{order.farmer_name ?? '—'}</td>
                      <td style={tdStyle}>{order.phone}</td>
                      <td style={tdStyle}>{order.last_known_state ?? '—'}</td>
                      <td style={{ ...tdStyle, fontWeight: 700 }}>
                        {order.total_amount != null && !Number.isNaN(Number(order.total_amount))
                          ? `₦${Number(order.total_amount).toLocaleString()}`
                          : '—'}
                      </td>
                      <td style={tdStyle}><StatusBadge status={order.status} /></td>
                      <td style={{ ...tdStyle, color: 'var(--color-text-muted)' }}>
                        {new Date(order.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: '2-digit' })}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center' }}>
                          {expandedId === order.id ? <ArrowUp2 size={14} /> : <ArrowDown2 size={14} />}
                        </span>
                      </td>
                    </tr>
                    {expandedId === order.id && (
                      <tr style={{ background: 'rgba(107,125,86,0.04)' }}>
                        <td colSpan={8} style={{ padding: '12px 16px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, fontSize: 12 }}>
                            <DetailField label="Order ID" value={order.id} mono />
                            <DetailField label="Payment Ref" value={order.payment_reference ?? '—'} mono />
                            <DetailField label="Placed At" value={order.placed_at ? new Date(order.placed_at).toLocaleString() : '—'} />
                            <DetailField label="Last Updated" value={new Date(order.updated_at).toLocaleString()} />
                            <div style={{ gridColumn: '1 / -1' }}>
                              <DetailField label="Delivery Address" value={order.delivery_address ?? '—'} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--color-text)', fontFamily: mono ? 'var(--font-mono)' : 'inherit', wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

function filterBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    cursor: 'pointer', border: 'none', transition: 'background 0.15s',
    background: active ? 'var(--color-sage)' : 'var(--color-bone-light)',
    color: active ? '#fff' : 'var(--color-text)',
    boxShadow: active ? '0 1px 4px rgba(107,125,86,0.3)' : 'none',
  };
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
