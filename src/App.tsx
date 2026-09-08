import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { StoreProvider } from './context/Store';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Shop, Wishlist } from './pages/Shop';
import { Product } from './pages/Product';
import { Account } from './pages/Account';
import { Checkout, OrderPage } from './pages/Checkout';
import { Admin } from './pages/Admin';
import { AdminLogin } from './pages/AdminLogin';
import { About, Shipping, Privacy, NotFound } from './pages/Editorial';
import './catalogue-payments.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Keep customer and order data out of console logging. */ }
  render() { return this.state.failed ? <main className="page-shell empty-state"><p className="eyebrow">URBAN KASHI</p><h1>Let’s take <em>a moment.</em></h1><p>The page could not be displayed. Your saved bag should still be here after reloading.</p><button className="button" onClick={() => window.location.reload()}>Reload the storefront</button><a className="text-link" href="/">Return home</a></main> : this.props.children; }
}
export default function App() {
  return <ErrorBoundary><BrowserRouter><StoreProvider><Routes><Route element={<Layout />}><Route index element={<Home />} /><Route path="shop" element={<Shop />} /><Route path="product/:slug" element={<Product />} /><Route path="wishlist" element={<Wishlist />} /><Route path="checkout" element={<Checkout />} /><Route path="account" element={<Account />} /><Route path="order/:id" element={<OrderPage />} /><Route path="about" element={<About />} /><Route path="shipping" element={<Shipping />} /><Route path="privacy" element={<Privacy />} /><Route path="admin/login" element={<AdminLogin />} /><Route path="admin" element={<Admin />} /><Route path="404" element={<NotFound />} /><Route path="*" element={<NotFound />} /></Route></Routes></StoreProvider></BrowserRouter></ErrorBoundary>;
}