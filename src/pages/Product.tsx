import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Heart, ShoppingBag, Truck } from 'lucide-react';
import type { Product as ProductType } from '../../shared/types';
import { CART_LIMIT_MESSAGE, CART_MAX_LINES, CART_MAX_QUANTITY, useStore } from '../context/Store';
import { money, useResource, useTitle } from '../lib/api';
import { ErrorState, Image, Loading, ProductGrid, Quantity } from '../components/UI';
import { CatalogueLabels } from '../components/CatalogueLabels';

export function Product() {
  const { slug } = useParams();
  const { data, loading, error, retry } = useResource<{ product: ProductType }>(`/products/${encodeURIComponent(slug || '')}`);
  const { addItem, wishlist, toggleWishlist, products, cart } = useStore();
  const [size, setSize] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [imageIndex, setImageIndex] = useState(0);
  const [formError, setFormError] = useState('');
  const product = data?.product;
  useTitle(product?.name || 'The piece');
  useEffect(() => { setSize(''); setQuantity(1); setImageIndex(0); setFormError(''); }, [slug]);
  if (loading) return <div className="page-shell"><Loading label="Getting a closer look…" /></div>;
  if (error) return <div className="page-shell"><ErrorState error={error} retry={retry} /><Link className="text-link" to="/shop">Back to the collection<ArrowRight size={16} /></Link></div>;
  if (!product || !product.active) return <div className="page-shell"><ErrorState error="This piece is no longer available." /><Link className="button" to="/shop">Explore other pieces</Link></div>;
  const gallery = [...new Set([product.image, ...product.images].filter(Boolean))];
  const selectedVariant = product.variants.find(v => v.size === size);
  const stock = selectedVariant?.stock ?? 0;
  const siblings = product.design?.trim() && product.brand?.trim() ? products.filter(p => p.active && p.id !== product.id && p.design?.trim() === product.design?.trim() && p.brand?.trim() === product.brand?.trim() && p.color !== product.color) : [];
  const inBag = cart.find(item => item.productId === product.id && item.size === size)?.quantity ?? 0;
  const remaining = Math.max(0, Math.min(stock, CART_MAX_QUANTITY) - inBag);
  const lineLimitReached = cart.length > CART_MAX_LINES || (!inBag && cart.length >= CART_MAX_LINES);
  const soldOut = !product.variants.some(v => v.stock > 0);
  const saved = wishlist.includes(product.id);
  function add() { if (!size) { setFormError('Choose an available size before adding to your bag.'); return; } if (lineLimitReached || inBag + quantity > CART_MAX_QUANTITY) { setFormError(CART_LIMIT_MESSAGE); return; } if (quantity > remaining) { setFormError('That quantity is already in your bag or no longer available.'); return; } setFormError(''); addItem(product!, size, quantity); }
  return <div className="page-shell product-page"><div className="breadcrumb"><Link to="/">Home</Link><span>/</span><Link to={`/shop?category=${product.category}`}>{product.category}</Link><span>/</span>{product.name}</div><div className="product-detail-grid"><div className="product-gallery"><div className="product-main-photo"><Image src={gallery[imageIndex] || gallery[0]} alt={`${product.name}, ${product.color}, view ${imageIndex + 1}`} fetchPriority="high" />
    {(soldOut || product.badge) && <span className={`product-badge${soldOut ? ' sold-out-badge' : ''}`}>{soldOut ? 'Sold out' : product.badge}</span>}
    <span className="gallery-caption">{(gallery[imageIndex] || gallery[0])?.startsWith('/uploads/products/') ? 'PRODUCT PHOTOGRAPHY' : 'EDITORIAL DEMO PHOTOGRAPHY'}</span></div>{gallery.length > 1 && <div className="gallery-thumbs" role="group" aria-label="Product photographs">{gallery.map((image, index) => <button key={image} className={index === imageIndex ? 'selected' : ''} onClick={() => setImageIndex(index)} aria-label={`View ${index + 1} of ${product.name}`} aria-pressed={imageIndex === index}><Image src={image} alt="" loading="lazy" /></button>)}</div>}</div><div className="product-detail-copy"><p className="eyebrow">{product.category} / THE EVERYDAY EDIT</p><h1>{product.name}</h1><div className="detail-price">{money(product.price)}{product.originalPrice !== null && product.originalPrice > product.price && <del>{money(product.originalPrice)}</del>}</div><p className="muted small">INR · Demo inventory · Payment options at checkout</p><p className="product-description">{product.description}</p><p className="color-label">Colour <strong>{product.color}</strong></p>
    <CatalogueLabels item={{ brand: product.brand, design: product.design }} />
    {siblings.length > 0 && <nav className="sibling-colours" aria-label="Other colours of this brand and design"><p className="small">Same brand & design · Other colours</p>{siblings.map(p => <Link key={p.id} className="text-link" to={`/product/${encodeURIComponent(p.slug)}`}>{p.color}</Link>)}</nav>}
    <fieldset className="size-fieldset"><legend>Select size <span>{size ? `— ${size}` : ''}</span></legend><div className="size-options">{product.variants.map(variant => <button type="button" key={variant.size} disabled={variant.stock <= 0} className={size === variant.size ? 'selected' : ''} aria-pressed={size === variant.size} aria-label={`Size ${variant.size}${variant.stock <= 0 ? ', sold out' : ''}`} onClick={() => { setSize(variant.size); setQuantity(1); setFormError(''); }}>{variant.size}</button>)}</div></fieldset>
    {selectedVariant && <div aria-live="polite"><CatalogueLabels item={selectedVariant} />{!selectedVariant.barcode && !selectedVariant.sku && <p className="small muted">No barcode / SKU supplied for this size.</p>}</div>}
    <p className="stock-note">{soldOut ? 'Currently sold out in all sizes.' : size ? `${stock} available in size ${size}${inBag ? ` · ${inBag} in your bag` : ''}` : 'Select a size to check availability.'}</p>
    <p className="small muted">Maximum 10 units per product/size · 20 product/size lines per order.</p>
    {size && (lineLimitReached || inBag >= CART_MAX_QUANTITY) && <p className="field-error" role="alert">{CART_LIMIT_MESSAGE}</p>}
    <div className="add-to-bag-row"><Quantity value={quantity} max={lineLimitReached ? 0 : remaining} onChange={setQuantity} /><button className="button" disabled={soldOut || Boolean(size && (remaining <= 0 || lineLimitReached))} onClick={add}><ShoppingBag size={18} />{soldOut ? 'Sold out' : 'Add to bag'}<ArrowRight size={17} /></button><button className={`icon-button detail-wishlist ${saved ? 'is-saved' : ''}`} aria-label={saved ? 'Remove from wishlist' : 'Save to wishlist'} aria-pressed={saved} onClick={() => toggleWishlist(product.id)}><Heart size={21} fill={saved ? 'currentColor' : 'none'} /></button></div>{formError && <p className="field-error" role="alert">{formError}</p>}<div className="delivery-note"><Truck size={20} strokeWidth={1.4} /><p>Free shipping from ₹2,499. Otherwise ₹99.<br /><Link to="/shipping">Delivery & returns information</Link></p></div><div className="product-accordions"><details open><summary>The details</summary>{product.details.length ? <ul>{product.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul> : <p>Further product details have not been supplied for this demo piece.</p>}</details><details><summary>Material & care</summary><p>Refer to the product details above and the garment label for its exact composition and washing instructions. Material and care specifications are not separately verified in this demo catalogue.</p></details><details><summary>Fit & sizing</summary><p>Available sizes are shown above. Measurements and a verified size chart have not yet been provided. Do not rely on editorial photography to judge fit.</p></details></div></div></div>{products.some(p => p.category === product.category && p.id !== product.id) && <section className="related-section"><div className="section-heading"><div><p className="eyebrow">SAME SPIRIT. DIFFERENT EXPRESSION.</p><h2>A few more <em>possibilities.</em></h2></div><Link to="/shop" className="text-link">Explore all<ArrowRight size={16} /></Link></div><ProductGrid products={products.filter(p => p.category === product.category && p.id !== product.id).slice(0, 4)} /></section>}</div>;
}