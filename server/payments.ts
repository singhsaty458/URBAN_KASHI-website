import express, { type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OnlineCheckout, Order, User } from '../shared/types.js';
import { getOrder, transaction, type OrderRow, type StoreDatabase } from './db.js';
import { HttpError } from './errors.js';
import { reserveOrder } from './orders.js';
import { checkoutSchema } from './validation.js';
import { disabledPaymentConfig, type GatewayOrder, type GatewayPayment, type GatewayRefund, type GatewayRefundCollection, type PaymentGateway } from './payment-gateway.js';

const providerId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const verification = z.object({ orderId: z.string().uuid(), razorpay_order_id: providerId,
  razorpay_payment_id: providerId, razorpay_signature: z.string().max(256) }).strict();
const entity = z.object({ entity: z.object({ id: providerId }) });
const eventSchema = z.object({ event: z.string(), payload: z.object({
  payment: entity.optional(), order: entity.optional(), refund: entity.optional(),
}) });
type RefundEvidence = GatewayRefundCollection & { expected?: GatewayRefund };
const hasRefund = (payment: GatewayPayment) => payment.status === 'refunded'
  || payment.refund_status !== null || payment.amount_refunded !== 0;
const refundReview = 'Refund evidence is partial, incomplete or inconsistent. Fulfilment is on hold; reconcile or contact support for provider review.';
const paymentIdentityReview = 'Multiple or conflicting provider payments require manual provider review. Fulfilment is on hold.';

