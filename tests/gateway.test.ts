import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { RazorpayGateway, verifyHmac, type GatewayCreateOrder } from '../server/payment-gateway.js';
import { HttpError } from '../server/errors.js';
import { fixture, xhr } from './fixtures.js';

// Synthetic examples of the documented entities, not live responses or environment credentials.
// https://razorpay.com/docs/api/payments/entity/
// https://razorpay.com/docs/api/refunds/fetch-multiple-refund-payment/
const credentials = { keyId: 'rzp_test_ADAPTERDUMMY', keySecret: 'adapter-dummy-secret', webhookSecret: 'adapter-dummy-webhook' };
const input: GatewayCreateOrder = { amount: 199800, currency: 'INR', receipt: 'local-receipt', notes: { local_order_id: 'local-receipt' } };
const orderEntity = { id: 'order_adapter', entity: 'order', ...input, status: 'paid', amount_paid: 199800,
  amount_due: 0, attempts: 1, offer_id: null, created_at: 1700000000 };
const paymentEntity = { id: 'pay_adapter', entity: 'payment', order_id: orderEntity.id, amount: input.amount, currency: 'INR',
  status: 'captured', captured: true, amount_refunded: 0, refund_status: null as 'full' | 'partial' | null,
  method: 'upi', invoice_id: null, description: null, international: false, card_id: null, bank: null,
  wallet: null, vpa: 'dummy@example', email: 'dummy@example.test', contact: '+919999999999',
  notes: [], fee: 200, tax: 30, error_code: null, error_description: null, created_at: 1700000000,
  acquirer_data: { rrn: '000000000000' }, upi: { vpa: 'dummy@example' } };
const refundEntity = { id: 'rfnd_adapter', entity: 'refund', payment_id: paymentEntity.id, amount: input.amount,
  currency: 'INR', status: 'processed', notes: { comment: 'Synthetic refund' }, receipt: null, batch_id: null,
  acquirer_data: { arn: '00000000000000' }, created_at: 1700000001, speed_requested: 'normal', speed_processed: 'normal' };
