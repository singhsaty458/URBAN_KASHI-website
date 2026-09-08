import { useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, Plus, Save, X } from 'lucide-react';
import type { AdminStats, Category, Order, OrderStatus, Product } from '../../shared/types';
import { AuthGate } from '../components/AuthGate';
import { ErrorState, Image, Loading } from '../components/UI';
import { useStore } from '../context/Store';
import { api, categories, message, money, sizes, useResource, useTitle } from '../lib/api';
import { matchesProduct, safeCatalogueText } from '../lib/catalogue';
import { CatalogueImport } from '../components/CatalogueImport';
import { CatalogueLabels, PaymentNotice } from '../components/CatalogueLabels';
import { ProductImageUpload } from '../components/ProductImageUpload';

type ProductDraft = Omit<Product, 'id' | 'soldOutAt' | 'archivedAt'>;
const blankProduct = (): ProductDraft => ({ slug: '', name: '', brand: '', design: '', category: 'Shirts', price: 0, originalPrice: null, color: '', description: '', details: [], image: '', images: [], badge: null, featured: false, active: true, variants: sizes.map(size => ({ size, stock: 0, barcode: '', sku: '' })) });
const safeImage = (value: string) => {
  if (value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith('/')) {
    return /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(value)
      && !value.split('/').some(part => part === '.' || part === '..');
  }
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
};
const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
  placed: ['confirmed', 'cancelled'], confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered'], delivered: [], cancelled: [],
};

function ProductLifecycle({ product }: { product: Product }) {
  return <div className="product-lifecycle">
    {product.archivedAt && <p><strong className="inventory-archived">Archived</strong> · <time dateTime={product.archivedAt}>{new Date(product.archivedAt).toLocaleString('en-IN')}</time>. Hidden from the storefront; existing orders and photos are preserved. To republish, restock at least one size and select Active before saving.</p>}
    {product.soldOutAt && <p>Sold out since <time dateTime={product.soldOutAt}>{new Date(product.soldOutAt).toLocaleString('en-IN')}</time>. Active listings show Sold out for 48 hours, then automatically archive and hide unless restocked.</p>}
  </div>;
}

