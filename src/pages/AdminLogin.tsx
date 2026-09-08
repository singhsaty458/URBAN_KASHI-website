import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import type { User } from '../../shared/types';
import { useStore } from '../context/Store';
import { api, message, useTitle } from '../lib/api';
import { ErrorState, Loading } from '../components/UI';

export function AdminLogin() {
  useTitle('Administrator sign-in');
  const { user, setUser, authLoading, authError, refreshUser } = useStore();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const email = String(fields.get('email') ?? '').trim();
    const password = String(fields.get('password') ?? '');
    setError('');
    if (!password || new TextEncoder().encode(password).length > 72) {
      setError('Enter your administrator password, at most 72 UTF-8 bytes.'); return;
    }
    setBusy(true);
    try {
      const result = await api<{ user: User }>('/auth/admin/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      });
      if (result.user.role !== 'admin') throw new Error('Administrator access was not confirmed.');
      form.reset();
      setUser(result.user);
      navigate('/admin', { replace: true });
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  if (authLoading) return <div className="page-shell"><Loading label="Checking administrator session…" /></div>;
  if (authError) return <div className="page-shell"><ErrorState error={authError} retry={refreshUser} /></div>;
  if (user?.role === 'admin') return <Navigate to="/admin" replace />;

  return <div className="auth-page">
    <div className="auth-editorial">
      <span className="eyebrow">URBAN KASHI / WEBSITE ADMIN</span>
      <h1>Your store.<br />Your <em>control.</em></h1>
      <p>Products, photos, sizes and stock.<br />One independent website workspace.</p>
      <span className="auth-monogram" aria-hidden="true">UK</span>
    </div>
    <div className="auth-form-panel">
      <p className="eyebrow"><ShieldCheck size={18} aria-hidden="true" /> OWNER ACCESS ONLY</p>
      <h2>Administrator sign-in.</h2>
      <p>Manage products, upload photography, update inventory and review orders.</p>
      {user && <p className="notice-panel">You are currently signed in as a customer. Enter an authorized administrator account below to switch accounts. A failed sign-in leaves your current session unchanged.</p>}
      <form className="form-stack" onSubmit={submit} aria-busy={busy}>
        <label>Admin email<input type="email" name="email" autoComplete="username" required maxLength={254} disabled={busy} /></label>
        <label>Admin password<input type="password" name="password" autoComplete="current-password" required maxLength={72} disabled={busy} aria-describedby="admin-login-help" /></label>
        {error && <ErrorState error={error} />}
        <button className="button full" disabled={busy}>{busy ? 'Checking access…' : 'Sign in to admin'}<ArrowRight size={17} /></button>
      </form>
      <p id="admin-login-help" className="small muted">No default password or public administrator registration. The owner must provision access using the private website setup procedure. Customer registration never grants administrator access.</p>
      <Link className="text-link" to="/account">Customer account portal<ArrowRight size={16} /></Link>
      <p className="small muted">Removing a listing means hiding it from the storefront; historical orders and product records are retained.</p>
    </div>
  </div>;
}