const collection = (items: unknown[]) => ({ entity: 'collection', count: items.length, items });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('production RazorpayGateway with intercepted fetch only', { concurrency: false }, () => {
  let gateway: RazorpayGateway;
  let calls: Array<{ url: string; init?: RequestInit }>;
  let respond: (url: string, init?: RequestInit) => Promise<Response>;
  beforeEach(() => {
    calls = [];
    respond = async () => { throw new Error('Unexpected mocked fetch; live network is forbidden'); };
    mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      calls.push({ url: value, init });
      return respond(value, init); // Never falls through to the original fetch.
    });
    gateway = new RazorpayGateway({ ...credentials });
  });
  afterEach(() => mock.restoreAll());

  it('uses official endpoints, server-only Basic auth, JSON, no redirects and a timeout', async () => {
    respond = async (url) => {
      if (url.endsWith('/orders') || url.endsWith(`/orders/${orderEntity.id}`)) return json(orderEntity);
      if (url.endsWith(`/orders/${orderEntity.id}/payments`)) return json(collection([paymentEntity]));
      if (url.endsWith(`/payments/${paymentEntity.id}`)) return json(paymentEntity);
      if (url.endsWith(`/refunds/${refundEntity.id}`)) return json(refundEntity);
      if (url.endsWith(`/payments/${paymentEntity.id}/refunds?count=100&skip=0`)) return json(collection([refundEntity]));
      throw new Error('Unexpected endpoint');
    };
    assert.equal((await gateway.createOrder(input)).receipt, input.receipt);
    assert.equal((await gateway.getOrder(orderEntity.id)).notes.local_order_id, input.receipt);
    const payment = await gateway.getPayment(paymentEntity.id);
    assert.equal(payment.refund_status, null); assert.equal(payment.amount_refunded, 0);
    assert.equal('email' in payment, false); // Only the server's reconciliation contract is retained.
    assert.deepEqual(await gateway.listPayments(orderEntity.id), [payment]);
    const refund = await gateway.getRefund(refundEntity.id);
    assert.equal(refund.currency, 'INR'); assert.equal(refund.amount, input.amount);
    assert.deepEqual(await gateway.listRefunds(payment.id), { items: [refund], complete: true });
    assert.equal(calls.length, 6);
    for (const [index, call] of calls.entries()) {
      assert.equal(new URL(call.url).origin, 'https://api.razorpay.com');
      assert.equal(new URL(call.url).username, ''); assert.equal(new URL(call.url).password, '');
      assert.equal(call.url.includes(credentials.keySecret), false);
      assert.equal(call.init?.method, index === 0 ? 'POST' : 'GET');
      assert.equal(call.init?.redirect, 'error'); assert.ok(call.init?.signal instanceof AbortSignal);
      assert.equal(call.init.signal.aborted, false);
      const headers = new Headers(call.init.headers);
      assert.equal(headers.get('Authorization'), `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`);
      assert.equal(headers.get('Accept'), 'application/json'); assert.equal(headers.get('Content-Type'), 'application/json');
      if (index === 0) assert.deepEqual(JSON.parse(String(call.init.body)), input);
      else assert.equal(call.init.body, undefined);
    }
    assert.equal(JSON.stringify(gateway.config).includes(credentials.keySecret), false);
    assert.equal(JSON.stringify(gateway.config).includes(credentials.webhookSecret), false);
  });

  it('retains full/partial refund metadata and a refunded uncaptured authorization', async () => {
    for (const patch of [
      { refund_status: 'partial', amount_refunded: 1, status: 'captured', captured: true },
      { refund_status: 'full', amount_refunded: input.amount, status: 'refunded', captured: true },
      { refund_status: 'full', amount_refunded: input.amount, status: 'refunded', captured: false },
    ]) {
      respond = async () => json({ ...paymentEntity, ...patch });
      const payment = await gateway.getPayment(paymentEntity.id);
      for (const key of ['refund_status', 'amount_refunded', 'status', 'captured'] as const) assert.equal(payment[key], patch[key]);
      respond = async () => json(collection([{ ...paymentEntity, ...patch }]));
      assert.deepEqual(await gateway.listPayments(orderEntity.id), [payment]);
    }
  });

  it('exhausts refund pages and does not treat page count or a matching amount as the final total', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ ...refundEntity, id: `rfnd_page_${i}`, amount: i === 0 ? input.amount : 1,
      status: i === 0 ? 'processed' : 'failed' }));
    respond = async (url) => {
      const skip = new URL(url).searchParams.get('skip');
      if (skip === '0') return json(collection(firstPage));
      if (skip === '100') return json(collection([{ ...refundEntity, id: 'rfnd_later', amount: 1, status: 'pending' }]));
      throw new Error('Unexpected pagination');
    };
    const result = await gateway.listRefunds(paymentEntity.id);
    assert.equal(result.complete, true); assert.equal(result.items.length, 101);
    assert.equal(result.items[100]!.status, 'pending'); assert.equal(calls.length, 2);
  });

  it('requires an empty terminal page after an exactly full page', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...refundEntity, id: `rfnd_${i}`, amount: 1 }));
    respond = async (url) => json(collection(new URL(url).searchParams.get('skip') === '0' ? page : []));
    const result = await gateway.listRefunds(paymentEntity.id);
    assert.equal(result.complete, true); assert.equal(result.items.length, 100); assert.equal(calls.length, 2);
  });

  for (const problem of ['duplicate', 'wrong-payment', 'count-mismatch', 'oversized', 'repeated-page', 'page-limit'] as const) {
    it(`does not report a ${problem} refund collection as complete`, async () => {
      respond = async (url) => {
        if (problem === 'duplicate') return json(collection([refundEntity, refundEntity]));
        if (problem === 'wrong-payment') return json(collection([{ ...refundEntity, payment_id: 'pay_other' }]));
        if (problem === 'count-mismatch') return json({ ...collection([refundEntity]), count: 2 });
        const skip = problem === 'page-limit' ? Number(new URL(url).searchParams.get('skip')) : 0;
        return json(collection(Array.from({ length: problem === 'oversized' ? 101 : 100 }, (_, i) => ({ ...refundEntity, id: `rfnd_${skip + i}`, amount: 1 }))));
      };
      assert.equal((await gateway.listRefunds(paymentEntity.id)).complete, false);
      assert.equal(calls.length, problem === 'page-limit' ? 10 : problem === 'repeated-page' ? 2 : 1);
    });
  }

  it('rejects a later-page HTTP failure instead of returning the successful first page', async () => {
    respond = async (url) => new URL(url).searchParams.get('skip') === '0'
      ? json(collection(Array.from({ length: 100 }, (_, i) => ({ ...refundEntity, id: `rfnd_${i}`, amount: 1 }))))
      : json({ error: { description: 'PRIVATE PROVIDER DETAIL' } }, 503);
    await assert.rejects(gateway.listRefunds(paymentEntity.id), (error: unknown) => error instanceof HttpError && error.status === 502);
    assert.equal(calls.length, 2);
  });

  for (const failure of ['http-401', 'http-429', 'http-500', 'redirect', 'network', 'timeout', 'json'] as const) {
    it(`sanitizes ${failure} failures without retries or leaking upstream details`, async () => {
      respond = async () => {
        if (failure === 'network') throw new Error(`PRIVATE ${credentials.keySecret}`);
        if (failure === 'timeout') throw new DOMException(`PRIVATE ${credentials.webhookSecret}`, 'TimeoutError');
        if (failure === 'json') return new Response('PRIVATE invalid json', { status: 200 });
        return json({ error: { description: `PRIVATE ${credentials.keySecret}` } }, failure === 'redirect' ? 302 : Number(failure.slice(5)));
      };
      await assert.rejects(gateway.getPayment(paymentEntity.id), (error: unknown) => {
        assert.ok(error instanceof HttpError); assert.equal(error.status, 502);
        assert.doesNotMatch(error.message, /PRIVATE|dummy-secret|dummy-webhook/);
        return true;
      });
      assert.equal(calls.length, 1);
    });
  }

  it('rejects malformed order, payment, refund and collection schemas rather than supplying defaults', async () => {
    const { currency: _currency, ...noCurrencyRefund } = refundEntity;
    const { refund_status: _refundStatus, ...noRefundStatus } = paymentEntity;
    const { amount_refunded: _amountRefunded, ...noRefundAmount } = paymentEntity;
    const cases: Array<[unknown, () => Promise<unknown>]> = [
      [{ ...orderEntity, notes: {} }, () => gateway.getOrder(orderEntity.id)],
      [{ ...orderEntity, amount: '199800' }, () => gateway.createOrder(input)],
      [noRefundStatus, () => gateway.getPayment(paymentEntity.id)],
      [noRefundAmount, () => gateway.getPayment(paymentEntity.id)],
      [{ ...paymentEntity, amount_refunded: -1 }, () => gateway.getPayment(paymentEntity.id)],
      [{ ...paymentEntity, captured: 'true' }, () => gateway.getPayment(paymentEntity.id)],
      [{ ...paymentEntity, refund_status: 'unknown' }, () => gateway.getPayment(paymentEntity.id)],
      [noCurrencyRefund, () => gateway.getRefund(refundEntity.id)],
      [{ ...refundEntity, amount: 0 }, () => gateway.getRefund(refundEntity.id)],
      [{ items: [refundEntity] }, () => gateway.listRefunds(paymentEntity.id)],
      [collection([noCurrencyRefund]), () => gateway.listRefunds(paymentEntity.id)],
      [{ ...collection([paymentEntity]), count: 2 }, () => gateway.listPayments(orderEntity.id)],
      [collection([noRefundStatus]), () => gateway.listPayments(orderEntity.id)],
    ];
    for (const [body, action] of cases) {
      respond = async () => json(body);
      await assert.rejects(action, (error: unknown) => error instanceof HttpError && error.status === 502);
    }
    assert.equal(calls.length, cases.length);
  });

  it('rejects path injection before any HTTP request', async () => {
    for (const value of ['../refunds', 'pay_id?skip=1', 'pay_id/other', 'pay%2fother', '', 'a'.repeat(101)]) {
      assert.throws(() => gateway.getPayment(value)); assert.throws(() => gateway.getOrder(value));
      assert.throws(() => gateway.getRefund(value));
      await assert.rejects(gateway.listPayments(value)); await assert.rejects(gateway.listRefunds(value));
    }
    assert.equal(calls.length, 0);
  });

  it('verifies SHA256 HMAC with the correct secret, order/payment binding and exact raw webhook bytes', () => {
    const paymentSignature = createHmac('sha256', credentials.keySecret).update(`${orderEntity.id}|${paymentEntity.id}`).digest('hex');
    assert.equal(gateway.verifyPaymentSignature(orderEntity.id, paymentEntity.id, paymentSignature), true);
    assert.equal(gateway.verifyPaymentSignature(orderEntity.id, paymentEntity.id, paymentSignature.toUpperCase()), true);
    assert.equal(gateway.verifyPaymentSignature('order_other', paymentEntity.id, paymentSignature), false);
    assert.equal(gateway.verifyPaymentSignature(orderEntity.id, 'pay_other', paymentSignature), false);
    const body = Buffer.from(' {"event":"refund.processed","note":"काशी"}\n');
    const signature = createHmac('sha256', credentials.webhookSecret).update(body).digest('hex');
    assert.equal(gateway.verifyWebhookSignature(body, signature), true);
    assert.equal(gateway.verifyWebhookSignature(Buffer.from(body.toString().trim()), signature), false);
    assert.equal(gateway.verifyWebhookSignature(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), signature), false);
    assert.equal(verifyHmac(credentials.keySecret, body, signature), false);
    for (const invalid of ['', '0'.repeat(64), 'g'.repeat(64), signature.slice(0, 62), `${signature}00`, ` ${signature}`, `${signature}\n`]) {
      assert.equal(gateway.verifyWebhookSignature(body, invalid), false);
      assert.equal(gateway.verifyPaymentSignature(orderEntity.id, paymentEntity.id, invalid), false);
    }
    assert.equal(calls.length, 0);
  });

  for (const lastPage of ['pending-refund', 'http-failure'] as const) {
    it(`holds an already paid order when a later refund page has ${lastPage}`, async () => {
      const f = fixture(gateway);
      try {
        let remote = { ...orderEntity }; let refunded = false;
        respond = async (url, init) => {
          if (init?.method === 'POST') { remote = { ...remote, ...JSON.parse(String(init.body)) }; return json(remote); }
          if (url.endsWith(`/orders/${remote.id}`)) return json(remote);
          if (url.endsWith(`/orders/${remote.id}/payments`)) return json(collection([{ ...paymentEntity, amount: remote.amount,
            ...(refunded ? { status: 'refunded', refund_status: 'full', amount_refunded: remote.amount } : {}) }]));
          if (url.includes(`/payments/${paymentEntity.id}/refunds?`)) {
            if (!refunded) return json(collection([]));
            if (new URL(url).searchParams.get('skip') === '0') return json(collection(Array.from({ length: 100 }, (_, i) => ({
              ...refundEntity, id: `rfnd_page_${i}`, amount: i === 0 ? remote.amount : 1, status: i === 0 ? 'processed' : 'failed',
            }))));
            return lastPage === 'http-failure' ? json({ error: { description: 'Synthetic outage' } }, 503)
              : json(collection([{ ...refundEntity, id: 'rfnd_pending', amount: 1, status: 'pending' }]));
          }
          throw new Error('Unexpected mocked endpoint');
        };
        const order = (await f.customer.post('/api/payments/create').set(xhr).send(f.payload()).expect(201)).body.order;
        const reconcile = () => f.customer.post(`/api/payments/reconcile/${order.id}`).set(xhr).send({}).expect(200);
        const paid = (await reconcile()).body.order; const stock = f.stock();
        assert.equal(paid.paymentStatus, 'paid'); assert.equal(paid.paymentReview, null);
        refunded = true;
        const held = (await reconcile()).body.order;
        assert.equal(held.paymentStatus, 'paid'); assert.ok(held.paymentReview); assert.equal(held.paidAt, paid.paidAt);
        assert.equal(f.stock(), stock); assert.ok(calls.some(({ url }) => url.endsWith('skip=100')));
        await f.admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'confirmed' }).expect(409);
        assert.equal((await f.admin.get('/api/admin/stats').expect(200)).body.stats.revenue, 0);
      } finally { f.db.close(); }
    });
  }

  for (const malformedRefund of [false, true]) {
    it(`uses the production adapter for reconciliation with ${malformedRefund ? 'malformed refund currency held for review' : 'a missed full refund'}`, async () => {
      const f = fixture(gateway);
      try {
        let remote = { ...orderEntity };
        respond = async (url, init) => {
          if (init?.method === 'POST') { remote = { ...remote, ...JSON.parse(String(init.body)) }; return json(remote); }
          if (url.endsWith(`/orders/${remote.id}`)) return json(remote);
          if (url.endsWith(`/orders/${remote.id}/payments`)) return json(collection([{ ...paymentEntity, amount: remote.amount,
            status: 'refunded', refund_status: 'full', amount_refunded: remote.amount }]));
          if (url.includes(`/payments/${paymentEntity.id}/refunds?`)) return json(collection([{ ...refundEntity,
            amount: remote.amount, currency: malformedRefund ? null : 'INR' }]));
          throw new Error('Unexpected mocked endpoint');
        };
        const created = (await f.customer.post('/api/payments/create').set(xhr).send(f.payload()).expect(201)).body.order;
        const stock = f.stock();
        const result = (await f.customer.post(`/api/payments/reconcile/${created.id}`).set(xhr).send({}).expect(200)).body.order;
        assert.equal(result.paymentStatus, malformedRefund ? 'pending' : 'refunded');
        if (malformedRefund) assert.ok(result.paymentReview); else assert.equal(result.paymentReview, null);
        assert.equal(f.stock(), stock);
        await f.admin.patch(`/api/admin/orders/${created.id}`).set(xhr).send({ status: 'confirmed' }).expect(409);
      } finally { f.db.close(); }
    });
  }
});