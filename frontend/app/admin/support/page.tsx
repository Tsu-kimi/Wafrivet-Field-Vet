'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { MessageQuestion, ArrowUp2, ArrowDown2, SearchNormal1 } from 'iconsax-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SupportRequest {
  id: string;
  phone: string;
  farmer_name: string | null;
  category: string;
  title: string;
  description: string;
  order_reference: string | null;
  status: string;
  priority: string;
  admin_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['open', 'in_progress', 'resolved', 'closed'];
const CATEGORY_OPTIONS = ['complaint', 'refund', 'delivery', 'product', 'other'];
const PRIORITY_OPTIONS = ['urgent', 'high', 'medium', 'low'];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  open:        { bg: 'rgba(248,81,73,0.12)',  text: '#f85149' },
  in_progress: { bg: 'rgba(210,153,34,0.15)', text: '#d29922' },
  resolved:    { bg: 'rgba(63,185,80,0.15)',  text: '#3fb950' },
  closed:      { bg: 'rgba(139,148,158,0.15)',text: '#8b949e' },
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
  urgent: { bg: 'rgba(248,81,73,0.18)',   text: '#f85149' },
  high:   { bg: 'rgba(210,100,34,0.15)',  text: '#d26422' },
  medium: { bg: 'rgba(88,166,255,0.15)',  text: '#58a6ff' },
  low:    { bg: 'rgba(139,148,158,0.12)', text: '#8b949e' },
};

const CATEGORY_LABELS: Record<string, string> = {
  complaint: 'Complaint',
  refund:    'Refund',
  delivery:  'Delivery',
  product:   'Product',
  other:     'Other',
};

// ── Badge components ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'rgba(139,148,158,0.15)', text: '#8b949e' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 20,
      background: c.bg, color: c.text,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.text, display: 'inline-block' }} />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const c = PRIORITY_COLORS[priority] ?? { bg: 'rgba(139,148,158,0.12)', text: '#8b949e' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 12,
      background: c.bg, color: c.text,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {priority}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 12,
      background: 'rgba(107,125,86,0.1)', color: 'var(--color-sage)',
      fontSize: 11, fontWeight: 600,
    }}>
      {CATEGORY_LABELS[category] ?? category}
    </span>
  );
}

// ── Edit panel ────────────────────────────────────────────────────────────────

