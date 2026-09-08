import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useStore } from '../context/Store';
import { Empty, ErrorState, Loading } from './UI';

export function AuthGate({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, authLoading, authError, refreshUser } = useStore();
  const location = useLocation();
  if (authLoading) return <div className="page-shell"><Loading label="Checking your account…" /></div>;
  if (authError) return <div className="page-shell"><ErrorState error={authError} retry={refreshUser} /></div>;
  if (admin && !user) return <div className="page-shell"><Empty title="Store administration." text="Sign in with your authorized website administrator account." to="/admin/login" action="Administrator sign-in" /></div>;
  if (!user) return <div className="page-shell"><Empty title="Make yourself at home." text="Sign in to securely access your account and orders." to={`/account?next=${encodeURIComponent(location.pathname + location.search)}`} action="Sign in or register" /></div>;
  if (admin && user.role !== 'admin') return <div className="page-shell"><div className="empty-state"><h1>Restricted access.</h1><p>This area is available only to store administrators. You are signed in with a customer account. Go to your account, sign out, then sign in with the owner account that has administrator access. Alternatively, use the dedicated administrator sign-in below to switch accounts.</p><p>Signing in again does not grant a role. If your owner email is still a customer, it needs the private website admin setup first.</p><Link className="button" to="/admin/login">Administrator sign-in</Link><p><Link className="text-link" to="/account">Back to your account</Link></p></div></div>;
  return children;
}