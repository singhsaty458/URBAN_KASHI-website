import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { getOrder, listProducts, openDatabase, type StoreDatabase, type UserRow } from '../server/db.js';
import { provisionAdministrator } from '../server/setup-admin.js';
import { reserveOrder } from '../server/orders.js';
import { sessionCookie, testAddress, xhr } from './fixtures.js';

// Test-only credentials and memory database. Never provisions a real owner.
const password = 'TestAdminOnly2026!';
const newPassword = 'ReplacedForTest2026!';
let hash: string;
before(async () => { hash = await bcrypt.hash(password, 12); });

describe('dedicated website administrator access', () => {
  let db: StoreDatabase;
  let app: ReturnType<typeof createApp>;
  const row = (id: string) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    assert.ok(user);
    return user;
  };
  beforeEach(() => {
    db = openDatabase(':memory:');
    for (const role of ['customer', 'admin']) db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)')
      .run(role, 'Test Account', `${role}@example.test`, hash, role, '2026-09-08T00:00:00.000Z');
    app = createApp({ db, rateLimit: false, paymentGateway: null, distPath: false, disableMaintenance: true });
  });
  afterEach(() => { app.locals.closeDatabase(); db.close(); });

  it('denies customer/unknown/wrong-password admin logins without changing the existing customer session', async () => {
    const customer = request.agent(app).set('Cookie', sessionCookie(db, 'customer'));
    let denial: unknown;
    for (const [email, supplied] of [['customer@example.test', password], ['missing@example.test', password], ['admin@example.test', 'WrongPassword2026!']]) {
      const response = await customer.post('/api/auth/admin/login').set(xhr).send({ email, password: supplied }).expect(401);
      assert.equal(response.headers['set-cookie'], undefined);
      if (denial) assert.deepEqual(response.body, denial);
      denial = response.body;
      assert.equal((await customer.get('/api/auth/me').expect(200)).body.user.id, 'customer');
    }
    await customer.get('/api/admin/products').expect(403);
  });

  it('issues an admin session only after role verification, with no secrets in JSON', async () => {
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/admin/login').set(xhr)
      .send({ email: 'admin@example.test', password }).expect(200);
    assert.deepEqual(response.body.user, { id: 'admin', name: 'Test Account', email: 'admin@example.test', role: 'admin' });
    await agent.get('/api/admin/products').expect(200);
    const created = await agent.post('/api/admin/products').set(xhr).send({
      slug: 'admin-login-product', name: 'Admin test shirt', category: 'Shirts', color: 'Sand',
      price: 1000, originalPrice: null, description: 'Isolated test product.', details: [],
      image: '/images/test-shirt.jpg', images: ['/images/test-shirt.jpg'], badge: null,
      featured: false, active: true, variants: [{ size: 'M', stock: 2 }],
    }).expect(201);
    const id = created.body.product.id as string;
    await request(app).get('/api/products/admin-login-product').expect(200);
    await agent.patch(`/api/admin/products/${id}`).set(xhr).send({ price: 1200, active: false }).expect(200);
    await request(app).get('/api/products/admin-login-product').expect(404);
    const inventory = await agent.get('/api/admin/products').expect(200);
    assert.ok(inventory.body.products.some((product: { id: string; price: number; active: boolean }) => product.id === id && product.price === 1200 && !product.active));
    await agent.post('/api/auth/logout').set(xhr).expect(200);
    await agent.get('/api/admin/products').expect(401);
  });

  it('retains customer login and rejects unsafe admin writes', async () => {
    await request(app).post('/api/auth/login').set(xhr).send({ email: 'customer@example.test', password }).expect(200);
    await request(app).post('/api/auth/admin/login').send({ email: 'admin@example.test', password }).expect(403);
    await request(app).post('/api/auth/admin/login').set(xhr).set('Sec-Fetch-Site', 'cross-site')
      .send({ email: 'admin@example.test', password }).expect(403);
    await request(app).post('/api/auth/admin/login').set(xhr)
      .send({ email: 'customer@example.test', password, role: 'admin' }).expect(400);
  });

  it('shares the sign-in rate limit across customer and administrator endpoints', async () => {
    const limited = createApp({ db, paymentGateway: null, distPath: false, disableMaintenance: true });
    try {
      for (let index = 0; index < 20; index++) {
        await request(limited).post(index % 2 ? '/api/auth/login' : '/api/auth/admin/login').set(xhr).send({}).expect(400);
      }
      await request(limited).post('/api/auth/admin/login').set(xhr)
        .send({ email: 'admin@example.test', password }).expect(429);
    } finally { limited.locals.closeDatabase(); }
  });

  it('requires explicit matching owner confirmation and a valid password before account changes', async () => {
    const original = row('customer');
    await assert.rejects(provisionAdministrator(db, { email: original.email, name: 'Owner', password: newPassword }, ''), /Confirmation/);
    await assert.rejects(provisionAdministrator(db, { email: original.email, name: 'Owner', password: 'weak' }, `ADMIN ${original.email}`));
    assert.deepEqual(row('customer'), original);
  });

  it('promotes explicitly, replaces the password, revokes sessions and preserves the account ID and order history', async () => {
    const oldCookie = sessionCookie(db, 'customer');
    const otherCookie = sessionCookie(db, 'admin');
    const product = listProducts(db)[0]!;
    const order = reserveOrder(db, 'customer', {
      items: [{ productId: product.id, size: 'M', quantity: 1 }], address: testAddress, idempotencyKey: 'admin-setup-history',
    }, 'COD');
    const details = { email: 'customer@example.test', name: 'Website Owner', password: newPassword };
    const result = await provisionAdministrator(db, details, `ADMIN ${details.email}`);
    assert.equal(result.created, false);
    assert.equal(result.user.id, 'customer');
    assert.equal(result.user.role, 'admin');
    assert.equal('password_hash' in result.user, false);
    assert.equal(await bcrypt.compare(newPassword, row('customer').password_hash), true);
    assert.deepEqual(getOrder(db, order.id), order);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).body.user, null);
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', otherCookie)).body.user.id, 'admin');
    await request(app).post('/api/auth/admin/login').set(xhr).send({ email: details.email, password }).expect(401);
    await request(app).post('/api/auth/admin/login').set(xhr).send({ email: details.email, password: newPassword }).expect(200);
  });

  it('creates a new administrator only through explicitly confirmed private setup', async () => {
    const details = { email: 'owner@example.test', name: 'New Owner', password: newPassword };
    const result = await provisionAdministrator(db, details, `ADMIN ${details.email}`);
    assert.equal(result.created, true);
    assert.equal(result.user.role, 'admin');
    await request(app).post('/api/auth/admin/login').set(xhr).send({ email: details.email, password: newPassword }).expect(200);
  });

  it('rolls back account changes if session revocation fails', async () => {
    sessionCookie(db, 'customer');
    const original = row('customer');
    db.exec("CREATE TRIGGER deny_session_removal BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
    await assert.rejects(provisionAdministrator(db, { email: original.email, name: 'Owner', password: newPassword }, `ADMIN ${original.email}`), /test rollback/);
    assert.deepEqual(row('customer'), original);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get('customer')?.count, 1);
  });
});