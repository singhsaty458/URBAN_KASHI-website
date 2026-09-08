import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { getOrder } from '../server/db.js';
import { gatewayFromEnvironment, paymentMethods } from '../server/payment-gateway.js';
import type { OnlineCheckout, Order } from '../shared/types.js';
import { FakeGateway, fixture, paymentSignature, sessionCookie, webhookSignature, xhr } from './fixtures.js';

describe('Razorpay payments (injected fake only, no network or real keys)', () => {
  let f: ReturnType<typeof fixture>;
  let gateway: FakeGateway;
  beforeEach(() => { gateway = new FakeGateway(); f = fixture(gateway); });
  afterEach(() => f.db.close());
  async function create(body = f.payload()): Promise<OnlineCheckout> {
    return (await f.customer.post('/api/payments/create').set(xhr).send(body).expect(201)).body;
  }
  function verifyBody(order: Order, paymentId: string) {
    return { orderId: order.id, razorpay_order_id: order.gatewayOrderId, razorpay_payment_id: paymentId, razorpay_signature: paymentSignature(order.gatewayOrderId!, paymentId) };
  }
  function webhook(event: string, paymentId: string, eventId = 'event-test', status = 200) {
    const body = JSON.stringify({ event, payload: { payment: { entity: { id: paymentId } } } });
    return request(f.app).post('/api/payments/webhook').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', webhookSignature(body)).set('X-Razorpay-Event-Id', eventId).send(body).expect(status);
  }
  function refundWebhook(refundId: string, eventId = `event-${refundId}`) {
    const body = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: refundId } } } });
    return request(f.app).post('/api/payments/webhook').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', webhookSignature(body)).set('X-Razorpay-Event-Id', eventId).send(body);
  }
  async function reconcile(order: Order) {
    return (await f.customer.post(`/api/payments/reconcile/${order.id}`).set(xhr).send({}).expect(200)).body.order as Order;
  }

  it('disables incomplete configuration without reserving stock; keys need all three values', async () => {
    const disabled = createApp({ db: f.db, distPath: false, rateLimit: false, paymentGateway: null });
    const config = await request(disabled).get('/api/payments/config').expect(200);
    assert.equal(config.body.online, false); assert.equal(config.body.mode, 'disabled'); assert.equal(config.body.keyId, null);
    const before = f.stock();
    await request(disabled).post('/api/payments/create').set(xhr).set('Cookie', sessionCookie(f.db, 'fixture-customer')).send(f.payload()).expect(503);
    assert.equal(f.stock(), before);
    for (const env of [{}, { RAZORPAY_KEY_ID: 'rzp_test_DUMMY' }, { RAZORPAY_KEY_ID: 'rzp_test_DUMMY', RAZORPAY_KEY_SECRET: 'dummy' }]) assert.equal(gatewayFromEnvironment(env), null);
    for (const mode of ['test', 'live']) {
      const configured = gatewayFromEnvironment({ RAZORPAY_KEY_ID: `rzp_${mode}_DUMMY`, RAZORPAY_KEY_SECRET: 'dummy', RAZORPAY_WEBHOOK_SECRET: 'dummy' });
      assert.equal(configured?.config.mode, mode); // Construction only, never a provider request.
      assert.equal(JSON.stringify(configured?.config).includes('SECRET'), false);
    }
  });

  it('returns public config and trusted paise checkout while persisting pending reservation', async () => {
    const config = (await request(f.app).get('/api/payments/config').expect(200)).body;
    assert.deepEqual(config.methods, paymentMethods); assert.equal(config.mode, 'test');
    const before = f.stock(); const result = await create();
    assert.equal(result.order.paymentMethod, 'Razorpay'); assert.equal(result.order.paymentStatus, 'pending');
    assert.equal(result.checkout?.amount, result.order.total * 100); assert.equal(result.checkout?.currency, 'INR');
    assert.equal(result.checkout?.name, 'URBAN KASHI'); assert.equal(f.stock(), before - 1);
    const remote = gateway.orders.get(result.checkout!.order_id)!;
    assert.equal(remote.receipt, result.order.id); assert.equal(remote.notes.local_order_id, result.order.id);
    assert.equal((await f.admin.get('/api/admin/stats')).body.stats.revenue, 0);
  });

  it('rejects unauthenticated, cross-site, no-XHR, and client-selected provider/amount writes', async () => {
    await request(f.app).post('/api/payments/create').set(xhr).send(f.payload()).expect(401);
    await f.customer.post('/api/payments/create').send(f.payload()).expect(403);
    await f.customer.post('/api/payments/create').set(xhr).set('Sec-Fetch-Site', 'cross-site').send(f.payload()).expect(403);
    for (const extra of [{ provider: 'mock' }, { amount: 1 }, { paymentMethod: 'COD' }]) {
      await f.customer.post('/api/payments/create').set(xhr).send({ ...f.payload(), ...extra }).expect(400);
    }
    assert.equal(gateway.createCalls, 0);
  });

  it('replays one order and reservation and rejects changed payload or cross-COD reuse', async () => {
    const body = f.payload(); const before = f.stock();
    const first = await create(body); assert.deepEqual(await create(body), first);
    assert.equal(gateway.createCalls, 1); assert.equal(f.stock(), before - 1);
    await f.customer.post('/api/payments/create').set(xhr).send({ ...body, address: { ...body.address, line1: 'Other address 99' } }).expect(409);
    await f.customer.post('/api/orders').set(xhr).send(body).expect(409);
  });

  it('guards concurrent in-flight creation across two app instances using the persisted claim', async () => {
    let release!: () => void;
    gateway.createGate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const original = gateway.createOrder.bind(gateway);
    gateway.createOrder = (input) => { const result = original(input); entered(); return result; };
    const body = f.payload(); const before = f.stock();
    const first = f.customer.post('/api/payments/create').set(xhr).send(body).then((response) => response);
    await started;
    try {
      const secondApp = createApp({ db: f.db, distPath: false, rateLimit: false, paymentGateway: gateway });
      const second = await request(secondApp).post('/api/payments/create').set(xhr).set('Cookie', sessionCookie(f.db, 'fixture-customer')).send(body).expect(201);
      assert.equal(second.body.checkout, null); assert.equal(second.body.order.paymentStatus, 'pending');
      assert.match(second.body.order.paymentReview, /unconfirmed/);
    } finally { release(); }
    const completed = await first; assert.equal(completed.status, 201); assert.ok(completed.body.checkout);
    assert.equal(gateway.createCalls, 1); assert.equal(f.stock(), before - 1);
  });

  it('retains uncertain outcome for review across restart; never blindly creates another provider order', async () => {
    gateway.failCreate = true; const body = f.payload(); const before = f.stock();
    const first = await create(body); assert.equal(first.checkout, null);
    assert.equal(first.order.paymentStatus, 'pending'); assert.equal(f.stock(), before - 1);
    const restarted = createApp({ db: f.db, distPath: false, rateLimit: false, paymentGateway: gateway });
    const replay = await request(restarted).post('/api/payments/create').set(xhr).set('Cookie', sessionCookie(f.db, 'fixture-customer')).send(body).expect(201);
    assert.match(replay.body.order.paymentReview, /unknown/); assert.equal(gateway.createCalls, 1);
    await f.customer.post(`/api/payments/reconcile/${first.order.id}`).set(xhr).send({}).expect(409);
    const payment = gateway.capture('order_test_1');
    await webhook('payment.captured', payment.id); // Authenticated provider receipt recovers durable binding.
    const recovered = getOrder(f.db, first.order.id)!;
    assert.equal(recovered.gatewayOrderId, 'order_test_1'); assert.equal(recovered.paymentStatus, 'paid');
    assert.equal(f.stock(), before - 1);
  });

  it('rejects signature tampering before provider fetch and protects verify/reconcile ownership', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!); const body = verifyBody(order, payment.id);
    for (const signature of ['bad', '0'.repeat(64), body.razorpay_signature.slice(0, 62)]) {
      await f.customer.post('/api/payments/verify').set(xhr).send({ ...body, razorpay_signature: signature }).expect(400);
    }
    await f.customer.post('/api/payments/verify').set(xhr).send({ ...body, razorpay_order_id: 'order_other' }).expect(400);
    await request(f.app).post('/api/payments/verify').set(xhr).send(body).expect(401);
    await f.other.post('/api/payments/verify').set(xhr).send(body).expect(404);
    await f.admin.post('/api/payments/verify').set(xhr).send(body).expect(404);
    await f.other.post(`/api/payments/reconcile/${order.id}`).set(xhr).send({}).expect(404);
    assert.equal(gateway.paymentReads, 0); assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'pending');
  });

  it('keeps authorized payment pending, then marks only captured payment paid without touching stock', async () => {
    const { order } = await create(); const before = f.stock();
    const payment = gateway.capture(order.gatewayOrderId!, { status: 'authorized', captured: false });
    const body = verifyBody(order, payment.id);
    const pending = await f.customer.post('/api/payments/verify').set(xhr).send(body).expect(200);
    assert.equal(pending.body.order.paymentStatus, 'pending');
    payment.status = 'captured'; payment.captured = true;
    const paid = await f.customer.post('/api/payments/verify').set(xhr).send(body).expect(200);
    assert.equal(paid.body.order.paymentStatus, 'paid'); assert.ok(paid.body.order.paidAt);
    assert.deepEqual((await f.customer.post('/api/payments/verify').set(xhr).send(body).expect(200)).body, paid.body);
    assert.equal(f.stock(), before);
  });

  it('rejects both under/overpayment, wrong currency, wrong provider order and forged order notes', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!); const original = { ...payment };
    for (const patch of [{ amount: payment.amount - 1 }, { amount: payment.amount + 1 }, { currency: 'USD' }, { order_id: 'order_wrong' }]) {
      Object.assign(payment, original, patch);
      await f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, payment.id)).expect(409);
      assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'pending');
    }
    Object.assign(payment, original);
    const remote = gateway.orders.get(order.gatewayOrderId!)!;
    for (const patch of [{ amount: remote.amount + 1 }, { currency: 'USD' }, { receipt: 'wrong-local' }, { notes: { local_order_id: 'wrong-local' } }, { id: 'order_wrong' }]) {
      const saved = structuredClone(remote); Object.assign(remote, patch);
      await f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, payment.id)).expect(409);
      Object.assign(remote, saved);
    }
  });

  it('recovers captured payments after modal close using owner or admin reconciliation', async () => {
    const { order } = await create();
    assert.equal((await f.customer.post(`/api/payments/reconcile/${order.id}`).set(xhr).send({}).expect(200)).body.order.paymentStatus, 'pending');
    gateway.capture(order.gatewayOrderId!);
    assert.equal((await f.admin.post(`/api/payments/reconcile/${order.id}`).set(xhr).send({}).expect(200)).body.order.paymentStatus, 'paid');
  });

  it('verifies exact raw bytes and exempts only the exact webhook POST from XHR', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!);
    const body = ` { "event": "payment.captured", "payload": {"payment":{"entity":{"id":"${payment.id}"}}} }\n`;
    await request(f.app).post('/api/payments/webhook').set('Content-Type', 'application/json').send(body).expect(400);
    await request(f.app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', webhookSignature(body.trim())).send(body).expect(400);
    for (const path of ['/api/payments/webhook/', '/api/payments/Webhook', '/api/payments/webhook/other']) {
      await request(f.app).post(path).set('Content-Type', 'application/json').set('X-Razorpay-Signature', webhookSignature(body)).send(body).expect(403);
    }
    await request(f.app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', webhookSignature(body)).send(body).expect(200);
    assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'paid');
    const malformed = '{broken';
    await request(f.app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', webhookSignature(malformed)).send(malformed).expect(400);
  });

  it('deduplicates webhooks and out-of-order failures never revert paid or reserve stock twice', async () => {
    const { order } = await create(); const stock = f.stock(); const payment = gateway.capture(order.gatewayOrderId!);
    await webhook('payment.captured', payment.id); await webhook('payment.captured', payment.id);
    const failed = gateway.capture(order.gatewayOrderId!, { captured: false, status: 'failed' });
    await webhook('payment.failed', failed.id, 'failed-event');
    await webhook('payment.captured', payment.id, 'second-capture-event');
    assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'paid'); assert.equal(f.stock(), stock);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get() as { n: number }).n, 3);
    await webhook('payment.failed', failed.id, 'event-test', 409);
  });

  it('rejects a validly signed but mismatched webhook capture amount', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!, { amount: 100 });
    await webhook('payment.captured', payment.id, 'bad-amount', 409);
    assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'pending');
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get() as { n: number }).n, 0);
  });

  it('does not consume an early capture webhook until provider capture is authoritative', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!, { captured: false, status: 'authorized' });
    await webhook('payment.captured', payment.id, 'early-capture', 409);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get() as { n: number }).n, 0);
    payment.captured = true; payment.status = 'captured';
    await webhook('payment.captured', payment.id, 'early-capture');
    assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'paid');
  });

  it('blocks pending fulfilment and marks late capture after cancellation refund_required', async () => {
    const before = f.stock(); const { order } = await create(); const route = `/api/admin/orders/${order.id}`;
    await f.admin.patch(route).set(xhr).send({ status: 'confirmed' }).expect(409);
    await f.admin.patch(route).set(xhr).send({ status: 'cancelled' }).expect(200);
    assert.equal(f.stock(), before);
    const payment = gateway.capture(order.gatewayOrderId!);
    await webhook('payment.captured', payment.id); await webhook('payment.captured', payment.id);
    const late = getOrder(f.db, order.id)!; assert.equal(late.status, 'cancelled'); assert.equal(late.paymentStatus, 'refund_required');
    assert.equal(f.stock(), before);
    await f.admin.patch(route).set(xhr).send({ status: 'confirmed' }).expect(409);
  });

  it('paid cancellation requests manual refund, only verified full processed refund sets refunded', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!);
    await webhook('payment.captured', payment.id);
    const cancelled = await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(200);
    assert.equal(cancelled.body.order.paymentStatus, 'refund_required');
    const stock = f.stock();
    const partial = gateway.refund(payment.id, payment.amount - 1);
    await refundWebhook(partial.id).expect(200); await refundWebhook(partial.id).expect(200);
    const held = getOrder(f.db, order.id)!;
    assert.equal(held.paymentStatus, 'refund_required'); assert.match(held.paymentReview!, /Refund.*hold/);
    const remainder = gateway.refund(payment.id, 1);
    await refundWebhook(remainder.id).expect(200); await refundWebhook(remainder.id).expect(200);
    const refunded = getOrder(f.db, order.id)!;
    assert.equal(refunded.paymentStatus, 'refunded'); assert.equal(refunded.paymentReview, null);
    await webhook('payment.captured', payment.id, 'late-capture'); // Provider remains refunded.
    assert.deepEqual(getOrder(f.db, order.id), refunded);
    assert.equal(payment.status, 'refunded'); assert.equal(f.stock(), stock);
    assert.equal(getOrder(f.db, order.id)!.status, 'cancelled');
  });

  for (const initial of ['pending', 'paid'] as const) {
    for (const route of ['verify', 'reconcile', 'late-capture', 'order-paid'] as const) {
      it(`recovers a missed full-refund webhook from ${initial} via ${route} without stock restoration`, async () => {
        const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!); const stock = f.stock();
        if (initial === 'paid') await reconcile(order);
        const paidAt = getOrder(f.db, order.id)!.paidAt;
        gateway.refund(payment.id);
        if (route === 'verify') await f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, payment.id)).expect(200);
        else if (route === 'reconcile') await reconcile(order);
        else if (route === 'late-capture') await webhook('payment.captured', payment.id);
        else {
          const body = JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: order.gatewayOrderId } } } });
          await request(f.app).post('/api/payments/webhook').set('Content-Type', 'application/json')
            .set('X-Razorpay-Signature', webhookSignature(body)).send(body).expect(200);
        }
        const refunded = getOrder(f.db, order.id)!;
        assert.equal(refunded.paymentStatus, 'refunded'); assert.equal(refunded.paymentReview, null);
        assert.equal(refunded.status, 'placed'); assert.equal(f.stock(), stock);
        if (paidAt) assert.equal(refunded.paidAt, paidAt);
        assert.equal(payment.status, 'refunded'); assert.equal(payment.amount_refunded, payment.amount);
        assert.equal((await f.admin.get('/api/admin/stats').expect(200)).body.stats.revenue, 0);
        await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'confirmed' }).expect(409);
        assert.deepEqual(await reconcile(order), refunded);
      });
    }
  }

  for (const route of ['verify', 'reconcile', 'refund-webhook', 'late-capture'] as const) {
    it(`closes an uncaptured authorization refund via ${route} without inventing paid_at`, async () => {
      const { order } = await create(); const stock = f.stock();
      const payment = gateway.capture(order.gatewayOrderId!, { status: 'authorized', captured: false });
      const refund = gateway.refund(payment.id);
      if (route === 'verify') await f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, payment.id)).expect(200);
      else if (route === 'reconcile') await reconcile(order);
      else if (route === 'refund-webhook') await refundWebhook(refund.id).expect(200);
      else await webhook('payment.captured', payment.id);
      const result = getOrder(f.db, order.id)!;
      assert.equal(result.paymentStatus, 'refunded'); assert.equal(result.paidAt, null); assert.equal(result.paymentReview, null);
      assert.equal(payment.captured, false); assert.equal(payment.status, 'refunded'); assert.equal(f.stock(), stock);
      assert.equal(f.db.prepare('SELECT gateway_payment_id FROM orders WHERE id = ?').get(order.id)!.gateway_payment_id, payment.id);
      await webhook('payment.captured', payment.id, 'late-uncaptured');
      assert.deepEqual(getOrder(f.db, order.id), result);
      await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'confirmed' }).expect(409);
    });
  }

  for (const initial of ['pending', 'paid'] as const) {
    for (const route of ['verify', 'reconcile', 'refund-webhook', 'late-capture'] as const) {
      it(`holds a partial refund from ${initial} via ${route}, excludes revenue and blocks fulfilment`, async () => {
        const body = f.payload(); const { order } = await create(body); const payment = gateway.capture(order.gatewayOrderId!);
        const stock = f.stock(); const adminRoute = `/api/admin/orders/${order.id}`;
        if (initial === 'paid') {
          await reconcile(order);
          await f.admin.patch(adminRoute).set(xhr).send({ status: 'confirmed' }).expect(200);
          assert.equal((await f.admin.get('/api/admin/stats').expect(200)).body.stats.revenue, order.total);
        }
        const paidAt = getOrder(f.db, order.id)!.paidAt;
        const refund = gateway.refund(payment.id, 1);
        if (route === 'verify') await f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, payment.id)).expect(200);
        else if (route === 'reconcile') await reconcile(order);
        else if (route === 'refund-webhook') await refundWebhook(refund.id).expect(200);
        else await webhook('payment.captured', payment.id);
        const result = getOrder(f.db, order.id)!;
        assert.equal(result.paymentStatus, initial); assert.match(result.paymentReview!, /Refund.*hold/);
        assert.equal(result.paidAt, paidAt); assert.equal(f.stock(), stock);
        assert.equal((await create(body)).checkout, null);
        assert.equal((await f.admin.get('/api/admin/stats').expect(200)).body.stats.revenue, 0);
        await f.admin.patch(adminRoute).set(xhr).send({ status: initial === 'paid' ? 'shipped' : 'confirmed' }).expect(409);
        await webhook('payment.captured', payment.id, 'partial-late-capture');
        assert.deepEqual(getOrder(f.db, order.id), result);
        assert.deepEqual(await reconcile(order), result);
        gateway.refund(payment.id, payment.amount - 1);
        const full = await reconcile(order);
        assert.equal(full.paymentStatus, 'refunded'); assert.equal(full.paymentReview, null); assert.equal(f.stock(), stock);
      });
    }
  }

  for (const failure of ['incomplete', 'unavailable', 'duplicate', 'wrong-payment', 'wrong-currency', 'pending', 'failed', 'under', 'over', 'missing', 'metadata'] as const) {
    it(`persists a hold for ${failure} refund evidence even when the payment says fully refunded`, async () => {
      const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!);
      await reconcile(order); const stock = f.stock();
      const refund = gateway.refund(payment.id);
      const originalList = gateway.listRefunds.bind(gateway);
      if (failure === 'incomplete') gateway.listRefunds = async () => ({ items: [structuredClone(refund)], complete: false });
      if (failure === 'unavailable') gateway.listRefunds = async () => { throw new Error('Simulated provider outage'); };
      if (failure === 'duplicate') gateway.listRefunds = async () => ({ items: [structuredClone(refund), structuredClone(refund)], complete: true });
      if (failure === 'wrong-payment') gateway.listRefunds = async () => ({ items: [{ ...refund, payment_id: 'pay_other' }], complete: true });
      if (failure === 'wrong-currency') refund.currency = 'USD';
      if (failure === 'pending' || failure === 'failed') refund.status = failure;
      if (failure === 'under') refund.amount--;
      if (failure === 'over') refund.amount++;
      if (failure === 'missing') gateway.refunds.clear();
      if (failure === 'metadata') payment.amount_refunded--;
      const result = await reconcile(order);
      assert.equal(result.paymentStatus, 'paid'); assert.match(result.paymentReview!, /Refund.*hold/);
      assert.equal(f.stock(), stock); assert.equal((await f.admin.get('/api/admin/stats').expect(200)).body.stats.revenue, 0);
      await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'confirmed' }).expect(409);
      gateway.listRefunds = originalList;
    });
  }

  it('requires the fetched webhook refund ID and details to be present in the complete collection', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!);
    const refund = gateway.refund(payment.id);
    const originalList = gateway.listRefunds.bind(gateway);
    gateway.listRefunds = async () => ({ items: [{ ...refund, id: 'rfnd_different' }], complete: true });
    await refundWebhook(refund.id).expect(200);
    assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'pending'); assert.ok(getOrder(f.db, order.id)!.paymentReview);
    gateway.listRefunds = originalList;
    assert.equal((await reconcile(order)).paymentStatus, 'refunded');
  });

  it('does not equate a pending refund or multiple captures to a clean paid order', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!);
    gateway.refunds.set('rfnd_pending', { id: 'rfnd_pending', payment_id: payment.id, amount: payment.amount, currency: 'INR', status: 'pending' });
    const held = await reconcile(order);
    assert.equal(held.paymentStatus, 'pending'); assert.ok(held.paymentReview);
    gateway.capture(order.gatewayOrderId!);
    const multiple = await reconcile(order);
    assert.equal(multiple.paymentStatus, 'pending'); assert.ok(multiple.paymentReview);
  });

  it('does not use another payment refund to clear the held payment identity', async () => {
    const { order } = await create(); const first = gateway.capture(order.gatewayOrderId!);
    gateway.refund(first.id, 1); await reconcile(order);
    assert.equal(f.db.prepare('SELECT gateway_payment_id FROM orders WHERE id = ?').get(order.id)!.gateway_payment_id, first.id);
    const other = gateway.capture(order.gatewayOrderId!); gateway.refund(other.id);
    const result = (await f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, other.id)).expect(200)).body.order;
    assert.equal(result.paymentStatus, 'pending'); assert.match(result.paymentReview, /conflicting/);
    gateway.refund(first.id, first.amount - 1);
    await f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, first.id)).expect(200);
    // One callback cannot prove the disposition of every conflicting payment: manual review remains required.
    assert.equal(getOrder(f.db, order.id)!.paymentStatus, 'pending'); assert.ok(getOrder(f.db, order.id)!.paymentReview);
  });

  it('records delivery of a shipped refunded parcel without restoring stock or recognizing revenue', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!); const stock = f.stock();
    await reconcile(order); const route = `/api/admin/orders/${order.id}`;
    await f.admin.patch(route).set(xhr).send({ status: 'confirmed' }).expect(200);
    await f.admin.patch(route).set(xhr).send({ status: 'shipped' }).expect(200);
    gateway.refund(payment.id); await reconcile(order);
    const delivered = (await f.admin.patch(route).set(xhr).send({ status: 'delivered' }).expect(200)).body.order;
    assert.equal(delivered.status, 'delivered'); assert.equal(delivered.paymentStatus, 'refunded');
    assert.equal(f.stock(), stock); assert.equal((await f.admin.get('/api/admin/stats').expect(200)).body.stats.revenue, 0);
    await f.admin.patch(route).set(xhr).send({ status: 'cancelled' }).expect(409);
  });

  it('records delivery of an already shipped parcel with a partial-refund review hold', async () => {
    const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!); const stock = f.stock();
    await reconcile(order); const route = `/api/admin/orders/${order.id}`;
    await f.admin.patch(route).set(xhr).send({ status: 'confirmed' }).expect(200);
    await f.admin.patch(route).set(xhr).send({ status: 'shipped' }).expect(200);
    gateway.refund(payment.id, 1); await reconcile(order);
    const delivered = (await f.admin.patch(route).set(xhr).send({ status: 'delivered' }).expect(200)).body.order;
    assert.equal(delivered.status, 'delivered'); assert.equal(delivered.paymentStatus, 'paid'); assert.ok(delivered.paymentReview);
    assert.equal(f.stock(), stock);
  });

  it('does not clear a webhook refund hold when an older create-order response finally arrives', async () => {
    let release!: () => void; let entered!: () => void;
    gateway.createGate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const original = gateway.createOrder.bind(gateway);
    gateway.createOrder = (input) => { const result = original(input); entered(); return result; };
    const before = f.stock(); const body = f.payload();
    const inFlight = f.customer.post('/api/payments/create').set(xhr).send(body).then((response) => response);
    await started;
    let held: Order;
    try {
      const remote = gateway.orders.get('order_test_1')!;
      const payment = gateway.capture(remote.id);
      const refund = gateway.refund(payment.id, 1);
      await refundWebhook(refund.id).expect(200);
      held = getOrder(f.db, remote.receipt)!;
      assert.equal(held.paymentStatus, 'pending'); assert.ok(held.paymentReview);
    } finally { release(); }
    const created = await inFlight;
    assert.equal(created.status, 201); assert.equal(created.body.checkout, null);
    assert.deepEqual(created.body.order, held!); assert.equal(f.stock(), before - 1);
    assert.equal((await create(body)).checkout, null); assert.equal(gateway.createCalls, 1);
  });

  for (const stale of ['capture', 'partial-refund'] as const) {
    for (const final of ['partial-refund', 'full-refund'] as const) {
      it(`keeps fresh ${final} state when an older ${stale} response finishes afterwards`, async () => {
        const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!); const stock = f.stock();
        if (stale === 'partial-refund') gateway.refund(payment.id, 1);
        const originalList = gateway.listRefunds.bind(gateway);
        let release!: () => void; let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        let first = true;
        gateway.listRefunds = async (id) => {
          const snapshot = await originalList(id);
          if (first) { first = false; entered(); await gate; }
          return snapshot;
        };
        const inFlight = f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, payment.id)).then((response) => response);
        await started;
        let fresh: Order;
        try {
          gateway.refund(payment.id, final === 'full-refund' ? payment.amount - payment.amount_refunded : 1);
          // This second request must finish while the first fetch is blocked: no transaction surrounds I/O.
          fresh = await reconcile(order);
          assert.equal(fresh.paymentStatus, final === 'full-refund' ? 'refunded' : 'pending');
          if (final === 'partial-refund') assert.ok(fresh.paymentReview);
        } finally { release(); }
        const late = await inFlight;
        assert.equal(late.status, 200); assert.deepEqual(late.body.order, fresh!);
        assert.deepEqual(getOrder(f.db, order.id), fresh!); assert.equal(f.stock(), stock);
        assert.equal(payment.status, final === 'full-refund' ? 'refunded' : 'captured');
      });
    }
  }

  it('applies a capture against fresh cancellation state after provider I/O completes', async () => {
    const before = f.stock(); const { order } = await create(); const payment = gateway.capture(order.gatewayOrderId!);
    const originalList = gateway.listRefunds.bind(gateway);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    gateway.listRefunds = async (id) => { const result = await originalList(id); entered(); await gate; return result; };
    const inFlight = f.customer.post('/api/payments/verify').set(xhr).send(verifyBody(order, payment.id)).then((response) => response);
    await started;
    try { await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(200); }
    finally { release(); }
    const late = await inFlight;
    assert.equal(late.status, 200); assert.equal(late.body.order.status, 'cancelled');
    assert.equal(late.body.order.paymentStatus, 'refund_required'); assert.equal(f.stock(), before);
  });

  it('allows paid confirmation/shipment but never cancels an already shipped order', async () => {
    const { order } = await create(); gateway.capture(order.gatewayOrderId!);
    await f.customer.post(`/api/payments/reconcile/${order.id}`).set(xhr).send({}).expect(200);
    const route = `/api/admin/orders/${order.id}`;
    await f.admin.patch(route).set(xhr).send({ status: 'confirmed' }).expect(200);
    await f.admin.patch(route).set(xhr).send({ status: 'shipped' }).expect(200);
    await f.admin.patch(route).set(xhr).send({ status: 'cancelled' }).expect(409);
  });
});