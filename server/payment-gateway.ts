import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PaymentConfig } from '../shared/types.js';
import { HttpError } from './errors.js';

export const paymentMethods = ['UPI', 'Cards', 'Netbanking', 'Wallets', 'EMI', 'Pay Later'];
export const disabledPaymentConfig: PaymentConfig = {
  online: false, keyId: null, mode: 'disabled', methods: [],
  reason: 'Online payments are not configured. Cash on delivery is available.',
};
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const gatewayOrderSchema = z.object({
  id, amount: z.number().int().positive(), currency: z.string(), receipt: z.string(),
  notes: z.object({ local_order_id: z.string() }), status: z.string(),
});
export const gatewayPaymentSchema = z.object({
  id, order_id: id, amount: z.number().int().positive(), currency: z.string(),
  status: z.string(), captured: z.boolean(),
  // Required provider fields: never strip refund evidence or default missing evidence to zero.
  refund_status: z.enum(['partial', 'full']).nullable(), amount_refunded: z.number().int().nonnegative(),
});
export const gatewayRefundSchema = z.object({
  id, payment_id: id, amount: z.number().int().positive(), currency: z.string(), status: z.string(),
});
const refundCollectionSchema = z.object({
  entity: z.literal('collection'), count: z.number().int().nonnegative(), items: z.array(gatewayRefundSchema),
});
export type GatewayOrder = z.infer<typeof gatewayOrderSchema>;
export type GatewayPayment = z.infer<typeof gatewayPaymentSchema>;
export type GatewayRefund = z.infer<typeof gatewayRefundSchema>;
export interface GatewayRefundCollection { items: GatewayRefund[]; complete: boolean }
export interface GatewayCreateOrder { amount: number; currency: 'INR'; receipt: string; notes: { local_order_id: string } }

/** Trusted server-side injection only. Tests inject a fake; requests can never select a provider. */
export interface PaymentGateway {
  config: PaymentConfig;
  createOrder(input: GatewayCreateOrder): Promise<GatewayOrder>;
  getOrder(id: string): Promise<GatewayOrder>;
  getPayment(id: string): Promise<GatewayPayment>;
  listPayments(orderId: string): Promise<GatewayPayment[]>;
  getRefund(id: string): Promise<GatewayRefund>;
  listRefunds(paymentId: string): Promise<GatewayRefundCollection>;
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  verifyWebhookSignature(body: Buffer, signature: string): boolean;
}

export function verifyHmac(secret: string, data: string | Buffer, signature: string): boolean {
  // JavaScript's $ also matches before a final newline; length must be exact before hex decoding.
  if (signature.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(data).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

/** No SDK globals, credentials in URLs, retries, provider error text, or logging. */
export class RazorpayGateway implements PaymentGateway {
  readonly config: PaymentConfig;
  constructor(private readonly credentials: { keyId: string; keySecret: string; webhookSecret: string }) {
    if (!/^rzp_(test|live)_[a-zA-Z0-9]+$/.test(credentials.keyId) || !credentials.keySecret.trim() || !credentials.webhookSecret.trim()) {
      throw new Error('Complete Razorpay credentials are required.');
    }
    this.config = { online: true, keyId: credentials.keyId, mode: credentials.keyId.startsWith('rzp_live_') ? 'live' : 'test',
      methods: [...paymentMethods], reason: 'Methods are subject to Razorpay merchant eligibility and availability. Payment is confirmed only after capture.' };
  }
  private async call(path: string, body?: GatewayCreateOrder): Promise<unknown> {
    try {
      const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(10_000), redirect: 'error',
        headers: { Authorization: `Basic ${Buffer.from(`${this.credentials.keyId}:${this.credentials.keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error('Gateway response failed');
      return await response.json();
    } catch { throw new HttpError(502, 'Payment provider could not confirm the result. Do not pay again; reconcile or contact support.'); }
  }
  private async parsed<T>(schema: z.ZodType<T>, path: string, body?: GatewayCreateOrder): Promise<T> {
    const result = schema.safeParse(await this.call(path, body));
    if (!result.success) throw new HttpError(502, 'Payment provider returned an unconfirmed result. Contact support.');
    return result.data;
  }
  createOrder(input: GatewayCreateOrder) { return this.parsed(gatewayOrderSchema, 'orders', input); }
  getOrder(value: string) { return this.parsed(gatewayOrderSchema, `orders/${encodeURIComponent(id.parse(value))}`); }
  getPayment(value: string) { return this.parsed(gatewayPaymentSchema, `payments/${encodeURIComponent(id.parse(value))}`); }
  async listPayments(value: string) {
    // The order-payments endpoint documents all attempts, not a paginated payment search.
    const collection = await this.parsed(z.object({ entity: z.literal('collection'), count: z.number().int().nonnegative(),
      items: z.array(gatewayPaymentSchema) }), `orders/${encodeURIComponent(id.parse(value))}/payments`);
    if (collection.count !== collection.items.length) throw new HttpError(502, 'Payment provider returned an incomplete payment collection.');
    return collection.items;
  }
  getRefund(value: string) { return this.parsed(gatewayRefundSchema, `refunds/${encodeURIComponent(id.parse(value))}`); }
  async listRefunds(value: string): Promise<GatewayRefundCollection> {
    const paymentId = id.parse(value);
    const items: GatewayRefund[] = [];
    const seen = new Set<string>();
    // https://razorpay.com/docs/api/refunds/fetch-multiple-refund-payment/
    // Razorpay collections use count/skip; response count is the page size, NOT a total.
    // Never stop merely because processed amounts already add up to the payment.
    const pageSize = 100;
    for (let page = 0; page < 10; page++) {
      const result = await this.parsed(refundCollectionSchema,
        `payments/${encodeURIComponent(paymentId)}/refunds?count=${pageSize}&skip=${page * pageSize}`);
      if (result.count !== result.items.length || result.items.length > pageSize) return { items, complete: false };
      for (const refund of result.items) {
        if (refund.payment_id !== paymentId || seen.has(refund.id)) return { items, complete: false };
        seen.add(refund.id);
        items.push(refund);
      }
      if (result.items.length < pageSize) return { items, complete: true };
    }
    // Bounded work: an unexhausted, repeated or inconsistent collection must stay in review.
    return { items, complete: false };
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return verifyHmac(this.credentials.keySecret, `${orderId}|${paymentId}`, signature);
  }
  verifyWebhookSignature(body: Buffer, signature: string) { return verifyHmac(this.credentials.webhookSecret, body, signature); }
}

/** All three environment values are mandatory. No dotenv/files or credential discovery. */
export function gatewayFromEnvironment(env: NodeJS.ProcessEnv = process.env): PaymentGateway | null {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!keyId || !keySecret?.trim() || !webhookSecret?.trim() || !/^rzp_(test|live)_[a-zA-Z0-9]+$/.test(keyId)) return null;
  return new RazorpayGateway({ keyId, keySecret, webhookSecret });
}