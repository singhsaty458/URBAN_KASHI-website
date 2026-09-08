import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CartItem, Product, User } from '../../shared/types';
import { api, message } from '../lib/api';

export const CART_MAX_QUANTITY = 10;
export const CART_MAX_LINES = 20;
export const CART_LIMIT_MESSAGE = 'Limit: 10 units per product/size and 20 product/size lines per order. Reduce quantities or remove lines that exceed these limits before checkout.';

function readStorage<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) || 'null'); return validate(value) ? value : fallback; }
  catch { return fallback; }
}
// Read legacy bags without discarding items; mutations and checkout enforce the current limits.
const validCart = (value: unknown): value is CartItem[] => Array.isArray(value) && value.length <= 100 && value.every(item => item && typeof item.productId === 'string' && typeof item.size === 'string' && item.size.trim().length > 0 && item.size.length <= 24 && !/[<>\u0000-\u001f\u007f]/.test(item.size) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 99) && new Set(value.map(item => JSON.stringify([item.productId, item.size]))).size === value.length;
const validWishlist = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 && value.every(id => typeof id === 'string') && new Set(value).size === value.length;

interface Store {
  user: User | null; authLoading: boolean; authError: string; refreshUser: () => Promise<void>;
  setUser: (user: User | null) => void;
  products: Product[]; productsLoading: boolean; productsError: string; refreshProducts: () => Promise<void>;
  cart: CartItem[]; addItem: (product: Product, size: string, quantity: number) => boolean;
  updateItem: (productId: string, size: string, quantity: number) => void;
  clearCart: () => void; wishlist: string[]; toggleWishlist: (id: string) => void;
  bagOpen: boolean; setBagOpen: (open: boolean) => void; toast: (text: string) => void;
  notification: { id: number; text: string } | null;
}
const StoreContext = createContext<Store | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState('');
  const [cart, setCart] = useState(() => readStorage('uk-bag-v1', [], validCart));
  const [wishlist, setWishlist] = useState(() => readStorage('uk-wishlist-v1', [], validWishlist));
  const [bagOpen, setBagOpen] = useState(false);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const noticeId = useRef(0);
  const cartRef = useRef(cart);
  const toast = useCallback((text: string) => setNotice({ id: ++noticeId.current, text }), []);
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(timer); } }, [notice]);
  useEffect(() => { try { localStorage.setItem('uk-bag-v1', JSON.stringify(cart)); } catch { toast('Your bag is available this session, but this browser could not save it.'); } }, [cart, toast]);
  useEffect(() => { try { localStorage.setItem('uk-wishlist-v1', JSON.stringify(wishlist)); } catch { toast('Your wishlist could not be saved on this device.'); } }, [wishlist, toast]);
  const refreshUser = useCallback(async () => {
    setAuthLoading(true); setAuthError('');
    try { const result = await api<{ user: User | null }>('/auth/me'); setUser(result.user); }
    catch (error) { setAuthError(message(error)); }
    finally { setAuthLoading(false); }
  }, []);
  const refreshProducts = useCallback(async () => {
    setProductsLoading(true); setProductsError('');
    try { const result = await api<{ products: Product[] }>('/products'); setProducts(result.products.filter(p => p.active)); }
    catch (error) { setProductsError(message(error)); }
    finally { setProductsLoading(false); }
  }, []);
  useEffect(() => { void refreshUser(); void refreshProducts(); }, [refreshUser, refreshProducts]);
  const saveCart = (next: CartItem[]) => { cartRef.current = next; setCart(next); };
  function addItem(product: Product, size: string, quantity: number) {
    const existing = cartRef.current.find(item => item.productId === product.id && item.size === size);
    const stock = product.variants.find(v => v.size === size)?.stock ?? 0;
    if ((existing?.quantity ?? 0) + quantity > CART_MAX_QUANTITY || cartRef.current.length > CART_MAX_LINES || (!existing && cartRef.current.length >= CART_MAX_LINES)) { toast(CART_LIMIT_MESSAGE); return false; }
    if (!product.active || !Number.isInteger(quantity) || quantity < 1 || (existing?.quantity ?? 0) + quantity > stock) { toast('That quantity is not available. Please check the selected size.'); return false; }
    saveCart(existing ? cartRef.current.map(item => item === existing ? { ...item, quantity: item.quantity + quantity } : item) : [...cartRef.current, { productId: product.id, size, quantity }]);
    toast(`${product.name} added to your bag.`); setBagOpen(true); return true;
  }
  function updateItem(productId: string, size: string, quantity: number) {
    if (!Number.isInteger(quantity) || quantity < 0) return;
    const stock = products.find(p => p.id === productId)?.variants.find(v => v.size === size)?.stock ?? 0;
    const current = cartRef.current.find(item => item.productId === productId && item.size === size);
    // A stale bag must still allow reductions, even if several steps are needed to reach current stock.
    if (!current) return;
    if (quantity >= current.quantity) {
      if (quantity > CART_MAX_QUANTITY || cartRef.current.length > CART_MAX_LINES) { toast(CART_LIMIT_MESSAGE); return; }
      if (quantity > stock) { toast('No more stock is available in that size.'); return; }
    }
    saveCart(quantity === 0 ? cartRef.current.filter(item => !(item.productId === productId && item.size === size)) : cartRef.current.map(item => item.productId === productId && item.size === size ? { ...item, quantity } : item));
  }
  const toggleWishlist = (id: string) => {
    const exists = wishlist.includes(id);
    if (!exists && wishlist.length >= 1000) { toast('Your wishlist is full. Remove an item first.'); return; }
    setWishlist(list => exists ? list.filter(item => item !== id) : [...list, id]);
    toast(exists ? 'Removed from your wishlist.' : 'Saved to your wishlist.');
  };
  return <StoreContext.Provider value={{ user, authLoading, authError, refreshUser, setUser, products, productsLoading, productsError, refreshProducts, cart, addItem, updateItem, clearCart: () => saveCart([]), wishlist, toggleWishlist, bagOpen, setBagOpen, toast, notification: notice }}>
    {children}<div className="toast-region" role="status" aria-live="polite" aria-atomic="true">{notice && <div className="toast" key={notice.id}><span className="toast-dot" />{notice.text}<button onClick={() => setNotice(null)} aria-label="Dismiss notification">×</button></div>}</div>
  </StoreContext.Provider>;
}
export function useStore() { const context = useContext(StoreContext); if (!context) throw new Error('StoreProvider is missing'); return context; }