export class PaymentService {
  constructor(private readonly db: StoreDatabase, private readonly gateway: PaymentGateway | null) {}
  private enabled(): PaymentGateway {
    if (!this.gateway?.config.online) throw new HttpError(503, 'Online payments are disabled. Use cash on delivery.');
    return this.gateway;
  }
  private row(id: string): OrderRow {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    if (!row || row.paymentMethod !== 'Razorpay') throw new HttpError(404, 'Online order not found.');
    return row;
  }
  private own(id: string, user: User, adminAllowed = false): OrderRow {
    const row = this.row(id);
    if (row.userId !== user.id && !(adminAllowed && user.role === 'admin')) throw new HttpError(404, 'Order not found.');
    return row;
  }
  private validateOrder(local: OrderRow, remote: GatewayOrder, allowBind = false): void {
    if (!remote.id || remote.amount !== local.total * 100 || remote.currency !== 'INR'
      || remote.receipt !== local.id || remote.notes?.local_order_id !== local.id
      || (local.gateway_order_id ? remote.id !== local.gateway_order_id : !allowBind)) {
      throw new HttpError(409, 'Payment provider order does not match this order.');
    }
    if (!local.gateway_order_id && !['creating', 'pending_review'].includes(local.gateway_state)) {
      throw new HttpError(409, 'Payment order has not been submitted to the provider.');
    }
  }
  private validatePayment(local: OrderRow, remote: GatewayOrder, payment: GatewayPayment): void {
    if (!payment.id || payment.order_id !== remote.id || payment.amount !== local.total * 100 || payment.currency !== 'INR') {
      throw new HttpError(409, 'Payment amount, currency or order does not match.');
    }
  }
  /** All provider I/O finishes before the synchronous transaction reads the current local row. */
  private async refundEvidence(payments: GatewayPayment[], expected?: GatewayRefund): Promise<Map<string, RefundEvidence>> {
    const gateway = this.enabled();
    const evidence = new Map<string, RefundEvidence>();
    await Promise.all(payments.map(async (payment) => {
      if (!payment.captured && !hasRefund(payment) && expected?.payment_id !== payment.id) return;
      try {
        evidence.set(payment.id, { ...await gateway.listRefunds(payment.id),
          ...(expected?.payment_id === payment.id ? { expected } : {}) });
      } catch {
        // A refund read failure must persist a hold, not leave a previously paid order shippable.
        evidence.set(payment.id, { items: [], complete: false });
      }
    }));
    return evidence;
  }
  private refundState(local: OrderRow, payment: GatewayPayment, evidence?: RefundEvidence): 'none' | 'full' | 'review' {
    if (!evidence?.complete) return 'review';
    const seen = new Set<string>();
    let processed = 0;
    for (const refund of evidence.items) {
      if (!providerId.safeParse(refund.id).success || seen.has(refund.id) || refund.payment_id !== payment.id
        || refund.currency !== 'INR' || !Number.isSafeInteger(refund.amount) || refund.amount <= 0
        || !['processed', 'failed'].includes(refund.status)) return 'review';
      seen.add(refund.id);
      if (refund.status === 'processed') processed += refund.amount;
    }
    if (!Number.isSafeInteger(processed)) return 'review';
    if (evidence.expected) {
      const expected = evidence.expected;
      const listed = evidence.items.find((refund) => refund.id === expected.id);
      if (!listed || listed.payment_id !== expected.payment_id || listed.amount !== expected.amount
        || listed.currency !== expected.currency || listed.status !== expected.status) return 'review';
    }
    // Official payment/refund entities both carry currency and amounts in subunits:
    // https://razorpay.com/docs/api/payments/entity/ and https://razorpay.com/docs/api/refunds/entity/
    // A terminal payment flag alone is insufficient: exhaust the collection and cross-check processed totals.
    if (payment.status === 'refunded' && payment.refund_status === 'full'
      && payment.amount_refunded === local.total * 100 && processed === local.total * 100) return 'full';
    if (hasRefund(payment) || processed !== 0 || evidence.expected) return 'review';
    return 'none';
  }
  /** Caller holds the transaction. Neither capture nor refund changes inventory or revives cancellation. */
  private applyConfirmation(id: string, remote: GatewayOrder, payments: GatewayPayment[], refunds: Map<string, RefundEvidence>, allowBind = false): void {
    const local = this.row(id);
    this.validateOrder(local, remote, allowBind);
    for (const payment of payments) this.validatePayment(local, remote, payment);
    if (!local.gateway_order_id) {
      if (this.db.prepare('SELECT id FROM orders WHERE gateway_order_id = ? AND id != ?').get(remote.id, id)) throw new HttpError(409, 'Provider order is already bound.');
      // Resolves only the initial unbound creation outcome; refund holds are always on a bound order.
      this.db.prepare("UPDATE orders SET gateway_order_id = ?, gateway_state = 'ready', payment_review = NULL WHERE id = ?").run(remote.id, id);
    }
    // Reordered/stale in-flight API reads cannot undo a verified full refund, or invent paid_at later.
    if (local.payment_status === 'refunded') return;
    const hold = (paymentId: string | null = null, reason = refundReview) => this.db.prepare(`UPDATE orders
      SET payment_review = ?, gateway_payment_id = COALESCE(gateway_payment_id, ?) WHERE id = ?`).run(reason, paymentId, id);
    const candidates = payments.filter((payment) => payment.captured || hasRefund(payment) || refunds.has(payment.id));
    if (candidates.length > 1) { hold(null, paymentIdentityReview); return; }
    const payment = candidates[0];
    if (!payment) return; // Ordinary authorized/failed attempts never clear an existing hold.
    if (local.gateway_payment_id && local.gateway_payment_id !== payment.id) { hold(null, paymentIdentityReview); return; }
    if (this.db.prepare('SELECT id FROM orders WHERE gateway_payment_id = ? AND id != ?').get(payment.id, id)) throw new HttpError(409, 'Payment is already assigned to another order.');
    // A single payment's refund cannot resolve an order known to have conflicting payment identities.
    if (local.payment_review === paymentIdentityReview) return;
    const refund = this.refundState(local, payment, refunds.get(payment.id));
    if (refund === 'full') {
      // captured=false is valid for auto-refunded authorizations; record no fictional capture timestamp.
      this.db.prepare(`UPDATE orders SET payment_status = 'refunded', gateway_payment_id = ?,
        paid_at = COALESCE(paid_at, ?), gateway_state = 'ready', payment_review = NULL WHERE id = ?`)
        .run(payment.id, payment.captured ? new Date().toISOString() : null, id);
      return;
    }
    if (refund === 'review') { hold(payment.id); return; }
    if (!payment.captured || payment.status !== 'captured') { hold(payment.id); return; }
    // A stale clean capture cannot clear a refund hold. Only a fully verified refund resolves it automatically.
    // The initial unbound provider-creation review is different: verified capture safely resolves that outcome.
    if (local.payment_review !== null && local.gateway_state === 'ready') return;
    const status = local.status === 'cancelled' || local.payment_status === 'refund_required' ? 'refund_required' : 'paid';
    this.db.prepare(`UPDATE orders SET payment_status = ?, gateway_payment_id = ?, paid_at = COALESCE(paid_at, ?),
      gateway_state = 'ready', payment_review = NULL WHERE id = ?`).run(status, payment.id, new Date().toISOString(), id);
  }
  private checkout(id: string): OnlineCheckout {
    const local = this.row(id);
    const order = getOrder(this.db, id)!;
    const key = this.gateway?.config.keyId;
    return { order, checkout: local.gateway_order_id && local.gateway_state === 'ready' && !local.payment_review && local.payment_status === 'pending' && local.status !== 'cancelled' && key
      ? { key, order_id: local.gateway_order_id, amount: local.total * 100, currency: 'INR', name: 'URBAN KASHI' } : null };
  }
  async create(user: User, body: unknown): Promise<OnlineCheckout> {
    const gateway = this.enabled();
    const order = reserveOrder(this.db, user.id, checkoutSchema.parse(body), 'Razorpay');
    // Durable compare-and-set guards concurrent requests, multiple app instances and process crashes.
    // Never reset creating/review to new: Razorpay order creation has no assumed idempotency guarantee.
    const claimed = this.db.prepare(`UPDATE orders SET gateway_state = 'creating', payment_review = ?
      WHERE id = ? AND gateway_state = 'new' AND status != 'cancelled'`)
      .run('Provider order creation is in progress or unconfirmed. Reconcile/contact support; do not create another payment.', order.id);
    if (Number(claimed.changes) === 1) {
      try {
        const remote = await gateway.createOrder({ amount: order.total * 100, currency: 'INR', receipt: order.id, notes: { local_order_id: order.id } });
        transaction(this.db, () => {
          const local = this.row(order.id);
          this.validateOrder(local, remote, true);
          if (this.db.prepare('SELECT id FROM orders WHERE gateway_order_id = ? AND id != ?').get(remote.id, order.id)) throw new HttpError(409, 'Provider order already bound.');
          // A webhook may already have bound this order and persisted a refund hold while creation was in flight.
          this.db.prepare("UPDATE orders SET gateway_order_id = ?, gateway_state = 'ready', payment_review = NULL WHERE id = ? AND gateway_order_id IS NULL").run(remote.id, order.id);
        });
      } catch {
        // Including malformed responses and HTTP failures: conservative unknown outcome, no retry or release.
        this.db.prepare(`UPDATE orders SET gateway_state = 'pending_review', payment_review = ? WHERE id = ? AND gateway_order_id IS NULL`)
          .run('Provider outcome unknown. Stock remains reserved. Contact support for Dashboard review; do not pay again.', order.id);
      }
    }
    return this.checkout(order.id);
  }
  async verify(user: User, body: unknown): Promise<Order> {
    const input = verification.parse(body);
    const local = this.own(input.orderId, user);
    const gateway = this.enabled();
    if (!local.gateway_order_id || input.razorpay_order_id !== local.gateway_order_id
      || !gateway.verifyPaymentSignature(local.gateway_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
      throw new HttpError(400, 'Invalid payment signature or provider order.');
    }
    const [remote, payment] = await Promise.all([gateway.getOrder(local.gateway_order_id), gateway.getPayment(input.razorpay_payment_id)]);
    if (payment.id !== input.razorpay_payment_id) throw new HttpError(409, 'Provider payment ID does not match.');
    const refunds = await this.refundEvidence([payment]);
    transaction(this.db, () => this.applyConfirmation(local.id, remote, [payment], refunds));
    return getOrder(this.db, local.id)!;
  }
  async reconcile(user: User, id: string): Promise<Order> {
    const local = this.own(id, user, true);
    const gateway = this.enabled();
    if (!local.gateway_order_id) throw new HttpError(409, 'Provider order outcome is unknown. Support must review the receipt in the Razorpay Dashboard and resend a verified webhook. Do not pay again.');
    const [remote, payments] = await Promise.all([gateway.getOrder(local.gateway_order_id), gateway.listPayments(local.gateway_order_id)]);
    const refunds = await this.refundEvidence(payments);
    transaction(this.db, () => this.applyConfirmation(local.id, remote, payments, refunds));
    return getOrder(this.db, local.id)!;
  }
  webhook: RequestHandler = async (req, res) => {
    const gateway = this.enabled();
    if (!Buffer.isBuffer(req.body) || !gateway.verifyWebhookSignature(req.body, req.get('X-Razorpay-Signature') ?? '')) {
      throw new HttpError(400, 'Invalid webhook signature.');
    }
    let json: unknown;
    try { json = JSON.parse(req.body.toString('utf8')); } catch { throw new HttpError(400, 'Invalid webhook JSON.'); }
    const event = eventSchema.parse(json);
    const digest = createHash('sha256').update(req.body).digest('hex');
    const eventId = req.get('X-Razorpay-Event-Id') || digest;
    if (eventId.length > 200) throw new HttpError(400, 'Invalid webhook event ID.');
    const previous = this.db.prepare('SELECT digest FROM payment_events WHERE id = ?').get(eventId) as { digest: string } | undefined;
    if (previous) {
      if (previous.digest !== digest) throw new HttpError(409, 'Webhook event ID conflict.');
      res.json({ ok: true }); return;
    }
    if (!['payment.captured', 'payment.failed', 'order.paid', 'refund.processed'].includes(event.event)) {
      res.json({ ok: true, ignored: true }); return;
    }
    let refund: GatewayRefund | undefined;
    let payment: GatewayPayment | undefined;
    let remote: GatewayOrder;
    if (event.event === 'refund.processed') {
      const refundId = event.payload.refund?.entity.id;
      if (!refundId) throw new HttpError(400, 'Missing refund entity.');
      refund = await gateway.getRefund(refundId);
      if (refund.id !== refundId || refund.status !== 'processed') throw new HttpError(409, 'Refund has not been confirmed.');
      payment = await gateway.getPayment(refund.payment_id);
      if (payment.id !== refund.payment_id) throw new HttpError(409, 'Refund payment ID mismatch.');
      remote = await gateway.getOrder(payment.order_id);
    } else if (event.payload.payment) {
      payment = await gateway.getPayment(event.payload.payment.entity.id);
      if (payment.id !== event.payload.payment.entity.id) throw new HttpError(409, 'Webhook payment ID mismatch.');
      remote = await gateway.getOrder(payment.order_id);
    } else if (event.event === 'order.paid' && event.payload.order) {
      remote = await gateway.getOrder(event.payload.order.entity.id);
      if (remote.id !== event.payload.order.entity.id) throw new HttpError(409, 'Webhook order ID mismatch.');
    } else throw new HttpError(400, 'Missing payment entity.');
    if (event.payload.order && event.payload.order.entity.id !== remote.id) throw new HttpError(409, 'Webhook order ID mismatch.');
    const local = this.row(remote.receipt);
    if (refund && event.payload.payment && event.payload.payment.entity.id !== payment?.id) throw new HttpError(409, 'Webhook refund payment ID mismatch.');
    // Event names describe the past. Provider reads describe current capture/refund state; never rewrite them.
    const payments = payment ? [payment] : await gateway.listPayments(remote.id);
    if (['payment.captured', 'order.paid'].includes(event.event)
      && !payments.some((candidate) => (candidate.captured === true && candidate.status === 'captured') || hasRefund(candidate))
      && local.payment_status !== 'refunded') {
      // Do not permanently acknowledge an early capture event while provider reads still say authorized.
      throw new HttpError(409, 'Provider capture is not confirmed yet. Retry this webhook later.');
    }
    const refunds = await this.refundEvidence(payments, refund);
    transaction(this.db, () => {
      const duplicate = this.db.prepare('SELECT digest FROM payment_events WHERE id = ?').get(eventId) as { digest: string } | undefined;
      if (duplicate) {
        if (duplicate.digest !== digest) throw new HttpError(409, 'Webhook event ID conflict.');
        return;
      }
      this.applyConfirmation(local.id, remote, payments, refunds, true);
      this.db.prepare('INSERT INTO payment_events(id,digest,processed_at) VALUES (?,?,?)').run(eventId, digest, new Date().toISOString());
    });
    res.json({ ok: true });
  };
  router(requireUser: RequestHandler) {
    const router = express.Router();
    router.get('/config', (_req, res) => { res.json(this.gateway?.config ?? disabledPaymentConfig); });
    router.post('/create', requireUser, async (req, res) => { res.status(201).json(await this.create(res.locals.user as User, req.body)); });
    router.post('/verify', requireUser, async (req, res) => { res.json({ order: await this.verify(res.locals.user as User, req.body) }); });
    router.post('/reconcile/:orderId', requireUser, async (req, res) => {
      res.json({ order: await this.reconcile(res.locals.user as User, String(req.params.orderId)) });
    });
    return router;
  }
}