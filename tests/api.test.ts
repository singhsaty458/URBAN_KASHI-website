import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { openDatabase, type StoreDatabase } from '../server/db.js';
import { hashToken, SESSION_COOKIE } from '../server/auth.js';
import type { Address, Order, Product } from '../shared/types.js';

const password = 'TestPassword2026!';
const adminPasswordHash = bcrypt.hashSync(password, 4); // Test fixtures only; production always uses cost 12.
const securityHeader = { 'X-Requested-With': 'UrbanKashi' };
const address: Address = {
  name: 'Aarav Sharma', phone: '9876543210', line1: '42 River Road, Assi',
  city: 'Varanasi', state: 'Uttar Pradesh', pincode: '221005',
};

describe('local ecommerce API', { concurrency: false }, () => {
  let directory: string;
  let databasePath: string;
  let db: StoreDatabase;
  let app: ReturnType<typeof createApp>;
  let customer: ReturnType<typeof request.agent>;
  let admin: ReturnType<typeof request.agent>;
  let products: Product[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'urban-kashi-api-'));
    databasePath = join(directory, 'store.sqlite');
    db = openDatabase(databasePath);
    app = createApp({ db, rateLimit: false, distPath: false, secureCookies: false, paymentGateway: null, disableMaintenance: true });
    customer = request.agent(app);
    admin = request.agent(app);
    // Explicit local test fixtures, never an API backdoor or production default.
    for (const [id, name, email, role] of [
      ['test-customer', 'Test Customer', 'customer@example.test', 'customer'],
      ['test-admin', 'Test Admin', 'admin@example.test', 'admin'],
    ]) {
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
        .run(id!, name!, email!, adminPasswordHash, role!, new Date().toISOString());
    }
    await customer.post('/api/auth/login').set(securityHeader).send({ email: 'customer@example.test', password }).expect(200);
    await admin.post('/api/auth/login').set(securityHeader).send({ email: 'admin@example.test', password }).expect(200);
    products = (await request(app).get('/api/products').expect(200)).body.products as Product[];
  });

  afterEach(() => { db?.close(); rmSync(directory, { recursive: true, force: true }); });

  function payload(product = products[0]!, quantity = 1, idempotencyKey = randomUUID()) {
    return { items: [{ productId: product.id, size: 'M', quantity }], address: { ...address }, idempotencyKey };
  }
  async function placeOrder(body = payload()): Promise<Order> {
    return (await customer.post('/api/orders').set(securityHeader).send(body).expect(201)).body.order as Order;
  }
  async function stock(product = products[0]!, size = 'M'): Promise<number> {
    const response = await admin.get('/api/admin/products').expect(200);
    const current = (response.body.products as Product[]).find(({ id }) => id === product.id)!;
    return current.variants.find((variant) => variant.size === size)?.stock ?? 0;
  }

  it('serves health, twelve seeded products, and matching product details without private fields', async () => {
    await request(app).get('/api/health').expect(200, { status: 'ok' });
    assert.equal(products.length, 12);
    assert.equal(new Set(products.map(({ slug }) => slug)).size, 12);
    for (const product of products) {
      assert.ok(Number.isInteger(product.price));
      assert.deepEqual(product.variants.map(({ size }) => size), ['S', 'M', 'L', 'XL']);
      assert.ok(product.image.startsWith('/images/photo-'));
      assert.ok(product.description.includes('placeholders'));
    }
    const response = await request(app).get(`/api/products/${products[0]!.slug}`).expect(200);
    assert.deepEqual(response.body.product, products[0]);
    await request(app).get('/api/products/not-a-product').expect(404);
  });

  it('registers normalized email, returns a public customer, and persists only a hashed session', async () => {
    const browser = request.agent(app);
    const response = await browser.post('/api/auth/register').set(securityHeader).send({
      name: '  New Customer  ', email: '  NEW@EXAMPLE.TEST  ', password,
    }).expect(201);
    assert.deepEqual(Object.keys(response.body.user).sort(), ['email', 'id', 'name', 'role']);
    assert.equal(response.body.user.email, 'new@example.test');
    assert.equal(response.body.user.name, 'New Customer');
    assert.equal(response.body.user.role, 'customer');
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const cookie = cookies[0]!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const token = cookie.split(';')[0]!.split('=')[1]!;
    assert.match(token, /^[a-f0-9]{64}$/);
    const session = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(response.body.user.id) as { token_hash: string };
    assert.equal(session.token_hash, hashToken(token));
    assert.notEqual(session.token_hash, token);
    const userRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(response.body.user.id) as { password_hash: string };
    assert.notEqual(userRow.password_hash, password);
    assert.ok(await bcrypt.compare(password, userRow.password_hash));
    assert.equal(bcrypt.getRounds(userRow.password_hash), 12);
    assert.deepEqual((await browser.get('/api/auth/me').expect(200)).body.user, response.body.user);
    assert.equal(JSON.stringify(response.body).includes('hash'), false);
  });

  it('rejects weak and over-72-byte passwords, invalid email, and role injection', async () => {
    for (const candidate of ['short1', 'onlyletterslong', '123456789012', `a1${'é'.repeat(36)}`]) {
      await request(app).post('/api/auth/register').set(securityHeader)
        .send({ name: 'Test User', email: 'new@example.test', password: candidate }).expect(400);
    }
    await request(app).post('/api/auth/register').set(securityHeader)
      .send({ name: 'Test User', email: 'not-an-email', password }).expect(400);
    await request(app).post('/api/auth/register').set(securityHeader)
      .send({ name: 'Test User', email: 'new@example.test', password, role: 'admin' }).expect(400);
  });

  it('rejects duplicate email registration case-insensitively', async () => {
    await request(app).post('/api/auth/register').set(securityHeader)
      .send({ name: 'Duplicate User', email: 'CUSTOMER@EXAMPLE.TEST', password }).expect(409);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 2);
  });

  it('logs in, rotates sessions, logs out, and rejects replay of the old cookie', async () => {
    const browser = request.agent(app);
    const first = await browser.post('/api/auth/login').set(securityHeader)
      .send({ email: 'CUSTOMER@EXAMPLE.TEST', password }).expect(200);
    const oldCookie = (first.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const second = await browser.post('/api/auth/login').set(securityHeader)
      .send({ email: 'customer@example.test', password }).expect(200);
    const newCookie = (second.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    assert.notEqual(oldCookie, newCookie);
    await request(app).get('/api/auth/me').set('Cookie', oldCookie).expect(200, { user: null });
    await browser.post('/api/auth/logout').set(securityHeader).expect(200, { ok: true });
    await browser.get('/api/auth/me').expect(200, { user: null });
    await request(app).get('/api/orders').set('Cookie', newCookie).expect(401);
  });

  it('returns identical generic failures for nonexistent users and wrong passwords', async () => {
    const missing = await request(app).post('/api/auth/login').set(securityHeader)
      .send({ email: 'missing@example.test', password }).expect(401);
    const wrong = await request(app).post('/api/auth/login').set(securityHeader)
      .send({ email: 'customer@example.test', password: 'WrongPassword123' }).expect(401);
    assert.deepEqual(missing.body, wrong.body);
    assert.deepEqual(Object.keys(wrong.body), ['error']);
  });

  it('expires sessions and treats malformed or duplicate session cookies as anonymous', async () => {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, 'test-customer');
    await customer.get('/api/auth/me').expect(200, { user: null });
    await customer.get('/api/orders').expect(401);
    await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=%ZZ`).expect(200, { user: null });
    const token = 'a'.repeat(64);
    await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}`)
      .expect(200, { user: null });
  });

  it('protects all admin routes and refuses unauthenticated checkout and order reads', async () => {
    for (const route of ['/api/admin/stats', '/api/admin/products', '/api/admin/orders']) {
      await request(app).get(route).expect(401);
      await customer.get(route).expect(403);
      await admin.get(route).expect(200);
    }
    await customer.post('/api/admin/products').set(securityHeader).send({}).expect(403);
    await customer.patch(`/api/admin/products/${products[0]!.id}`).set(securityHeader).send({ price: 1 }).expect(403);
    await customer.patch('/api/admin/orders/any-id').set(securityHeader).send({ status: 'confirmed' }).expect(403);
    await request(app).get('/api/orders').expect(401);
    await request(app).post('/api/orders').set(securityHeader).send(payload()).expect(401);
  });

  it('requires the write header and rejects cross-site writes even with the header', async () => {
    await request(app).post('/api/auth/login').send({ email: 'customer@example.test', password }).expect(403);
    await customer.post('/api/orders').send(payload()).expect(403);
    await customer.post('/api/orders').set(securityHeader).set('Sec-Fetch-Site', 'cross-site').send(payload()).expect(403);
    await customer.post('/api/auth/logout').expect(403);
    await admin.patch(`/api/admin/products/${products[0]!.id}`).send({ active: false }).expect(403);
    await customer.post('/api/orders').set(securityHeader).set('Sec-Fetch-Site', 'same-origin').send(payload()).expect(201);
  });

  it('sets no-store and Helmet headers, offers no CORS, and uses secure cookies when configured', async () => {
    const response = await request(app).get('/api/health').set('Origin', 'https://other.example').expect(200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /script-src 'self'/);
    assert.match(response.headers['content-security-policy'], /images\.unsplash\.com/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['x-powered-by'], undefined);
    const secureApp = createApp({ db, distPath: false, rateLimit: false, secureCookies: true, paymentGateway: null, disableMaintenance: true });
    const login = await request(secureApp).post('/api/auth/login').set(securityHeader)
      .send({ email: 'customer@example.test', password }).expect(200);
    assert.match((login.headers['set-cookie'] as unknown as string[])[0]!, /; Secure/);
  });

  it('computes trusted integer COD totals, charges shipping, and persists depleted stock after reopening', async () => {
    const product = products[0]!;
    const before = await stock(product);
    const order = await placeOrder(payload(product));
    assert.equal(order.subtotal, product.price);
    assert.equal(order.shipping, 99);
    assert.equal(order.total, product.price + 99);
    assert.equal(order.paymentMethod, 'COD');
    assert.equal(order.status, 'placed');
    assert.equal(order.userId, 'test-customer');
    assert.equal(order.items[0]!.price, product.price);
    assert.equal(await stock(product), before - 1);
    assert.equal('payload_hash' in order, false);
    assert.equal('idempotency_key' in order, false);
    // A second freshly opened application sees existing sessions, order snapshots and stock; no reseed.
    const reopened = createApp({ databasePath, distPath: false, rateLimit: false, paymentGateway: null });
    try {
      const other = request.agent(reopened);
      await other.post('/api/auth/login').set(securityHeader).send({ email: 'customer@example.test', password }).expect(200);
      const result = await other.get(`/api/orders/${order.id}`).expect(200);
      assert.deepEqual(result.body.order, order);
      const listing = await other.get('/api/products').expect(200);
      assert.equal(listing.body.products.length, 12);
      const persisted = (listing.body.products as Product[]).find(({ id }) => id === product.id)!;
      assert.equal(persisted.variants.find(({ size }) => size === 'M')!.stock, before - 1);
    } finally { reopened.locals.closeDatabase(); }
  });

  it('applies free shipping exactly at the 2499-rupee threshold', async () => {
    const product = products[0]!;
    await admin.patch(`/api/admin/products/${product.id}`).set(securityHeader)
      .send({ price: 2498, originalPrice: null }).expect(200);
    assert.equal((await placeOrder(payload(product))).shipping, 99);
    await admin.patch(`/api/admin/products/${product.id}`).set(securityHeader).send({ price: 2499 }).expect(200);
    const order = await placeOrder(payload(product));
    assert.equal(order.subtotal, 2499);
    assert.equal(order.shipping, 0);
    assert.equal(order.total, 2499);
  });

  it('rejects client totals, prices, payment methods and unexpected address fields', async () => {
    const before = await stock();
    for (const extra of [{ total: 1 }, { subtotal: 1 }, { shipping: 0 }, { paymentMethod: 'PAID' }]) {
      await customer.post('/api/orders').set(securityHeader).send({ ...payload(), ...extra }).expect(400);
    }
    const body = payload();
    await customer.post('/api/orders').set(securityHeader)
      .send({ ...body, items: [{ ...body.items[0], price: 1 }] }).expect(400);
    await customer.post('/api/orders').set(securityHeader)
      .send({ ...body, address: { ...address, arbitrary: 'field' } }).expect(400);
    assert.equal(await stock(), before);
  });

  it('replays the same idempotency key without creating another order or decrementing twice', async () => {
    const body = payload(products[0]!, 2);
    const before = await stock();
    const order = await placeOrder(body);
    assert.deepEqual(await placeOrder(body), order);
    assert.equal(await stock(), before - 2);
    assert.equal((await customer.get('/api/orders').expect(200)).body.orders.length, 1);
    await customer.post('/api/orders').set(securityHeader)
      .send({ ...body, address: { ...address, line1: '99 Changed Road' } }).expect(409);
    await customer.post('/api/orders').set(securityHeader)
      .send({ ...body, items: [{ ...body.items[0], quantity: 3 }] }).expect(409);
    assert.equal(await stock(), before - 2);
  });

  it('canonicalizes line ordering for replay and scopes idempotency keys to each user', async () => {
    const body = payload();
    body.items.push({ productId: products[1]!.id, size: 'L', quantity: 1 });
    const order = await placeOrder(body);
    const replay = await placeOrder({ ...body, items: [...body.items].reverse() });
    assert.equal(replay.id, order.id);
    const other = await admin.post('/api/orders').set(securityHeader).send(body).expect(201);
    assert.notEqual(other.body.order.id, order.id);
    assert.equal(other.body.order.userId, 'test-admin');
  });

  it('rejects duplicate variant lines rather than bypassing quantity limits', async () => {
    const body = payload(products[0]!, 6);
    const before = await stock();
    await customer.post('/api/orders').set(securityHeader)
      .send({ ...body, items: [body.items[0], body.items[0]] }).expect(400);
    assert.equal(await stock(), before);
  });

  it('rejects invalid quantities, empty/oversized carts, invalid sizes and missing idempotency keys', async () => {
    for (const quantity of [0, -1, 11, 1.5, '2', null]) {
      const body = payload();
      await customer.post('/api/orders').set(securityHeader)
        .send({ ...body, items: [{ ...body.items[0], quantity }] }).expect(400);
    }
    const body = payload();
    for (const items of [[], Array(21).fill(body.items[0]), [{ ...body.items[0], size: '<unsafe>' }]]) {
      await customer.post('/api/orders').set(securityHeader).send({ ...body, items }).expect(400);
    }
    await customer.post('/api/orders').set(securityHeader).send({ items: body.items, address }).expect(400);
    await customer.post('/api/orders').set(securityHeader).send({ ...body, idempotencyKey: 'bad' }).expect(400);
  });

  it('validates every address field and never checks out a malformed address', async () => {
    for (const invalid of [{ name: '' }, { phone: '123' }, { line1: 'x' }, { city: '' }, { state: '' }, { pincode: '000000' }]) {
      await customer.post('/api/orders').set(securityHeader)
        .send({ ...payload(), address: { ...address, ...invalid } }).expect(400);
    }
    await customer.post('/api/orders').set(securityHeader).send({ ...payload(), address: null }).expect(400);
    assert.equal((await customer.get('/api/orders').expect(200)).body.orders.length, 0);
  });

  it('rejects out-of-stock, missing and inactive products and rolls back earlier line decrements', async () => {
    const first = [...products].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    const second = [...products].sort((a, b) => a.id.localeCompare(b.id))[1]!;
    const before = await stock(first);
    await admin.patch(`/api/admin/products/${second.id}`).set(securityHeader)
      .send({ variants: second.variants.map((variant) => ({ ...variant, stock: 0 })) }).expect(200);
    const body = payload(first);
    body.items.push({ productId: second.id, size: 'M', quantity: 1 });
    await customer.post('/api/orders').set(securityHeader).send(body).expect(409);
    assert.equal(await stock(first), before);
    assert.equal((await customer.get('/api/orders').expect(200)).body.orders.length, 0);
    await customer.post('/api/orders').set(securityHeader)
      .send({ ...payload(), items: [{ productId: 'missing-id', size: 'M', quantity: 1 }] }).expect(409);
    await admin.patch(`/api/admin/products/${first.id}`).set(securityHeader).send({ active: false }).expect(200);
    await customer.post('/api/orders').set(securityHeader).send(payload(first)).expect(409);
  });

  it('prevents overselling when two requests compete for the final unit', async () => {
    const product = products[0]!;
    await admin.patch(`/api/admin/products/${product.id}`).set(securityHeader)
      .send({ variants: [{ size: 'M', stock: 1 }] }).expect(200);
    const results = await Promise.all([
      customer.post('/api/orders').set(securityHeader).send(payload(product)),
      customer.post('/api/orders').set(securityHeader).send(payload(product)),
    ]);
    assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
    assert.equal(await stock(product), 0);
  });

  it('returns own orders only, hides another customer’s order, and allows admin inspection', async () => {
    const own = await placeOrder();
    const other = request.agent(app);
    await other.post('/api/auth/register').set(securityHeader)
      .send({ name: 'Other Customer', email: 'other@example.test', password }).expect(201);
    await other.get('/api/orders').expect(200, { orders: [] });
    await other.get(`/api/orders/${own.id}`).expect(404);
    await other.patch(`/api/admin/orders/${own.id}`).set(securityHeader).send({ status: 'cancelled' }).expect(403);
    assert.deepEqual((await customer.get(`/api/orders/${own.id}`).expect(200)).body.order, own);
    assert.deepEqual((await admin.get(`/api/orders/${own.id}`).expect(200)).body.order, own);
    assert.equal((await admin.get('/api/admin/orders').expect(200)).body.orders.length, 1);
    await customer.get('/api/orders/missing-id').expect(404);
  });

  it('cancels once, restores stock exactly once, and excludes cancelled totals from revenue', async () => {
    const before = await stock();
    const body = payload(products[0]!, 2);
    const order = await placeOrder(body);
    assert.equal((await admin.get('/api/admin/stats').expect(200)).body.stats.revenue, order.total);
    const cancellation = await admin.patch(`/api/admin/orders/${order.id}`).set(securityHeader)
      .send({ status: 'cancelled' }).expect(200);
    assert.equal(cancellation.body.order.status, 'cancelled');
    assert.equal(await stock(), before);
    await admin.patch(`/api/admin/orders/${order.id}`).set(securityHeader).send({ status: 'cancelled' }).expect(409);
    await admin.patch(`/api/admin/orders/${order.id}`).set(securityHeader).send({ status: 'confirmed' }).expect(409);
    assert.equal(await stock(), before);
    const replay = await placeOrder(body);
    assert.equal(replay.id, order.id);
    assert.equal(replay.status, 'cancelled');
    assert.equal(await stock(), before);
    const stats = (await admin.get('/api/admin/stats').expect(200)).body.stats;
    assert.deepEqual(stats, { products: 12, orders: 1, customers: 1, revenue: 0 });
  });

  it('restores a cancelled variant even if an administrator removed it after checkout', async () => {
    const product = products[0]!;
    const order = await placeOrder(payload(product, 2));
    await admin.patch(`/api/admin/products/${product.id}`).set(securityHeader)
      .send({ variants: [{ size: 'S', stock: 4 }] }).expect(200);
    await admin.patch(`/api/admin/orders/${order.id}`).set(securityHeader).send({ status: 'cancelled' }).expect(200);
    assert.equal(await stock(product, 'M'), 2);
    assert.equal(await stock(product, 'S'), 4);
  });

  it('enforces the complete order state machine and terminal immutability', async () => {
    const order = await placeOrder();
    const route = `/api/admin/orders/${order.id}`;
    await admin.patch(route).set(securityHeader).send({ status: 'delivered' }).expect(409);
    await admin.patch(route).set(securityHeader).send({ status: 'invalid' }).expect(400);
    await admin.patch(route).set(securityHeader).send({ status: 'confirmed', total: 1 }).expect(400);
    await admin.patch(route).set(securityHeader).send({ status: 'confirmed' }).expect(200);
    await admin.patch(route).set(securityHeader).send({ status: 'placed' }).expect(409);
    await admin.patch(route).set(securityHeader).send({ status: 'shipped' }).expect(200);
    await admin.patch(route).set(securityHeader).send({ status: 'cancelled' }).expect(409);
    await admin.patch(route).set(securityHeader).send({ status: 'delivered' }).expect(200);
    await admin.patch(route).set(securityHeader).send({ status: 'delivered' }).expect(409);
    await admin.patch(route).set(securityHeader).send({ status: 'cancelled' }).expect(409);
    const cancellable = await placeOrder();
    await admin.patch(`/api/admin/orders/${cancellable.id}`).set(securityHeader).send({ status: 'confirmed' }).expect(200);
    await admin.patch(`/api/admin/orders/${cancellable.id}`).set(securityHeader).send({ status: 'cancelled' }).expect(200);
  });

  it('keeps immutable product and address snapshots after catalogue edits', async () => {
    const order = await placeOrder();
    await admin.patch(`/api/admin/products/${products[0]!.id}`).set(securityHeader)
      .send({ name: 'Changed Product', price: 1, image: '/images/new.jpg', active: false }).expect(200);
    assert.deepEqual((await customer.get(`/api/orders/${order.id}`).expect(200)).body.order, order);
  });

  it('creates and partially updates products; inactive products are admin-only', async () => {
    const { id: _id, soldOutAt: _soldOutAt, archivedAt: _archivedAt, ...fields } = products[0]!;
    const result = await admin.post('/api/admin/products').set(securityHeader)
      .send({ ...fields, slug: 'new-demo-shirt', name: 'New Demo Shirt', active: false }).expect(201);
    const created = result.body.product as Product;
    assert.notEqual(created.id, products[0]!.id);
    assert.equal(created.slug, 'new-demo-shirt');
    await request(app).get(`/api/products/${created.slug}`).expect(404);
    assert.equal((await request(app).get('/api/products').expect(200)).body.products.length, 12);
    assert.equal((await admin.get('/api/admin/products').expect(200)).body.products.length, 13);
    const changed = await admin.patch(`/api/admin/products/${created.id}`).set(securityHeader)
      .send({ active: true, variants: [{ size: 'L', stock: 5 }] }).expect(200);
    assert.equal(changed.body.product.name, 'New Demo Shirt');
    assert.deepEqual(changed.body.product.variants, [{ size: 'L', stock: 5 }]);
    await request(app).get(`/api/products/${created.slug}`).expect(200);
  });

  it('validates admin image URLs, immutable IDs, unique slugs, price bounds and variant arrays', async () => {
    const route = `/api/admin/products/${products[0]!.id}`;
    for (const image of ['javascript:alert(1)', 'http://example.test/a.jpg', '//evil.test/image', '/../../store.sqlite', '/%2e%2e/store.sqlite', 'https://user:password@example.test/a.jpg']) {
      await admin.patch(route).set(securityHeader).send({ image }).expect(400);
    }
    for (const body of [
      { id: 'replacement' }, {}, { price: 1.5 }, { price: -1 }, { originalPrice: 1 },
      { variants: [] }, { variants: [{ size: 'M', stock: -1 }] },
      { variants: [{ size: 'M', stock: 1 }, { size: 'M', stock: 2 }] },
    ]) await admin.patch(route).set(securityHeader).send(body).expect(400);
    await admin.patch(route).set(securityHeader).send({ slug: products[1]!.slug, variants: [{ size: 'M', stock: 0 }] }).expect(409);
    assert.equal(await stock(), products[0]!.variants.find(({ size }) => size === 'M')!.stock);
    const { id: _id, soldOutAt: _soldOutAt, archivedAt: _archivedAt, ...fields } = products[0]!;
    await admin.post('/api/admin/products').set(securityHeader).send(fields).expect(409);
    await admin.post('/api/admin/products').set(securityHeader).send({ ...fields, id: 'injected' }).expect(400);
    await admin.patch(route).set(securityHeader).send({ image: 'https://cdn.example.test/product.jpg' }).expect(200);
    await admin.patch(route).set(securityHeader).send({ image: '/images/product.jpg' }).expect(200);
    await admin.patch('/api/admin/products/missing').set(securityHeader).send({ active: false }).expect(404);
  });

  it('returns JSON errors for malformed/oversized bodies and unknown API routes', async () => {
    const malformed = await request(app).post('/api/auth/login').set(securityHeader)
      .set('Content-Type', 'application/json').send('{broken').expect(400);
    assert.deepEqual(Object.keys(malformed.body), ['error']);
    await request(app).post('/api/auth/login').set(securityHeader)
      .send({ email: 'x'.repeat(40_000), password }).expect(413);
    await request(app).post('/api/auth/login').set(securityHeader)
      .set('Content-Type', 'text/plain').send('not-json').expect(415);
    const unknown = await request(app).get('/api/not-real').set('Accept', 'text/html').expect(404);
    assert.match(unknown.headers['content-type'], /application\/json/);
    assert.equal(unknown.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(unknown.body), ['error']);
    await request(app).get('/api/products/%27%20OR%201%3D1--').expect(404);
  });

  it('rate-limits authentication and the general API with JSON errors', async () => {
    const limited = createApp({ db, distPath: false, paymentGateway: null, disableMaintenance: true });
    for (let index = 0; index < 20; index++) {
      await request(limited).post('/api/auth/login').set(securityHeader).send({}).expect(400);
    }
    const blocked = await request(limited).post('/api/auth/login').set(securityHeader).send({}).expect(429);
    assert.equal(typeof blocked.body.error, 'string');
    const general = createApp({ db, distPath: false, paymentGateway: null, disableMaintenance: true });
    for (let index = 0; index < 300; index++) await request(general).get('/api/health').expect(200);
    const throttled = await request(general).get('/api/health').expect(429);
    assert.equal(typeof throttled.body.error, 'string');
    assert.equal(throttled.headers['cache-control'], 'no-store');
  });

  it('serves only compiled assets and HTML navigation fallback, never database or arbitrary files', async () => {
    const distPath = join(directory, 'dist');
    mkdirSync(distPath);
    writeFileSync(join(distPath, 'index.html'), '<!doctype html><title>Test storefront</title>');
    writeFileSync(join(distPath, 'app.js'), 'console.log("test");');
    writeFileSync(join(directory, 'private.txt'), 'private-secret');
    const web = createApp({ db, distPath, rateLimit: false, paymentGateway: null, disableMaintenance: true });
    await request(web).get('/account/orders').set('Accept', 'text/html').expect(200).expect(/Test storefront/);
    await request(web).get('/app.js').expect(200);
    await request(web).get('/account/orders').set('Accept', 'application/json').expect(404);
    await request(web).get('/account/orders').expect(404);
    await request(web).get('/missing.js').set('Accept', 'text/html').expect(404);
    for (const path of ['/store.sqlite', '/private.txt', '/.env', '/server/db.ts', '/../private.txt', '/%2e%2e%2fprivate.txt']) {
      const result = await request(web).get(path);
      assert.ok(result.status >= 400);
      assert.equal(result.text.includes('private-secret'), false);
      assert.match(result.headers['content-type'], /application\/json/);
    }
    await request(web).get('/api/missing').set('Accept', 'text/html').expect(404).expect('Content-Type', /json/);
    assert.throws(() => createApp({ db, distPath: directory, paymentGateway: null }), /DATABASE_PATH must be outside/);
  });
});