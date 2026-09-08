import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Heart, Menu, Search, ShoppingBag, Trash2, UserRound } from 'lucide-react';
import { CART_LIMIT_MESSAGE, CART_MAX_LINES, CART_MAX_QUANTITY, useStore } from '../context/Store';
import { money } from '../lib/api';
import { Drawer, Empty, ErrorState, Image, Loading, Quantity } from './UI';
import { Brand } from './Brand';
import { CatalogueLabels } from './CatalogueLabels';

function Bag() {
  const { cart, products, productsError, productsLoading, refreshProducts, bagOpen, setBagOpen, updateItem } = useStore();
  const subtotal = cart.reduce((sum, item) => sum + (products.find(p => p.id === item.productId)?.price ?? 0) * item.quantity, 0);
  const overLimit = cart.length > CART_MAX_LINES || cart.some(item => item.quantity > CART_MAX_QUANTITY);
  const invalid = overLimit || cart.some(item => { const p = products.find(p => p.id === item.productId); return !p || !p.active || (p.variants.find(v => v.size === item.size)?.stock ?? 0) < item.quantity; });
  const close = () => setBagOpen(false);
  return <Drawer open={bagOpen} onClose={close} title={`Your bag (${cart.reduce((n, item) => n + item.quantity, 0)})`}>
    <div className="drawer-content">{productsLoading ? <Loading /> : productsError ? <ErrorState error={productsError} retry={refreshProducts} /> : !cart.length ? <div onClick={event => { if ((event.target as HTMLElement).closest('a')) close(); }}><Empty title="Good things take space." text="Find your next everyday favourite." /></div> : <>
      <p className="bag-note">{subtotal >= 2499 ? 'Your bag qualifies for free shipping.' : `${money(2499 - subtotal)} away from free shipping.`}</p><div className="shipping-progress"><span style={{ width: `${Math.min(100, subtotal / 2499 * 100)}%` }} /></div>
      <p className="small muted">Maximum 10 units per product/size · 20 product/size lines per order.</p>
      {cart.map(item => { const product = products.find(p => p.id === item.productId); const variant = product?.variants.find(v => v.size === item.size); const stock = variant?.stock ?? 0; return <div className="bag-item" key={`${item.productId}:${item.size}`}>
        <Image src={product?.image} alt={product?.name || 'Unavailable product'} loading="lazy" /><div className="bag-item-info">{product ? <Link onClick={close} to={`/product/${product.slug}`}>{product.name}</Link> : <strong>Item no longer available</strong>}<p>Size {item.size} {product && `· ${product.color}`}</p>{product && (product.brand || product.design || variant?.barcode || variant?.sku) && <CatalogueLabels item={{ brand: product.brand, design: product.design, barcode: variant?.barcode, sku: variant?.sku }} />}{product && <span>{money(product.price)}</span>}{stock < item.quantity && <p className="field-error">{stock ? `Only ${stock} left. Please reduce quantity.` : 'Unavailable. Please remove.'}</p>}{item.quantity > CART_MAX_QUANTITY && <p className="field-error">Maximum 10 units per product/size. Please reduce quantity.</p>}<Quantity value={item.quantity} max={cart.length > CART_MAX_LINES ? 0 : Math.min(stock, CART_MAX_QUANTITY)} onChange={quantity => updateItem(item.productId, item.size, quantity)} label={`quantity for ${product?.name || 'unavailable item'}, size ${item.size}`} /></div><button className="icon-button" aria-label={`Remove ${product?.name || 'unavailable item'}, size ${item.size}`} onClick={() => updateItem(item.productId, item.size, 0)}><Trash2 size={17} /></button></div>; })}
    </>}</div>
    {!!cart.length && !productsLoading && !productsError && <div className="drawer-bottom"><div className="summary-line"><span>Subtotal</span><strong>{money(subtotal)}</strong></div><p className="muted small">Shipping {subtotal >= 2499 ? 'free' : money(99)}. Payment options at checkout.</p>{invalid ? <p role="alert" className="field-error">{overLimit ? CART_LIMIT_MESSAGE : 'Update unavailable items before checkout.'}</p> : <Link className="button full" to="/checkout" onClick={close}>Continue to checkout<ArrowRight size={18} /></Link>}<button className="text-button centered" onClick={close}>Continue exploring</button></div>}
  </Drawer>;
}

