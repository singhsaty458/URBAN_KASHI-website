import type { Address, CartItem, OnlineCheckout, PaymentConfig } from '../../shared/types';

export interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
interface RazorpayOptions {
  key: string; order_id: string; amount: number; currency: 'INR'; name: string;
  prefill: { name: string; email: string; contact: string };
  handler: (response: RazorpayResponse) => void;
  modal: { ondismiss: () => void };
  retry: { enabled: boolean };
}
interface RazorpayInstance {
  open: () => void;
  close: () => void;
  on: (event: 'payment.failed', callback: () => void) => void;
}
type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;
declare global { interface Window { Razorpay?: RazorpayConstructor } }

let scriptPromise: Promise<RazorpayConstructor> | null = null;

// No gateway network request until an explicit online checkout action and enabled API config.
export function loadRazorpay(config: PaymentConfig): Promise<RazorpayConstructor> {
  if (!config.online || !config.keyId || config.mode === 'disabled') return Promise.reject(new Error(config.reason || 'Online payment is not configured.'));
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    const cleanup = () => { window.clearTimeout(timer); script.onload = null; script.onerror = null; };
    const fail = () => { cleanup(); script.remove(); reject(new Error('Razorpay could not load. Check your connection or browser restrictions, then retry. No payment was confirmed.')); };
    const timer = window.setTimeout(fail, 15000);
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => { if (!window.Razorpay) { fail(); return; } cleanup(); resolve(window.Razorpay); };
    script.onerror = fail;
    document.head.appendChild(script);
  }).catch(error => { scriptPromise = null; throw error; });
  return scriptPromise;
}

export type GatewayOutcome = { kind: 'submitted'; response: RazorpayResponse } | { kind: 'dismissed' | 'failed' };
export function openRazorpay(Gateway: RazorpayConstructor, checkout: NonNullable<OnlineCheckout['checkout']>, prefill: RazorpayOptions['prefill']): Promise<GatewayOutcome> {
  if (!checkout.key || !checkout.order_id || checkout.currency !== 'INR' || !Number.isSafeInteger(checkout.amount) || checkout.amount <= 0) return Promise.reject(new Error('The server returned incomplete gateway details. Check the existing order status.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: GatewayOutcome) => { if (settled) return; settled = true; resolve(outcome); };
    try {
      const instance = new Gateway({
        // All money, merchant and gateway order fields come from the authenticated API.
        key: checkout.key, order_id: checkout.order_id, amount: checkout.amount,
        currency: checkout.currency, name: checkout.name, prefill,
        handler: response => finish({ kind: 'submitted', response }),
        modal: { ondismiss: () => finish({ kind: 'dismissed' }) },
        retry: { enabled: false },
      });
      instance.on('payment.failed', () => { finish({ kind: 'failed' }); instance.close(); });
      instance.open();
    } catch (error) { if (!settled) { settled = true; reject(error); } }
  });
}

export interface CheckoutAttempt { signature: string; key: string; orderId?: string }
const cachedAttempts = new Map<string, CheckoutAttempt[]>();
const storageKey = (userId: string) => `uk-checkout-attempt:${userId}`;
function attempts(userId: string): CheckoutAttempt[] {
  const cached = cachedAttempts.get(userId);
  if (cached) return cached;
  let list: CheckoutAttempt[] = [];
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey(userId)) || '[]');
    const entries: unknown[] = Array.isArray(saved) ? saved : [saved];
    list = entries.filter((value): value is CheckoutAttempt => {
      if (!value || typeof value !== 'object') return false;
      const item = value as Partial<CheckoutAttempt>;
      return typeof item.signature === 'string' && typeof item.key === 'string' && /^[0-9a-f-]{36}$/i.test(item.key) && (item.orderId === undefined || typeof item.orderId === 'string');
    });
  } catch { /* In-memory recovery is still available when storage is blocked. */ }
  cachedAttempts.set(userId, list);
  return list;
}
export function persistAttempt(userId: string, attempt: CheckoutAttempt): boolean {
  const list = attempts(userId);
  const next = [...list.filter(a => a.signature !== attempt.signature), { ...attempt }];
  cachedAttempts.set(userId, next);
  try { sessionStorage.setItem(storageKey(userId), JSON.stringify(next)); return true; } catch { return false; }
}
export function getAttempt(userId: string, signature: string): CheckoutAttempt {
  return attempts(userId).find(a => a.signature === signature) ?? { signature, key: crypto.randomUUID() };
}
export function pendingAttempts(userId: string): CheckoutAttempt[] {
  return attempts(userId).filter(a => a.orderId);
}
export function forgetOrderAttempt(userId: string, orderId: string) {
  const next = attempts(userId).filter(a => a.orderId !== orderId);
  cachedAttempts.set(userId, next);
  try { if (next.length) sessionStorage.setItem(storageKey(userId), JSON.stringify(next)); else sessionStorage.removeItem(storageKey(userId)); } catch { /* No gateway credentials are persisted. */ }
}
export function itemSignature(items: CartItem[]) {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return JSON.stringify(items.map(({ productId, size, quantity }) => ({ productId, size, quantity })).sort((a, b) => compare(a.productId, b.productId) || compare(a.size, b.size)));
}
export function checkoutSignature(userId: string, method: 'COD' | 'Razorpay', items: CartItem[], address: Address) {
  return JSON.stringify({ userId, method, items: JSON.parse(itemSignature(items)), address });
}