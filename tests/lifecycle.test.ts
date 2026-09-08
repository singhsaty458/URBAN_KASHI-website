import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { archiveSoldOutProducts, getOrder, getProduct, insertProduct, listProducts, openDatabase, setDatabaseClock,
  SOLD_OUT_ARCHIVE_MS, synchronizeProductLifecycle, transaction, updateProduct, type StoreDatabase } from '../server/db.js';
import { commitCatalogueImport, planCatalogueImport } from '../server/catalogue.js';
import { reserveOrder, restoreOrderStock } from '../server/orders.js';
import { productSchema } from '../server/validation.js';
import type { Product } from '../shared/types.js';
import { sessionCookie, testAddress, xhr } from './fixtures.js';

describe('48-hour sold-out soft archival', () => {
  let directory: string;
  let db: StoreDatabase;
  let app: ReturnType<typeof createApp>;
  let now: number;
  let id: string;
  let admin: ReturnType<typeof request.agent>;
  let customer: ReturnType<typeof request.agent>;
  const current = () => getProduct(db, id)!;
  const edit = (patch: Partial<Product>, republish = false) => {
    updateProduct(db, { ...current(), ...patch }, { republish });
    return current();
  };
  const checkout = () => ({ items: [{ productId: id, size: 'M', quantity: 1 }], address: testAddress, idempotencyKey: randomUUID() });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'urban-kashi-lifecycle-'));
    now = Date.parse('2026-09-01T12:00:00.000Z');
    db = openDatabase(join(directory, 'store.sqlite'));
    app = createApp({ db, uploadsPath: join(directory, 'uploads'), distPath: false, paymentGateway: null,
      rateLimit: false, disableMaintenance: true, clock: () => now });
    id = listProducts(db)[0]!.id;
    for (const role of ['admin', 'customer']) db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)')
      .run(role, 'Test User', `${role}@example.test`, 'unused-test-hash', role, new Date(now).toISOString());
    admin = request.agent(app).set('Cookie', sessionCookie(db, 'admin'));
    customer = request.agent(app).set('Cookie', sessionCookie(db, 'customer'));
  });
  afterEach(() => { app.locals.closeDatabase(); db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('starts the timer only when ALL sizes reach zero, in the reservation transaction', async () => {
    edit({ variants: [{ size: 'M', stock: 1 }, { size: 'L', stock: 1 }] });
    await customer.post('/api/orders').set(xhr).send(checkout()).expect(201);
    assert.equal(current().soldOutAt, null);
    const body = checkout(); body.items[0]!.size = 'L';
    await customer.post('/api/orders').set(xhr).send(body).expect(201);
    assert.equal(current().soldOutAt, new Date(now).toISOString());
    assert.equal(current().active, true);
    assert.equal(current().archivedAt, null);
    const stamp = current().soldOutAt;
    now += 60_000;
    await customer.post('/api/orders').set(xhr).send(body).expect(201); // idempotent replay
    assert.equal(current().soldOutAt, stamp);
    assert.deepEqual(current().variants.map(({ stock }) => stock), [0, 0]);
  });

  it('is visible at 47:59 and 48h minus 1ms, hidden at the exact deadline without waiting for a background job', async () => {
    const photo = current().image;
    const variants = edit({ variants: [{ size: 'M', stock: 0 }] }).variants;
    const start = now;
    now = start + SOLD_OUT_ARCHIVE_MS - 60_000;
    await request(app).get(`/api/products/${current().slug}`).expect(200);
    now = start + SOLD_OUT_ARCHIVE_MS - 1;
    assert.equal(archiveSoldOutProducts(db, now), 0);
    now++;
    await request(app).get(`/api/products/${current().slug}`).expect(404);
    assert.equal(current().active, false);
    assert.equal(current().soldOutAt, new Date(start).toISOString());
    assert.equal(current().archivedAt, new Date(now).toISOString());
    assert.equal(current().image, photo);
    assert.deepEqual(current().variants, variants);
    assert.equal((await request(app).get('/api/products')).body.products.some((product: Product) => product.id === id), false);
    const all = (await admin.get('/api/admin/products').expect(200)).body.products as Product[];
    assert.equal(all.find((product) => product.id === id)!.archivedAt, current().archivedAt);
    assert.equal(archiveSoldOutProducts(db, now + 60_000), 0);
    assert.equal(listProducts(db, true).length, 12);
  });

  it('clears a pre-deadline timer on restock and starts a fresh timer on the next sellout', () => {
    edit({ variants: [{ size: 'M', stock: 0 }] });
    const start = now;
    now += SOLD_OUT_ARCHIVE_MS - 1;
    edit({ variants: [{ size: 'M', stock: 2 }] });
    assert.equal(current().soldOutAt, null);
    assert.equal(archiveSoldOutProducts(db, start + SOLD_OUT_ARCHIVE_MS), 0);
    now += 1000;
    edit({ variants: [{ size: 'M', stock: 0 }] });
    assert.equal(current().soldOutAt, new Date(now).toISOString());
  });

  it('does not reset timers across repeated edits, variant replacement, CSV reimport or restart', () => {
    edit({ variants: [{ size: 'M', stock: 0, barcode: '000-clock' }] });
    const start = current().soldOutAt;
    now += 60_000;
    edit({ name: 'Renamed without resetting availability' });
    edit({ variants: [{ size: 'M', stock: 0, barcode: '000-clock' }] });
    assert.equal(current().soldOutAt, start);
    const text = 'slug,name,category,brand,design,color,size,barcode,sku,price,stock,image,description\n'
      + `${current().slug},,,,,,M,000-clock,,,0,,`;
    assert.equal(planCatalogueImport(db, text).preview.valid, true);
    assert.equal(commitCatalogueImport(db, text).result?.updated, 1);
    assert.equal(commitCatalogueImport(db, text).result?.updated, 1);
    assert.equal(current().soldOutAt, start);
    app.locals.closeDatabase(); db.close();
    db = openDatabase(join(directory, 'store.sqlite'));
    assert.equal(current().soldOutAt, start);
    now = Date.parse(start!) + SOLD_OUT_ARCHIVE_MS;
    app = createApp({ db, uploadsPath: join(directory, 'uploads'), distPath: false, paymentGateway: null,
      rateLimit: false, disableMaintenance: true, clock: () => now });
    assert.equal(current().active, false);
    assert.equal(current().archivedAt, new Date(now).toISOString());
  });

  it('creates zero-stock products with timestamps and rejects writable lifecycle fields', async () => {
    const { id: _id, soldOutAt: _soldOutAt, archivedAt: _archivedAt, ...fields } = current();
    for (const field of ['soldOutAt', 'archivedAt', 'sold_out_at', 'archived_at']) {
      await admin.patch(`/api/admin/products/${id}`).set(xhr).send({ [field]: null }).expect(400);
      assert.equal(productSchema.safeParse({ ...fields, [field]: null }).success, false);
    }
    const response = await admin.post('/api/admin/products').set(xhr).send({ ...fields, slug: 'brand-new-sold-out', variants: [{ size: 'M', stock: 0 }] }).expect(201);
    assert.equal(response.body.product.soldOutAt, new Date(now).toISOString());
    assert.equal(response.body.product.archivedAt, null);
    assert.equal('sold_out_at' in response.body.product, false);
    assert.equal('archived_at' in response.body.product, false);
  });

  it('restocks archived rows on cancellation without publishing, restores once, and requires explicit stocked republish', async () => {
    edit({ variants: [{ size: 'M', stock: 1 }] });
    const order = (await customer.post('/api/orders').set(xhr).send(checkout()).expect(201)).body.order;
    const snapshot = structuredClone(order.items);
    now += SOLD_OUT_ARCHIVE_MS;
    await request(app).get('/api/products').expect(200);
    const archivedAt = current().archivedAt;
    await admin.patch(`/api/admin/products/${id}`).set(xhr).send({ active: true }).expect(409);
    await admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(200);
    assert.equal(current().variants[0]!.stock, 1);
    assert.equal(current().active, false);
    assert.equal(current().archivedAt, archivedAt);
    assert.deepEqual(getOrder(db, order.id)!.items, snapshot);
    await admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(409);
    assert.throws(() => restoreOrderStock(db, order), /cannot be restored/);
    assert.equal(current().variants[0]!.stock, 1);
    await request(app).get(`/api/products/${current().slug}`).expect(404);
    await admin.patch(`/api/admin/products/${id}`).set(xhr).send({ name: 'Still archived' }).expect(200);
    assert.equal(current().active, false);
    await admin.patch(`/api/admin/products/${id}`).set(xhr).send({ active: true }).expect(200);
    assert.equal(current().archivedAt, null);
    assert.equal(current().soldOutAt, null);
    await request(app).get(`/api/products/${current().slug}`).expect(200);
  });

  it('pre-deadline cancellation clears the timer but deadline restock without a prior read cannot evade archival', async () => {
    edit({ variants: [{ size: 'M', stock: 1 }] });
    const order = reserveOrder(db, 'customer', checkout(), 'COD');
    now += SOLD_OUT_ARCHIVE_MS - 1;
    await admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(200);
    assert.equal(current().soldOutAt, null);
    edit({ variants: [{ size: 'M', stock: 0 }] });
    now += SOLD_OUT_ARCHIVE_MS;
    edit({ variants: [{ size: 'M', stock: 1 }] });
    assert.equal(current().active, false);
    assert.ok(current().archivedAt);
  });

  it('CSV maintains archives on stock edits and requires explicit active:true with positive final stock to restore', () => {
    edit({ variants: [{ size: 'M', stock: 0, barcode: 'archive-csv' }] });
    now += SOLD_OUT_ARCHIVE_MS;
    const csv = (stock: number, active: string) => 'slug,name,category,brand,design,color,size,barcode,sku,price,stock,image,description,active\n'
      + `${current().slug},,,,,,M,archive-csv,,,${stock},,,${active}`;
    assert.equal(commitCatalogueImport(db, csv(0, 'true')).result, null);
    assert.equal(commitCatalogueImport(db, csv(2, '')).result?.updated, 1);
    assert.equal(current().active, false);
    assert.ok(current().archivedAt);
    assert.equal(commitCatalogueImport(db, csv(2, 'true')).result?.updated, 1);
    assert.equal(current().active, true);
    assert.equal(current().soldOutAt, null);
    assert.equal(current().archivedAt, null);
  });

  it('preserves payment review reservations and enforces shipping/terminal guards after archival', async () => {
    edit({ variants: [{ size: 'M', stock: 1 }] });
    const order = reserveOrder(db, 'customer', checkout(), 'Razorpay');
    db.prepare("UPDATE orders SET payment_review = 'Manual review', payment_status = 'paid' WHERE id = ?").run(order.id);
    const before = getOrder(db, order.id);
    now += SOLD_OUT_ARCHIVE_MS;
    archiveSoldOutProducts(db, now);
    assert.deepEqual(getOrder(db, order.id), before);
    await admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'confirmed' }).expect(409);
    await admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'shipped' }).expect(409);
    await admin.patch(`/api/admin/orders/${order.id}`).set(xhr).send({ status: 'cancelled' }).expect(200);
    assert.equal(getOrder(db, order.id)!.paymentStatus, 'refund_required');
    assert.equal(current().active, false);
    assert.equal(current().variants[0]!.stock, 1);
  });

  it('rejects archived reservations even if the active flag is accidentally set and causes no writes on ordinary reads', async () => {
    const before = db.prepare('SELECT total_changes() AS changes').get();
    await request(app).get('/api/products').expect(200);
    await admin.get('/api/admin/products').expect(200);
    assert.deepEqual(db.prepare('SELECT total_changes() AS changes').get(), before);
    db.prepare('UPDATE products SET active = 1, archived_at = ? WHERE id = ?').run(new Date(now).toISOString(), id);
    await customer.post('/api/orders').set(xhr).send(checkout()).expect(409);
    await request(app).get(`/api/products/${current().slug}`).expect(404);
  });

  it('rolls stock and lifecycle back together on a failed transaction', () => {
    edit({ variants: [{ size: 'M', stock: 1 }] });
    assert.throws(() => transaction(db, () => {
      db.prepare('UPDATE variants SET stock = 0 WHERE product_id = ?').run(id);
      synchronizeProductLifecycle(db, id, now);
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(current().soldOutAt, null);
    assert.equal(current().variants[0]!.stock, 1);
  });
});

describe('v2 to v3 migration', () => {
  it('preserves products, variants, history, seed markers and future-version rejection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'urban-kashi-v3-migration-'));
    const path = join(directory, 'legacy.sqlite');
    let db: StoreDatabase | undefined;
    try {
      db = openDatabase(path);
      const product = listProducts(db)[0]!;
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run('customer', 'Test User', 'customer@example.test', 'unused-hash', 'customer', '2025-01-01');
      const order = reserveOrder(db, 'customer', { items: [{ productId: product.id, size: 'M', quantity: 1 }], address: testAddress, idempotencyKey: 'legacy-v2-order' }, 'COD');
      const variants = getProduct(db, product.id)!.variants;
      const rawOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      db.exec('DROP INDEX products_lifecycle; ALTER TABLE products DROP COLUMN sold_out_at; ALTER TABLE products DROP COLUMN archived_at; DROP TABLE image_uploads; PRAGMA user_version = 2;');
      db.close(); db = openDatabase(path);
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
      assert.equal(listProducts(db, true).length, 12);
      assert.deepEqual(getProduct(db, product.id)!.variants, variants);
      assert.deepEqual(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id), rawOrder);
      assert.equal(getProduct(db, product.id)!.soldOutAt, null);
      assert.equal(getProduct(db, product.id)!.archivedAt, null);
      assert.deepEqual(db.prepare('SELECT * FROM image_uploads').all(), []);
      assert.equal(db.prepare('SELECT * FROM seed_history').all().length, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      db.close(); db = new DatabaseSync(path);
      db.exec('PRAGMA user_version = 4;'); db.close(); db = undefined;
      assert.throws(() => openDatabase(path), /newer than this server/);
    } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});