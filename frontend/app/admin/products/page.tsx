'use client';

import React, { useState, useEffect, useRef, FormEvent, ChangeEvent } from 'react';
import NextImage from 'next/image';
import { Box, Gallery, AddSquare } from 'iconsax-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  description: string;
  dosage_notes: string;
  base_price: number;
  unit: string;
  min_order_qty: number;
  max_order_qty: number;
  is_active: boolean;
  image_url: string;
  disease_tags: string[];
  states_available: string[];
  created_at: string;
}

type ProductForm = Omit<Product, 'id' | 'created_at'>;

const CATEGORIES = ['vaccine', 'antibiotic', 'antiparasitic', 'antifungal', 'supplement', 'feed', 'equipment', 'other'];
const UNITS = ['piece', 'bottle', 'sachet', 'vial', 'litre', 'kg', 'g', 'ml', 'tablet', 'capsule'];

const NIGERIAN_STATES = [
  'Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno',
  'Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT','Gombe','Imo',
  'Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa',
  'Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba',
  'Yobe','Zamfara',
];

const EMPTY_FORM: ProductForm = {
  sku: '', name: '', category: 'other', description: '', dosage_notes: '',
  base_price: 0, unit: 'piece', min_order_qty: 1, max_order_qty: 1000,
  is_active: true, image_url: '', disease_tags: [], states_available: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function categoryColor(cat: string) {
  const map: Record<string, string> = {
    vaccine: '#3fb950', antibiotic: '#58a6ff', antiparasitic: '#d29922',
    antifungal: '#bc8cff', supplement: '#6B7D56', feed: '#8b949e',
    equipment: '#f0883e', other: '#8b949e',
  };
  return map[cat] ?? '#8b949e';
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editTarget, setEditTarget] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<Product | null>(null);
  const [tagInput, setTagInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function fetchProducts() {
    setLoading(true);
    const params = new URLSearchParams();
    if (searchQ) params.set('q', searchQ);
    if (categoryFilter) params.set('category', categoryFilter);
    fetch(`/api/admin/products?${params}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(data => setProducts(data.products ?? []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchProducts(); }, [searchQ, categoryFilter]); // eslint-disable-line

  function openCreate() {
    setForm(EMPTY_FORM);
    setImageFile(null);
    setImagePreview('');
    setFormError('');
    setTagInput('');
    setModalMode('create');
  }

  function openEdit(p: Product) {
    setForm({
      sku: p.sku, name: p.name, category: p.category,
      description: p.description, dosage_notes: p.dosage_notes,
      base_price: p.base_price, unit: p.unit,
      min_order_qty: p.min_order_qty, max_order_qty: p.max_order_qty,
      is_active: p.is_active, image_url: p.image_url,
      disease_tags: [...(p.disease_tags ?? [])],
      states_available: [...(p.states_available ?? [])],
    });
    setImageFile(null);
    setImagePreview(p.image_url ?? '');
    setFormError('');
    setTagInput('');
    setEditTarget(p);
    setModalMode('edit');
  }

  function closeModal() { setModalMode(null); setEditTarget(null); }

  function handleImageChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setImageFile(file);
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => setImagePreview(ev.target?.result as string);
      reader.readAsDataURL(file);
    } else {
      setImagePreview(form.image_url);
    }
  }

  function toggleState(state: string) {
    setForm(f => ({
      ...f,
      states_available: f.states_available.includes(state)
        ? f.states_available.filter(s => s !== state)
        : [...f.states_available, state],
    }));
  }

  function addTag() {
    const tag = tagInput.trim();
    if (!tag || form.disease_tags.includes(tag)) { setTagInput(''); return; }
    setForm(f => ({ ...f, disease_tags: [...f.disease_tags, tag] }));
    setTagInput('');
  }

  function removeTag(tag: string) {
    setForm(f => ({ ...f, disease_tags: f.disease_tags.filter(t => t !== tag) }));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!form.sku || !form.name || !form.category) {
      setFormError('SKU, name, and category are required.');
      return;
    }
    setSaving(true);
    try {
      let imageUrl = form.image_url;

      // Upload image if a new file was selected
      if (imageFile) {
        const fd = new FormData();
        fd.append('file', imageFile);
        fd.append('sku', form.sku);
        const uploadRes = await fetch('/api/admin/products/upload', { method: 'POST', body: fd });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(uploadData.error ?? 'Image upload failed.');
        imageUrl = uploadData.url;
      }

      const payload = { ...form, image_url: imageUrl };

      let res: Response;
      if (modalMode === 'create') {
        res = await fetch('/api/admin/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch(`/api/admin/products/${editTarget!.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed.');
      closeModal();
      fetchProducts();
    } catch (err) {
      setFormError(String((err as Error).message));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(product: Product) {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/products/${product.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? 'Delete failed.');
      }
      setDeleteConfirm(null);
      fetchProducts();
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(product: Product) {
    await fetch(`/api/admin/products/${product.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !product.is_active }),
    });
    fetchProducts();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontFamily: 'var(--font-fraunces)', color: 'var(--color-forest)', fontWeight: 700 }}>
            Master SKU Catalog
          </h2>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {products.length} product{products.length !== 1 ? 's' : ''}
            {categoryFilter ? ` in "${categoryFilter}"` : ''}
          </p>
        </div>
        <button onClick={openCreate} style={primaryBtnStyle}>
          <AddSquare size={18} variant="Bulk" style={{ marginRight: 8, verticalAlign: 'middle' }} />
          Add Product
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Search products…"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          style={{ ...inputBaseStyle, flex: '1 1 200px' }}
        />
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{ ...inputBaseStyle, flex: '0 0 auto' }}
        >
          <option value="">All categories</option>
          {CATEGORIES.map(c => (
            <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
          ))}
        </select>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ background: 'rgba(248,81,73,0.1)', border: '1px solid var(--color-error)', borderRadius: 8, padding: '10px 14px', color: 'var(--color-error)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Product grid */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {[1,2,3,4,5,6].map(i => (
            <div key={i} style={{ height: 180, background: 'rgba(107,125,86,0.08)', borderRadius: 12, animation: 'fade-in 0.4s ease' }} />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-muted)' }}>
          <Box size={64} variant="Bulk" color="var(--color-sage)" style={{ opacity: 0.2, marginBottom: 16 }} />
          <div style={{ fontSize: 16, fontWeight: 600 }}>No products found</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Add your first product to the catalog</div>
          <button onClick={openCreate} style={{ ...primaryBtnStyle, marginTop: 24 }}>
            <AddSquare size={18} variant="Bulk" style={{ marginRight: 8, verticalAlign: 'middle' }} />
            Add Product
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {products.map(p => (
            <div key={p.id} style={{
              background: 'var(--color-bone-light)', borderRadius: 12,
              overflow: 'hidden', boxShadow: '0 1px 8px rgba(58,68,46,0.07)',
              display: 'flex', flexDirection: 'column',
              opacity: p.is_active ? 1 : 0.6,
            }}>
              {/* Image */}
              <div style={{ height: 140, background: 'var(--color-bone)', position: 'relative', overflow: 'hidden' }}>
                {p.image_url ? (
                  <img
                    src={p.image_url}
                    alt={p.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Box size={48} variant="Bulk" style={{ opacity: 0.1 }} />
                  </div>
                )}
                {!p.is_active && (
                  <div style={{
                    position: 'absolute', top: 8, right: 8,
                    background: 'rgba(248,81,73,0.85)', color: '#fff',
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                  }}>
                    INACTIVE
                  </div>
                )}
                <div style={{
                  position: 'absolute', top: 8, left: 8,
                  background: `${categoryColor(p.category)}cc`,
                  color: '#fff', fontSize: 10, fontWeight: 700,
                  padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase',
                }}>
                  {p.category}
                </div>
              </div>

              {/* Content */}
              <div style={{ padding: '14px 16px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-forest)' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>SKU: {p.sku}</div>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-sage)', whiteSpace: 'nowrap' }}>
                    ₦{Number(p.base_price).toLocaleString()}
                  </div>
                </div>

                {p.description && (
                  <p style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {p.description}
                  </p>
                )}

                {p.disease_tags?.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                    {p.disease_tags.slice(0, 3).map(tag => (
                      <span key={tag} style={{
                        fontSize: 10, padding: '2px 7px', borderRadius: 20,
                        background: 'rgba(107,125,86,0.12)', color: 'var(--color-sage)', fontWeight: 600,
                      }}>{tag}</span>
                    ))}
                    {p.disease_tags.length > 3 && (
                      <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>+{p.disease_tags.length - 3} more</span>
                    )}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(107,125,86,0.12)', display: 'flex', gap: 8 }}>
                <button onClick={() => openEdit(p)} style={secondaryBtnStyle}>Edit</button>
                <button onClick={() => toggleActive(p)} style={{ ...secondaryBtnStyle, color: p.is_active ? 'var(--color-warning)' : 'var(--color-success)' }}>
                  {p.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => setDeleteConfirm(p)} style={{ ...secondaryBtnStyle, color: 'var(--color-error)', marginLeft: 'auto' }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Product modal (create / edit) ── */}
      {modalMode && (
        <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) closeModal(); }}>
          <div style={modalStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <h3 style={{ fontSize: 18, fontFamily: 'var(--font-fraunces)', color: 'var(--color-forest)', fontWeight: 700 }}>
                {modalMode === 'create' ? 'Add New Product' : `Edit: ${editTarget?.name}`}
              </h3>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--color-text-muted)' }}>✕</button>
            </div>

            {formError && (
              <div style={{ background: 'rgba(248,81,73,0.1)', border: '1px solid var(--color-error)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: 'var(--color-error)', fontSize: 13 }}>
                {formError}
              </div>
            )}

            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <div style={{ overflowY: 'auto', maxHeight: 'calc(90svh - 200px)', paddingRight: 4 }}>
                {/* Image upload */}
                <Section title="Product Image">
                  <div
                    style={{
                      border: '2px dashed rgba(107,125,86,0.35)', borderRadius: 10,
                      padding: 16, textAlign: 'center', cursor: 'pointer',
                      background: 'rgba(107,125,86,0.04)',
                    }}
                    onClick={() => fileRef.current?.click()}
                  >
                    {imagePreview ? (
                      <img src={imagePreview} alt="preview" style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 8, objectFit: 'cover' }} />
                    ) : (
                      <div style={{ padding: '20px 0' }}>
                        <Gallery size={48} variant="Bulk" color="var(--color-sage)" style={{ opacity: 0.3, marginBottom: 8 }} />
                        <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Click to upload product image</div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>JPEG, PNG, WebP — max 5MB</div>
                      </div>
                    )}
                  </div>
                  <input
                    ref={fileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp"
                    style={{ display: 'none' }} onChange={handleImageChange}
                  />
                  {imagePreview && (
                    <button type="button" onClick={() => { setImageFile(null); setImagePreview(''); setForm(f => ({ ...f, image_url: '' })); }}
                      style={{ marginTop: 6, fontSize: 12, color: 'var(--color-error)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      Remove image
                    </button>
                  )}
                </Section>

                {/* Basic info */}
                <Section title="Basic Information">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="SKU *" required>
                      <input type="text" value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))}
                        placeholder="e.g. AMOXY-500" style={inputBaseStyle} required />
                    </Field>
                    <Field label="Category *" required>
                      <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={inputBaseStyle}>
                        {CATEGORIES.map(c => (
                          <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Product Name *" required>
                    <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Amoxycillin 500mg" style={inputBaseStyle} required />
                  </Field>
                  <Field label="Description">
                    <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="Brief product description…" rows={3}
                      style={{ ...inputBaseStyle, resize: 'vertical', fontFamily: 'inherit' }} />
                  </Field>
                  <Field label="Dosage Notes">
                    <textarea value={form.dosage_notes} onChange={e => setForm(f => ({ ...f, dosage_notes: e.target.value }))}
                      placeholder="Administration instructions, dosage per kg, etc."
                      rows={2} style={{ ...inputBaseStyle, resize: 'vertical', fontFamily: 'inherit' }} />
                  </Field>
                </Section>

                {/* Pricing */}
                <Section title="Pricing & Inventory">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                    <Field label="Base Price (₦) *" required>
                      <input type="number" min={0} step={0.01} value={form.base_price}
                        onChange={e => setForm(f => ({ ...f, base_price: Number(e.target.value) }))}
                        style={inputBaseStyle} required />
                    </Field>
                    <Field label="Unit">
                      <select value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} style={inputBaseStyle}>
                        {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </Field>
                    <Field label="Active">
                      <select value={form.is_active ? 'true' : 'false'}
                        onChange={e => setForm(f => ({ ...f, is_active: e.target.value === 'true' }))}
                        style={inputBaseStyle}>
                        <option value="true">Active</option>
                        <option value="false">Inactive</option>
                      </select>
                    </Field>
                    <Field label="Min Order Qty">
                      <input type="number" min={1} value={form.min_order_qty}
                        onChange={e => setForm(f => ({ ...f, min_order_qty: Number(e.target.value) }))}
                        style={inputBaseStyle} />
                    </Field>
                    <Field label="Max Order Qty">
                      <input type="number" min={1} value={form.max_order_qty}
                        onChange={e => setForm(f => ({ ...f, max_order_qty: Number(e.target.value) }))}
                        style={inputBaseStyle} />
                    </Field>
                  </div>
                </Section>

                {/* Disease tags */}
                <Section title="Disease Tags">
                  <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                    Tags link this product to disease conditions (must match disease_content.disease_name values).
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      type="text" value={tagInput} onChange={e => setTagInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                      placeholder="e.g. Ruminal Bloat" style={{ ...inputBaseStyle, flex: 1 }}
                    />
                    <button type="button" onClick={addTag} style={secondaryBtnStyle}>Add</button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {form.disease_tags.map(tag => (
                      <span key={tag} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: 'rgba(107,125,86,0.15)', color: 'var(--color-sage)',
                        fontSize: 12, padding: '3px 10px', borderRadius: 20, fontWeight: 600,
                      }}>
                        {tag}
                        <button type="button" onClick={() => removeTag(tag)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 14, lineHeight: 1, padding: 0 }}>
                          ×
                        </button>
                      </span>
                    ))}
                    {form.disease_tags.length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>No disease tags yet</span>
                    )}
                  </div>
                </Section>

                {/* States available */}
                <Section title="States Available">
                  <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                    Select all Nigerian states where this product is stocked.
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button type="button" onClick={() => setForm(f => ({ ...f, states_available: NIGERIAN_STATES }))}
                      style={{ ...secondaryBtnStyle, fontSize: 11 }}>Select All</button>
                    <button type="button" onClick={() => setForm(f => ({ ...f, states_available: [] }))}
                      style={{ ...secondaryBtnStyle, fontSize: 11 }}>Clear All</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 6 }}>
                    {NIGERIAN_STATES.map(state => (
                      <label key={state} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={form.states_available.includes(state)}
                          onChange={() => toggleState(state)}
                          style={{ accentColor: 'var(--color-sage)' }}
                        />
                        {state}
                      </label>
                    ))}
                  </div>
                </Section>
              </div>

              {/* Footer buttons */}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(107,125,86,0.15)' }}>
                <button type="button" onClick={closeModal} style={secondaryBtnStyle}>Cancel</button>
                <button type="submit" disabled={saving} style={{ ...primaryBtnStyle, opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Saving…' : modalMode === 'create' ? 'Create Product' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete confirmation ── */}
      {deleteConfirm && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 400 }}>
            <h3 style={{ fontSize: 17, fontFamily: 'var(--font-fraunces)', color: 'var(--color-error)', marginBottom: 12 }}>
              Delete Product?
            </h3>
            <p style={{ fontSize: 14, color: 'var(--color-text)', marginBottom: 20 }}>
              Are you sure you want to permanently delete <strong>{deleteConfirm.name}</strong>? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDeleteConfirm(null)} style={secondaryBtnStyle}>Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} disabled={saving}
                style={{ ...primaryBtnStyle, background: 'var(--color-error)', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h4 style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
        {title}
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>
        {label}{required && <span style={{ color: 'var(--color-error)' }}> *</span>}
      </span>
      {children}
    </label>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const inputBaseStyle: React.CSSProperties = {
  padding: '9px 11px', borderRadius: 7, border: '1.5px solid rgba(107,125,86,0.25)',
  background: '#fff', fontSize: 13, color: 'var(--color-text)',
  fontFamily: 'var(--font-inter)', outline: 'none', width: '100%', boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '9px 20px', background: 'var(--color-sage)', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'transparent', color: 'var(--color-text)',
  border: '1.5px solid rgba(107,125,86,0.3)', borderRadius: 8, fontSize: 13,
  fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(58,68,46,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: '16px',
};

const modalStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 16, padding: 28,
  width: '100%', maxWidth: 680,
  boxShadow: '0 20px 60px rgba(58,68,46,0.25)',
  maxHeight: '95svh', overflow: 'hidden',
  display: 'flex', flexDirection: 'column',
};
