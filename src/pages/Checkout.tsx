import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Check, Package } from 'lucide-react';
import type { Address, OnlineCheckout, Order, PaymentConfig } from '../../shared/types';
import { CART_LIMIT_MESSAGE, CART_MAX_LINES, CART_MAX_QUANTITY, useStore } from '../context/Store';
import { api, message, money, useResource, useTitle } from '../lib/api';
import { Empty, ErrorState, Image, Loading } from '../components/UI';
import { AuthGate } from '../components/AuthGate';
import { CatalogueLabels, PaymentNotice, paymentLabel } from '../components/CatalogueLabels';
import { checkoutSignature, forgetOrderAttempt, getAttempt, itemSignature, loadRazorpay, openRazorpay, pendingAttempts, persistAttempt } from '../lib/payments';

const cleanAddress = (address: Address): Address => ({ name: address.name.trim(), phone: address.phone.replace(/\s/g, ''), line1: address.line1.trim(), city: address.city.trim(), state: address.state.trim(), pincode: address.pincode.trim() });

export function Checkout() { useTitle('Checkout'); return <AuthGate><CheckoutForm /></AuthGate>; }

function CheckoutForm() {
  const { user, cart, products, productsLoading, productsError, refreshProducts, clearCart, setBagOpen, toast } = useStore();
  const [address, setAddress] = useState<Address>({ name: user?.name ?? '', phone: '', line1: '', city: '', state: '', pincode: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Partial<Record<keyof Address, string>>>({});
  const [method, setMethod] = useState<'COD' | 'Razorpay'>('COD');
  const [separateOrderConfirmed, setSeparateOrderConfirmed] = useState(false);
  const recovery = user ? pendingAttempts(user.id) : [];
  const config = useResource<PaymentConfig>('/payments/config');
  const onlineEnabled = Boolean(config.data?.online && config.data.keyId && config.data.mode !== 'disabled' && !config.loading && !config.error);
  const [progress, setProgress] = useState('');
  const latestCart = useRef(cart);
  latestCart.current = cart;
  const submitting = useRef(false);
  const navigate = useNavigate();
  const subtotal = cart.reduce((sum, item) => sum + (products.find(p => p.id === item.productId)?.price ?? 0) * item.quantity, 0);
  const shipping = subtotal >= 2499 ? 0 : 99;
  const overLimit = cart.length > CART_MAX_LINES || cart.some(item => item.quantity > CART_MAX_QUANTITY);
  const invalid = overLimit || cart.some(item => { const p = products.find(p => p.id === item.productId); return !p || !p.active || (p.variants.find(v => v.size === item.size)?.stock ?? 0) < item.quantity; });
  const cartError = overLimit ? CART_LIMIT_MESSAGE : 'Some items are unavailable in your selected quantity. Edit your bag to continue.';
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitting.current) return; setError('');
    const cleaned = cleanAddress(address);
    const validation: Partial<Record<keyof Address, string>> = {};
    if (cleaned.name.length < 2) validation.name = 'Enter the recipient’s full name.';
    if (!/^[6-9]\d{9}$/.test(cleaned.phone)) validation.phone = 'Enter a valid 10-digit Indian mobile number.';
    if (cleaned.line1.length < 5) validation.line1 = 'Enter a complete street address, including house number.';
    if (cleaned.city.length < 2) validation.city = 'Enter your city.';
    if (cleaned.state.length < 2) validation.state = 'Enter your state or union territory.';
    if (!/^[1-9]\d{5}$/.test(cleaned.pincode)) validation.pincode = 'Enter a valid 6-digit Indian PIN code.';
    setErrors(validation);
    if (Object.keys(validation).length) { document.getElementById(`address-${Object.keys(validation)[0]}`)?.focus(); return; }
    if (!cart.length || !user) { setError('Please update your bag and sign in before placing an order.'); return; }
    const signature = checkoutSignature(user.id, method, cart, cleaned);
    const attempt = getAttempt(user.id, signature);
    if (attempt.orderId) { navigate(`/order/${encodeURIComponent(attempt.orderId)}`); return; }
    if (recovery.length && !separateOrderConfirmed) { setError('Check the existing order first, or explicitly confirm that you want a separate order.'); return; }
    if (invalid) { setError(cartError); return; }
    if (method === 'Razorpay' && !onlineEnabled) { setError('Online payment is unavailable. Choose COD or refresh payment options.'); return; }
    submitting.current = true; setBusy(true);
    let reservedOrder: Order | null = null;
    const goPending = (order: Order, notice: string) => {
      void refreshProducts();
      navigate(`/order/${encodeURIComponent(order.id)}`, { replace: true, state: { paymentNotice: notice } });
    };
    const complete = (order: Order) => {
      forgetOrderAttempt(user.id, order.id);
      if (itemSignature(latestCart.current) === itemSignature(cart)) clearCart();
      toast(method === 'COD' ? 'Your cash-on-delivery order has been placed.' : 'Payment verified by the server. Your order is recorded.');
      void refreshProducts(); navigate(`/order/${encodeURIComponent(order.id)}`, { replace: true });
    };
    try {
      // Persist the exact attempt before sending. Changing method cannot reuse a COD key online.
      if (!persistAttempt(user.id, attempt)) toast('Keep this page open if you need to retry; this browser cannot save checkout recovery data.');
      const body = JSON.stringify({ items: JSON.parse(itemSignature(cart)), address: cleaned, idempotencyKey: attempt.key });
      if (method === 'COD') {
        setProgress('Placing your order…');
        const result = await api<{ order: Order }>('/orders', { method: 'POST', body, signal: AbortSignal.timeout(30000) });
        persistAttempt(user.id, { ...attempt, orderId: result.order.id });
        complete(result.order); return;
      }
      setProgress('Loading secure payment checkout…');
      const currentConfig = await api<PaymentConfig>('/payments/config', { signal: AbortSignal.timeout(15000) });
      if (currentConfig.mode !== config.data?.mode) { config.retry(); throw new Error('Payment mode changed. Review the refreshed options before trying again.'); }
      const Gateway = await loadRazorpay(currentConfig);
      setProgress('Reserving your order…');
      const result = await api<OnlineCheckout>('/payments/create', { method: 'POST', body, signal: AbortSignal.timeout(30000) });
      reservedOrder = result.order;
      persistAttempt(user.id, { ...attempt, orderId: result.order.id });
      if (result.order.paymentStatus === 'paid' && !result.order.paymentReview) { complete(result.order); return; }
      if (!result.checkout || result.order.status === 'cancelled' || result.order.paymentStatus === 'refund_required' || result.order.paymentStatus === 'refunded') {
        goPending(result.order, 'The server did not offer a new payment checkout. Review the existing order and payment status below.'); return;
      }
      setProgress('Complete payment in Razorpay or close it to view your pending order.');
      const outcome = await openRazorpay(Gateway, result.checkout, { name: cleaned.name, email: user.email, contact: cleaned.phone });
      if (outcome.kind !== 'submitted') {
        goPending(result.order, outcome.kind === 'failed' ? 'The payment attempt failed. Payment is not confirmed; your reserved order is in your account. Check status before trying another order.' : 'Payment checkout was closed. Payment is not confirmed; your bag is kept and this order is already recorded.'); return;
      }
      setProgress('Verifying payment with the store server…');
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = outcome.response;
      const verified = await api<{ order: Order }>('/payments/verify', { method: 'POST', body: JSON.stringify({ orderId: result.order.id, razorpay_order_id, razorpay_payment_id, razorpay_signature }), signal: AbortSignal.timeout(30000) });
      if (verified.order.id !== result.order.id) throw new Error('Payment verification returned a different order. Contact the store.');
      if (verified.order.paymentStatus === 'paid' && !verified.order.paymentReview) complete(verified.order);
      else goPending(verified.order, 'Payment has not been confirmed as paid by the server. Use Check payment status; do not pay again yet.');
    } catch (error) {
      if (reservedOrder) goPending(reservedOrder, `${message(error)} Payment is not confirmed here. Check this existing order before paying again.`);
      else setError(`${message(error)} If the connection was interrupted, retry without changing method or details, or check your account for an existing order.`);
    }
    finally { submitting.current = false; setBusy(false); setProgress(''); }
  }
  if (productsLoading) return <div className="page-shell"><Loading label="Checking your bag…" /></div>;
  if (productsError) return <div className="page-shell"><ErrorState error={productsError} retry={refreshProducts} /></div>;
  if (!cart.length) return <div className="page-shell"><Empty title="Your bag is a blank canvas." text="Choose a piece before continuing to checkout." /></div>;
  const fields: { key: keyof Address; label: string; complete: string; placeholder: string; max: number }[] = [
    { key: 'name', label: 'Full name', complete: 'shipping name', placeholder: 'Recipient’s name', max: 100 },
    { key: 'phone', label: 'Mobile number', complete: 'shipping tel-national', placeholder: '10-digit Indian mobile number', max: 15 },
    { key: 'line1', label: 'Street address', complete: 'shipping address-line1', placeholder: 'House / flat, street, neighbourhood', max: 250 },
    { key: 'city', label: 'City', complete: 'shipping address-level2', placeholder: 'City', max: 100 },
    { key: 'state', label: 'State / union territory', complete: 'shipping address-level1', placeholder: 'State', max: 100 },
    { key: 'pincode', label: 'PIN code', complete: 'shipping postal-code', placeholder: '6-digit PIN code', max: 6 },
  ];
  return <div className="page-shell checkout-page">
    <div className="breadcrumb"><Link to="/shop">Collection</Link><span>/</span>Checkout</div><div className="page-heading"><p className="eyebrow">A FEW DETAILS. THEN IT’S YOURS.</p><h1>The final <em>touch.</em></h1><p>Signed in as {user?.email}. <Link to="/account">Manage account</Link></p></div>
    {recovery.length > 0 && <div className="notice-panel payment-recovery"><strong>Existing checkout / पहले ऑर्डर की स्थिति देखें</strong><p>Your bag may already be reserved by these orders. Check their status before creating another order, even if you change payment method. Your bag is kept until payment is verified.</p>{recovery.map(a => <Link key={a.key} className="text-link" to={`/order/${encodeURIComponent(a.orderId!)}`}>Check existing order {a.orderId?.slice(0, 8)}<ArrowRight size={16} /></Link>)}<label className="checkbox-label"><input type="checkbox" checked={separateOrderConfirmed} disabled={busy} onChange={e => setSeparateOrderConfirmed(e.target.checked)} />I checked the existing orders and intentionally want a separate order. An unchanged attempt still opens its existing order.</label></div>}
    <form className="checkout-grid" onSubmit={submit} noValidate aria-busy={busy}><div>
      <section className="checkout-section"><h2><span>01</span>Where should it go?</h2><p className="notice-panel small">Demo checkout: avoid real personal information. Orders are stored by this demo; fulfilment is not guaranteed.</p><fieldset disabled={busy} className="address-fields">{fields.map(field => <label key={field.key} className={field.key === 'line1' ? 'span-two' : ''} htmlFor={`address-${field.key}`}>{field.label}<input id={`address-${field.key}`} autoComplete={field.complete} value={address[field.key]} onChange={e => { setAddress({ ...address, [field.key]: e.target.value }); setErrors({ ...errors, [field.key]: undefined }); }} required maxLength={field.max} placeholder={field.placeholder} type={field.key === 'phone' ? 'tel' : 'text'} inputMode={field.key === 'phone' || field.key === 'pincode' ? 'numeric' : undefined} aria-invalid={Boolean(errors[field.key])} aria-describedby={errors[field.key] ? `error-${field.key}` : undefined} />{errors[field.key] && <span className="field-error" id={`error-${field.key}`}>{errors[field.key]}</span>}</label>)}</fieldset></section>
      <section className="checkout-section"><h2><span>02</span>Choose how to pay.</h2>
        <fieldset className="payment-choices" disabled={busy}><legend>Payment method / भुगतान विकल्प</legend>
          <label className="payment-choice"><input type="radio" name="payment-method" value="COD" checked={method === 'COD'} onChange={() => setMethod('COD')} /><span><strong>Cash on delivery</strong><span className="small">Pay when your order arrives.</span></span></label>
          <label className={`payment-choice ${!onlineEnabled ? 'payment-disabled' : ''}`}><input type="radio" name="payment-method" value="Razorpay" checked={method === 'Razorpay'} disabled={!onlineEnabled} onChange={() => setMethod('Razorpay')} aria-describedby="online-payment-info" /><span><strong>Online · Razorpay</strong><span className="small">UPI, cards, netbanking, wallets, EMI / pay later — subject to provider and merchant eligibility, not guaranteed.</span></span></label>
        </fieldset>
        <div id="online-payment-info" className="small" aria-live="polite">
          {config.loading ? <p>Checking online payment availability… COD remains available.</p> : !onlineEnabled ? <p>Online unavailable: {config.error || config.data?.reason || 'The store has not configured online payment keys.'}</p> : <p>{config.data?.reason || 'Secure checkout is available.'} {config.data?.methods.length ? `Provider-configured methods: ${config.data.methods.join(', ')}. Actual options depend on eligibility.` : 'Available methods appear in Razorpay.'}</p>}
          {config.data?.mode === 'test' && <p className="payment-test"><strong>TEST MODE / परीक्षण मोड</strong> — Test transactions only; not a real paid purchase.</p>}
          {onlineEnabled && config.data?.mode === 'live' && <p><strong>LIVE MODE</strong> — Continuing can collect a real payment through Razorpay.</p>}
        </div>
        <button type="button" className="text-button" disabled={busy || config.loading} onClick={config.retry}>Refresh payment options</button>
        <p className="small muted">Only choosing online payment and continuing loads Razorpay. By continuing online, you agree to share the recipient name, phone and your account email with the gateway for checkout prefill. Enter card / UPI credentials only in Razorpay, never in this local form. Live gateway operation has not been verified with real keys.</p>
      </section>
    </div><aside className="checkout-summary"><h2>Your considered selection</h2>
      {cart.map(item => { const product = products.find(p => p.id === item.productId); const variant = product?.variants.find(v => v.size === item.size); return <div className="checkout-item" key={JSON.stringify([item.productId, item.size])}><Image src={product?.image} alt={product?.name || 'Unavailable item'} loading="lazy" /><div><strong>{product?.name || 'Unavailable item'}</strong><p>Size {item.size} · Qty {item.quantity}</p><CatalogueLabels item={{ brand: product?.brand, design: product?.design, color: product?.color, barcode: variant?.barcode, sku: variant?.sku }} /></div><span>{money((product?.price ?? 0) * item.quantity)}</span></div>; })}
      <button type="button" className="text-button" disabled={busy} onClick={() => setBagOpen(true)}>Edit your bag</button><div className="summary-totals"><div className="summary-line"><span>Subtotal</span><span>{money(subtotal)}</span></div><div className="summary-line"><span>Shipping</span><span>{shipping === 0 ? 'Complimentary' : money(shipping)}</span></div><div className="summary-line total"><strong>Total</strong><strong>{money(subtotal + shipping)}</strong></div></div>
      <p className="small muted">Prices, immutable item labels and stock are saved by the server when your order is created. Online checkout reserves an order before payment is verified.</p>
      {invalid && <ErrorState error={cartError} />}{error && <ErrorState error={error} />}{(error || recovery.length > 0) && <Link className="text-link" to="/account">Check account for an existing order<ArrowRight size={16} /></Link>}
      {busy && <p role="status">{progress}</p>}
      <button className="button full" disabled={busy || invalid || (recovery.length > 0 && !separateOrderConfirmed) || (method === 'Razorpay' && !onlineEnabled)}>{busy ? 'Please wait…' : method === 'COD' ? 'Place COD order' : config.data?.mode === 'test' ? 'Continue to TEST payment' : 'Continue to online payment'}<ArrowRight size={17} /></button>
      <p className="small muted">Review the <Link to="/shipping">shipping & returns draft</Link> and <Link to="/privacy">privacy draft</Link> before ordering. An order record is not proof of payment.</p>
    </aside></form>
  </div>;
}