function ProductEditor({ product, onSaved, onCancel, onBusyChange }: { product?: Product; onSaved: () => void; onCancel: () => void; onBusyChange: (busy: boolean) => void }) {
  const [draft, setDraft] = useState<ProductDraft>(() => product ? { slug: product.slug, name: product.name, brand: product.brand, design: product.design, category: product.category, price: product.price, originalPrice: product.originalPrice, color: product.color, description: product.description, details: [...product.details], image: product.image, images: [...product.images], badge: product.badge, featured: product.featured, active: product.active, variants: product.variants.map(v => ({ ...v })) } : blankProduct());
  const [details, setDetails] = useState(draft.details.join('\n'));
  const [images, setImages] = useState(draft.images.join('\n'));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const locked = busy || uploading;
  const galleryId = useId();
  useEffect(() => { onBusyChange(locked); return () => onBusyChange(false); }, [locked, onBusyChange]);
  const [error, setError] = useState('');
  const { toast, refreshProducts } = useStore();
  const change = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const galleryPaths = (value: string) => [...new Set(value.split('\n').map(path => path.trim()).filter(Boolean))];
  function uploadedMain(path: string) {
    const previous = draft.image.trim();
    change('image', path);
    setImages(current => {
      const gallery = galleryPaths(current);
      return [...new Set(gallery.length ? gallery.map(image => image === previous ? path : image) : [path])].join('\n');
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (locked) return;
    setError('');
    const payload: ProductDraft = { ...draft, name: draft.name.trim(), slug: draft.slug.trim(), color: draft.color.trim(), description: draft.description.trim(), image: draft.image.trim(), badge: draft.badge?.trim() || null, details: details.split('\n').map(s => s.trim()).filter(Boolean), images: images.split('\n').map(s => s.trim()).filter(Boolean) };
    payload.variants = draft.variants.map(v => ({ ...v, size: v.size.trim() }));
    if (!safeCatalogueText(payload.brand ?? '', 160) || !safeCatalogueText(payload.design ?? '', 160)) { setError('Brand and design must be safe text, at most 160 characters each.'); return; }
    if (payload.variants.length < 1 || payload.variants.length > 30 || payload.variants.some(v => !safeCatalogueText(v.size, 24, true) || !/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u.test(v.size)) || new Set(payload.variants.map(v => v.size)).size !== payload.variants.length) { setError('Use 1–30 rows with unique sizes, each 1–24 characters. Start with a letter or number; use letters, numbers, spaces, dots, underscores, slashes or hyphens.'); return; }
    if (payload.variants.some(v => !safeCatalogueText(v.barcode ?? '', 128) || !safeCatalogueText(v.sku ?? '', 160))) { setError('Barcode must be safe text up to 128 characters; SKU up to 160. Barcodes must be globally unique (checked by the server).'); return; }
    if (!payload.images.length) payload.images = [payload.image];
    if (!payload.name || payload.name.length > 160) { setError('Name must be 1–160 characters.'); return; }
    if (payload.slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.slug)) { setError('Slug must be 1–120 lowercase letters or numbers, separated by single hyphens.'); return; }
    if (!payload.color || payload.color.length > 80) { setError('Colour must be 1–80 characters.'); return; }
    if (!payload.description || payload.description.length > 5000) { setError('Description must be 1–5,000 characters.'); return; }
    if (payload.badge !== null && payload.badge.length > 50) { setError('Badge must be blank or at most 50 characters.'); return; }
    if (!Number.isSafeInteger(payload.price) || payload.price < 1 || payload.price > 1_000_000 || (payload.originalPrice !== null && (!Number.isSafeInteger(payload.originalPrice) || payload.originalPrice < payload.price || payload.originalPrice > 1_000_000))) { setError('Prices must be whole INR amounts from 1 to 1,000,000. Original price must be blank or at least the selling price.'); return; }
    if (payload.variants.some(v => !Number.isSafeInteger(v.stock) || v.stock < 0 || v.stock > 1_000_000)) { setError('Each size needs a whole-number stock count from 0 to 1,000,000.'); return; }
    if (payload.details.length > 20 || payload.details.some(detail => detail.length > 500)) { setError('Provide at most 20 detail lines, with at most 500 characters per detail.'); return; }
    if (payload.images.length > 12) { setError('Provide at most 12 gallery images, one per line. Leave blank to use the main image.'); return; }
    if (![payload.image, ...payload.images].every(safeImage)) { setError('Each image must be an HTTPS URL without credentials or a safe same-site path (e.g. /images/shirt.jpg), at most 2,048 characters. No spaces, backslashes, control characters, or http URLs. Same-site paths cannot contain dot segments, queries, or fragments.'); return; }
    setBusy(true);
    try { await api(product ? `/admin/products/${encodeURIComponent(product.id)}` : '/admin/products', { method: product ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); toast(product ? `${payload.name} updated.` : `${payload.name} created.`); void refreshProducts(); onSaved(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <form className="product-editor" onSubmit={save} aria-busy={locked}><div className="editor-heading"><h3>{product ? `Edit ${product.name}` : 'Create a new piece'}</h3><button type="button" className="icon-button" disabled={locked} onClick={onCancel} aria-label="Close product editor"><X size={19} /></button></div>{product && <ProductLifecycle product={product} />}<fieldset disabled={locked} className="admin-fields">
    <label>Name<input value={draft.name} onChange={e => change('name', e.target.value)} required maxLength={160} /></label>
    <label>Slug<input value={draft.slug} onChange={e => change('slug', e.target.value)} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={120} placeholder="the-everyday-shirt" /></label>
    <label>Brand / ब्रांड (optional)<input value={draft.brand ?? ''} onChange={e => change('brand', e.target.value)} maxLength={160} /></label>
    <label>Design / डिज़ाइन (optional)<input value={draft.design ?? ''} onChange={e => change('design', e.target.value)} maxLength={160} /></label>
    <p className="span-two small muted">One listing per colour + design. Use the same nonempty brand and design on separate colour listings to link them.</p>
    <label>Category<select value={draft.category} onChange={e => change('category', e.target.value as Category)}>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
    <label>Colour<input value={draft.color} onChange={e => change('color', e.target.value)} required maxLength={80} /></label>
    <label>Price (whole INR, 1–1,000,000)<input type="number" min={1} max={1_000_000} step={1} required value={draft.price} onChange={e => change('price', Number(e.target.value))} /></label>
    <label>Original price (optional, up to 1,000,000)<input type="number" min={draft.price || 1} max={1_000_000} step={1} value={draft.originalPrice ?? ''} onChange={e => change('originalPrice', e.target.value === '' ? null : Number(e.target.value))} /></label>
    <label className="span-two">Description<textarea rows={3} value={draft.description} onChange={e => change('description', e.target.value)} required maxLength={5000} /></label>
    <label className="span-two">Details (one per line; up to 20 lines, 500 characters each)<textarea rows={3} value={details} onChange={e => setDetails(e.target.value)} /></label>
    <ProductImageUpload image={draft.image} images={galleryPaths(images)} disabled={locked} onMain={uploadedMain} onGallery={path => setImages(current => [...new Set([...galleryPaths(current), path])].slice(0, 12).join('\n'))} onBusyChange={setUploading} />
    <label className="span-two">Main image (HTTPS URL or safe same-site path)<input type="text" value={draft.image} onChange={e => change('image', e.target.value)} required maxLength={2048} placeholder="https://example.com/shirt.jpg or /images/shirt.jpg" /></label>
    <div className="span-two"><label htmlFor={galleryId}>Gallery (up to 12 HTTPS URLs or safe same-site paths, one per line; 2,048 characters each; blank uses main image)</label><textarea id={galleryId} rows={3} value={images} onChange={e => setImages(e.target.value)} /></div>
    <label>Badge (optional)<input value={draft.badge ?? ''} onChange={e => change('badge', e.target.value || null)} maxLength={50} /></label>
    <div className="editor-checkboxes"><label className="checkbox-label"><input type="checkbox" checked={draft.active} onChange={e => change('active', e.target.checked)} />Active</label><label className="checkbox-label"><input type="checkbox" checked={draft.featured} onChange={e => change('featured', e.target.checked)} />Featured</label></div>
    <p className="span-two small muted">When all sizes reach zero, an Active product displays Sold out on its photo for 48 hours, then is automatically archived and hidden. Orders are preserved. Archived products require positive stock and Active selected to republish.</p>
    <div className="span-two"><p className="field-label">Stock by size / साइज़ अनुसार स्टॉक ({draft.variants.length}/30 rows)</p><p className="small muted">Size: 1–24 characters, unique per listing. Barcode / SKU are text: keep leading zeros. Allocate web stock separately; no automatic POS sync.</p>
      <div className="catalogue-variants">{draft.variants.map((variant, index) => <div className="catalogue-variant" key={index}>
        <label>Size {index + 1}<input required maxLength={24} value={variant.size} onChange={e => change('variants', draft.variants.map((v, i) => i === index ? { ...v, size: e.target.value } : v))} /></label>
        <label>{variant.size || 'Stock'}<input aria-label={variant.size || `Stock row ${index + 1}`} title="Website stock (0–1,000,000)" type="number" step={1} min={0} max={1_000_000} required value={variant.stock} onChange={e => change('variants', draft.variants.map((v, i) => i === index ? { ...v, stock: Number(e.target.value) } : v))} /></label>
        <label>Barcode {index + 1}<input type="text" maxLength={128} value={variant.barcode ?? ''} placeholder="001234567890" onChange={e => change('variants', draft.variants.map((v, i) => i === index ? { ...v, barcode: e.target.value } : v))} /></label>
        <label>SKU {index + 1}<input type="text" maxLength={160} value={variant.sku ?? ''} onChange={e => change('variants', draft.variants.map((v, i) => i === index ? { ...v, sku: e.target.value } : v))} /></label>
        <button type="button" className="text-button" aria-label={`Remove size row ${index + 1}`} disabled={draft.variants.length <= 1} onClick={() => change('variants', draft.variants.filter((_, i) => i !== index))}><X size={15} />Remove</button>
      </div>)}</div><button type="button" className="text-button" disabled={draft.variants.length >= 30} onClick={() => change('variants', [...draft.variants, { size: '', stock: 0, barcode: '', sku: '' }])}><Plus size={16} />Add size / साइज़ जोड़ें</button>
    </div></fieldset>{error && <ErrorState error={error} />}<div className="editor-actions"><button className="button" disabled={locked}><Save size={16} />{busy ? 'Saving…' : product ? 'Save product' : 'Create product'}</button><button className="text-button" type="button" disabled={locked} onClick={onCancel}>Cancel</button></div><p className="small muted">Use photography only with appropriate rights. Avoid unsupported sourcing, review or material claims.</p></form>;
}

function Inventory({ busy, onBusyChange }: { busy: boolean; onBusyChange: (busy: boolean) => void }) {
  const { data, loading, error, retry } = useResource<{ products: Product[] }>('/admin/products');
  const { refreshProducts } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  return <section>
    {!creating && editing === null && <CatalogueImport onImported={async () => { retry(); await refreshProducts(); }} />}
    <div className="section-heading"><h2>The inventory</h2><div className="editor-actions"><button type="button" className="text-button" disabled={creating || editing !== null} onClick={retry}>Refresh inventory</button><button className="button" disabled={creating || editing !== null} onClick={() => setCreating(true)}><Plus size={17} />New product</button></div></div>
    {creating && <ProductEditor onBusyChange={onBusyChange} onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); retry(); }} />}
    <label className="admin-search">Find a product<input type="search" disabled={busy || editing !== null} placeholder="Name, category, slug, colour, brand, design, barcode or SKU" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {loading ? <Loading label="Loading inventory…" /> : error ? <ErrorState error={error} retry={retry} /> : <div className="inventory-list">{data?.products.filter(product => matchesProduct(product, query)).map(product => <article className="inventory-product" key={product.id}>
      <div className="inventory-row"><Image src={product.image} alt={product.name} loading="lazy" /><div><h3>{product.name}</h3><p>{product.category} · {product.color} · {product.archivedAt ? 'Archived' : product.active ? 'Active' : 'Hidden'}</p><ProductLifecycle product={product} /><CatalogueLabels item={product} /><span className="small">{product.variants.map(v => `${v.size}: ${v.stock}`).join(' / ')}</span><details className="small"><summary>Size identifiers / बारकोड</summary>{product.variants.map(v => <div key={v.size}><strong>{v.size}</strong><CatalogueLabels item={v} /></div>)}</details></div><strong>{money(product.price)}</strong><button className="button outline-button" disabled={busy || creating || (editing !== null && editing !== product.id)} onClick={() => setEditing(editing === product.id ? null : product.id)}>Edit<ChevronDown size={15} /></button></div>
      {editing === product.id && <ProductEditor product={product} onBusyChange={onBusyChange} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); retry(); }} />}
    </article>)}{!data?.products.some(product => matchesProduct(product, query)) && <div className="empty-state"><h3>No matching products.</h3><p>Create a piece or try another search.</p></div>}</div>}
  </section>;
}

