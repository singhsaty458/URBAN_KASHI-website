import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Search, SlidersHorizontal, X } from 'lucide-react';
import { useStore } from '../context/Store';
import { categories, useTitle } from '../lib/api';
import { matchesProduct } from '../lib/catalogue';
import { Empty, ErrorState, Loading, ProductGrid } from '../components/UI';

export function Shop() {
  useTitle('The collection');
  const { products, productsError, productsLoading, refreshProducts } = useStore();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const sort = params.get('sort') ?? 'featured';
  const available = params.get('available') === 'true';
  const update = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next, { replace: true, preventScrollReset: true }); };
  const filtered = useMemo(() => {
    const list = products.filter(p => (!category || p.category === category) && (!available || p.variants.some(v => v.stock > 0)) && matchesProduct(p, query));
    if (sort === 'price-asc') list.sort((a, b) => a.price - b.price);
    else if (sort === 'price-desc') list.sort((a, b) => b.price - a.price);
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'newest') list.sort((a, b) => Number(/new/i.test(b.badge ?? '')) - Number(/new/i.test(a.badge ?? '')));
    else list.sort((a, b) => Number(b.featured) - Number(a.featured));
    return list;
  }, [products, query, category, available, sort]);
  return <div className="page-shell shop-page"><div className="breadcrumb"><Link to="/">Home</Link><span>/</span>Collection</div><div className="shop-intro"><div><p className="eyebrow">THE URBAN KASHI WARDROBE</p><h1>{category || 'Your everyday.'}<br /><em>{category ? 'Your perspective.' : 'Reconsidered.'}</em></h1></div><p>Pieces for the person, not the occasion.<br />Explore the demo collection, your way.<br /><span className="demo-label"><span /> Sample inventory & photography</span></p></div><div className="shop-filters"><div className="category-tabs" role="group" aria-label="Filter by category">{['', ...categories].map(value => <button key={value} className={category === value ? 'active' : ''} aria-pressed={category === value} onClick={() => update('category', value)}>{value || 'All pieces'}</button>)}</div><div className="filter-controls"><div className="search-input"><Search size={18} /><input aria-label="Search products" placeholder="Find something you love…" value={query} onChange={e => update('q', e.target.value)} />{query && <button className="icon-button" aria-label="Clear search" onClick={() => update('q', '')}><X size={16} /></button>}</div><label className="checkbox-label"><input type="checkbox" checked={available} onChange={e => update('available', e.target.checked ? 'true' : '')} />Available only</label><label className="sort-label"><SlidersHorizontal size={16} /><span className="sr-only">Sort products</span><select value={sort} onChange={e => update('sort', e.target.value)}><option value="featured">Featured</option><option value="newest">New arrivals</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option><option value="name">Name: A–Z</option></select></label></div></div><div className="results-line"><span>{productsLoading ? 'Finding your pieces…' : `${filtered.length} ${filtered.length === 1 ? 'piece' : 'pieces'}`}</span>{(query || category || available) && <button className="text-button" onClick={() => setParams({})}>Reset filters<X size={13} /></button>}</div>{sort === 'newest' && <p className="muted small">New-arrival badges first, then catalogue order. Exact release dates are not provided.</p>}{productsLoading ? <Loading /> : productsError ? <ErrorState error={productsError} retry={refreshProducts} /> : filtered.length ? <ProductGrid products={filtered} /> : <div className="empty-state"><h2>No pieces in this edit.</h2><p>Try another search or make a little more room in your filters.</p><button className="button" onClick={() => setParams({})}>See all pieces<ArrowUpRight size={17} /></button></div>}</div>;
}
export function Wishlist() {
  useTitle('Your wishlist');
  const { products, productsError, productsLoading, refreshProducts, wishlist, toggleWishlist } = useStore();
  const saved = products.filter(p => wishlist.includes(p.id));
  const unavailable = wishlist.filter(id => !products.some(p => p.id === id));
  return <div className="page-shell"><div className="page-heading"><p className="eyebrow">KEEP THE GOOD ONES CLOSE</p><h1>Your <em>wishlist.</em></h1><p>A little inspiration, saved for later. Stored on this device.</p></div>{productsLoading ? <Loading /> : productsError ? <ErrorState error={productsError} retry={refreshProducts} /> : <>{saved.length ? <ProductGrid products={saved} /> : <Empty title="Something will catch your eye." text="Tap the heart on any piece to save it here." />}{unavailable.length > 0 && <div className="notice-panel"><p>{unavailable.length} saved {unavailable.length === 1 ? 'piece is' : 'pieces are'} no longer in the catalogue.</p>{unavailable.map((id, index) => <button key={id} className="text-button" onClick={() => toggleWishlist(id)}>Remove unavailable piece {index + 1}<X size={14} /></button>)}</div>}</>}</div>;
}