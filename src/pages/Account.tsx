import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, LogOut, Package } from 'lucide-react';
import type { Order, User } from '../../shared/types';
import { api, message, money, useResource, useTitle } from '../lib/api';
import { useStore } from '../context/Store';
import { Empty, ErrorState, Image, Loading } from '../components/UI';
import { CatalogueLabels, PaymentNotice, paymentLabel } from '../components/CatalogueLabels';

export function OrderList({ orders }: { orders: Order[] }) {
  return <div className="orders-list">{orders.map(order => <article className="order-card" key={order.id}>
    <div className="order-card-head"><div><span className="eyebrow">ORDER {order.id.slice(0, 8)}</span><p>{new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div><span className={`status status-${order.status}`}>{order.status}</span></div>
    <div className="order-card-body"><div className="order-thumbnails">{order.items.slice(0, 3).map((item, index) => <Image key={index} src={item.image} alt={item.name} loading="lazy" />)}</div><div><strong>{money(order.total)}</strong><p>{order.items.reduce((n, item) => n + item.quantity, 0)} items · {paymentLabel(order)}</p></div><Link className="text-link" to={`/order/${encodeURIComponent(order.id)}`}>View order<ArrowRight size={16} /></Link></div>
    <PaymentNotice order={order} />
    <details className="order-snapshot"><summary>Recorded item details / आइटम विवरण</summary>{order.items.map((item, index) => <div key={index}><p className="small"><strong>{item.name}</strong> · Size {item.size} × {item.quantity}</p><CatalogueLabels item={item} /></div>)}</details>
  </article>)}</div>;
}

function MyOrders() {
  const { data, loading, error, retry } = useResource<{ orders: Order[] }>('/orders');
  return <section className="account-orders"><div className="section-heading"><h2>Your orders</h2><Package size={25} strokeWidth={1} /></div>{loading ? <Loading label="Loading your orders…" /> : error ? <ErrorState error={error} retry={retry} /> : data?.orders.length ? <OrderList orders={data.orders} /> : <Empty title="Your story starts here." text="When you place an order, it will appear here." />}</section>;
}

export function Account() {
  useTitle('Your account');
  const { user, setUser, authLoading, authError, refreshUser, toast } = useStore();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get('next');
  const safeNext = next && /^\/(?:checkout|wishlist|admin|order(?:\/[^/?#]+)?)(?:[?#].*)?$/.test(next) ? next : null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim(); const password = String(form.get('password')); const name = String(form.get('name') || '').trim();
    if (tab === 'register' && name.length < 2) { setError('Enter a name with at least two characters.'); setBusy(false); return; }
    const passwordBytes = new TextEncoder().encode(password).length;
    if (!passwordBytes || passwordBytes > 72) { setError('Password must be non-empty and at most 72 UTF-8 bytes. Accented characters and emoji can use multiple bytes.'); setBusy(false); return; }
    if (tab === 'register' && (passwordBytes < 10 || !/[a-z]/i.test(password) || !/[0-9]/.test(password))) { setError('Use 10–72 UTF-8 bytes, including at least one letter (A–Z) and one number (0–9). Accented characters and emoji can use multiple bytes.'); setBusy(false); return; }
    try { const result = await api<{ user: User }>(`/auth/${tab}`, { method: 'POST', body: JSON.stringify(tab === 'register' ? { name, email, password } : { email, password }) }); setUser(result.user); toast(tab === 'register' ? 'Your account is ready.' : 'Welcome back.'); if (safeNext) navigate(safeNext, { replace: true }); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function logout() { setBusy(true); setError(''); try { await api('/auth/logout', { method: 'POST' }); setUser(null); toast('You have been signed out.'); } catch (error) { setError(message(error)); } finally { setBusy(false); } }
  if (authLoading) return <div className="page-shell"><Loading label="Opening your account…" /></div>;
  if (authError) return <div className="page-shell"><ErrorState error={authError} retry={refreshUser} /></div>;
  if (user) return <div className="page-shell account-page"><div className="account-header"><div><p className="eyebrow">YOUR OWN LITTLE CORNER</p><h1>Hello, <em>{user.name.split(' ')[0]}.</em></h1><p className="muted">{user.email}</p></div><button className="button outline-button" onClick={logout} disabled={busy}><LogOut size={17} />{busy ? 'Signing out…' : 'Sign out'}</button></div>{error && <ErrorState error={error} />}{safeNext && <Link className="button" to={safeNext}>Continue where you left off<ArrowRight size={16} /></Link>}{user.role === 'admin' && <div className="notice-panel"><p>You are signed in as a store administrator.</p><Link className="text-link" to="/admin">Open administration<ArrowRight size={16} /></Link></div>}<MyOrders key={user.id} /></div>;
  return <div className="auth-page"><div className="auth-editorial"><span className="eyebrow">URBAN KASHI / YOUR PERSPECTIVE</span><h1>Good to<br />have you<br /><em>here.</em></h1><p>A home for your orders.<br />A new chapter for your wardrobe.</p><span className="auth-monogram">UK</span></div><div className="auth-form-panel"><p className="eyebrow">MAKE YOURSELF AT HOME</p><h2>{tab === 'login' ? 'Welcome back.' : 'A fresh beginning.'}</h2><div className="auth-tabs" role="group" aria-label="Choose account action"><button className={tab === 'login' ? 'active' : ''} aria-pressed={tab === 'login'} disabled={busy} onClick={() => { setTab('login'); setError(''); }}>Sign in</button><button className={tab === 'register' ? 'active' : ''} aria-pressed={tab === 'register'} disabled={busy} onClick={() => { setTab('register'); setError(''); }}>Create account</button></div><form onSubmit={submit} className="form-stack" key={tab}>{tab === 'register' && <label>Full name<input name="name" autoComplete="name" required minLength={2} maxLength={100} placeholder="Your name" /></label>}<label>Email address<input type="email" name="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" /></label><label>Password<input type="password" name="password" autoComplete={tab === 'login' ? 'current-password' : 'new-password'} required minLength={1} maxLength={72} aria-describedby="password-hint" placeholder={tab === 'register' ? '10–72 UTF-8 bytes; letter + number' : 'Your password'} /></label><p id="password-hint" className="small muted">{tab === 'register' ? 'Use 10–72 UTF-8 bytes with a letter (A–Z) and a number (0–9).' : 'Enter your existing password (up to 72 UTF-8 bytes).'} Accented characters and emoji can use multiple bytes.</p>{error && <ErrorState error={error} />}<button className="button full" disabled={busy}>{busy ? 'Please wait…' : tab === 'login' ? 'Sign in' : 'Create your account'}<ArrowRight size={17} /></button><p className="small muted">Demo storefront. Use a unique password and avoid entering sensitive personal information. See our <Link to="/privacy">privacy draft</Link>.</p></form></div></div>;
}