function AdminOrder({ order, onUpdate }: { order: Order; onUpdate: () => void }) {
  const [status, setStatus] = useState<OrderStatus>(order.status);
  const [currentStatus, setCurrentStatus] = useState<OrderStatus>(order.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useStore();
  const transitions = allowedTransitions[currentStatus].filter(next => !(order.paymentMethod === 'Razorpay' && (order.paymentStatus !== 'paid' || order.paymentReview) && (next === 'confirmed' || next === 'shipped')));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || status === currentStatus) return;
    if (!transitions.includes(status)) { setError('This status transition is not allowed. Refresh orders to see the latest status.'); return; }
    setBusy(true); setError('');
    try { const result = await api<{ order: Order }>(`/admin/orders/${encodeURIComponent(order.id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }); setCurrentStatus(result.order.status); setStatus(result.order.status); toast(`Order status updated to ${result.order.status}.`); onUpdate(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <article className="admin-order paper-panel"><div className="order-card-head"><div><h3>Order {order.id.slice(0, 8)}</h3><p>{new Date(order.createdAt).toLocaleString('en-IN')}</p></div><strong>{money(order.total)}</strong></div><p className="small order-reference">Full ID: {order.id}</p><PaymentNotice order={order} />
    <details><summary>Customer, delivery & items</summary><address>{order.address.name} · {order.address.phone}<br />{order.address.line1}, {order.address.city}, {order.address.state} — {order.address.pincode}</address><ul>{order.items.map((item, index) => <li key={index}>{item.name} · {item.size} × {item.quantity} — {money(item.price * item.quantity)}<CatalogueLabels item={item} /></li>)}</ul><p className="small">Customer ID: {order.userId}<br />Payment method: {order.paymentMethod} · Shipping: {money(order.shipping)}</p></details>
    {order.paymentMethod === 'Razorpay' && order.paymentStatus !== 'paid' && <p className="notice-panel small">Unpaid online orders cannot be confirmed or shipped. Verify payment server-side first. Refunds require manual provider dashboard handling.</p>}
    <form className="order-status-form" onSubmit={save}><label>Status<select aria-label={`Status for order ${order.id}`} value={status} disabled={busy || !transitions.length} onChange={e => setStatus(e.target.value as OrderStatus)}>{[currentStatus, ...transitions].map(value => <option key={value} value={value}>{value}</option>)}</select></label><button className="button" disabled={busy || !transitions.includes(status)}><Check size={16} />{busy ? 'Updating…' : 'Update status'}</button></form>{!transitions.length && <p className="small muted">No further status changes are currently allowed.</p>}{error && <ErrorState error={error} />}</article>;
}
function AdminOrders() {
  const { data, loading, error, retry } = useResource<{ orders: Order[] }>('/admin/orders');
  return <section><div className="section-heading"><h2>All orders</h2><button className="text-button" onClick={retry}>Refresh<ArrowRight size={16} /></button></div>{loading ? <Loading label="Loading store orders…" /> : error ? <ErrorState error={error} retry={retry} /> : data?.orders.length ? <div className="admin-orders">{data.orders.map(order => <AdminOrder key={`${order.id}:${order.status}:${order.paymentStatus}`} order={order} onUpdate={retry} />)}</div> : <div className="empty-state"><h3>No orders yet.</h3><p>Server-recorded orders will appear here.</p></div>}</section>;
}
function Dashboard() {
  const { data, loading, error, retry } = useResource<{ stats: AdminStats }>('/admin/stats');
  const [tab, setTab] = useState<'products' | 'orders'>('products');
  const [editorBusy, setEditorBusy] = useState(false);
  return <div className="page-shell admin-page"><div className="page-heading"><p className="eyebrow">URBAN KASHI / STORE ADMINISTRATION</p><h1>Behind <em>the edit.</em></h1><p>Manage this independent demo storefront. Changes are saved to the server.</p></div>{loading ? <Loading label="Loading store statistics…" /> : error ? <ErrorState error={error} retry={retry} /> : data && <div className="stats-grid">{(['products', 'orders', 'customers', 'revenue'] as const).map(key => <div key={key}><span>{key === 'revenue' ? 'Order value · all methods' : key}</span><strong>{key === 'revenue' ? money(data.stats[key]) : data.stats[key]}</strong></div>)}</div>}<p className="small muted">Revenue is the server-reported order value, not confirmation of collected payment.</p><button className="text-button" onClick={retry}>Refresh statistics</button><div className="admin-tabs" role="group" aria-label="Administration section"><button disabled={editorBusy} className={tab === 'products' ? 'active' : ''} aria-pressed={tab === 'products'} onClick={() => setTab('products')}>Products & inventory</button><button disabled={editorBusy} className={tab === 'orders' ? 'active' : ''} aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Orders</button></div>{tab === 'products' ? <Inventory busy={editorBusy} onBusyChange={setEditorBusy} /> : <AdminOrders />}</div>;
}
export function Admin() { useTitle('Administration'); return <AuthGate admin><Dashboard /></AuthGate>; }