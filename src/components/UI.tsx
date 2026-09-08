import { useEffect, useRef, useState, type ReactNode, type ImgHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Heart, Minus, Plus, RefreshCw, X } from 'lucide-react';
import type { Product } from '../../shared/types';
import { useStore } from '../context/Store';
import { money } from '../lib/api';
import { CardPurchaseActions } from './CardPurchaseActions';
import '../product-images.css';

export function Image({ src, alt, className = '', ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed || !src ? <div className={`image-fallback ${className}`} role="img" aria-label={alt || 'Product image unavailable'}><span>UK</span><small>{alt || 'Image unavailable'}</small></div> : <img {...props} src={src} alt={alt ?? ''} className={className} onError={() => setFailed(true)} />;
}
export function ErrorState({ error, retry }: { error: string; retry?: () => void }) { return <div className="error-state" role="alert"><p>{error}</p>{retry && <button className="text-button" onClick={retry}><RefreshCw size={15} />Try again</button>}</div>; }
export function Loading({ label = 'Loading the collection…' }: { label?: string }) { return <div className="loading" role="status"><span className="spinner" />{label}</div>; }
export function Empty({ title, text, to = '/shop', action = 'Explore the collection' }: { title: string; text: string; to?: string; action?: string }) { return <div className="empty-state"><span className="eyebrow">A little room for possibility</span><h2>{title}</h2><p>{text}</p><Link className="button" to={to}>{action}<ArrowUpRight size={18} /></Link></div>; }
export function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    element.classList.add('reveal-ready');
    const observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting) { element.classList.add('revealed'); observer.disconnect(); } }, { threshold: 0.08 });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  return <div ref={ref} className={`reveal ${className}`}>{children}</div>;
}
export function ProductCard({ product }: { product: Product }) {
  const { wishlist, toggleWishlist } = useStore();
  const saved = wishlist.includes(product.id);
  const available = product.active && product.variants.some(v => v.stock > 0);
  return <article className="product-card"><div className="product-image-wrap"><Link to={`/product/${product.slug}`} tabIndex={-1} aria-hidden="true"><Image src={product.image} alt={product.name} loading="lazy" /></Link>
    {(product.badge || !available) && <span className={`product-badge${!available ? ' sold-out-badge' : ''}`}>{available ? product.badge : 'Sold out'}</span>}
    <button className={`icon-button save-product ${saved ? 'is-saved' : ''}`} onClick={() => toggleWishlist(product.id)} aria-label={`${saved ? 'Remove' : 'Save'} ${product.name} ${saved ? 'from' : 'to'} wishlist`} aria-pressed={saved}><Heart size={18} fill={saved ? 'currentColor' : 'none'} /></button>
    <Link to={`/product/${product.slug}`} className="quick-view">Discover the piece<ArrowUpRight size={16} /></Link>
  </div><div className="product-meta"><div><p className="product-category">{product.category} <span>·</span> {product.color}</p><h3><Link to={`/product/${product.slug}`}>{product.name}</Link></h3></div><div className="product-price">{money(product.price)}{product.originalPrice !== null && product.originalPrice > product.price && <del>{money(product.originalPrice)}</del>}</div></div>
    <CardPurchaseActions product={product} />
  </article>;
}
export function ProductGrid({ products }: { products: Product[] }) { return <div className="product-grid">{products.map(product => <ProductCard product={product} key={product.id} />)}</div>; }
export function Quantity({ value, max, onChange, label = 'Quantity' }: { value: number; max: number; onChange: (value: number) => void; label?: string }) { return <div className="quantity" role="group" aria-label={label}><button type="button" aria-label={`Decrease ${label}`} disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus size={14} /></button><span aria-live="polite">{value}</span><button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={14} /></button></div>; }
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const { notification } = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    node?.showModal();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]')).filter(item => item.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    node?.addEventListener('keydown', trap);
    return () => { node?.removeEventListener('keydown', trap); node?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, [open]);
  if (!open) return null;
  return <dialog ref={dialog} className="drawer" aria-label={title} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right) onClose(); } }}><div className="drawer-inner"><header className="drawer-header"><h2>{title}</h2><button autoFocus className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X /></button></header>{children}<div className="drawer-live-region" role="status" aria-live="polite" aria-atomic="true">{notification && <p key={notification.id}>{notification.text}</p>}</div></div></dialog>;
}