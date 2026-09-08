import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import request from 'supertest';
import type { Address, PaymentConfig } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { openDatabase, listProducts, type StoreDatabase } from '../server/db.js';
import { hashToken, SESSION_COOKIE } from '../server/auth.js';
import { paymentMethods, verifyHmac, type GatewayCreateOrder, type GatewayOrder, type GatewayPayment, type GatewayRefund, type PaymentGateway } from '../server/payment-gateway.js';

export const xhr = { 'X-Requested-With': 'UrbanKashi' };
export const testAddress: Address = { name: 'Test Customer', phone: '9876543210', line1: '42 Test Road', city: 'Varanasi', state: 'Uttar Pradesh', pincode: '221005' };
// Dummy secrets belong solely to this in-memory fake. No test loads process payment credentials.
const paymentSecret = 'dummy-test-payment-secret';
const webhookSecret = 'dummy-test-webhook-secret';
export const paymentSignature = (orderId: string, paymentId: string) => createHmac('sha256', paymentSecret).update(`${orderId}|${paymentId}`).digest('hex');
export const webhookSignature = (body: string) => createHmac('sha256', webhookSecret).update(body).digest('hex');

export class FakeGateway implements PaymentGateway {
  config: PaymentConfig = { online: true, keyId: 'rzp_test_DUMMY', mode: 'test', reason: 'Injected test fixture only; merchant eligibility applies.', methods: [...paymentMethods] };
  orders = new Map<string, GatewayOrder>();
  payments = new Map<string, GatewayPayment>();
  refunds = new Map<string, GatewayRefund>();
  createCalls = 0;
  paymentReads = 0;
  failCreate = false;
  createGate: Promise<void> | undefined;
  async createOrder(input: GatewayCreateOrder): Promise<GatewayOrder> {
    this.createCalls++;
    const order: GatewayOrder = { id: `order_test_${this.createCalls}`, ...input, status: 'created' };
    this.orders.set(order.id, order);
    if (this.createGate) await this.createGate;
    if (this.failCreate) throw new Error('Simulated unknown provider outcome');
    return structuredClone(order);
  }
  async getOrder(id: string) { const row = this.orders.get(id); if (!row) throw new Error('Fixture order missing'); return structuredClone(row); }
  async getPayment(id: string) { this.paymentReads++; const row = this.payments.get(id); if (!row) throw new Error('Fixture payment missing'); return structuredClone(row); }
  async listPayments(id: string) { return [...this.payments.values()].filter((payment) => payment.order_id === id).map((payment) => structuredClone(payment)); }
  async getRefund(id: string) { const row = this.refunds.get(id); if (!row) throw new Error('Fixture refund missing'); return structuredClone(row); }
  async listRefunds(id: string) {
    return { items: [...this.refunds.values()].filter((refund) => refund.payment_id === id).map((refund) => structuredClone(refund)), complete: true };
  }
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) { return verifyHmac(paymentSecret, `${orderId}|${paymentId}`, signature); }
  verifyWebhookSignature(body: Buffer, signature: string) { return verifyHmac(webhookSecret, body, signature); }
  capture(orderId: string, patch: Partial<GatewayPayment> = {}) {
    const order = this.orders.get(orderId)!;
    order.status = 'paid';
    const payment: GatewayPayment = { id: `pay_test_${this.payments.size + 1}`, order_id: orderId, amount: order.amount,
      currency: 'INR', status: 'captured', captured: true, refund_status: null, amount_refunded: 0, ...patch };
    this.payments.set(payment.id, payment);
    return payment;
  }
  refund(paymentId: string, amount = this.payments.get(paymentId)!.amount) {
    const payment = this.payments.get(paymentId)!;
    const refund: GatewayRefund = { id: `rfnd_test_${this.refunds.size + 1}`, payment_id: paymentId,
      amount, currency: payment.currency, status: 'processed' };
    this.refunds.set(refund.id, refund);
    payment.amount_refunded += amount;
    payment.refund_status = payment.amount_refunded === payment.amount ? 'full' : 'partial';
    if (payment.refund_status === 'full') payment.status = 'refunded';
    // In particular, an authorization auto-refund does not invent a capture.
    return refund;
  }
}

export function fixture(gateway: PaymentGateway | null = null) {
  const db = openDatabase(':memory:');
  const app = createApp({ db, distPath: false, rateLimit: false, paymentGateway: gateway, disableMaintenance: true });
  const actor = (id: string, role: 'customer' | 'admin') => {
    db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, 'Fixture User', `${id}@example.test`, 'unused-test-hash', role, new Date().toISOString());
    return request.agent(app).set('Cookie', sessionCookie(db, id));
  };
  const customer = actor('fixture-customer', 'customer');
  const other = actor('fixture-other', 'customer');
  const admin = actor('fixture-admin', 'admin');
  const products = listProducts(db);
  const payload = (idempotencyKey = randomUUID()) => ({ items: [{ productId: products[0]!.id, size: 'M', quantity: 1 }], address: { ...testAddress }, idempotencyKey });
  const stock = (productId = products[0]!.id, size = 'M') => (db.prepare('SELECT stock FROM variants WHERE product_id = ? AND size = ?').get(productId, size) as { stock: number } | undefined)?.stock ?? 0;
  return { db, app, customer, other, admin, products, payload, stock };
}
export function sessionCookie(db: StoreDatabase, userId: string) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(hashToken(token), userId, Date.now() + 60_000);
  return `${SESSION_COOKIE}=${token}`;
}