export function OrderPage() { useTitle('Your order'); const { id } = useParams(); return <AuthGate><OrderDetail key={id} /></AuthGate>; }
function OrderDetail() {
  const { id } = useParams();
  const location = useLocation();
  const { user, cart, clearCart, refreshProducts } = useStore();
  const { data, loading, error, retry } = useResource<{ order: Order }>(`/orders/${encodeURIComponent(id || '')}`);
  const [reconciled, setReconciled] = useState<Order | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [checkResult, setCheckResult] = useState('');
  const locked = useRef(false);
  const latestCart = useRef(cart);
  latestCart.current = cart;
  async function reconcile() {
    if (locked.current || !id || !user) return;
    locked.current = true; setChecking(true); setCheckError(''); setCheckResult('');
    try {
      const result = await api<{ order: Order }>(`/payments/reconcile/${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(30000) });
      if (result.order.id !== id) throw new Error('The server returned a different order. Contact the store.');
      setReconciled(result.order);
      setCheckResult(result.order.paymentStatus === 'paid' && !result.order.paymentReview ? 'Payment verified by the server.' : 'Status refreshed from the server. Review the payment state below; do not pay again while it is pending or held for review.');
      if (result.order.paymentStatus === 'paid' && !result.order.paymentReview) {
        // Clear only the unchanged bag belonging to this stored checkout, never a newer bag.
        const saved = pendingAttempts(user.id).find(a => a.orderId === id);
        if (saved) {
          try { const original = JSON.parse(saved.signature); if (original.userId === user.id && Array.isArray(original.items) && itemSignature(original.items) === itemSignature(latestCart.current)) clearCart(); } catch { /* Keep the bag if its provenance cannot be verified. */ }
        }
        forgetOrderAttempt(user.id, id);
      }
      void refreshProducts();
    } catch (error) { setCheckError(message(error)); }
    finally { locked.current = false; setChecking(false); }
  }
  if (loading) return <div className="page-shell"><Loading label="Retrieving your order…" /></div>;
  if (error) return <div className="page-shell"><ErrorState error={error} retry={retry} /><Link to="/account" className="text-link">Return to your orders<ArrowRight size={16} /></Link></div>;
  if (!data) return null;
  const order = reconciled && reconciled.id === id ? reconciled : data.order;
  const pending = order.paymentMethod === 'Razorpay' && (!order.paymentStatus || order.paymentStatus === 'pending' || order.paymentStatus === 'unpaid');
  const notice = typeof location.state?.paymentNotice === 'string' ? location.state.paymentNotice : '';
  return <div className="page-shell order-page"><div className="order-confirmation"><span className="confirmation-icon">{order.status === 'cancelled' || pending || order.paymentReview ? <Package size={29} /> : <Check size={29} />}</span><p className="eyebrow">YOUR URBAN KASHI ORDER</p><h1>{order.status === 'cancelled' ? <>Order <em>cancelled.</em></> : order.paymentReview ? <>Payment <em>review.</em></> : pending ? <>Payment <em>pending.</em></> : <>Your order, <em>recorded.</em></>}</h1>
    <PaymentNotice order={order} />
    <span className={`status status-${order.status}`}>{order.status}</span><p className="order-reference">Order {order.id}<br />{new Date(order.createdAt).toLocaleString('en-IN')}</p>
    {notice && pending && <p className="notice-panel small" role="status">{notice}</p>}
    {order.paymentMethod === 'Razorpay' && <section className="payment-recovery paper-panel" aria-label="Payment recovery">
      <button type="button" className="button outline-button" disabled={checking} onClick={reconcile}>{checking ? 'Checking payment…' : 'Check payment status'}</button>
      {pending && <p className="small">{order.status === 'cancelled' ? 'This order is cancelled. Check for any late payment before placing another order.' : 'Your order is already reserved and available in your account. Check status before creating another order.'} Resuming payment from this page is not currently supported; contact the store with this order ID if it remains unresolved. Verified support details must be published before live trading.</p>}
      {checking && <p role="status">Contacting the store server…</p>}{checkError && <ErrorState error={checkError} />}{checkResult && <p role="status">{checkResult}</p>}
    </section>}
  </div><div className="order-details-grid"><section className="paper-panel"><h2>The pieces</h2><p className="small muted">Item details recorded with this order; later catalogue edits do not change these labels.</p>{order.items.map((item, index) => <div className="checkout-item" key={index}><Image src={item.image} alt={item.name} loading="lazy" /><div><strong>{item.name}</strong><p>Size {item.size} · Qty {item.quantity}</p><CatalogueLabels item={item} /></div><span>{money(item.price * item.quantity)}</span></div>)}<div className="summary-line"><span>Subtotal</span><span>{money(order.subtotal)}</span></div><div className="summary-line"><span>Shipping</span><span>{order.shipping ? money(order.shipping) : 'Complimentary'}</span></div><div className="summary-line total"><strong>Total · {paymentLabel(order)}</strong><strong>{money(order.total)}</strong></div></section><section className="paper-panel"><h2>Delivery details</h2><address><strong>{order.address.name}</strong><br />{order.address.line1}<br />{order.address.city}, {order.address.state}<br />{order.address.pincode}<br />{order.address.phone}</address><p className="notice-panel small">Demo order. Dispatch dates, tracking and fulfilment are not configured. This page shows the current server-recorded status.</p><Link className="text-link" to="/account">All your orders<ArrowRight size={16} /></Link></section></div><Link className="button" to="/shop">Keep exploring<ArrowRight size={17} /></Link></div>;
}