export function Layout() {
  const { cart, wishlist, user, setBagOpen } = useStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => { setMenuOpen(false); setSearchOpen(false); setBagOpen(false); }, [location.pathname, location.search, setBagOpen]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [location.pathname]);
  function search(event: FormEvent) { event.preventDefault(); navigate(`/shop${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`); setSearchOpen(false); }
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="announcement"><span>Considered essentials. A different rhythm.</span><span>Complimentary shipping on orders ₹2,499+ <ArrowUpRight size={12} /></span></div>
    <header className="site-header"><div className="header-inner"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={23} /></button><Link to="/" className="brand-link" aria-label="Urban Kashi home"><Brand compact /></Link><nav className="desktop-nav" aria-label="Main navigation"><NavLink to="/shop">Shop</NavLink><Link to="/shop?sort=newest">New arrivals <span className="nav-dot" /></Link><NavLink to="/about">Our story</NavLink></nav><div className="nav-actions"><button className="icon-button" aria-label="Search collection" onClick={() => setSearchOpen(true)}><Search size={21} /></button><Link className="icon-button account-nav" to="/account" aria-label={user ? `${user.name}'s account` : 'Sign in'}><UserRound size={21} />{user && <span className="customer-name">{user.name.split(' ')[0]}</span>}</Link><Link className="icon-button wishlist-nav" to="/wishlist" aria-label={`Wishlist, ${wishlist.length} items`}><Heart size={21} />{wishlist.length > 0 && <span className="counter">{wishlist.length}</span>}</Link><button className="icon-button bag-button" aria-label={`Open bag, ${count} items`} onClick={() => setBagOpen(true)}><ShoppingBag size={21} /><span className="bag-count">{count}</span></button></div></div></header>
    <main id="main" tabIndex={-1}><Outlet /></main>
    <footer className="site-footer"><div className="footer-top"><div className="footer-brand"><Link className="brand-link" to="/"><Brand /></Link><p>For the lanes you know.<br />And the roads you haven’t taken.</p><span className="demo-label"><span />Demo storefront · sample inventory & photography</span></div><div><h2>Explore</h2><Link to="/shop">All clothing</Link><Link to="/shop?sort=newest">New arrivals</Link><Link to="/wishlist">Your wishlist</Link><Link to="/about">Our story</Link></div><div><h2>Good to know</h2><Link to="/shipping">Shipping & returns</Link><Link to="/privacy">Privacy</Link><Link to="/account">Account & orders</Link>{user?.role === 'admin' && <Link to="/admin">Store administration</Link>}</div><div className="footer-note"><h2>A slower kind of scroll.</h2><p>Less noise. More room for your own expression.</p><Link className="text-link" to="/shop?category=Kurtas">Find your rhythm <ArrowUpRight size={17} /></Link></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} URBAN KASHI</span><span>Independent by design. Not connected to a POS.</span><span>INR · COD + optional online payments</span></div></footer>
    <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Explore"><nav className="mobile-links" aria-label="Mobile navigation"><Link to="/shop">Shop all <ArrowUpRight /></Link><Link to="/shop?sort=newest">New arrivals <ArrowUpRight /></Link><Link to="/about">Our story <ArrowUpRight /></Link><Link to="/wishlist">Wishlist ({wishlist.length})</Link><Link to="/account">{user ? `Hello, ${user.name}` : 'Sign in / Register'}</Link><Link to="/shipping">Shipping & returns</Link>{user?.role === 'admin' && <Link to="/admin">Administration</Link>}</nav><p className="drawer-content muted">Old soul. New perspective.</p></Drawer>
    <Drawer open={searchOpen} onClose={() => setSearchOpen(false)} title="Find your next favourite"><div className="drawer-content"><form onSubmit={search} className="search-form"><label htmlFor="site-search">Search the collection</label><div className="search-input"><Search size={19} /><input id="site-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Linen, shirts, olive…" /><button type="submit" className="icon-button" aria-label="Submit search"><ArrowRight size={20} /></button></div></form><p className="eyebrow search-suggestions">A place to start</p><div className="chips">{['Shirts', 'Kurtas', 'Layers'].map(category => <Link key={category} to={`/shop?category=${category}`}>{category}<ArrowUpRight size={14} /></Link>)}</div></div></Drawer>
    <Bag />
  </>;
}