function EditPanel({
  request,
  onSave,
  onClose,
}: {
  request: SupportRequest;
  onSave: (updated: SupportRequest) => void;
  onClose: () => void;
}) {
  const [status, setStatus]     = useState(request.status);
  const [priority, setPriority] = useState(request.priority);
  const [notes, setNotes]       = useState(request.admin_notes ?? '');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/support/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, priority, admin_notes: notes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to save');
      onSave(json.request as SupportRequest);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      background: 'rgba(107,125,86,0.05)',
      border: '1px solid rgba(107,125,86,0.15)',
      borderRadius: 10,
      padding: '16px 20px',
      marginTop: 4,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-forest)', marginBottom: 14 }}>
        Manage Request
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)} style={selectStyle}>
            {STATUS_OPTIONS.map(s => (
              <option key={s} value={s}>{STATUS_LABELS[s] ?? s}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Priority</label>
          <select value={priority} onChange={e => setPriority(e.target.value)} style={selectStyle}>
            {PRIORITY_OPTIONS.map(p => (
              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Admin Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Add internal notes about this issue…"
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '8px 12px', borderRadius: 8,
            border: '1.5px solid rgba(107,125,86,0.25)',
            background: 'var(--color-bone-light)',
            color: 'var(--color-text)',
            fontSize: 13, fontFamily: 'var(--font-inter)',
            resize: 'vertical', outline: 'none',
          }}
        />
      </div>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--color-error)', marginBottom: 10 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>Cancel</button>
        <button onClick={handleSave} style={saveBtnStyle} disabled={saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SupportPage() {
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [statusFilter, setStatusFilter]   = useState('open');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch]     = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const LIMIT = 25;

  const fetchRequests = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (statusFilter)   params.set('status', statusFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    if (search)         params.set('search', search);
    fetch(`/api/admin/support?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => {
        setRequests(data.requests ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [page, statusFilter, categoryFilter, search]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const totalPages = Math.ceil(total / LIMIT);

  function handleUpdated(updated: SupportRequest) {
    setRequests(prev => prev.map(r => r.id === updated.id ? updated : r));
    setEditingId(null);
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  }

  // Count open/urgent for the header summary
  const urgentCount = requests.filter(r => r.priority === 'urgent' && r.status === 'open').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontFamily: 'var(--font-fraunces)', color: 'var(--color-forest)', fontWeight: 700 }}>
            Support Requests
          </h2>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {total} total ticket{total !== 1 ? 's' : ''}
            {urgentCount > 0 && (
              <span style={{ marginLeft: 8, color: '#f85149', fontWeight: 700 }}>
                · {urgentCount} urgent
              </span>
            )}
          </p>
        </div>

        {/* Search */}
        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <SearchNormal1
              size={14}
              color="var(--color-text-muted)"
              style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
            />
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search by phone, name, title…"
              style={{
                paddingLeft: 32, paddingRight: 12,
                height: 36, borderRadius: 8,
                border: '1.5px solid rgba(107,125,86,0.25)',
                background: 'var(--color-bone-light)',
                color: 'var(--color-text)',
                fontSize: 13, outline: 'none', width: 240,
              }}
            />
          </div>
          <button type="submit" style={{ ...filterBtnStyle(false), height: 36, padding: '0 14px' }}>
            Search
          </button>
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); setSearchInput(''); setPage(1); }}
              style={{ ...filterBtnStyle(false), height: 36, padding: '0 12px', color: 'var(--color-error)' }}
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Filter tabs — Status */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Status:
        </span>
        <button onClick={() => { setStatusFilter(''); setPage(1); }} style={filterBtnStyle(statusFilter === '')}>All</button>
        {STATUS_OPTIONS.map(s => (
          <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }} style={filterBtnStyle(statusFilter === s)}>
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Filter tabs — Category */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Category:
        </span>
        <button onClick={() => { setCategoryFilter(''); setPage(1); }} style={filterBtnStyle(categoryFilter === '')}>All</button>
        {CATEGORY_OPTIONS.map(c => (
          <button key={c} onClick={() => { setCategoryFilter(c); setPage(1); }} style={filterBtnStyle(categoryFilter === c)}>
            {CATEGORY_LABELS[c]}
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
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted)' }}>Loading support requests…</div>
        ) : requests.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted)' }}>
            <MessageQuestion size={64} variant="Bulk" color="var(--color-sage)" style={{ opacity: 0.2, marginBottom: 16 }} />
            <div style={{ fontWeight: 600 }}>No support requests found</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'rgba(107,125,86,0.06)' }}>
                  {['Priority', 'Category', 'Customer', 'Phone', 'Issue', 'Status', 'Date', ''].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {requests.map(req => (
                  <React.Fragment key={req.id}>
                    <tr
                      style={{
                        borderBottom: '1px solid rgba(107,125,86,0.1)',
                        cursor: 'pointer',
                        background: req.priority === 'urgent' && req.status === 'open'
                          ? 'rgba(248,81,73,0.03)'
                          : undefined,
                      }}
                      onClick={() => {
                        if (editingId === req.id) return;
                        setExpandedId(expandedId === req.id ? null : req.id);
                        setEditingId(null);
                      }}
                    >
                      <td style={tdStyle}><PriorityBadge priority={req.priority} /></td>
                      <td style={tdStyle}><CategoryBadge category={req.category} /></td>
                      <td style={tdStyle}>{req.farmer_name ?? '—'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{req.phone}</td>
                      <td style={{ ...tdStyle, maxWidth: 260 }}>
                        <div style={{ fontWeight: 600, color: 'var(--color-text)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {req.title}
                        </div>
                        {req.order_reference && (
                          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                            Ref: {req.order_reference}
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}><StatusBadge status={req.status} /></td>
                      <td style={{ ...tdStyle, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(req.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: '2-digit' })}
                      </td>
                      <td style={tdStyle}>
                        <span style={{ color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center' }}>
                          {expandedId === req.id ? <ArrowUp2 size={14} /> : <ArrowDown2 size={14} />}
                        </span>
                      </td>
                    </tr>

                    {expandedId === req.id && (
                      <tr style={{ background: 'rgba(107,125,86,0.02)' }}>
                        <td colSpan={8} style={{ padding: '16px 20px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                            {/* Description */}
                            <div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                                Complaint Description
                              </div>
                              <div style={{
                                background: 'var(--color-bg)',
                                border: '1px solid rgba(107,125,86,0.12)',
                                borderRadius: 8,
                                padding: '12px 14px',
                                fontSize: 13,
                                color: 'var(--color-text)',
                                lineHeight: 1.6,
                                whiteSpace: 'pre-wrap',
                              }}>
                                {req.description}
                              </div>
                            </div>

                            {/* Meta grid */}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                              <DetailField label="Ticket ID" value={req.id.slice(0, 8).toUpperCase()} mono />
                              <DetailField label="Full ID" value={req.id} mono />
                              <DetailField label="Opened" value={new Date(req.created_at).toLocaleString()} />
                              <DetailField label="Last Updated" value={new Date(req.updated_at).toLocaleString()} />
                              {req.resolved_at && (
                                <DetailField label="Resolved At" value={new Date(req.resolved_at).toLocaleString()} />
                              )}
                              {req.order_reference && (
                                <DetailField label="Order Reference" value={req.order_reference} mono />
                              )}
                            </div>

                            {/* Admin notes (read) */}
                            {req.admin_notes && !editingId && (
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                                  Admin Notes
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--color-text)', whiteSpace: 'pre-wrap' }}>
                                  {req.admin_notes}
                                </div>
                              </div>
                            )}

                            {/* Edit panel or trigger */}
                            {editingId === req.id ? (
                              <EditPanel
                                request={req}
                                onSave={handleUpdated}
                                onClose={() => setEditingId(null)}
                              />
                            ) : (
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  onClick={e => { e.stopPropagation(); setEditingId(req.id); }}
                                  style={manageBtnStyle}
                                >
                                  Manage / Resolve
                                </button>
                                <a
                                  href={`tel:${req.phone}`}
                                  onClick={e => e.stopPropagation()}
                                  style={{
                                    ...manageBtnStyle,
                                    textDecoration: 'none',
                                    background: 'rgba(63,185,80,0.12)',
                                    color: '#3fb950',
                                    border: '1.5px solid rgba(63,185,80,0.25)',
                                  }}
                                >
                                  Call {req.farmer_name ?? req.phone}
                                </a>
                              </div>
                            )}
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{
        fontSize: 12, color: 'var(--color-text)',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        wordBreak: 'break-all',
      }}>
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

const manageBtnStyle: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
  cursor: 'pointer', border: '1.5px solid rgba(107,125,86,0.25)',
  background: 'rgba(107,125,86,0.08)', color: 'var(--color-forest)',
  transition: 'background 0.15s',
  display: 'inline-flex', alignItems: 'center',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700,
  color: 'var(--color-text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.04em', marginBottom: 5,
};

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8,
  border: '1.5px solid rgba(107,125,86,0.25)',
  background: 'var(--color-bone-light)', color: 'var(--color-text)',
  fontSize: 13, outline: 'none',
};

const saveBtnStyle: React.CSSProperties = {
  padding: '8px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', border: 'none',
  background: 'var(--color-sage)', color: '#fff',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', border: '1.5px solid rgba(107,125,86,0.25)',
  background: 'transparent', color: 'var(--color-text)',
};
